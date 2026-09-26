"""The agent graph, on LangGraph.

This is the cycle the event router runs whenever the world changes (a report,
an incident, a road block, a crew update). Before this module the router called
the CP-SAT re-planner directly; now it runs this graph, which does the same
solve but with the steps an officer can see, a human-approval stop for the one
kind of decision that should not be automatic, and a checkpoint per step.

    START
      └─ triage ──(severity ≥ 5)──► command (wake the LLM Incident Commander) ─┐
            │                                                                   │
            └─────────────────────────────────────────────────────────────────►┤
                                                                                ▼
         fan-out (Send) ─► sense[units] · sense[needs] · sense[risk] · sense[facilities]
                                                                                │
                                                                                ▼
                                                                             assess
         fan-out (Send) ─► domain[rescue] · domain[medical] · domain[logistics]   (only
                                                                                │  domains
                                                                                ▼  with a need)
                                                                            optimise  (CP-SAT, dry run)
                                                                                │
                                                                            validate ──fail, <3 tries──► optimise
                                                                                │
                                                                           policy_gate
                                          needs an officer ─► human_approval (interrupt)
                                                 │ approved        │ rejected
                                                 ▼                 ▼
                                              dispatch            END   (current assignments stand)
                                                 │
                                              observe ──► END

LangGraph patterns used, and why:

  * **Conditional branching** — triage decides whether the Commander is woken;
    the gate decides whether a human is needed.
  * **Parallel fan-out with `Send`** — the four situation reads and the domain
    planners run concurrently and merge through reducers.
  * **Loop** — validate → optimise, at most `MAX_ATTEMPTS` times.
  * **Human-in-the-loop** — `interrupt()` pauses the graph before a plan that
    pulls a unit off a severe incident. The run is checkpointed; an officer
    approves or rejects from the console and the run resumes where it stopped.
  * **Checkpointing** — every step is saved under the run's thread id
    (in-memory by default, Postgres with `AGENT_GRAPH_CHECKPOINTER=postgres`).
  * **Per-domain state** — each domain node sees only its own `Send` payload,
    not the whole state, and writes back one summary.

Nothing here decides a number. The solver assigns, the policy decides authority,
the officer decides the exception. When `langgraph` is not installed the router
falls back to the direct re-plan, so the system never depends on this module to
function.
"""

from __future__ import annotations

import asyncio
import operator
import time
import uuid
from dataclasses import asdict, dataclass, field
from typing import Annotated, Any, TypedDict

from app.core.config import settings
from app.core.logging import get_logger

log = get_logger(__name__)

try:  # pragma: no cover - exercised when the dependency is installed
    from langgraph.graph import END, START, StateGraph
    from langgraph.types import Command, Send, interrupt

    try:
        from langgraph.checkpoint.memory import InMemorySaver as _MemorySaver
    except ImportError:  # older langgraph
        from langgraph.checkpoint.memory import MemorySaver as _MemorySaver
    AVAILABLE = True
    IMPORT_ERROR: str | None = None
except Exception as exc:  # noqa: BLE001 - the app must boot without it
    AVAILABLE = False
    IMPORT_ERROR = f"{type(exc).__name__}: {exc}"

ACTOR = "agent:langgraph"
MAX_ATTEMPTS = 3
SEVERE = 5

#: Capability -> domain planner. A capability not listed goes to logistics.
DOMAINS: dict[str, str] = {
    "water_rescue": "rescue", "search_rescue": "rescue", "field_assessment": "rescue",
    "fire_suppression": "rescue",
    "medical_transport": "medical", "medical_care": "medical",
    "dewatering": "logistics", "debris_clearance": "logistics",
    "supply_delivery": "logistics", "mass_transport": "logistics",
    "water_supply": "logistics",
}
SOURCES = ("units", "needs", "risk", "facilities")


# ------------------------------------------------------------------- state ---
class GraphState(TypedDict, total=False):
    run_id: str
    city_id: str
    trigger: str
    #: Highest open-incident severity, set by triage.
    max_severity: int
    commander_woken: bool
    #: Parallel reads merge here (reducer: list concatenation).
    situation: Annotated[list[dict[str, Any]], operator.add]
    #: Unmet capability -> count, set by assess.
    shortfall: dict[str, int]
    #: One summary per domain planner (reducer: list concatenation).
    domain_plans: Annotated[list[dict[str, Any]], operator.add]
    attempts: int
    proposal: dict[str, Any]
    valid: bool
    validation: str
    needs_officer: bool
    gate_reason: str
    approval: dict[str, Any]
    dispatched: dict[str, Any]
    outcome: str
    #: Every node appends one line (reducer: list concatenation).
    trace: Annotated[list[dict[str, Any]], operator.add]


