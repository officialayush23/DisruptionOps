"""The demo surface.

One snapshot endpoint the console polls once a second, plus the controls. The
snapshot is deliberately one call rather than eight: a map that assembles itself
from eight requests tears, and a tearing map during a live demo reads as a
broken system even when every number in it is correct.
"""

from __future__ import annotations

import asyncio
import time
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Query
from pydantic import Field

from app.core.errors import BadRequest, Conflict, NotFound
from app.core.security import CurrentPrincipal, StaffPrincipal
from app.db import session as db
from app.demo import runner
from app.agents import forecast as forecasting
from app.incidents import duplicates
from app import taxonomy
from app.schemas.domain import Camel, CategoryId
from app.taxonomy import UnknownTaxonomyValue
from app.world import clock as clocks
from app.world import events as ev

router = APIRouter(tags=["demo"])


class StartIn(Camel):
    city_id: str = "pune"
    #: Ticks between generated reports. One tick is a second.
    report_every_ticks: int = Field(default=4, ge=1, le=30)


class MoveIn(Camel):
    lng: float = Field(ge=-180, le=180)
    lat: float = Field(ge=-90, le=90)


class CitizenReportIn(Camel):
    category: CategoryId = "flooded_road"
    note: str = ""


class DecisionActionIn(Camel):
    note: str | None = None


@router.post("/demo/start")
async def demo_start(body: StartIn, _: StaffPrincipal) -> dict:
    await runner.start(city_id=body.city_id, report_every_ticks=body.report_every_ticks)
    return {"running": True, "tick": runner.state.tick}


@router.post("/demo/stop")
async def demo_stop(_: StaffPrincipal) -> dict:
    await runner.stop()
    return {"running": False, "tick": runner.state.tick}


@router.post("/demo/replan")
async def demo_replan(_: StaffPrincipal) -> dict:
    await runner.force_replan()
    return runner.state.last_plan or {}


@router.post("/demo/citizen/move")
async def demo_move(body: MoveIn, _: CurrentPrincipal) -> dict:
    """Move the watcher's marker. Their ward is resolved by PostGIS, not guessed."""
    return await runner.move_citizen(body.lng, body.lat)


@router.post("/demo/citizen/report")
async def demo_citizen_report(body: CitizenReportIn, _: CurrentPrincipal) -> dict:
    """File a report from wherever the marker currently is.

    The same `intake.receive` every other report uses. It is scored, clustered
    against the generated reports, and can change the next allocation. That is
    the whole argument for the design: there is no separate path for a human.
    """
    try:
        result = await runner.citizen_report(body.category, body.note or "Reported from the map")
    except ValueError as exc:
        raise BadRequest(str(exc)) from exc
    except UnknownTaxonomyValue as exc:
        raise NotFound(str(exc)) from exc
    return {
        "reportId": result.report_id,
        "incidentId": result.incident_id,
        "createdIncident": result.created_incident,
        "linked": result.linked,
        "trust": result.trust.score,
        "status": result.trust.status,
        "linkScore": result.link_score,
        "reasons": result.trust.reasons,
        "summary": result.summary,
    }


@router.post("/demo/decisions/{decision_id}/{action}")
async def demo_decide(decision_id: str, action: str, principal: StaffPrincipal) -> dict:
    """Approve or reject a decision the policy gate held back.

    The gate is not decoration. An action that the delegation matrix reserves to
    the Commissioner waits here until a person with that delegation acts, and
    the interface names the clause that held it.
    """
    if action not in ("approve", "reject", "override"):
        raise NotFound("Unknown action.")
    row = await db.fetchrow(
        "select status, authority, action from decisions where id = $1::uuid", decision_id
    )
    if row is None:
        raise NotFound("No such decision.")
    if row["status"] not in ("awaiting_approval", "auto_issued"):
        raise Conflict(f"That decision is already {row['status']}.")

    status = {"approve": "approved", "reject": "rejected", "override": "overridden"}[action]
    await db.execute(
        """
        update decisions
           set status = $2, decided_by = $3, decided_at = now()
         where id = $1::uuid
        """,
        decision_id, status, principal.full_name or "Officer",
    )
    await ev.append(
        clock=clocks.WALL, kind=ev.Kind.DECISION_ACTED,
        actor=ev.officer(principal.full_name or "Officer"),
        subject_type="decision", subject_id=decision_id,
        payload={"status": status, "action": row["action"]},
    )
    runner.state.beat("decision", f"Officer {status} “{row['action']}”.")
    runner.state.dirty = True
    return {"id": decision_id, "status": status}


