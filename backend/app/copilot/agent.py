"""The Command Agent: the Commissioner's way into everything else.

What it is for
--------------

A commissioner should not have to learn which of eleven screens holds the
number they want. They should be able to ask, in the words they already use:

    what is happening
    why is Kothrud above Aundh
    what happens if we send the Dewatering pump 3 to the Baner flooding
    give me mitigation options for the next three hours
    apply the second one

and get an answer that is a *rendered* answer — ranked tables, a comparison
with arrows, the evidence underneath — rather than a paragraph of prose that
has to be taken on trust.

How it stays honest
-------------------

The model does three jobs here and no others:

1. **Route.** Turn a sentence into an intent and some arguments. If it is
   unavailable, or it returns something malformed, a keyword router does the
   same job less gracefully and the feature keeps working.
2. **Name.** Resolve "the pump in Baner" to a resource id, against a list of
   real ids fetched first. It cannot invent one, because the resolver checks.
3. **Narrate.** Write the sentence above the table, from the numbers in the
   table.

Every number, every ranking, every consequence comes from `tools`, which comes
from the database and the solver. The blocks are built before the model is
asked for prose, and the prose is discarded if the model is absent — never the
blocks. So "the LLM hallucinated a resource" cannot happen: there is nothing in
the response the model was allowed to author except the English.

And the one tier that changes the world, `propose_action`, goes through the
policy gate like everything else. The Copilot may recommend requisitioning
NDRF; it may not requisition NDRF.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any

from app.agents import llm
from app.copilot import execute, strategies as strat, tools
from app.core.logging import get_logger
from app.db import session as db
from app import taxonomy

log = get_logger(__name__)

#: Intents the router may return. Anything else is treated as `situation`,
#: which is the question somebody asking a vague question usually meant.
INTENTS = (
    "situation", "rank", "explain", "incident", "resources", "facilities",
    "forecast", "decisions", "alerts", "reports", "timeline", "agencies",
    "policy", "simulate", "surge", "strategies", "apply", "help",
)

ROUTER_SYSTEM = """You route a question from a city disaster commissioner to one
handler. Reply with JSON only, no prose, no code fence:

{"intent": "<one of: %s>", "args": {...}}

Guidance:
- "what is happening", "status", "brief me"        -> situation
- "which wards/zones are worst", "priorities"      -> rank
- "why is X above Y", "why that priority"          -> explain, args {ward, against}
- "tell me about <an incident>"                    -> incident, args {incident}
- "what units/ambulances/boats do we have"         -> resources, args {capability}
- "hospitals", "shelters", "food", "water", "stock"-> facilities, args {kind}
- "what will happen", "forecast", "expected"       -> forecast
- "what is waiting for approval", "decisions"      -> decisions
- "what have we told the public"                   -> alerts
- "what came in", "reports"                        -> reports
- "what happened at ...", "timeline", "history"    -> timeline
- "who else can help", "agencies", "mutual aid"    -> agencies
- "who authorises X", "policy", "clause"           -> policy, args {action_key}
- "what if we move/send <unit> to <place>"         -> simulate, args {unit, target}
- "what if <ward> gets N more <need>"              -> surge, args {ward, capability, count}
- "options", "strategies", "what should we do"     -> strategies
- "apply/do/execute <strategy>"                    -> apply, args {strategy}

Put names in args exactly as the person wrote them. Do not invent ids.""" % (
    ", ".join(INTENTS)
)

NARRATOR_SYSTEM = """You are the duty analyst for a city disaster command centre,
speaking to the Commissioner.

Rules, in order of importance:
1. Every number you use must appear in the DATA below. Never estimate, round
   into a different number, or add a figure that is not there.
2. Two to four sentences. They are about to read the table underneath you, so
   say what it means, not what it contains.