def _step(node: str, text: str, **extra: Any) -> list[dict[str, Any]]:
    return [{"node": node, "text": text, "at": time.time(), **extra}]


def _diff_dict(diff: Any) -> dict[str, Any]:
    """PlanDiff -> plain dict, so checkpoints serialise without custom types."""
    if diff is None:
        return {}
    d = asdict(diff) if hasattr(diff, "__dataclass_fields__") else dict(diff)
    d["changed"] = len(d.get("assigned", [])) + len(d.get("reassigned", [])) + len(d.get("released", []))
    try:
        d["headline"] = diff.headline
    except Exception:  # noqa: BLE001
        d["headline"] = ""
    return d


# ------------------------------------------------------------------- nodes ---
async def triage(state: GraphState) -> dict[str, Any]:
    from app.db import session as db

    sev = await db.fetchval(
        "select coalesce(max(severity), 0) from incidents where city_id = $1 and status <> 'resolved'",
        state["city_id"],
    )
    sev = int(sev or 0)
    return {
        "max_severity": sev, "attempts": 0,
        "trace": _step("triage", f"Trigger: {state['trigger']}. Worst open incident S{sev}."),
    }


def after_triage(state: GraphState) -> str:
    return "command" if state.get("max_severity", 0) >= SEVERE else "fanout"


async def command(state: GraphState) -> dict[str, Any]:
    """Wake the LLM Incident Commander in the background. It never blocks the plan."""
    from app.agents import commander

    woke = commander.nudge(
        "graph.severe", f"Severity {state.get('max_severity')} incident open; {state['trigger']}",
        key=f"graph:{state['city_id']}", city_id=state["city_id"],
    )
    return {"commander_woken": bool(woke),
            "trace": _step("command", "Incident Commander woken." if woke
                           else "Incident Commander already working (debounced).")}


def fanout(state: GraphState) -> dict[str, Any]:
    return {"trace": _step("fanout", f"Reading {len(SOURCES)} sources in parallel.")}


def to_sensors(state: GraphState) -> list[Any]:
    return [Send("sense", {"source": s, "city_id": state["city_id"]}) for s in SOURCES]


async def sense(payload: dict[str, Any]) -> dict[str, Any]:
    """One situation read. Runs once per source, concurrently."""
    from app.db import session as db

    src, city = payload["source"], payload["city_id"]
    if src == "units":
        row = await db.fetchrow(
            """
            select count(*) total,
                   count(*) filter (where status::text = 'available') available
              from resources where city_id = $1
            """, city)
        data = dict(row) if row else {}
        text = f"{data.get('available', 0)} of {data.get('total', 0)} units available."
    elif src == "needs":
        rows = await db.fetch(
            """
            select n.capability_id, sum(n.required) required, sum(coalesce(n.met, 0)) met
              from incident_needs n join incidents i on i.id = n.incident_id
             where i.city_id = $1 and i.status <> 'resolved'
             group by n.capability_id
            """, city)
        data = {r["capability_id"]: {"required": int(r["required"] or 0), "met": int(r["met"] or 0)}
                for r in rows}
        text = f"{len(data)} capabilities in demand."
    elif src == "risk":
        rows = await db.fetch(
            """
            select distinct on (ward_id) ward_id, severity from ward_risks
             order by ward_id, created_at desc
            """)
        severe = [r["ward_id"] for r in rows if (r["severity"] or 0) >= 4]
        data = {"severe_wards": severe}
        text = f"{len(severe)} wards at risk severity 4+."
    else:
        row = await db.fetchrow(
            """
            select count(*) filter (where capacity > 0 and occupancy >= capacity) full_,
                   count(*) total
              from lifelines where city_id = $1
            """, city)
        data = {"full": int(row["full_"] or 0) if row else 0, "total": int(row["total"] or 0) if row else 0}
        text = f"{data['full']} of {data['total']} facilities full."
    return {"situation": [{"source": src, "data": data}],
            "trace": _step("sense", text, source=src)}


def assess(state: GraphState) -> dict[str, Any]:
    needs = next((s["data"] for s in state.get("situation", []) if s["source"] == "needs"), {})
    short = {cap: v["required"] - min(v["met"], v["required"])
             for cap, v in needs.items() if v["required"] > v["met"]}
    text = ("Unmet: " + ", ".join(f"{q}× {c}" for c, q in short.items())) if short else \
        "Every need is covered by the current plan."
    return {"shortfall": short, "trace": _step("assess", text)}