#: Duplicate detection is two joins over assignments and a self-join over
#: incidents. At a 120 ms round trip, running it on every one-second poll was a
#: meaningful share of why this endpoint took five seconds. It changes on the
#: scale of a re-plan, not a frame, so it is cached.
_DUP_TTL = 4.0
_dup_cache: tuple[float, list] = (0.0, [])

#: The forecast is a pass over the whole incident history plus a catchment
#: calculation per facility. It moves on the scale of an arrival, not a frame.
_FORECAST_TTL = 12.0
_forecast_cache: tuple[float, dict] = (0.0, {})


async def _forecast_cached(city_id: str) -> dict:
    now = time.monotonic()
    stamp, value = _forecast_cache
    if now - stamp < _FORECAST_TTL and value:
        return value
    try:
        built = forecasting.as_dict(await forecasting.build(city_id=city_id))
    except Exception as exc:  # noqa: BLE001 - the console must not die on this
        return {"error": str(exc)[:200], "recurrence": [], "facilities": [], "demand": []}
    globals()["_forecast_cache"] = (now, built)
    return built


async def _duplicates_cached(city_id: str) -> list:
    now = time.monotonic()
    stamp, value = _dup_cache
    if now - stamp < _DUP_TTL:
        return value
    found = await duplicates.detect(city_id=city_id, sim_run_id=None)
    globals()["_dup_cache"] = (now, found)
    return found


@router.get("/demo/state")
async def demo_state(
    _: CurrentPrincipal,
    city_id: str = Query(default="pune"),
    since_event: int = Query(default=0, ge=0),
    geometry: bool = Query(
        default=True,
        description="Ward polygons. The console asks for them once and then "
                    "stops, because they are reference data and re-sending "
                    "forty of them every second was most of this payload.",
    ),
) -> dict:
    """Everything the console draws, in one round trip."""
    st = runner.state

    snapshot, dupes, forecast = await asyncio.gather(
        _snapshot(city_id, since_event, geometry),
        _duplicates_cached(city_id),
        _forecast_cached(city_id),
    )
    (wards, resources, incidents, needs, decisions, events, facilities,
     blocks, routes, alerts, reports) = snapshot

    return {
        "running": st.running,
        "tick": st.tick,
        "simNow": st.sim_now.isoformat() if st.sim_now else None,
        "error": st.error,
        "citizen": st.citizen,
        "wards": wards,
        "resources": resources,
        "incidents": incidents,
        "needs": needs,
        "decisions": decisions,
        "events": events,
        "facilities": facilities,
        "roadBlocks": blocks,
        "routes": routes,
        "forecast": forecast,
        "alerts": alerts,
        "reports": reports,
        "citizenRoute": st.citizen_route,
        "duplicates": [
            {
                "kind": d.kind, "incidentIds": d.incident_ids, "wardId": d.ward_id,
                "agencies": d.agencies, "detail": d.detail, "wastedUnits": d.wasted_units,
            }
            for d in dupes
        ],
        "plan": st.last_plan,
        "beats": [
            {"tick": b.tick, "at": b.at.isoformat(), "kind": b.kind,
             "text": b.text, "detail": b.detail}
            for b in st.beats[-120:]
        ],
    }


#: Ward names, numbers, populations and polygons. None of it changes during a
#: run, and PostGIS was re-serialising forty polygons to GeoJSON on every
#: one-second poll. Read once per process, per city.
_WARD_GEOM_SQL = """
select w.id, w.name, w.number, w.population,
       extensions.ST_X(w.centroid::extensions.geometry) lng,
       extensions.ST_Y(w.centroid::extensions.geometry) lat,
       extensions.ST_AsGeoJSON(w.boundary)::json -> 'coordinates' -> 0 as boundary
  from wards w
 where w.city_id = $1
 order by w.number::int
"""

