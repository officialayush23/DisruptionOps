"""Request middleware: correlation id, access log, timing, and the last-resort
error boundary.

The error boundary is here rather than only as an `@app.exception_handler`
because of where Starlette puts things. An app-level `Exception` handler runs in
`ServerErrorMiddleware`, which sits OUTSIDE the user middleware stack, so its
500 response never passes back through `CORSMiddleware` and carries no
`Access-Control-Allow-Origin` header. The browser then reports a CORS failure
and hides the actual error, which sends you looking at your CORS configuration
for a bug that is in a query.

Catching it here, in the innermost middleware, means the response still travels
out through CORS and the frontend sees the real status and message.
"""

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
        except Exception as exc:  # noqa: BLE001 - deliberate boundary
            elapsed = (time.perf_counter() - started) * 1000
            log.exception(
                "request_failed",
                method=request.method,
                path=request.url.path,
                duration_ms=round(elapsed, 1),
            )
            from app.core.errors import problem_response

            response = problem_response(exc)
            response.headers["X-Request-ID"] = rid
            # No reset here: the `finally` below is the single reset. Resetting
            # a context token twice raises `RuntimeError: Token has already been
            # used once`, and that exception escapes the boundary this class
            # exists to be -- so the 500 never travels back out through
            # CORSMiddleware and the browser blames CORS for a bug in a query.
            return response
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
