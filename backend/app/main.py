"""Indradhanu API.

Application wiring only: configuration, lifespan, middleware, routers. Every
piece of behaviour lives in its own module so this file stays readable.
"""

from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import ORJSONResponse

from app.api.v1.router import api_router
from app.core.config import settings
from app.core.errors import register_error_handlers
from app.core.logging import configure_logging, get_logger
from app.core.middleware import RequestContextMiddleware
from app import taxonomy
from app.db import session as db
from app.demo import runner as demo_runner

configure_logging(settings.log_level, json_logs=settings.is_production)
log = get_logger(__name__)


@asynccontextmanager
async def lifespan(_: FastAPI):
    await db.connect()
    # Which hazards, categories, resource kinds and capabilities exist is data.
    # Read it once here so nothing downstream has to ask the database what a
    # boat can do in the middle of a dispatch decision.
    await taxonomy.load()
    log.info(
        "startup",
        env=settings.indradhanu_env,
        llm_provider=settings.llm_provider,
        hazards=len(taxonomy.cache.hazards),
        resource_kinds=len(taxonomy.cache.resource_kinds),
    )
    try:
        yield
    finally:
        # Stop the demo loop before the pool closes. Otherwise a reload leaves a
        # task writing into a disconnected pool and the log fills with noise
        # that looks like a real failure.
        await demo_runner.stop()
        await db.disconnect()
        log.info("shutdown")


app = FastAPI(
    title="Indradhanu API",
    description=(
        "Hazard-agnostic climate disaster early warning and response. "
        "Forecast to ward-level decision to household instruction."
    ),
    version="0.1.0",
    default_response_class=ORJSONResponse,
    docs_url=None if settings.is_production else "/docs",
    redoc_url=None,
    openapi_url=None if settings.is_production else "/openapi.json",
    lifespan=lifespan,
)

app.add_middleware(RequestContextMiddleware)
app.add_middleware(GZipMiddleware, minimum_size=1024)
# A CORS misconfiguration is the one failure this service cannot see: the API
# answers 200, the browser discards the response, and the logs show a healthy
# deployment while the frontend shows nothing. Say out loud, once, which origins
# this process will actually accept, so the answer is in the startup log rather
# than in a dashboard someone has to remember to open.
log.info(
    "cors",
    origins=settings.cors_origin_list,
    origin_regex=settings.cors_origin_regex or None,
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_origin_regex=settings.cors_origin_regex or None,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PATCH", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "X-Request-ID"],
    expose_headers=["X-Request-ID"],
)

register_error_handlers(app)
app.include_router(api_router, prefix="/api/v1")


@app.get("/health/live", tags=["health"], include_in_schema=False)
async def live() -> dict[str, str]:
    """Liveness: the process is up. Deliberately does not touch the database."""
    return {"status": "ok"}


@app.get("/health", tags=["health"])
async def health() -> dict[str, object]:
    """Readiness: the process is up *and* its dependencies answer."""
    database = await db.healthcheck()
    return {
        "status": "ok" if database else "degraded",
        "env": settings.indradhanu_env,
        "database": database,
        "llm_provider": settings.llm_provider,
    }