#: What actually moves: the latest risk row per ward.
_WARD_RISK_SQL = """
select distinct on (ward_id) ward_id, score, severity, population_at_risk par
  from ward_risks
 order by ward_id, created_at desc
"""

_RESOURCES_SQL = """
select r.id, r.kind, r.label, r.operator, r.agency_id, r.capacity,
       r.status::text status, r.status_note, r.unavailable_reason,
       r.updated_at,
       extensions.ST_X(r.location::extensions.geometry) lng,
       extensions.ST_Y(r.location::extensions.geometry) lat,
       a.incident_id::text incident_id, a.eta_minutes, a.status::text a_status,
       a.distance_km, i.title incident_title
  from resources r
  left join lateral (
    select * from assignments x
     where x.resource_id = r.id
       and x.status in ('proposed','approved','en_route','on_site')
       and x.sim_run_id is null
     order by x.created_at desc limit 1
  ) a on true
  left join incidents i on i.id = a.incident_id
 where r.city_id = $1
 order by r.kind, r.label
"""

_ROUTES_SQL = """
select a.id::text, a.resource_id, a.incident_id::text incident_id,
       a.eta_minutes, a.distance_km, a.status::text status,
       a.route_engine, a.progress, a.steps, r.label, r.kind, i.title,
       extensions.ST_AsGeoJSON(a.route)::json -> 'coordinates' as path
  from assignments a
  join resources r on r.id = a.resource_id
  join incidents i on i.id = a.incident_id
 where a.sim_run_id is null
   and a.status in ('proposed','approved','en_route','on_site')
   and a.route is not null
 order by a.created_at desc
 limit 40
"""

_ALERTS_SQL = """
select a.id::text, a.ward_id, a.hazard, a.severity, a.headline, a.action,
       a.safe_location, a.channels, a.language, a.reach, a.issued_at,
       a.decision_id::text decision_id, w.name ward_name
  from alerts a
  left join wards w on w.id = a.ward_id
 where a.sim_run_id is null
 order by a.issued_at desc
 limit 30
"""

#: The inbox. Every raw report as it arrived, and what the system did with it.
#: Without this there is no way to see what actually entered the system: the
#: console shows incidents, and an incident is already four reports and a
#: judgement about them.
_REPORTS_SQL = """
select r.id::text, r.note, r.category, r.classified_as,
       r.classification_confidence, r.source, r.device_id, r.reporter_name,
       r.trust_score, r.trust_breakdown, r.verification_status, r.street,
       r.ward_id, r.created_at, r.mesh_hops, r.photo_path,
       r.incident_id::text incident_id,
       i.title incident_title, i.severity incident_severity,
       i.report_count, i.created_at incident_created_at,
       l.link_score, l.rationale link_reason, l.decided_by link_decided_by,
       w.name ward_name,
       extensions.ST_X(r.location::extensions.geometry) lng,
       extensions.ST_Y(r.location::extensions.geometry) lat
  from citizen_reports r
  left join incidents i on i.id = r.incident_id
  left join report_links l on l.report_id = r.id
  left join wards w on w.id = r.ward_id
 where r.city_id = $1 and r.sim_run_id is null
 order by r.created_at desc
 limit 80
"""

_INCIDENTS_SQL = """
select i.id::text, i.title, i.category, i.ward_id, i.severity, i.street,
       i.status::text status, i.report_count, i.confidence, i.created_at,
       extensions.ST_X(i.location::extensions.geometry) lng,
       extensions.ST_Y(i.location::extensions.geometry) lat,
       (select count(*) from assignments a
         where a.incident_id = i.id
           and a.status in ('proposed','approved','en_route','on_site'))::int units
  from incidents i
 where i.city_id = $1 and i.status <> 'resolved'
 order by i.severity desc, i.created_at desc
 limit 60
"""

_NEEDS_SQL = """
select n.incident_id::text incident_id, n.capability_id, n.required, n.met
  from incident_needs n
  join incidents i on i.id = n.incident_id
 where i.status <> 'resolved'
"""

_DECISIONS_SQL = """
select id::text, action, target, ward_id, rationale, confidence,
       status::text status, authority, created_at
  from decisions
 where sim_run_id is null
 order by (status = 'awaiting_approval') desc, created_at desc
 limit 25
"""

