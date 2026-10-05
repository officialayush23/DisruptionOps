"""Drone frame localization (map-patch-finder) in the command centre.

    POST /drone/localized   the finder's webhook: one result (gateway key)
    POST /drone/localize    console upload, forwarded to the finder (staff)
    GET  /drone/recent      the latest results, newest first (staff)
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, File, Form, Header, HTTPException, UploadFile
from pydantic import BaseModel, Field

from app.api.v1.mesh import _gateway
from app.core.security import StaffPrincipal
from app.drone import service

router = APIRouter(tags=["drone"])


class LocalizedIn(BaseModel):
    result: dict[str, Any]
    source: str = Field(default="finder", max_length=40)
    drone: str | None = Field(default=None, max_length=40)
    thumb: str | None = None
    city_id: str = "pune"


@router.post("/drone/localized")
async def drone_localized(body: LocalizedIn,
                          x_mesh_gateway_key: str | None = Header(default=None)) -> dict:
    _gateway(x_mesh_gateway_key)
    entry = await service.record(body.result, source=body.source, drone=body.drone,
                                 thumb=body.thumb, city_id=body.city_id)
    return {"recorded": entry["id"], "accepted": entry["accepted"]}


@router.post("/drone/localize")
async def drone_localize(_: StaffPrincipal, query: UploadFile = File(...),
                         drone: str | None = Form(default=None)) -> dict:
    data = await query.read()
    if not data:
        raise HTTPException(status_code=400, detail="Empty image.")
    if len(data) > 15 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Image over 15 MB.")
    out = await service.localize(data, query.filename or "frame.jpg", query.content_type or "image/jpeg",
                                 drone=drone)
    if not out["ok"]:
        raise HTTPException(status_code=503 if out.get("status") == 503 else 502,
                            detail=f"Localizer: {out['error']}")
    return out["entry"]


@router.get("/drone/recent")
async def drone_recent(_: StaffPrincipal, limit: int = 20) -> dict:
    return {"items": service.recent(max(1, min(limit, 40))), "finder": service.FINDER_URL}
