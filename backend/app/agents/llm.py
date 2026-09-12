"""Language model providers, as an ordered chain.

Gemini first, Bedrock second, and a deterministic fallback whenever neither can
answer — quota exhausted, network gone, key missing.

The chain matters because the most likely failure by far is not an outage, it is
a free-tier quota running out halfway through a demo. When that happens Gemini
returns 429 for hours, so a single-provider design degrades to deterministic
rules for the rest of the session even though a perfectly good second provider
is configured and idle. Each provider therefore carries its own circuit breaker,
and a provider that is cooling down is skipped rather than waited on.

Circuits reopen on a timer rather than staying latched, so a quota that resets at
midnight is picked up on its own without anybody calling the health endpoint.

The fallback is not a degraded imitation of the model. It is a set of rules
over the same structured inputs, so the system keeps giving correct answers
without a model at all. That property is what lets a demo run on venue wifi,
and it is also the honest answer to "what happens when the LLM is wrong or
absent?": the numbers come from the solver and the scorer, never from here.
"""

from __future__ import annotations

import asyncio
import time
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


#: Errors that mean "this provider is out for a while", as opposed to "that one
#: request went wrong". Matched on the text because the three SDKs involved raise
#: entirely different exception types for the same condition, and importing all
#: of them to catch them properly would defeat the lazy imports that let this
#: module load with neither installed.
_EXHAUSTED = (
    "429", "quota", "resource_exhausted", "resourceexhausted",
    "throttling", "throttled", "too many requests", "rate limit",
    "insufficient_quota", "serviceunavailable", "503",
)


def _is_exhausted(exc: Exception) -> bool:
    return any(m in f"{type(exc).__name__} {exc}".lower() for m in _EXHAUSTED)


def _build_chain() -> list[Provider]:
    """Every provider that is configured, best first.

    `llm_provider` chooses the head of the chain rather than the only member of
    it. Anything else that has credentials follows, because a configured
    provider sitting idle while the system degrades to rules is the worst of
    both worlds — it is the outcome that made this a chain.
    """
    built: dict[Engine, Provider] = {}
    if settings.gemini_api_key:
        built["gemini"] = GeminiProvider(settings.gemini_api_key, settings.gemini_model)
    if settings.bedrock_model_id:
        built["bedrock"] = BedrockProvider(
            settings.bedrock_model_id,
            settings.aws_region,
            settings.aws_api_key_bedrock_for_xai,
        )

    order: list[Engine] = ["gemini", "bedrock"]
    if settings.llm_provider in order:
        order.remove(settings.llm_provider)
        order.insert(0, settings.llm_provider)
    return [built[e] for e in order if e in built]


_chain: list[Provider] | None = None

#: Consecutive failures per provider, and the monotonic time each one may be
#: tried again. Per provider, not global: Gemini being out of quota says nothing
#: whatever about whether Bedrock can answer.
_failures: dict[Engine, int] = {}
_cooldown_until: dict[Engine, float] = {}

_FAILURE_THRESHOLD = 3
#: A provider that merely erred is rested briefly. One that reported an
#: exhausted quota is rested for long enough that we are not hammering a limit
#: that resets on the hour, but not so long that a demo cannot recover.
_COOLDOWN_S = 60.0
_EXHAUSTED_COOLDOWN_S = 900.0


def _available(provider: Provider) -> bool:
    """Is this provider worth trying right now?

    Half-open by design: once the cooldown passes the provider is tried again on
    the next request, and one success clears its failure count. There is no
    separate probe and nothing to call by hand.
    """
    until = _cooldown_until.get(provider.engine, 0.0)
    return time.monotonic() >= until


def _get_chain() -> list[Provider]:
    global _chain
    if _chain is None:
        _chain = _build_chain()
        log.info(
            "llm_chain",
            preferred=settings.llm_provider,
            chain=[p.engine for p in _chain] or ["fallback"],
        )
    return _chain


