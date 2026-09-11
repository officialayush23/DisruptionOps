"""Request middleware: correlation id, access log, timing."""

from __future__ import annotations

import time
import uuid

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

from app.core.logging import get_logger, request_id_ctx

log = get_logger("http")


class RequestContextMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next) -> Response:
        rid = request.headers.get("X-Request-ID") or uuid.uuid4().hex[:16]
        token = request_id_ctx.set(rid)
        started = time.perf_counter()
        try:
            response = await call_next(request)
        except Exception:
            elapsed = (time.perf_counter() - started) * 1000
            log.exception(
                "request_failed",
                method=request.method,
                path=request.url.path,
                duration_ms=round(elapsed, 1),
            )
            raise
        finally:
            request_id_ctx.reset(token)

        elapsed = (time.perf_counter() - started) * 1000
        response.headers["X-Request-ID"] = rid
        # Health checks would otherwise dominate the log.
        if request.url.path not in ("/health", "/health/live", "/metrics"):
            log.info(
                "request",
                method=request.method,
                path=request.url.path,
                status=response.status_code,
                duration_ms=round(elapsed, 1),
            )
        return response
