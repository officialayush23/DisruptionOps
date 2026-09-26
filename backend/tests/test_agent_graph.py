"""The LangGraph agent graph, run end to end against fakes for the database,
the solver and the Commander (and a stand-in for langgraph itself when it is not
installed)."""
from __future__ import annotations

import asyncio
import importlib
import importlib.util
import sys
import unittest
from dataclasses import dataclass, field

sys.path.insert(0, "tests")
import _stubs  # noqa: E402

_stubs.install()
if importlib.util.find_spec("langgraph") is None:
    import fake_langgraph

    fake_langgraph.install()


@dataclass
class Change:
    kind: str
    resource_id: str
    resource_label: str = "Boat 1"
    incident_id: str | None = "i2"
    incident_title: str = "x"
    ward_id: str = "w"
    from_incident_id: str | None = None
    from_incident_title: str = ""
    eta_minutes: int = 5
    reason: str = ""


@dataclass
class Diff:
    plan_id: str | None = "p"
    engine: str = "cp-sat"
    runtime_ms: int = 3
    coverage: float = 0.8
    kept: list = field(default_factory=list)
    assigned: list = field(default_factory=list)
    reassigned: list = field(default_factory=list)
    released: list = field(default_factory=list)
    uncovered: list = field(default_factory=list)

    @property
    def headline(self):
        return f"{len(self.assigned)} newly tasked, {len(self.reassigned)} re-tasked"


class FakeDB:
    def __init__(self, severity=3, pulled_severity=3):
        self.severity, self.pulled = severity, pulled_severity

    async def fetchval(self, q, *a):
        return self.severity

    async def fetchrow(self, q, *a):
        if "resources" in q:
            return {"total": 10, "available": 2}
        return {"full_": 1, "total": 5}

    async def fetch(self, q, *a):
        if "incident_needs" in q:
            return [{"capability_id": "water_rescue", "required": 2, "met": 1},
                    {"capability_id": "medical_transport", "required": 1, "met": 0}]
        if "ward_risks" in q:
            return [{"ward_id": "w1", "severity": 4}]
        if "from incidents" in q:
            return [{"id": "i1", "title": "Stranded family", "severity": self.pulled}]
        return []


class FakeReplan:
    def __init__(self, diff, fail_times=0):
        self.diff, self.fail_times, self.previews, self.commits = diff, fail_times, 0, 0

    async def preview(self, **kw):
        self.previews += 1
        if self.previews <= self.fail_times:
            raise RuntimeError("solver timeout")
        return self.diff

    async def replan(self, **kw):
        self.commits += 1
        return self.diff


class AgentGraph(unittest.TestCase):
    def setup(self, *, severity=3, pulled=3, diff=None, fail_times=0):
        import app.agents.graph as graph
        graph = importlib.reload(graph)
        from app.db import session
        from app.agents import commander, replan
        self.db = FakeDB(severity, pulled)
        self.rp = FakeReplan(diff or Diff(assigned=[Change("assigned", "u1")]), fail_times)
        self._saved = (session.fetchval, session.fetchrow, session.fetch,
                       replan.preview, replan.replan, commander.nudge)
        session.fetchval, session.fetchrow, session.fetch = self.db.fetchval, self.db.fetchrow, self.db.fetch
        replan.preview, replan.replan = self.rp.preview, self.rp.replan
        self.nudges = []
        commander.nudge = lambda *a, **k: self.nudges.append(a) or True

        async def no_event(*a, **k):
            return None
        graph._event = no_event
        self.graph = graph
        return graph

    def tearDown(self):
        from app.db import session
        from app.agents import commander, replan
        (session.fetchval, session.fetchrow, session.fetch,
         replan.preview, replan.replan, commander.nudge) = self._saved

    def run_(self, coro):
        return asyncio.run(coro)

    def test_simple_plan_dispatches_without_a_human(self):
        g = self.setup()
        run = self.run_(g.run_cycle(trigger="incident.opened"))
        self.assertEqual(run.status, "done")
        self.assertEqual(run.outcome, "dispatched")
        self.assertEqual(self.rp.commits, 1)
        nodes = [t["node"] for t in run.trace]
        self.assertEqual(nodes.count("sense"), 4)                 # parallel fan-out
        self.assertIn("domain", nodes)                             # rescue + medical
        self.assertEqual({t.get("domain") for t in run.trace if t["node"] == "domain"}, {"rescue", "medical"})
        self.assertNotIn("command", nodes)                         # S3: commander not woken
        self.assertNotIn("human_approval", nodes)

    def test_severe_incident_wakes_commander(self):
        g = self.setup(severity=5)
        run = self.run_(g.run_cycle(trigger="incident.opened"))
        self.assertIn("command", [t["node"] for t in run.trace])
        self.assertEqual(len(self.nudges), 1)

    def test_retasking_off_severe_incident_waits_then_approved(self):
        d = Diff(reassigned=[Change("reassigned", "u9", from_incident_id="i1")])
        g = self.setup(pulled=4, diff=d)

        async def flow():
            run = await g.run_cycle(trigger="road.blocked")
            self.assertEqual(run.status, "waiting")
            self.assertEqual(self.rp.commits, 0)                   # nothing written yet
            self.assertIn("Stranded family", run.pending["reason"])
            return await g.resume(run.run_id, approved=True, by="Meera")
        run = self.run_(flow())
        self.assertEqual(run.status, "done")
        self.assertEqual(run.outcome, "dispatched")
        self.assertEqual(self.rp.commits, 1)
        self.assertTrue(any("Approved by Meera" in t["text"] for t in run.trace))

    def test_rejected_plan_writes_nothing(self):
        d = Diff(reassigned=[Change("reassigned", "u9", from_incident_id="i1")])
        g = self.setup(pulled=5, diff=d)

        async def flow():
            run = await g.run_cycle(trigger="x")
            return await g.resume(run.run_id, approved=False, by="Meera")
        run = self.run_(flow())
        self.assertEqual(run.outcome, "rejected")
        self.assertEqual(self.rp.commits, 0)

    def test_solver_failure_loops_then_gives_up(self):
        g = self.setup(fail_times=10)
        run = self.run_(g.run_cycle(trigger="x"))
        self.assertEqual(run.outcome, "failed")
        self.assertEqual(self.rp.previews, 3)
        self.assertEqual(self.rp.commits, 0)

    def test_solver_recovers_on_retry(self):
        g = self.setup(fail_times=1)
        run = self.run_(g.run_cycle(trigger="x"))
        self.assertEqual(run.outcome, "dispatched")
        self.assertEqual(self.rp.previews, 2)

    def test_no_change_needs_no_dispatch(self):
        g = self.setup(diff=Diff(kept=[Change("kept", "u1")]))
        run = self.run_(g.run_cycle(trigger="x"))
        self.assertEqual(run.status, "done")
        self.assertEqual(self.rp.commits, 0)
        self.assertEqual(run.trace[-1]["node"], "observe")


if __name__ == "__main__":
    unittest.main()
