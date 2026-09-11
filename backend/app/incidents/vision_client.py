"""Calling a vision model that lives somewhere else.

The model is not our problem. This is the whole of our side of the boundary:
post an image and the prompt, get back JSON, hand it to `vision.parse_response`
which validates it and to `vision.assess` which scores it against what the
person actually reported.

Three placements, one code path:

  * **hosted** — `VLM_URL` points at a machine running the model. That machine
    can be anything; it only has to answer the contract in `vision.PROMPT`.
  * **device** — the phone ran it and posts the JSON to `/citizen/vision`
    directly. This module is not involved, and the validation is identical,
    which is the property that keeps placement an engineering decision.
  * **none** — no URL configured. Reports carry photos and nobody looks at them,
    which is exactly where this was before and is a perfectly fine state to
    ship in.

Never raises. A vision service that is down must cost a report its corroboration
bonus and nothing else.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

import httpx

from app.core.config import settings
from app.core.logging import get_logger
from app.incidents import vision

log = get_logger(__name__)


@dataclass(slots=True)
class VisionCall:
    ok: bool
    evidence: vision.PhotoEvidence | None
    error: str = ""
    latency_ms: int = 0


def configured() -> bool:
    return bool(settings.vlm_url)


def _extract_json(text: str) -> Any:
    """Small models wrap JSON in prose and fences however you ask them not to.

    Pulling the first balanced object out is not elegant, and the alternative is
    discarding an otherwise good answer because the model said "Here is the
    JSON:" first.
    """
    text = text.strip()
    if text.startswith("```"):
        text = text.split("```")[1] if "```" in text[3:] else text[3:]
        text = text.removeprefix("json").strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    start = text.find("{")
    if start < 0:
        return None
    depth = 0
    for i, ch in enumerate(text[start:], start):
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                try:
                    return json.loads(text[start : i + 1])
                except json.JSONDecodeError:
                    return None
    return None


async def analyse(
    *,
    image_url: str | None = None,
    image_base64: str | None = None,
    category: str = "flooded_road",
) -> VisionCall:
    """Ask the configured vision service about one photo.

    Sends whichever of URL or base64 the caller has. A hosted model that can
    fetch a URL should be given the URL: shipping a megabyte of base64 through
    our own process to a GPU box is a waste of both ends.
    """
    if not settings.vlm_url:
        return VisionCall(ok=False, evidence=None, error="No VLM_URL configured.")
    if not image_url and not image_base64:
        return VisionCall(ok=False, evidence=None, error="No image supplied.")

    headers = {"Content-Type": "application/json"}
    if settings.vlm_api_key:
        headers["Authorization"] = f"Bearer {settings.vlm_api_key}"

    body: dict[str, Any] = {
        "prompt": vision.PROMPT,
        "model": settings.vlm_model or None,
        # Asking for JSON twice: in the prompt, and as a flag the server may
        # honour with constrained decoding. A model that can be forced to emit
        # valid JSON should be.
        "response_format": "json",
        "max_tokens": 512,
        "temperature": 0.1,
    }
    if image_url:
        body["image_url"] = image_url
    if image_base64:
        body["image_base64"] = image_base64

    try:
        async with httpx.AsyncClient(timeout=settings.vlm_timeout_seconds) as client:
            import time

            started = time.perf_counter()
            response = await client.post(settings.vlm_url, headers=headers, json=body)
            response.raise_for_status()
            payload: Any = response.json()
            latency = int((time.perf_counter() - started) * 1000)
    except Exception as exc:  # noqa: BLE001 - a model outage is not a failure
        log.warning("vlm_unavailable", error=str(exc)[:200])
        return VisionCall(ok=False, evidence=None, error=type(exc).__name__)

    # Accept either the analysis directly, or a wrapper with the model's text in
    # it, because every serving stack shapes this differently and none of them
    # are wrong.
    analysis: Any = None
    if isinstance(payload, dict):
        for key in ("analysis", "result", "json", "data"):
            if isinstance(payload.get(key), dict):
                analysis = payload[key]
                break
        if analysis is None:
            for key in ("text", "output", "content", "generated_text", "response"):
                if isinstance(payload.get(key), str):
                    analysis = _extract_json(payload[key])
                    break
        if analysis is None and "shows_hazard" in payload:
            analysis = payload
    elif isinstance(payload, str):
        analysis = _extract_json(payload)

    evidence = vision.parse_response(
        analysis, model=settings.vlm_model or "hosted", ran_on="hosted"
    )
    if evidence is None:
        return VisionCall(
            ok=False, evidence=None,
            error="The service answered, but not in the contract's shape.",
            latency_ms=latency,
        )
    return VisionCall(
        ok=True,
        evidence=vision.assess(evidence, category=category),
        latency_ms=latency,
    )
