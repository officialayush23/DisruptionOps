"""Reference geography. Public: a resident reads the map without an account."""

from __future__ import annotations

from fastapi import APIRouter

from app.db.repositories import queries as q
from app.schemas.domain import Lifeline, Shelter, Ward

router = APIRouter(tags=["geography"])


@router.get("/wards", response_model=list[Ward])
async def get_wards() -> list[Ward]:
    return await q.list_wards()


@router.get("/lifelines", response_model=list[Lifeline])
async def get_lifelines() -> list[Lifeline]:
    return await q.list_lifelines()


@router.get("/shelters", response_model=list[Shelter])
async def get_shelters() -> list[Shelter]:
    return await q.list_shelters()