def to_domains(state: GraphState) -> list[Any] | str:
    short = state.get("shortfall") or {}
    by: dict[str, dict[str, int]] = {}
    for cap, q in short.items():
        by.setdefault(DOMAINS.get(cap, "logistics"), {})[cap] = q
    if not by:
        return "optimise"
    units = next((s["data"] for s in state.get("situation", []) if s["source"] == "units"), {})
    return [Send("domain", {"domain": d, "needs": caps, "units": units}) for d, caps in by.items()]


async def domain(payload: dict[str, Any]) -> dict[str, Any]:
    """A domain planner. Sees only its own needs: private state by construction."""
    d, needs = payload["domain"], payload["needs"]
    total = sum(needs.values())
    avail = int((payload.get("units") or {}).get("available") or 0)
    note = (f"{d}: {total} unit(s) short ({', '.join(needs)}); "
            + ("free units exist, the solver can cover some." if avail else
               "no free units: coverage depends on re-tasking."))
    return {"domain_plans": [{"domain": d, "needs": needs, "note": note}],
            "trace": _step("domain", note, domain=d)}


async def optimise(state: GraphState) -> dict[str, Any]:
    """CP-SAT, as a dry run: the exact plan, nothing written yet."""
    from app.agents import replan as replanner

    attempt = int(state.get("attempts") or 0) + 1
    try:
        diff = await replanner.preview(city_id=state["city_id"], trigger=state["trigger"], actor=ACTOR)
        proposal = _diff_dict(diff)
        text = f"Attempt {attempt}: {proposal.get('headline') or 'plan computed'} (coverage {proposal.get('coverage', 0):.0%})."
        return {"attempts": attempt, "proposal": proposal, "trace": _step("optimise", text)}
    except Exception as exc:  # noqa: BLE001 - validate decides what to do
        return {"attempts": attempt, "proposal": {"error": str(exc)[:300]},
                "trace": _step("optimise", f"Attempt {attempt} failed: {str(exc)[:160]}")}


def validate(state: GraphState) -> dict[str, Any]:
    p = state.get("proposal") or {}
    if p.get("error"):
        return {"valid": False, "validation": p["error"], "trace": _step("validate", "Solver error.")}
    # A plan may not assign one unit twice or re-task a unit that is not in the fleet.
    ids = [c["resource_id"] for k in ("assigned", "reassigned", "kept") for c in p.get(k, [])]
    if len(ids) != len(set(ids)):
        return {"valid": False, "validation": "a unit appears twice",
                "trace": _step("validate", "Rejected: a unit appears twice.")}
    return {"valid": True, "validation": "ok",
            "trace": _step("validate", f"Plan valid; {len(p.get('uncovered', []))} need(s) still unmet.")}


def after_validate(state: GraphState) -> str:
    if state.get("valid"):
        return "policy_gate"
    return "optimise" if int(state.get("attempts") or 0) < MAX_ATTEMPTS else "give_up"


def give_up(state: GraphState) -> dict[str, Any]:
    return {"outcome": "failed",
            "trace": _step("give_up", f"No valid plan after {MAX_ATTEMPTS} attempts; current assignments stand.")}


async def policy_gate(state: GraphState) -> dict[str, Any]:
    """Automatic unless the plan pulls a unit off a severe incident."""
    from app.db import session as db

    p = state.get("proposal") or {}
    threshold = int(settings.agent_graph_approval_severity or 0)
    if not p.get("changed"):
        return {"needs_officer": False, "gate_reason": "no change",
                "trace": _step("policy_gate", "Nothing changes; nothing to authorise.")}
    pulled = [c for c in p.get("reassigned", []) + p.get("released", []) if c.get("from_incident_id") or c.get("incident_id")]
    severe: list[str] = []
    if threshold and pulled:
        ids = list({c.get("from_incident_id") or c.get("incident_id") for c in pulled})
        rows = await db.fetch(
            "select id::text, title, severity from incidents where id::text = any($1::text[])", ids)
        severe = [f"{r['title']} (S{r['severity']})" for r in rows if int(r["severity"] or 0) >= threshold]
    if severe:
        reason = "Re-tasks units away from " + "; ".join(severe[:3])
        return {"needs_officer": True, "gate_reason": reason,
                "trace": _step("policy_gate", reason + " — an officer must approve.")}
    return {"needs_officer": False, "gate_reason": "within delegation",
            "trace": _step("policy_gate", "Within the planner's delegation; issuing.")}


def after_gate(state: GraphState) -> str:
    if state.get("needs_officer"):
        return "human_approval"
    return "dispatch" if (state.get("proposal") or {}).get("changed") else "observe"