3. Lead with the thing that needs a decision. If nothing does, say so plainly.
4. No greetings, no "I hope this helps", no offers to assist further.
5. If the data is thin or the evidence weak, say that rather than smoothing it.
"""


@dataclass(slots=True)
class Answer:
    text: str = ""
    blocks: list[dict] = field(default_factory=list)
    intent: str = "situation"
    tools_used: list[str] = field(default_factory=list)
    engine: str = "fallback"
    suggestions: list[str] = field(default_factory=list)
    note: str | None = None

    def as_dict(self) -> dict:
        return {
            "text": self.text, "blocks": self.blocks, "intent": self.intent,
            "toolsUsed": self.tools_used, "engine": self.engine,
            "suggestions": self.suggestions, "note": self.note,
        }


# ------------------------------------------------------------------ naming ---
@dataclass(slots=True)
class Names:
    """Real ids, so nothing the model says has to be believed."""

    wards: dict[str, str] = field(default_factory=dict)        # lower name -> id
    resources: dict[str, str] = field(default_factory=dict)    # lower label -> id
    incidents: dict[str, str] = field(default_factory=dict)    # lower title -> id
    capabilities: list[str] = field(default_factory=list)


async def _names(city_id: str) -> Names:
    wards = await db.fetch("select id, name from wards where city_id = $1", city_id)
    resources = await db.fetch(
        "select id, label from resources where city_id = $1", city_id
    )
    incidents = await db.fetch(
        "select id::text, title from incidents where city_id = $1 and status <> 'resolved'",
        city_id,
    )
    return Names(
        wards={r["name"].lower(): r["id"] for r in wards},
        resources={r["label"].lower(): r["id"] for r in resources},
        incidents={r["title"].lower(): r["id"] for r in incidents},
        capabilities=sorted(taxonomy.cache.capabilities),
    )


def _match(text: str | None, table: dict[str, str]) -> str | None:
    """Resolve a phrase to an id, longest name first.

    Substring matching both ways: the person may type less than the full name
    ("Kothrud" for "Kothrud Ward") or more ("the Baner flooding" for "Flooding
    on Baner Road"). Longest-first stops "Ward 1" from swallowing "Ward 12".
    """
    if not text:
        return None
    needle = text.strip().lower()
    if not needle:
        return None
    if needle in table:
        return table[needle]
    for name in sorted(table, key=len, reverse=True):
        if name and (name in needle or needle in name):
            return table[name]
    return None


# ------------------------------------------------------------------ router ---
async def _route(question: str, names: Names) -> tuple[str, dict]:
    """Model first, rules second. The rules are not a stub — they carry the
    feature on a venue wifi with no model reachable."""
    fallback_intent, fallback_args = _rule_route(question, names)

    completion = await llm.complete(
        ROUTER_SYSTEM,
        f"Question: {question}",
        fallback=json.dumps({"intent": fallback_intent, "args": fallback_args}),
    )
    try:
        raw = completion.text.strip()
        raw = re.sub(r"^```(?:json)?|```$", "", raw, flags=re.M).strip()
        parsed = json.loads(raw)
        intent = str(parsed.get("intent", "")).strip()
        args = parsed.get("args") or {}
        if intent in INTENTS and isinstance(args, dict):
            return intent, args
    except (ValueError, AttributeError):
        log.info("copilot_router_unparsable", text=completion.text[:120])
    return fallback_intent, fallback_args


_RULES: list[tuple[str, str]] = [
    (r"\bwhat if\b.*\b(more|another|extra|additional)\b", "surge"),
    (r"\bwhat if\b|\bsimulate\b|\bif we (move|send|pull|redirect)\b", "simulate"),
    (r"\bapply\b|\bexecute\b|\bdo strategy\b|\bgo with\b", "apply"),
    (r"\bstrateg|\boptions?\b|\bwhat should we do\b|\bmitigat|\brecommend", "strategies"),
    (r"\bwhy\b", "explain"),
    (r"\brank|\bworst\b|\bmost critical\b|\bpriorit|\bwhich (ward|zone|area)", "rank"),
    (r"\bforecast|\bexpect|\bpredict|\bnext (few |three |3 )?hours?\b", "forecast"),
    (r"\bapprov|\bdecision|\bgate\b|\bwaiting\b", "decisions"),
    (r"\balert|\badvisor|\bwarn|\btold the public\b", "alerts"),
    (r"\breport|\bcame in\b|\binbox\b|\bintake\b", "reports"),
    (r"\btimeline|\bhistory\b|\bwhat happened\b|\baudit\b", "timeline"),
    (r"\bagenc|\bmutual aid\b|\bndrf\b|\bwho else\b", "agencies"),
    (r"\bpolicy\b|\bclause\b|\bauthoris|\bauthoriz|\bwho can\b|\bdelegat", "policy"),
    (r"\bhospital|\bshelter|\bfood\b|\bwater\b|\bkitchen|\bstock\b|\bsupplies\b|\bcamp\b",
     "facilities"),
    (r"\bunit|\bambulance|\bboat|\bpump|\bfleet\b|\btruck|\bteam\b|\bresource", "resources"),
    (r"\bincident\b|\btell me about\b", "incident"),
    (r"\bhelp\b|\bwhat can you\b|\bcapabilit", "help"),
]


def _rule_route(question: str, names: Names) -> tuple[str, dict]:
    q = question.lower()
    intent = "situation"
    for pattern, candidate in _RULES:
        if re.search(pattern, q):
            intent = candidate
            break

    args: dict[str, Any] = {}
    ward_hits = [n for n in names.wards if n and n in q]
    if ward_hits:
        ward_hits.sort(key=len, reverse=True)
        args["ward"] = ward_hits[0]
        if len(ward_hits) > 1:
            args["against"] = ward_hits[1]
    unit_hits = [n for n in names.resources if n and n in q]
    if unit_hits:
        args["unit"] = max(unit_hits, key=len)
    incident_hits = [n for n in names.incidents if n and n in q]
    if incident_hits:
        args["target"] = max(incident_hits, key=len)
    for capability in names.capabilities:
        if capability.replace("_", " ") in q:
            args["capability"] = capability
            break
    count = re.search(r"\b(\d{1,4})\b", q)
    if count:
        args["count"] = int(count.group(1))
    return intent, args


# ---------------------------------------------------------------- handlers ---
def _table(title: str, columns: list[tuple[str, str]], rows: list[dict],
           note: str = "") -> dict:
    return {
        "type": "table", "title": title,
        "columns": [{"key": k, "label": label} for k, label in columns],
        "rows": rows, "note": note,
    }


async def _situation(args: dict, names: Names, city_id: str) -> tuple[list[dict], list[str]]:
    situation = await tools.call("get_situation", city_id=city_id)
    ranked = await tools.call("rank_wards", city_id=city_id, limit=5)
    blocks = [
        {
            "type": "stats", "title": "Right now",
            "stats": [
                {"label": "Open incidents", "value": situation.get("incidents", 0)},
                {"label": "Severity 4+", "value": situation.get("critical", 0),
                 "tone": "bad" if situation.get("critical") else "ok"},
                {"label": "Units committed",
                 "value": f"{situation.get('committed', 0)}/{situation.get('units', 0)}"},
                {"label": "Unmet demand", "value": situation.get("unmet", 0),
                 "tone": "bad" if situation.get("unmet") else "ok"},
                {"label": "Awaiting approval", "value": situation.get("awaiting", 0),
                 "tone": "warn" if situation.get("awaiting") else "ok"},
                {"label": "Average ETA",
                 "value": f"{situation.get('avg_eta') or '—'} min"},
            ],
        },
        _table(
            "Wards needing attention",
            [("rank", "#"), ("name", "Ward"), ("score", "Score"),
             ("worst_severity", "Worst"), ("incidents", "Open"),
             ("unmet", "Unmet"), ("units_committed", "Units"), ("exposed", "Exposed")],
            ranked,
            "Score is four named terms, not a model. Ask why to see them.",
        ),
    ]
    return blocks, ["get_situation", "rank_wards"]


async def _rank(args: dict, names: Names, city_id: str) -> tuple[list[dict], list[str]]:
    ranked = await tools.call("rank_wards", city_id=city_id, limit=10)
    return [
        _table(
            "Wards by priority",
            [("rank", "#"), ("name", "Ward"), ("score", "Score"),
             ("worst_severity", "Worst"), ("critical", "Sev 4+"),
             ("incidents", "Open"), ("unmet", "Unmet"),
             ("units_committed", "Units"), ("avg_eta", "ETA"), ("exposed", "Exposed")],
            ranked,
            "Ordered by a transparent score: 40% worst open incident, 25% unmet "
            "demand, 20% people exposed, 15% incident count, adjusted for whether "
            "anything is already committed there.",
        )
    ], ["rank_wards"]


async def _explain(args: dict, names: Names, city_id: str) -> tuple[list[dict], list[str]]:
    ward = _match(args.get("ward"), names.wards)
    against = _match(args.get("against"), names.wards)
    if ward is None:
        ranked = await tools.call("rank_wards", city_id=city_id, limit=2)
        if not ranked:
            return [{"type": "text", "body": "Nothing is open, so nothing is ranked."}], ["rank_wards"]
        ward = ranked[0]["ward_id"]
        against = against or (ranked[1]["ward_id"] if len(ranked) > 1 else None)

    detail = await tools.call(
        "explain_priority", ward_id=ward, against=against, city_id=city_id
    )
    if "error" in detail:
        return [{"type": "text", "body": detail["error"]}], ["explain_priority"]

    blocks: list[dict] = [{
        "type": "terms",
        "title": f"Why {detail['ward']['name']} scores {detail['ward']['score']}",
        "subject": detail["ward"]["name"],
        "against": (detail.get("against") or {}).get("name"),
        "terms": detail["terms"],
        "comparison": detail.get("comparison", []),
        "note": "Each term is a number you can check against the incident queue. "
                "Nothing here is a learned weight.",
    }]
    return blocks, ["explain_priority", "rank_wards"]


async def _incident(args: dict, names: Names, city_id: str) -> tuple[list[dict], list[str]]:
    incident_id = _match(args.get("target") or args.get("incident"), names.incidents)
    if incident_id is None:
        rows = await tools.call("get_incidents", city_id=city_id, limit=12)
        return [_table(
            "Open incidents",
            [("title", "Incident"), ("ward_name", "Ward"), ("severity", "Sev"),
             ("report_count", "Reports"), ("units", "Units"), ("unmet", "Unmet"),
             ("street", "Street")],
            rows, "Name one and I will show what we believe about it and why.",
        )], ["get_incidents"]

    detail = await tools.call("evidence_for", incident_id=incident_id)
    if "error" in detail:
        return [{"type": "text", "body": detail["error"]}], ["evidence_for"]
    inc = detail["incident"]
    return [
        {
            "type": "evidence",
            "title": inc["title"],
            "items": [
                {"label": "Ward", "value": inc["ward_name"]},
                {"label": "Severity", "value": inc["severity"]},
                {"label": "Reports clustered", "value": inc["report_count"]},
                {"label": "Trust", "value": f"{(inc.get('trust_score') or 0):.0%}"},
                {"label": "Confidence", "value": f"{(inc.get('confidence') or 0):.0%}"},
                {"label": "Photos", "value": detail["photos"]},
                {"label": "Sources",
                 "value": ", ".join(f"{k} × {v}" for k, v in detail["sources"].items()) or "—"},
                {"label": "Street", "value": inc.get("street") or "—"},
            ],
            "note": "Trust is seven named components, not a classifier.",
        },
        _table("Units committed",
               [("label", "Unit"), ("kind", "Kind"), ("operator", "Operator"),
                ("status", "Status"), ("eta_minutes", "ETA")],
               detail["units"], "" if detail["units"] else "Nothing is committed here."),
        _table("Needs",
               [("capability_id", "Capability"), ("required", "Required"), ("met", "Met")],
               detail["needs"]),
        _table("Reports behind it",
               [("created_at", "At"), ("source", "Source"), ("note", "What was said"),
                ("trust_score", "Trust"), ("link_score", "Link")],
               detail["reports"][:10],
               "The link score is why these were treated as one incident."),
    ], ["evidence_for"]


async def _resources(args: dict, names: Names, city_id: str) -> tuple[list[dict], list[str]]:
    rows = await tools.call(
        "get_resources", city_id=city_id, capability=args.get("capability")
    )
    available = [r for r in rows if r["status"] == "available"]
    return [
        {"type": "stats", "title": "Fleet", "stats": [
            {"label": "Units", "value": len(rows)},
            {"label": "Available", "value": len(available)},
            {"label": "Committed", "value": len(rows) - len(available),
             "tone": "warn" if len(rows) - len(available) > len(rows) * 0.8 else "ok"},
        ]},
        _table("Units",
               [("label", "Unit"), ("kind", "Kind"), ("operator", "Operator"),
                ("status", "Status"), ("incident_title", "On"), ("eta_minutes", "ETA")],
               rows[:60]),
    ], ["get_resources"]


async def _facilities(args: dict, names: Names, city_id: str) -> tuple[list[dict], list[str]]:
    rows = await tools.call("get_facilities", city_id=city_id, kind=args.get("kind"))
    stock: dict[str, float] = {}
    for r in rows:
        for item, qty in (r.get("supplies") or {}).items():
            stock[item] = stock.get(item, 0) + float(qty or 0)
    blocks: list[dict] = []
    if stock:
        blocks.append({
            "type": "stats", "title": "Relief stock on the shelves",
            "stats": [
                {"label": k.replace("_", " "), "value": f"{int(v):,}"}
                for k, v in sorted(stock.items(), key=lambda kv: -kv[1])
            ],
        })
    blocks.append(_table(
        "Facilities",
        [("name", "Name"), ("kind_label", "Kind"), ("status", "Status"),
         ("occupancy", "In"), ("capacity", "Capacity"),
         ("people_served_per_hour", "Served/h")],
        rows,
    ))
    return blocks, ["get_facilities"]


async def _forecast(args: dict, names: Names, city_id: str) -> tuple[list[dict], list[str]]:
    f = await tools.call("get_forecast", city_id=city_id)
    if f.get("error"):
        return [{"type": "text", "body": f"The forecast could not be built: {f['error']}"}], ["get_forecast"]
    return [
        _table("Most likely next, by ward",
               [("wardName", "Ward"), ("category", "Category"),
                ("expected", "Expected"), ("pAtLeastOne", "P(≥1)"),
                ("evidence", "Evidence"), ("observed", "Seen")],
               f.get("recurrence", [])[:10],
               f.get("confidenceNote", "")),
        _table("Capability demand over the horizon",
               [("capability", "Capability"), ("expectedUnits", "Expected"),
                ("availableNow", "Free now"), ("committedNow", "Committed"),
                ("shortfall", "Shortfall")],
               f.get("demand", []),
               "A shortfall here is the argument for prepositioning or mutual aid."),
        _table("Facilities under pressure",
               [("name", "Facility"), ("pressure", "Pressure"),
                ("spare", "Spare"), ("expectedArrivals", "Expected"),
                ("hoursToFull", "Hours to full")],
               [x for x in f.get("facilities", []) if x.get("pressure") != "steady"][:10],
               "Projections, not measurements."),
    ], ["get_forecast"]


async def _decisions(args: dict, names: Names, city_id: str) -> tuple[list[dict], list[str]]:
    rows = await tools.call("get_decisions", limit=25)
    waiting = [r for r in rows if r["status"] == "awaiting_approval"]
    for r in rows:
        auth = r.get("authority") or {}
        r["clause"] = auth.get("clause")
        r["delegated_to"] = auth.get("delegated_to")
    blocks: list[dict] = []
    if waiting:
        blocks.append({
            "type": "cards", "title": "Waiting for a person",
            "cards": [{
                "title": r["action"], "subtitle": r["target"], "tone": "warn",
                "lines": [
                    {"label": "Clause", "value": r.get("clause") or "—"},
                    {"label": "Reserved to", "value": r.get("delegated_to") or "—"},
                    {"label": "Confidence", "value": f"{(r.get('confidence') or 0):.0%}"},
                ],
            } for r in waiting[:6]],
        })
    blocks.append(_table(
        "Decisions",
        [("action", "Action"), ("target", "Target"), ("status", "Status"),
         ("clause", "Clause"), ("delegated_to", "Delegated to"),
         ("confidence", "Confidence")],
        rows,
        "Nothing issues because the system is confident. It issues because a "
        "clause delegates it and the confidence floor is cleared.",
    ))
    return blocks, ["get_decisions"]


async def _alerts(args: dict, names: Names, city_id: str) -> tuple[list[dict], list[str]]:
    rows = await tools.call("get_alerts", limit=20)
    return [_table(
        "Advisories issued",
        [("issued_at", "At"), ("ward_name", "Ward"), ("headline", "Headline"),
         ("action", "What people were told"), ("reach", "Reach")],
        rows,
        "Each one exists because a decision cleared the gate. Wards where the "
        "action is still waiting are silent, on purpose.",
    )], ["get_alerts"]


async def _reports(args: dict, names: Names, city_id: str) -> tuple[list[dict], list[str]]:
    rows = await tools.call("get_reports", city_id=city_id, limit=30)
    return [_table(
        "What came in",
        [("created_at", "At"), ("source", "Source"), ("note", "Report"),
         ("trust_score", "Trust"), ("verification_status", "Status"),
         ("link_score", "Merged at")],
        rows,
        "Raw intake, before it became an incident.",
    )], ["get_reports"]


async def _timeline(args: dict, names: Names, city_id: str) -> tuple[list[dict], list[str]]:
    rows = await tools.call("get_timeline", limit=40)
    return [{
        "type": "timeline", "title": "What happened",
        "events": [
            {"id": r["id"], "kind": r["kind"], "actor": r["actor"],
             "at": r["occurred_at"].isoformat() if hasattr(r["occurred_at"], "isoformat")
                   else str(r["occurred_at"]),
             "wardId": r["ward_id"], "causedBy": r["causation_id"],
             "payload": r["payload"]}
            for r in rows
        ],
        "note": "Straight from the append-only log, newest first.",
    }], ["get_timeline"]


async def _agencies(args: dict, names: Names, city_id: str) -> tuple[list[dict], list[str]]:
    data = await tools.call("get_agency_status", city_id=city_id)
    rows = [
        {"name": a["name"], "kind": a["kind"],
         "capabilities": ", ".join(c.replace("_", " ") for c in a["capabilities"])}
        for a in data["agencies"]
    ]
    blocks = [_table("Who holds what",
                     [("name", "Agency"), ("kind", "Kind"), ("capabilities", "Capabilities")],
                     rows)]
    if data["requests"]:
        blocks.append(_table(
            "Mutual-aid requests",
            [("requested_at", "At"), ("to_name", "To"), ("capability_id", "For"),
             ("quantity", "Qty"), ("status", "Status")],
            data["requests"]))
    return blocks, ["get_agency_status"]


async def _policy(args: dict, names: Names, city_id: str) -> tuple[list[dict], list[str]]:
    action_key = args.get("action_key") or args.get("action") or ""
    key = str(action_key).strip().lower().replace(" ", "_")
    if not key:
        rows = await db.fetch(
            "select clause, source, delegated_to, max_severity_without_escalation, "
            "authorises from policy_clauses order by id"
        )
        return [_table(
            "The delegation matrix",
            [("clause", "Clause"), ("delegated_to", "Delegated to"),
             ("max_severity_without_escalation", "Auto up to severity"),
             ("authorises", "Authorises")],
            [dict(r) | {"authorises": ", ".join(r["authorises"])} for r in rows],
            "Severity 0 means it always waits for a person.",
        )], ["get_policy"]

    found = await tools.call("get_policy", action_key=key)
    return [{
        "type": "evidence", "title": key.replace("_", " ").title(),
        "items": [
            {"label": "Clause", "value": found.get("clause", "—")},
            {"label": "Source", "value": found.get("source", "—")},
            {"label": "Delegated to", "value": found.get("delegatedTo", "—")},
            {"label": "Auto up to severity",
             "value": found.get("maxSeverityWithoutEscalation", "—")},
        ],
        "note": found.get("body") or found.get("note") or "",
    }], ["get_policy"]


async def _simulate(args: dict, names: Names, city_id: str) -> tuple[list[dict], list[str]]:
    unit = _match(args.get("unit") or args.get("resource"), names.resources)
    target = _match(args.get("target") or args.get("incident"), names.incidents)
    if unit is None or target is None:
        missing = "a unit" if unit is None else "an incident"
        return [{
            "type": "text",
            "body": (
                f"I could not find {missing} in that. Name the unit as it appears "
                "on the resources screen and the incident as it appears on the "
                "queue, and I will re-solve the plan with that move forced and "
                "show you what it costs elsewhere."
            ),
        }], []

    table = await tools.call(
        "simulate_reallocation", resource_id=unit, incident_id=target, city_id=city_id
    )
    label = next((k for k, v in names.resources.items() if v == unit), unit)
    title = next((k for k, v in names.incidents.items() if v == target), target)
    return [
        {"type": "comparison",
         "title": f"Sending {label.title()} to {title}",
         "rows": table["rows"], "wards": table["wards"],
         "note": table.get("note") or "",
         "engine": table.get("engine")},
        {"type": "actions", "title": "If you want to do it",
         "actions": [{
             "actionKey": "reallocate_unit",
             "action": f"Move {label.title()} to {title}",
             "target": label.title(), "wardId": None,
             "params": {"resource_id": unit, "incident_id": target},
             "severity": 3,
         }]},
    ], ["simulate_reallocation"]


async def _surge(args: dict, names: Names, city_id: str) -> tuple[list[dict], list[str]]:
    ward = _match(args.get("ward"), names.wards)
    capability = args.get("capability") or "medical"
    count = int(args.get("count") or 10)
    if ward is None:
        return [{"type": "text",
                 "body": "Name the ward and what it would need, and I will add "
                         "that demand to the current world and re-solve."}], []
    table = await tools.call(
        "simulate_surge", ward_id=ward, capability=capability, count=count, city_id=city_id
    )
    ward_name = next((k for k, v in names.wards.items() if v == ward), ward)
    return [{
        "type": "comparison",
        "title": f"{count} more {capability.replace('_', ' ')} calls in {ward_name.title()}",
        "rows": table["rows"], "wards": table["wards"],
        "note": table.get("note") or "", "engine": table.get("engine"),
    }], ["simulate_surge"]


async def _strategies(args: dict, names: Names, city_id: str) -> tuple[list[dict], list[str]]:
    built = await tools.call("generate_strategies", city_id=city_id)
    return [{
        "type": "strategies",
        "title": "Options for the next few hours",
        "strategies": built["strategies"],
        "matrix": built["matrix"],
        "baseline": built["baseline"],
        "note": built["note"],
    }], ["generate_strategies"]


async def _apply(args: dict, names: Names, city_id: str) -> tuple[list[dict], list[str]]:
    wanted = str(args.get("strategy") or args.get("id") or "").strip().lower()
    built = await tools.call("generate_strategies", city_id=city_id)
    options = built["strategies"]
    chosen = None
    for s in options:
        if wanted and (wanted == s["id"] or wanted in s["title"].lower()):
            chosen = s
            break
    if chosen is None:
        return [{
            "type": "strategies", "title": "Which one?",
            "strategies": options, "matrix": built["matrix"],
            "baseline": built["baseline"],
            "note": "Name one and I will put its actions to the policy gate.",
        }], ["generate_strategies"]
    return [{
        "type": "actions",
        "title": f"{chosen['title']} — {len(chosen['actions'])} action(s)",
        "strategyId": chosen["id"],
        "actions": chosen["actions"],
        "note": "Nothing has been done. Approving sends each of these to the "
                "policy gate, which decides what may issue and what waits.",
    }], ["generate_strategies"]


async def _help(args: dict, names: Names, city_id: str) -> tuple[list[dict], list[str]]:
    return [{
        "type": "table", "title": "What I can reach",
        "columns": [{"key": "name", "label": "Tool"}, {"key": "tier", "label": "Tier"},
                    {"key": "description", "label": "What it does"}],
        "rows": tools.catalogue(),
        "note": "read answers questions, analyse re-solves the real model on a "
                "copy and writes nothing, act goes through the policy gate. "
                "There is no fourth tier.",
    }], []


_HANDLERS = {
    "situation": _situation, "rank": _rank, "explain": _explain,
    "incident": _incident, "resources": _resources, "facilities": _facilities,
    "forecast": _forecast, "decisions": _decisions, "alerts": _alerts,
    "reports": _reports, "timeline": _timeline, "agencies": _agencies,
    "policy": _policy, "simulate": _simulate, "surge": _surge,
    "strategies": _strategies, "apply": _apply, "help": _help,
}

SUGGESTIONS = {
    "situation": ["Which wards are worst?", "What options do I have?",
                  "What is waiting for my approval?"],
    "rank": ["Why is the top one above the second?", "What options do I have?"],
    "explain": ["What would fix it?", "Show me the incidents there"],
    "strategies": ["Apply the first one", "What are the drawbacks of each?"],
    "simulate": ["Apply it", "What else would that slow down?"],
    "forecast": ["Should we preposition?", "Which facility fills first?"],
    "decisions": ["Why did that one need me?", "Who holds that delegation?"],
}


# -------------------------------------------------------------------- prose ---
def _shrink(blocks: list[dict], limit: int = 2400) -> str:
    """The blocks, small enough to put in a prompt and still be the whole truth.

    Tables are truncated by rows rather than by characters, so the model never
    sees half a number.
    """
    compact: list[Any] = []
    for b in blocks:
        if b["type"] == "table":
            compact.append({"table": b.get("title"),
                            "rows": b.get("rows", [])[:8]})
        elif b["type"] == "strategies":
            compact.append({"strategies": [
                {"title": s["title"], "risk": s["risk"],
                 "drawbacks": s["drawbacks"][:2],
                 "expected": s["expected"].get("rows", [])}
                for s in b.get("strategies", [])
            ]})
        elif b["type"] == "timeline":
            compact.append({"events": [e["kind"] for e in b.get("events", [])[:15]]})
        else:
            compact.append({k: v for k, v in b.items() if k != "type"})
    text = json.dumps(compact, default=str)
    return text[:limit]


async def _narrate(question: str, intent: str, blocks: list[dict]) -> tuple[str, str]:
    fallback = _fallback_text(intent, blocks)
    completion = await llm.complete(
        NARRATOR_SYSTEM,
        f"QUESTION: {question}\n\nINTENT: {intent}\n\nDATA: {_shrink(blocks)}",
        fallback=fallback,
    )
    return completion.text.strip(), completion.engine


def _fallback_text(intent: str, blocks: list[dict]) -> str:
    """The answer without a model. Plainer, not emptier."""
    stats = next((b for b in blocks if b["type"] == "stats"), None)
    table = next((b for b in blocks if b["type"] == "table"), None)
    comparison = next((b for b in blocks if b["type"] == "comparison"), None)
    strategies_block = next((b for b in blocks if b["type"] == "strategies"), None)

    if strategies_block:
        options = strategies_block.get("strategies", [])
        return (
            f"{len(options)} option(s), each re-solved against the current plan. "
            "Every one of them costs something; the drawbacks are listed under each."
        )
    if comparison:
        unmet = next((r for r in comparison["rows"] if r["metric"] == "Unmet demand"), None)
        eta = next((r for r in comparison["rows"] if r["metric"] == "Median ETA (min)"), None)
        parts = []
        if eta and eta.get("change") is not None:
            parts.append(
                f"median ETA {'falls' if eta['change'] < 0 else 'rises'} by "
                f"{abs(eta['change'])} minutes"
            )
        if unmet and unmet.get("change") is not None:
            parts.append(f"unmet demand changes by {unmet['change']:+.0f}")
        worse = [w for w in comparison.get("wards", []) if w.get("better") is False]
        if worse:
            parts.append(f"{len(worse)} ward(s) get slower")
        return "Re-solved with that move forced: " + ", ".join(parts) + "." if parts else \
            "Re-solved with that move forced; nothing measurable changed."
    if stats:
        pieces = ", ".join(f"{s['label'].lower()} {s['value']}" for s in stats["stats"][:4])
        return f"{pieces}."
    if table and table.get("rows"):
        return f"{len(table['rows'])} row(s) below, ordered by what matters most first."
    return "Nothing matching that is in the system right now."


# --------------------------------------------------------------------- ask ---
async def ask(question: str, *, city_id: str = "pune") -> Answer:
    """One question in, one rendered answer out."""
    question = (question or "").strip()
    if not question:
        return Answer(text="Ask me anything about what is happening.", intent="help")

    names = await _names(city_id)
    intent, args = await _route(question, names)
    handler = _HANDLERS.get(intent, _situation)

    try:
        blocks, used = await handler(args, names, city_id)
    except Exception as exc:  # noqa: BLE001 - an answer, never a stack trace
        log.exception("copilot_handler_failed", intent=intent)
        return Answer(
            text=f"I could not answer that: {type(exc).__name__}. The underlying "
                 "data is still on the operational screens.",
            intent=intent, note=str(exc)[:200],
        )

    text, engine = await _narrate(question, intent, blocks)
    return Answer(
        text=text, blocks=blocks, intent=intent, tools_used=used, engine=engine,
        suggestions=SUGGESTIONS.get(intent, SUGGESTIONS["situation"]),
    )


# ------------------------------------------------------------------- apply ---
async def apply_actions(
    actions: list[dict], *, actor: str, city_id: str = "pune",
    strategy_id: str | None = None,
) -> dict:
    """Put a set of proposed actions to the policy gate, then do what may be done.

    This is the only path from the Copilot to the world, and it is two steps on
    purpose. The gate decides authority; the executor carries out what the gate
    authorised. An action the gate holds back is not executed and not quietly
    dropped — it appears on the decision gate with the clause that held it, and
    an officer with that delegation can approve it there.
    """
    results: list[dict] = []
    for raw in actions:
        proposal = await tools.call(
            "propose_action",
            action_key=raw.get("actionKey") or raw.get("action_key"),
            action=raw.get("action") or "",
            target=raw.get("target") or "",
            ward_id=raw.get("wardId") or raw.get("ward_id"),
            rationale=raw.get("rationale")
            or f"Proposed from the command console{f' as part of {strategy_id}' if strategy_id else ''}.",
            confidence=float(raw.get("confidence") or 0.82),
            severity=int(raw.get("severity") or 3),
            params=raw.get("params") or {},
            city_id=city_id,
        )
        entry = dict(proposal)
        entry["executed"] = False
        if proposal["status"] == "auto_issued" and execute.executable(proposal["actionKey"]):
            try:
                entry["result"] = await execute.run(
                    proposal["actionKey"], raw.get("params") or {},
                    actor=f"officer:{actor}",
                )
                entry["executed"] = True
            except execute.NotExecutable as exc:
                entry["note"] = str(exc)
            except Exception as exc:  # noqa: BLE001
                log.exception("copilot_execute_failed", action=proposal["actionKey"])
                entry["note"] = f"Authorised but failed to carry out: {exc}"
        elif proposal["status"] == "auto_issued":
            entry["note"] = (
                "Authorised, and this one has to be carried out by a person — "
                "there is no mechanism here that can do it."
            )
        results.append(entry)

    issued = sum(1 for r in results if r["status"] == "auto_issued")
    waiting = sum(1 for r in results if r["status"] == "awaiting_approval")
    done = sum(1 for r in results if r["executed"])
    return {
        "strategyId": strategy_id,
        "proposals": results,
        "summary": (
            f"{len(results)} action(s) put to the gate: {issued} authorised "
            f"({done} carried out), {waiting} waiting for somebody with the "
            "delegation."
        ),
    }


async def apply_strategy(strategy_id: str, *, actor: str, city_id: str = "pune") -> dict:
    strategy = await strat.by_id(strategy_id, city_id)
    if strategy is None:
        return {"error": f"No strategy called {strategy_id!r} in the current world."}
    return await apply_actions(
        [a.as_dict() for a in strategy.actions],
        actor=actor, city_id=city_id, strategy_id=strategy_id,
    )
