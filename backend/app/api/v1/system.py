"""System status: what is live, what is cached, and which model is answering."""

from __future__ import annotations

from datetime import UTC, datetime

from fastapi import APIRouter

from app.agents import llm
from app.db.repositories import queries as q
from app.hazards import registry
from app.schemas.domain import FeedStatus, HazardType, LLMStatus, SystemStatus

router = APIRouter(tags=["system"])


@router.get("/status", response_model=SystemStatus)
async def status() -> SystemStatus:
    run = await q.latest_run(HazardType.FLOOD)
    engine = llm.current_engine()

    feeds: list[FeedStatus] = []
    for adapter in registry.all_adapters():
        for source in adapter.sources:
            feeds.append(
                FeedStatus(
                    id=f"{adapter.hazard.value}:{abs(hash(source)) % 10_000}",
                    label=source,
                    # A run that fell back to cache is reported as cached, not live.
                    state="live" if (run and run.get("mode") == "live") else "cached",
                    last_updated=run["started_at"] if run else None,
                    detail=f"{adapter.display_name} adapter ({adapter.maturity.value})",
                )
            )

    return SystemStatus(
        mode="live" if engine != "fallback" and run and run.get("mode") == "live" else "fallback",
        llm=LLMStatus(engine=engine, note=llm.engine_note()),
        feeds=feeds,
        simulated_time=run.get("started_at") if run and run.get("replay_of") else None,
        scenario_id=f"replay-{run['replay_of']}" if run and run.get("replay_of") else None,
    )