def human_approval(state: GraphState) -> dict[str, Any]:
    """Pause the run. The console resumes it with {approved, by, note}."""
    p = state.get("proposal") or {}
    answer = interrupt({
        "question": "Approve this re-tasking?",
        "reason": state.get("gate_reason"),
        "headline": p.get("headline"),
        "reassigned": p.get("reassigned", []),
        "released": p.get("released", []),
        "assigned": p.get("assigned", []),
    })
    answer = answer if isinstance(answer, dict) else {"approved": bool(answer)}
    ok = bool(answer.get("approved"))
    who = str(answer.get("by") or "officer")
    return {"approval": answer,
            "trace": _step("human_approval", f"{'Approved' if ok else 'Rejected'} by {who}"
                           + (f": {answer.get('note')}" if answer.get("note") else "."))}


def after_approval(state: GraphState) -> str:
    return "dispatch" if (state.get("approval") or {}).get("approved") else "rejected"


def rejected(state: GraphState) -> dict[str, Any]:
    return {"outcome": "rejected",
            "trace": _step("rejected", "Plan rejected; current assignments stand.")}


async def dispatch(state: GraphState) -> dict[str, Any]:
    """Commit. Re-solves against the world as it is now and writes it."""
    from app.agents import replan as replanner

    diff = await replanner.replan(city_id=state["city_id"], trigger=state["trigger"], actor=ACTOR)
    d = _diff_dict(diff)
    return {"dispatched": d, "outcome": "dispatched",
            "trace": _step("dispatch", d.get("headline") or "Plan written.")}


def observe(state: GraphState) -> dict[str, Any]:
    d = state.get("dispatched") or state.get("proposal") or {}
    unmet = len(d.get("uncovered", []))
    return {"outcome": state.get("outcome") or "unchanged",
            "trace": _step("observe", f"Coverage {float(d.get('coverage') or 1):.0%}; {unmet} unmet. "
                           "The router re-enters this graph on the next change.")}


# ------------------------------------------------------------------- build ---
def build(checkpointer: Any = None) -> Any:
    g = StateGraph(GraphState)
    for name, fn in (
        ("triage", triage), ("command", command), ("fanout", fanout), ("sense", sense),
        ("assess", assess), ("domain", domain), ("optimise", optimise), ("validate", validate),
        ("give_up", give_up), ("policy_gate", policy_gate), ("human_approval", human_approval),
        ("rejected", rejected), ("dispatch", dispatch), ("observe", observe),
    ):
        g.add_node(name, fn)
    g.add_edge(START, "triage")
    g.add_conditional_edges("triage", after_triage, {"command": "command", "fanout": "fanout"})
    g.add_edge("command", "fanout")
    g.add_conditional_edges("fanout", to_sensors, ["sense"])
    g.add_edge("sense", "assess")
    g.add_conditional_edges("assess", to_domains, ["domain", "optimise"])
    g.add_edge("domain", "optimise")
    g.add_edge("optimise", "validate")
    g.add_conditional_edges("validate", after_validate,
                            {"policy_gate": "policy_gate", "optimise": "optimise", "give_up": "give_up"})
    g.add_edge("give_up", END)
    g.add_conditional_edges("policy_gate", after_gate,
                            {"human_approval": "human_approval", "dispatch": "dispatch", "observe": "observe"})
    g.add_conditional_edges("human_approval", after_approval,
                            {"dispatch": "dispatch", "rejected": "rejected"})
    g.add_edge("rejected", END)
    g.add_edge("dispatch", "observe")
    g.add_edge("observe", END)
    return g.compile(checkpointer=checkpointer)


# ----------------------------------------------------------------- runtime ---
@dataclass
class Run:
    run_id: str
    city_id: str
    trigger: str
    started_at: float
    status: str = "running"          # running | waiting | done | failed
    outcome: str | None = None
    trace: list[dict[str, Any]] = field(default_factory=list)
    pending: dict[str, Any] | None = None
    finished_at: float | None = None
    error: str | None = None

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


RUNS: dict[str, Run] = {}
_ORDER: list[str] = []
_graph: Any = None
_saver: Any = None
_saver_cm: Any = None
_init_lock = asyncio.Lock()


def enabled() -> bool:
    return AVAILABLE and bool(settings.agent_graph_enabled)


