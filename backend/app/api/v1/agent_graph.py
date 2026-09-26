"""The LangGraph agent graph: its runs, the approvals it is waiting on, and a
way to answer them.

    GET  /agent-graph                  status, recent runs and their step trace
    GET  /agent-graph/diagram          the compiled graph as Mermaid
    POST /agent-graph/run              run one cycle now
    POST /agent-graph/runs/{id}/resume approve or reject a paused plan
"""

from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel, Field

from app.agents import graph
from app.core.errors import NotFound
from app.core.security import StaffPrincipal

router = APIRouter(tags=["agent-graph"])


class RunIn(BaseModel):
    trigger: str = Field(default="manual run from the console", max_length=240)
    city_id: str = "pune"


class ResumeIn(BaseModel):
    approved: bool
    note: str | None = Field(default=None, max_length=300)


@router.get("/agent-graph")
async def agent_graph_status(_: StaffPrincipal) -> dict:
    return graph.status()


@router.get("/agent-graph/diagram")
async def agent_graph_diagram(_: StaffPrincipal) -> dict:
    return {"mermaid": graph.mermaid(), "available": graph.AVAILABLE}


@router.post("/agent-graph/run")
async def agent_graph_run(body: RunIn, _: StaffPrincipal) -> dict:
    if not graph.enabled():
        return {"ok": False, "reason": graph.IMPORT_ERROR or "AGENT_GRAPH_ENABLED is off"}
    run = await graph.run_cycle(city_id=body.city_id, trigger=body.trigger)
    return {"ok": True, "run": run.as_dict()}


@router.post("/agent-graph/runs/{run_id}/resume")
async def agent_graph_resume(run_id: str, body: ResumeIn, who: StaffPrincipal) -> dict:
    name = who.full_name or f"{getattr(who.role, 'value', who.role)} {who.user_id or ''}".strip() or "officer"
    try:
        run = await graph.resume(run_id, approved=body.approved, by=str(name), note=body.note)
    except KeyError:
        raise NotFound("No run with that id is waiting for an approval.") from None
    return {"ok": True, "run": run.as_dict()}
