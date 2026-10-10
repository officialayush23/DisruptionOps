"""Live road risk from the passability model (PCMC district)."""
from __future__ import annotations

from fastapi import APIRouter

from app.core.security import StaffPrincipal
from app.nav import live

router = APIRouter(prefix="/nav", tags=["nav"])


@router.get("/risk")
async def risk(_: StaffPrincipal, min_p: float = 0.3, refresh: bool = False) -> dict:
    """Roads likely blocked for an ambulance within 30 min: GeoJSON lines with p,
    the model's own spread (sd), why (model / binding closure / crew), and whether
    the router avoids it (p >= 0.6)."""
    r = await live.current_risk(force=refresh)
    if r is None:
        return {"available": False, "reason": "model or data not available; routing uses reported blocks only"}
    gj = live.as_geojson(r, min_p)
    return {"available": True, "model": r.model, "computedAt": r.at, "notes": r.notes,
            "scored": int(len(r.p)), "avoided": int((r.p >= live.AVOID_P).sum()),
            "atRisk": len(gj["features"]), "segments": gj}
