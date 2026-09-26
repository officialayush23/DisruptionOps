"""Guardrails for every place a model or an agent touches operations.

Three layers, applied in this order and never skipped:

  1. **Input**: text from the public goes to a model only after it is
     length-capped, stripped of control characters, checked for prompt
     injection, and has personal identifiers redacted (phone numbers, emails,
     Aadhaar/PAN-shaped numbers). The model is told the text is data; this
     makes sure that data carries no instructions and no personal information
     it does not need. (Production swaps the regexes for Llama Prompt Guard 2
     and Presidio behind the same functions.)

  2. **Output**: a model answer is parsed against a strict schema. Anything that
     is not valid JSON of the right shape, or is out of range, is rejected and
     the deterministic answer is used instead. A model never writes a number
     into the database that has not passed through here.

  3. **Action**: before a plan is written, invariant checks: no unit twice, no
     more than `MAX_RETASK_PER_CYCLE` units moved in one cycle without an
     officer, no drop in coverage without an officer. These are hard limits on
     what the automated loop may do on its own, whatever produced the plan.
"""

from __future__ import annotations

import json
import re
import unicodedata
from dataclasses import dataclass, field
from typing import Any, TypeVar

from pydantic import BaseModel, ValidationError

MAX_INPUT_CHARS = 600
MAX_RETASK_PER_CYCLE = 8
#: A plan may lose this much coverage before an officer has to see it.
COVERAGE_DROP_TOLERANCE = 0.05

INJECTION = re.compile(
    r"(ignore\s+(all\s+)?(the\s+)?(previous|prior|above)|disregard\s+(the\s+)?(above|previous)|"
    r"system\s*prompt|you\s+are\s+now|act\s+as\s+|pretend\s+to\s+be|new\s+instructions?|"
    r"developer\s+mode|jailbreak|reveal\s+(your|the)\s+(prompt|instructions)|"
    r"send\s+(all|every)\s+(ambulance|unit|boat|resource|vehicle)s?|"
    r"(set|mark)\s+(the\s+)?severity\s+(to\s+)?\d|"
    r"</?(system|assistant|user|tool)>|\[\s*(system|inst)\s*\])",
    re.I,
)

_PII = (
    ("[email]", re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")),
    ("[aadhaar]", re.compile(r"\b\d{4}\s?\d{4}\s?\d{4}\b")),
    ("[pan]", re.compile(r"\b[A-Z]{5}\d{4}[A-Z]\b")),
    ("[phone]", re.compile(r"(?:\+?91[\s-]?)?\b[6-9]\d{4}[\s-]?\d{5}\b")),
    ("[phone]", re.compile(r"\+?\d[\d\s-]{9,14}\d")),
)


@dataclass(slots=True)
class CleanText:
    text: str
    injection: bool
    redacted: list[str] = field(default_factory=list)
    truncated: bool = False


def clean_input(text: str | None, *, limit: int = MAX_INPUT_CHARS) -> CleanText:
    """Everything a model will read from the public goes through this."""
    raw = unicodedata.normalize("NFKC", text or "")
    raw = "".join(ch for ch in raw if ch in "\n\t" or unicodedata.category(ch)[0] != "C")
    injection = bool(INJECTION.search(raw))
    redacted: list[str] = []
    for tag, rx in _PII:
        if rx.search(raw):
            redacted.append(tag.strip("[]"))
            raw = rx.sub(tag, raw)
    raw = " ".join(raw.split())
    truncated = len(raw) > limit
    return CleanText(text=raw[:limit], injection=injection,
                     redacted=sorted(set(redacted)), truncated=truncated)


def quote(text: str) -> str:
    """Wrap public text so a prompt shows it as data. Quotes inside are neutralised."""
    return "“" + text.replace("“", "'").replace("”", "'").replace('"', "'") + "”"


M = TypeVar("M", bound=BaseModel)


def parse_model_output(raw: str | None, schema: type[M]) -> M | None:
    """Strict output guardrail: the first JSON object in the answer, validated
    against `schema`, or None. Never raises."""
    if not raw:
        return None
    start, end = raw.find("{"), raw.rfind("}")
    if start < 0 or end <= start:
        return None
    try:
        data = json.loads(raw[start:end + 1])
        return schema.model_validate(data)
    except (ValueError, ValidationError):
        return None


@dataclass(slots=True)
class PlanCheck:
    ok: bool
    needs_officer: bool
    reasons: list[str] = field(default_factory=list)


def check_plan(proposal: dict[str, Any], *, current_coverage: float | None = None) -> PlanCheck:
    """Action guardrail over a solver proposal (a PlanDiff as a dict)."""
    reasons: list[str] = []
    ids = [c.get("resource_id") for k in ("assigned", "reassigned", "kept") for c in proposal.get(k, [])]
    if len(ids) != len(set(ids)):
        return PlanCheck(False, False, ["a unit appears twice in the plan"])
    try:
        coverage = float(proposal.get("coverage", 1.0))
    except (TypeError, ValueError):
        return PlanCheck(False, False, ["coverage is not a number"])
    if not 0.0 <= coverage <= 1.0:
        return PlanCheck(False, False, [f"coverage {coverage} out of range"])
    needs_officer = False
    moved = len(proposal.get("reassigned", [])) + len(proposal.get("released", []))
    if moved > MAX_RETASK_PER_CYCLE:
        needs_officer = True
        reasons.append(f"moves {moved} units in one cycle (limit {MAX_RETASK_PER_CYCLE} without an officer)")
    if current_coverage is not None and coverage < current_coverage - COVERAGE_DROP_TOLERANCE:
        needs_officer = True
        reasons.append(f"coverage would drop from {current_coverage:.0%} to {coverage:.0%}")
    return PlanCheck(True, needs_officer, reasons)
