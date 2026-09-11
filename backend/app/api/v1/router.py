"""API v1 surface."""

from __future__ import annotations

from fastapi import APIRouter

from app.api.v1 import (
    auth,
    config,
    citizen,
    copilot,
    demo,
    geography,
    operations,
    personas,
    replay,
    reports,
    risk,
    runs,
    system,
)
from app.hazards import registry

# Adapters register once, at import of the router, so `/hazards` is populated
# before the first request rather than on first use.
registry.load_adapters()

api_router = APIRouter()
api_router.include_router(system.router)
api_router.include_router(auth.router)
api_router.include_router(runs.router)
api_router.include_router(reports.router)
api_router.include_router(demo.router)
api_router.include_router(personas.router)
api_router.include_router(geography.router)
api_router.include_router(risk.router)
api_router.include_router(operations.router)
api_router.include_router(citizen.router)
api_router.include_router(config.router)
api_router.include_router(copilot.router)
api_router.include_router(replay.router)
