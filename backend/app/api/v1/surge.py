"""Surge operations: the escalation ladder, mutual aid, surge shelters, the scarcity drill."""
from __future__ import annotations

from fastapi import APIRouter
from pydantic import Field

from app.core.errors import BadRequest
from app.core.security import CommissionerPrincipal, StaffPrincipal
from app.schemas.domain import Camel
from app.surge import service

router = APIRouter(prefix="/surge", tags=["surge"])


def _region(r: str) -> str:
    if r not in ("pune", "ncr"):
        raise BadRequest("region must be pune or ncr")
    return r


@router.get("")
async def overview(_: StaffPrincipal, region: str = "pune") -> dict:
    """Ladder level and why, live load (fleet, shelters, unmet needs by capability,
    low stock), aid requests and their outcomes, surge shelters, the surge log."""
    return await service.overview(_region(region))


@router.post("/evaluate")
async def evaluate(_: StaffPrincipal, region: str = "pune") -> dict:
    return await service.evaluate(_region(region), actor="officer")


class DrillIn(Camel):
    region: str = "pune"
    fleet_keep: float = Field(default=0.35, ge=0.05, le=1.0)
    shelter_scale: float = Field(default=0.3, ge=0.05, le=1.0)


@router.post("/drill/start")
async def drill_start(body: DrillIn, _: StaffPrincipal) -> dict:
    """Scarcity drill: hold most of the fleet in reserve and shrink shelters, so the
    ladder climbs: strained -> mutual aid -> surge shelters -> declaration."""
    return await service.scarcity_drill(_region(body.region), body.fleet_keep, body.shelter_scale)


@router.post("/drill/end")
async def drill_end(_: StaffPrincipal, region: str = "pune") -> dict:
    return await service.end_drill(_region(region))


@router.post("/aid")
async def request_aid(_: StaffPrincipal, region: str = "pune") -> dict:
    """Ask for mutual aid now for whatever is unmet (level-2 offers)."""
    m = await service.metrics(_region(region))
    return {"requested": await service.request_aid(region, m, min_level=2)}


@router.post("/shelters/open")
async def open_shelters(_: StaffPrincipal, region: str = "pune", count: int = 2) -> dict:
    m = await service.metrics(_region(region))
    return {"opened": await service.open_surge_shelters(region, m, limit=max(1, min(count, 8)))}


@router.post("/declare")
async def declare(principal: CommissionerPrincipal, region: str = "pune") -> dict:
    """An officer approves the declaration: level 4, NDRF and Army offers requested."""
    region = _region(region)
    m = await service.metrics(region)
    from app.db import session as db
    await db.execute("update surge_state set level = 4, since = now(), updated_at = now() where region = $1", region)
    service._LEVEL[region] = 4
    from app.world import clock as clocks, events as ev
    await ev.append(clock=clocks.WALL, kind="surge.level_changed", actor=f"officer:{principal.full_name or 'commissioner'}",
                    subject_type="region", subject_id=region,
                    payload={"from": "approved", "to": "declaration", "level": 4,
                             "reason": "declaration approved by an officer; NDRF and Army requested"})
    made = await service.request_aid(region, m, min_level=4, approved_by=principal.full_name or "commissioner")
    return {"level": 4, "requested": made}