_EVENTS_SQL = """
select id, kind, actor, subject_type, subject_id, ward_id, payload,
       occurred_at, causation_id
  from events
 where sim_run_id is null and id > $1
 order by id desc limit 150
"""

_FACILITIES_SQL = """
select id, name, kind, status, capacity, occupancy, accepts_casualties,
       extensions.ST_X(location::extensions.geometry) lng,
       extensions.ST_Y(location::extensions.geometry) lat
  from lifelines
 where city_id = $1 and kind in ('hospital','shelter','pump_station')
 order by kind, name
"""

_BLOCKS_SQL = """
select id::text, reason, reported_by, radius_m,
       extensions.ST_X(location::extensions.geometry) lng,
       extensions.ST_Y(location::extensions.geometry) lat
  from road_blocks where city_id = $1 and active
"""


#: Ward geometry, per city, for the life of the process. Wards do not move.
_ward_geom: dict[str, list[dict]] = {}


async def _ward_geometry(city_id: str) -> list[dict]:
    cached = _ward_geom.get(city_id)
    if cached is not None:
        return cached
    rows = await db.fetch(_WARD_GEOM_SQL, city_id)
    built = [
        {"id": r["id"], "name": r["name"], "number": r["number"],
         "centroid": [float(r["lng"]), float(r["lat"])],
         "boundary": r["boundary"], "population": r["population"]}
        for r in rows
    ]
    _ward_geom[city_id] = built
    return built


#: Facilities and road blocks change when a field crew presses a button, which
#: is often but not sixty times a minute.
_SLOW_TTL = 2.0
_slow_cache: dict[str, tuple[float, Any]] = {}


async def _slow(key: str, sql: str, *args: Any) -> Any:
    now = time.monotonic()
    hit = _slow_cache.get(key)
    if hit and now - hit[0] < _SLOW_TTL:
        return hit[1]
    rows = await db.fetch(sql, *args)
    _slow_cache[key] = (now, rows)
    return rows


def invalidate_slow() -> None:
    """Called when a field status write makes the cached reads wrong."""
    _slow_cache.clear()


def _narrate(kind: str, actor: str, payload: dict) -> str:
    """One readable line per event.

    The audit log is the source of truth for what the agents did, but `payload`
    as raw JSON is unreadable on a hover card. This renders the handful of kinds
    that actually appear during a run and falls back to the kind name for the
    rest, rather than inventing prose for something it does not understand.
    """
    p = payload if isinstance(payload, dict) else {}
    who = actor.split(":", 1)[-1].replace("_", " ") if actor else "the system"
    match kind:
        case "incident.opened":
            return f"Incident opened at {float(p.get('trust', 0)):.0%} confidence."
        case "report.received":
            return f"Report accepted, trust {float(p.get('trust', 0)):.0%}."
        case "report.linked":
            return (f"Report merged into this incident at "
                    f"{float(p.get('score', 0)):.0%} match.")
        case "report.rejected":
            return f"Report held back: {p.get('reason', 'below the trust floor')}."
        case "incident.resolved":
            return "Closed by the crew on scene."
        case "incident.severity_changed":
            return f"Severity moved to {p.get('to', '?')}."
        case "assignment.created":
            return (f"{who} tasked a unit here, "
                    f"{p.get('eta_minutes', '?')} min out, for "
                    f"{str(p.get('capability', '')).replace('_', ' ')}.")
        case "assignment.changed":
            return p.get("reason") or f"{who} re-tasked a unit."
        case "assignment.cancelled":
            return f"{who} stood a unit down."
        case "plan.generated":
            return (f"{who} re-planned: {p.get('demands', 0)} need(s), "
                    f"{p.get('units', 0)} unit(s), "
                    f"{float(p.get('coverage', 0)):.0%} covered "
                    f"({p.get('engine', '?')}).")
        case "demand.uncovered":
            return p.get("reason") or "A need could not be covered."
        case "decision.proposed":
            return f"{who} proposed {p.get('action', 'an action')}."
        case "decision.gated":
            return f"Held for an officer: {p.get('clause', 'delegation')}."
        case "decision.acted":
            return f"Officer {p.get('status', 'acted on')} {p.get('action', 'it')}."
        case "resource.status_changed":
            return (f"Status set to {str(p.get('to', '?')).replace('_', ' ')}"
                    + (f": {p['note']}" if p.get("note") else "."))
        case "risk.updated":
            return (f"Risk rescored to severity {p.get('severity', '?')} "
                    f"({float(p.get('score', 0)):.0%}).")
        case "road.blocked":
            return f"Road blocked: {p.get('reason', 'reported impassable')}."
        case "alert.issued":
            return f"Alert issued to {p.get('audience', 'the ward')}."
        case "task.created":
            return f"Field task raised for {p.get('operator', 'a crew')}."
        case _:
            return kind.replace(".", " ").replace("_", " ")