def current_engine() -> Engine:
    """Which engine would answer right now."""
    for provider in _get_chain():
        if _available(provider):
            return provider.engine
    return "fallback"


def engine_note() -> str:
    chain = _get_chain()
    if not chain:
        return "No model configured; deterministic rules in use."

    live = [p for p in chain if _available(p)]
    if not live:
        return "Every provider is cooling down; deterministic rules in use."

    name = {
        "gemini": settings.gemini_model,
        "bedrock": settings.bedrock_model_id,
    }.get(live[0].engine, live[0].engine)

    resting = [p.engine for p in chain if not _available(p)]
    if resting:
        return f"{name} responding — {', '.join(resting)} cooling down"
    spare = [p.engine for p in chain[1:]]
    return f"{name} responding" + (f", {', '.join(spare)} standing by" if spare else "")


async def complete(
    system: str,
    prompt: str,
    *,
    fallback: str,
) -> Completion:
    """Ask each configured provider in turn; hand back `fallback` if none answer.

    Callers always supply a usable fallback string; there is no code path where
    a missing model produces a missing answer, and none where a model produces
    an operational number — the figures come from the solver and the scorer.
    """
    chain = _get_chain()
    if not chain:
        return Completion(fallback, "fallback", "no provider configured")

    tried: list[str] = []
    first_reason: str | None = None

    for provider in chain:
        engine = provider.engine
        if not _available(provider):
            tried.append(f"{engine}:cooling")
            continue

        try:
            text = await asyncio.wait_for(
                provider.complete(system, prompt), timeout=LLM_TIMEOUT_S
            )
            if not text:
                raise ValueError("empty completion")
        except Exception as exc:  # noqa: BLE001 - degrade, never fail
            exhausted = _is_exhausted(exc)
            n = _failures.get(engine, 0) + 1
            _failures[engine] = n
            reason = f"{type(exc).__name__}: {str(exc)[:120]}"
            first_reason = first_reason or f"{engine} {reason}"
            tried.append(f"{engine}:{'exhausted' if exhausted else 'error'}")

            # An exhausted quota is not a flaky request and there is no point
            # spending two more attempts proving it. Rest this provider at once
            # and move down the chain.
            if exhausted or n >= _FAILURE_THRESHOLD:
                rest = _EXHAUSTED_COOLDOWN_S if exhausted else _COOLDOWN_S
                _cooldown_until[engine] = time.monotonic() + rest
                log.warning("llm_provider_resting", engine=engine,
                            seconds=rest, failures=n, error=reason)
            else:
                log.warning("llm_unavailable", engine=engine,
                            failures=n, error=reason)
            continue

        # Success. Clear this provider's history, and say plainly when the
        # answer came from somewhere other than the preferred provider — a
        # silent failover is how you discover in March that the primary has
        # been dead since January.
        _failures[engine] = 0
        _cooldown_until.pop(engine, None)
        degraded = None
        if engine != chain[0].engine or tried:
            degraded = f"failed over to {engine} after {', '.join(tried)}"
            log.info("llm_failover", engine=engine, after=tried)
        return Completion(text, engine, degraded)

    return Completion(
        fallback, "fallback",
        first_reason or f"all providers cooling down ({', '.join(tried)})",
    )


def reset_circuit() -> None:
    """Forget every cooldown. Called by the health endpoint, and safe to call
    at any time — the timers would expire on their own regardless."""
    _failures.clear()
    _cooldown_until.clear()


def provider_status() -> list[dict]:
    """What each provider is doing, for the health endpoint and the console.

    Worth exposing rather than keeping internal: "which model answered, and did
    anything fail over" is the first question when an explanation reads oddly.
    """
    now = time.monotonic()
    return [
        {
            "engine": p.engine,
            "preferred": i == 0,
            "available": _available(p),
            "consecutiveFailures": _failures.get(p.engine, 0),
            "restingForSeconds": max(0, round(_cooldown_until.get(p.engine, 0.0) - now)),
        }
        for i, p in enumerate(_get_chain())
    ]
