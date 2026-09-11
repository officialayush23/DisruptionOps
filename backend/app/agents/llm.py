"""Language model provider.

Gemini in development, Bedrock in production, and a deterministic fallback
whenever either is unavailable — quota exhausted, network gone, key missing.

The fallback is not a degraded imitation of the model. It is a set of rules
over the same structured inputs, so the system keeps giving correct answers
without a model at all. That property is what lets a demo run on venue wifi,
and it is also the honest answer to "what happens when the LLM is wrong or
absent?": the numbers come from the solver and the scorer, never from here.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Literal, Protocol

from app.core.config import settings
from app.core.logging import get_logger

log = get_logger(__name__)

Engine = Literal["gemini", "bedrock", "fallback"]

#: A single slow model call must not hold up a dispatch decision.
LLM_TIMEOUT_S = 8.0


@dataclass(slots=True)
class Completion:
    text: str
    engine: Engine
    #: Set when the primary provider failed and we degraded.
    degraded_reason: str | None = None


class Provider(Protocol):
    engine: Engine

    async def complete(self, system: str, prompt: str) -> str: ...


class GeminiProvider:
    engine: Engine = "gemini"

    def __init__(self, api_key: str, model: str) -> None:
        self._api_key = api_key
        self._model = model
        self._client = None

    def _ensure(self):
        if self._client is None:
            from google import genai  # imported lazily so the app boots without it

            self._client = genai.Client(api_key=self._api_key)
        return self._client

    async def complete(self, system: str, prompt: str) -> str:
        client = self._ensure()

        def _call() -> str:
            response = client.models.generate_content(
                model=self._model,
                contents=f"{system}\n\n{prompt}",
            )
            return (response.text or "").strip()

        return await asyncio.to_thread(_call)


class BedrockProvider:
    """Bedrock via a Bedrock API key.

    AWS issues two credential shapes for Bedrock. Classic IAM keys go through
    the usual boto3 chain; a Bedrock API key (the `ABSK...` form) is a bearer
    token that botocore reads from `AWS_BEARER_TOKEN_BEDROCK`. We export it
    here so either shape works without the caller caring which they hold.
    """

    engine: Engine = "bedrock"

    def __init__(self, model_id: str, region: str, api_key: str = "") -> None:
        self._model_id = model_id
        self._region = region
        self._api_key = api_key
        self._client = None

    def _ensure(self):
        if self._client is None:
            import os

            import boto3

            if self._api_key and not os.environ.get("AWS_BEARER_TOKEN_BEDROCK"):
                os.environ["AWS_BEARER_TOKEN_BEDROCK"] = self._api_key

            self._client = boto3.client("bedrock-runtime", region_name=self._region)
        return self._client

    async def complete(self, system: str, prompt: str) -> str:
        client = self._ensure()

        def _call() -> str:
            response = client.converse(
                modelId=self._model_id,
                system=[{"text": system}],
                messages=[{"role": "user", "content": [{"text": prompt}]}],
                inferenceConfig={"maxTokens": 700, "temperature": 0.2},
            )
            blocks = response["output"]["message"]["content"]
            return "".join(b.get("text", "") for b in blocks).strip()

        return await asyncio.to_thread(_call)


def _build_provider() -> Provider | None:
    if settings.llm_provider == "gemini" and settings.gemini_api_key:
        return GeminiProvider(settings.gemini_api_key, settings.gemini_model)
    if settings.llm_provider == "bedrock" and settings.bedrock_model_id:
        return BedrockProvider(
            settings.bedrock_model_id,
            settings.aws_region,
            settings.aws_api_key_bedrock_for_xai,
        )
    return None


_provider: Provider | None = None
_provider_built = False
#: Once the provider fails this many times in a row we stop trying for a while,
#: so an exhausted quota does not add eight seconds to every request.
_consecutive_failures = 0
_FAILURE_THRESHOLD = 3


def current_engine() -> Engine:
    if _consecutive_failures >= _FAILURE_THRESHOLD:
        return "fallback"
    provider = _get_provider()
    return provider.engine if provider else "fallback"


def engine_note() -> str:
    if _consecutive_failures >= _FAILURE_THRESHOLD:
        return "Provider unavailable; deterministic rules in use."
    provider = _get_provider()
    if provider is None:
        return "No model configured; deterministic rules in use."
    if provider.engine == "gemini":
        return f"{settings.gemini_model} responding"
    return f"{settings.bedrock_model_id} responding"


def _get_provider() -> Provider | None:
    global _provider, _provider_built
    if not _provider_built:
        _provider = _build_provider()
        _provider_built = True
        log.info(
            "llm_provider",
            configured=settings.llm_provider,
            active=_provider.engine if _provider else "fallback",
        )
    return _provider


async def complete(
    system: str,
    prompt: str,
    *,
    fallback: str,
) -> Completion:
    """Ask the model, and hand back `fallback` if it cannot answer.

    Callers always supply a usable fallback string; there is no code path where
    a missing model produces a missing answer.
    """
    global _consecutive_failures

    if _consecutive_failures >= _FAILURE_THRESHOLD:
        return Completion(fallback, "fallback", "provider circuit open")

    provider = _get_provider()
    if provider is None:
        return Completion(fallback, "fallback", "no provider configured")

    try:
        text = await asyncio.wait_for(
            provider.complete(system, prompt), timeout=LLM_TIMEOUT_S
        )
        if not text:
            raise ValueError("empty completion")
        _consecutive_failures = 0
        return Completion(text, provider.engine)
    except Exception as exc:  # noqa: BLE001 - degrade, never fail
        _consecutive_failures += 1
        reason = f"{type(exc).__name__}: {str(exc)[:120]}"
        log.warning(
            "llm_unavailable",
            engine=provider.engine,
            failures=_consecutive_failures,
            error=reason,
        )
        return Completion(fallback, "fallback", reason)


def reset_circuit() -> None:
    """Called by the health endpoint so a recovered quota is picked up."""
    global _consecutive_failures
    _consecutive_failures = 0