async def _snapshot(city_id: str, since_event: int, geometry: bool) -> tuple[Any, ...]:
    """The live reads, issued together; the static ones served from memory.

    They were sequential, which on a link to a database in another region meant
    a round trip each, on a poll that runs every second. The demo loop was
    competing with it for the same ten connections, ordinary requests started
    queueing behind the two of them, and the browser reported those timeouts as
    CORS failures.

    Concurrency was half the fix. The other half is not reading things that
    cannot have changed: ward polygons, ward names and the capability list for
    each kind of vehicle are reference data, and they were the bulk of both the
    query time and the payload.
    """
    geom = await _ward_geometry(city_id)

    (
        risk_rows, resource_rows, incident_rows, need_rows,
        decision_rows, event_rows, facility_rows, block_rows,
        route_rows, alert_rows, report_rows,
    ) = await asyncio.gather(
        db.fetch(_WARD_RISK_SQL),
        db.fetch(_RESOURCES_SQL, city_id),
        db.fetch(_INCIDENTS_SQL, city_id),
        db.fetch(_NEEDS_SQL),
        db.fetch(_DECISIONS_SQL),
        db.fetch(_EVENTS_SQL, since_event),
        _slow(f"fac:{city_id}", _FACILITIES_SQL, city_id),
        _slow(f"blk:{city_id}", _BLOCKS_SQL, city_id),
        db.fetch(_ROUTES_SQL),
        db.fetch(_ALERTS_SQL),
        db.fetch(_REPORTS_SQL, city_id),
    )

    risk = {r["ward_id"]: r for r in risk_rows}
    wards = []
    for w in geom:
        r = risk.get(w["id"])
        wards.append({
            **{k: v for k, v in w.items() if geometry or k != "boundary"},
            "score": float(r["score"]) if r and r["score"] is not None else None,
            "severity": r["severity"] if r else None,
            "populationAtRisk": r["par"] if r else None,
        })

    kinds = taxonomy.cache.resource_kinds
    resources = [
        {"id": r["id"], "kind": r["kind"], "label": r["label"],
         "operator": r["operator"], "agencyId": r["agency_id"],
         "capacity": r["capacity"], "status": r["status"],
         "statusNote": r["status_note"], "unavailableReason": r["unavailable_reason"],
         "location": [float(r["lng"]), float(r["lat"])],
         "capabilities": list(kinds[r["kind"]].capabilities) if r["kind"] in kinds else [],
         "assignedTo": r["incident_title"], "incidentId": r["incident_id"],
         "assignmentStatus": r["a_status"],
         "distanceKm": float(r["distance_km"]) if r["distance_km"] is not None else None,
         "updatedAt": r["updated_at"].isoformat() if r["updated_at"] else None,
         "etaMinutes": r["eta_minutes"]}
        for r in resource_rows
    ]
    incidents = [
        {"id": r["id"], "title": r["title"], "category": r["category"],
         "wardId": r["ward_id"], "severity": r["severity"], "status": r["status"],
         "street": r["street"],
         "reportCount": r["report_count"], "confidence": float(r["confidence"]),
         "location": [float(r["lng"]), float(r["lat"])],
         "createdAt": r["created_at"].isoformat(), "unitsEnRoute": r["units"]}
        for r in incident_rows
    ]
    routes = [
        {"id": r["id"], "resourceId": r["resource_id"], "incidentId": r["incident_id"],
         "resourceLabel": r["label"], "resourceKind": r["kind"],
         "incidentTitle": r["title"], "status": r["status"],
         "etaMinutes": r["eta_minutes"],
         "distanceKm": float(r["distance_km"]) if r["distance_km"] is not None else None,
         "engine": r["route_engine"], "progress": float(r["progress"] or 0),
         "steps": r["steps"] or [],
         "path": r["path"] or []}
        for r in route_rows
    ]
    alerts = [
        {"id": r["id"], "wardId": r["ward_id"], "wardName": r["ward_name"],
         "hazard": r["hazard"], "severity": r["severity"],
         "headline": r["headline"], "action": r["action"],
         "safeLocation": r["safe_location"], "channels": list(r["channels"] or []),
         "language": r["language"], "reach": r["reach"],
         "decisionId": r["decision_id"],
         "issuedAt": r["issued_at"].isoformat() if r["issued_at"] else None}
        for r in alert_rows
    ]
    reports = [
        {"id": r["id"], "text": r["note"] or "", "category": r["category"],
         "classifiedAs": r["classified_as"],
         "classificationConfidence": (
             float(r["classification_confidence"])
             if r["classification_confidence"] is not None else None
         ),
         "source": r["source"], "deviceId": r["device_id"],
         "reporter": r["reporter_name"], "street": r["street"],
         "meshHops": r["mesh_hops"], "hasPhoto": bool(r["photo_path"]),
         "trust": float(r["trust_score"]) if r["trust_score"] is not None else None,
         "trustBreakdown": r["trust_breakdown"] or {},
         "status": r["verification_status"],
         "wardId": r["ward_id"], "wardName": r["ward_name"],
         "location": [float(r["lng"]), float(r["lat"])],
         "createdAt": r["created_at"].isoformat(),
         "incidentId": r["incident_id"], "incidentTitle": r["incident_title"],
         "incidentSeverity": r["incident_severity"],
         "incidentReportCount": r["report_count"],
         # A report that opened its incident is the first one in; anything else
         # with an incident was merged into one that already existed. That is
         # the distinction the inbox exists to show.
         "opened": bool(
             r["incident_id"] and r["incident_created_at"]
             and abs((r["created_at"] - r["incident_created_at"]).total_seconds()) < 2
         ),
         "linkScore": float(r["link_score"]) if r["link_score"] is not None else None,
         "linkReason": r["link_reason"], "linkDecidedBy": r["link_decided_by"]}
        for r in report_rows
    ]
    needs = [
        {"incidentId": r["incident_id"], "capability": r["capability_id"],
         "required": r["required"], "met": r["met"]}
        for r in need_rows
    ]
    decisions = [
        {"id": r["id"], "action": r["action"], "target": r["target"],
         "wardId": r["ward_id"], "rationale": r["rationale"],
         "confidence": float(r["confidence"]), "status": r["status"],
         "clause": (r["authority"] or {}).get("clause"),
         "delegatedTo": (r["authority"] or {}).get("delegated_to"),
         "withinDelegation": (r["authority"] or {}).get("within_delegation"),
         "createdAt": r["created_at"].isoformat()}
        for r in decision_rows
    ]
    events = [
        {"id": r["id"], "kind": r["kind"], "actor": r["actor"],
         "subjectType": r["subject_type"], "subjectId": r["subject_id"],
         "wardId": r["ward_id"], "payload": r["payload"],
         "text": _narrate(r["kind"], r["actor"], r["payload"] or {}),
         "occurredAt": r["occurred_at"].isoformat(), "causationId": r["causation_id"]}
        for r in event_rows
    ]
    facilities = [
        {"id": r["id"], "name": r["name"], "kind": r["kind"], "status": r["status"],
         "capacity": r["capacity"], "occupancy": r["occupancy"],
         "acceptsCasualties": r["accepts_casualties"],
         "location": [float(r["lng"]), float(r["lat"])]}
        for r in facility_rows
    ]
    blocks = [
        {"id": r["id"], "reason": r["reason"], "reportedBy": r["reported_by"],
         "radiusM": r["radius_m"],
         "location": [float(r["lng"]), float(r["lat"])]}
        for r in block_rows
    ]
    return (wards, resources, incidents, needs, decisions, events, facilities,
            blocks, routes, alerts, reports)