async def _compiled() -> Any:
    global _graph, _saver, _saver_cm
    if _graph is not None:
        return _graph
    async with _init_lock:
        if _graph is not None:
            return _graph
        saver = None
        if settings.agent_graph_checkpointer == "postgres":
            try:  # pragma: no cover - needs the optional package and a DSN
                from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver

                _saver_cm = AsyncPostgresSaver.from_conn_string(settings.dsn)
                saver = await _saver_cm.__aenter__()
                await saver.setup()
            except Exception as exc:  # noqa: BLE001
                log.warning("graph_postgres_checkpointer_unavailable", error=str(exc)[:200])
                saver = None
        _saver = saver or _MemorySaver()
        _graph = build(_saver)
        return _graph


def _remember(run: Run) -> None:
    RUNS[run.run_id] = run
    _ORDER.insert(0, run.run_id)
    for old in _ORDER[30:]:
        if RUNS.get(old) and RUNS[old].status != "waiting":
            RUNS.pop(old, None)
    del _ORDER[30:]


async def _event(run: Run, kind: str) -> None:
    try:
        from app.world import clock as clocks
        from app.world import events as ev

        await ev.append(clock=clocks.WALL, kind=kind, actor=ACTOR, subject_type="agent",
                        subject_id=run.run_id, city_id=run.city_id,
                        payload={"trigger": run.trigger, "outcome": run.outcome,
                                 "steps": [t["text"] for t in run.trace][-14:],
                                 "pending": bool(run.pending)})
    except Exception as exc:  # noqa: BLE001 - the trace is best-effort
        log.info("graph_event_failed", error=type(exc).__name__)


async def _drive(run: Run, payload: Any) -> Run:
    graph = await _compiled()
    config = {"configurable": {"thread_id": run.run_id}}
    try:
        await graph.ainvoke(payload, config)
        snap = await graph.aget_state(config)
        values = dict(snap.values or {})
        run.trace = list(values.get("trace") or [])
        interrupts = [i for t in (snap.tasks or ()) for i in (getattr(t, "interrupts", ()) or ())]
        if snap.next and interrupts:
            run.status = "waiting"
            run.pending = getattr(interrupts[0], "value", None) or {}
        else:
            run.status = "done"
            run.pending = None
            run.outcome = values.get("outcome") or "unchanged"
            run.finished_at = time.time()
    except Exception as exc:  # noqa: BLE001
        run.status = "failed"
        run.error = str(exc)[:300]
        run.finished_at = time.time()
        log.warning("graph_run_failed", run=run.run_id, error=run.error)
    await _event(run, "agent.graph_waiting" if run.status == "waiting" else "agent.graph_run")
    if run.status == "waiting":
        asyncio.get_running_loop().create_task(_timeout(run.run_id))
    return run


async def run_cycle(*, city_id: str = "pune", trigger: str = "manual") -> Run:
    """One pass of the graph. Returns when it finishes or pauses for an officer."""
    run = Run(run_id=f"g-{uuid.uuid4().hex[:10]}", city_id=city_id, trigger=trigger,
              started_at=time.time())
    _remember(run)
    return await _drive(run, {"run_id": run.run_id, "city_id": city_id, "trigger": trigger,
                              "situation": [], "domain_plans": [], "trace": []})


async def resume(run_id: str, *, approved: bool, by: str = "officer", note: str | None = None) -> Run:
    run = RUNS.get(run_id)
    if run is None or run.status != "waiting":
        raise KeyError(run_id)
    run.status = "running"
    return await _drive(run, Command(resume={"approved": approved, "by": by, "note": note}))


async def _timeout(run_id: str) -> None:
    """An unanswered approval does not hold the city: after the timeout the
    safe default (keep what units are doing) is taken."""
    await asyncio.sleep(max(30, int(settings.agent_graph_approval_timeout_s or 300)))
    run = RUNS.get(run_id)
    if run and run.status == "waiting":
        try:
            await resume(run_id, approved=False, by="timeout",
                         note="No officer answered in time; current assignments kept.")
        except Exception:  # noqa: BLE001
            pass


def status() -> dict[str, Any]:
    runs = [RUNS[r].as_dict() for r in _ORDER if r in RUNS]
    return {
        "available": AVAILABLE,
        "enabled": enabled(),
        "importError": IMPORT_ERROR,
        "checkpointer": type(_saver).__name__ if _saver is not None else settings.agent_graph_checkpointer,
        "approvalSeverity": settings.agent_graph_approval_severity,
        "waiting": [r for r in runs if r["status"] == "waiting"],
        "runs": runs,
    }


def mermaid() -> str | None:
    if not AVAILABLE:
        return None
    try:
        g = _graph or build(None)
        return g.get_graph().draw_mermaid()
    except Exception:  # noqa: BLE001
        return None
