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
from app.incidents import duplicates
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
) -> dict:
    """Everything the console draws, in one round trip."""
    st = runner.state

    snapshot, dupes = await asyncio.gather(
        _snapshot(city_id, since_event), _duplicates_cached(city_id)
    )
    (wards, resources, incidents, needs, decisions,
     events, facilities, blocks) = snapshot

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
            for b in st.beats[-40:]
        ],
    }


_WARDS_SQL = """
select w.id, w.name, w.number, w.population,
       extensions.ST_X(w.centroid::extensions.geometry) lng,
       extensions.ST_Y(w.centroid::extensions.geometry) lat,
       extensions.ST_AsGeoJSON(w.boundary)::json -> 'coordinates' -> 0 as boundary,
       r.score, r.severity, r.population_at_risk par
  from wards w
  left join lateral (
    select score, severity, population_at_risk from ward_risks
     where ward_id = w.id order by created_at desc limit 1
  ) r on true
 where w.city_id = $1
 order by w.number::int
"""

_RESOURCES_SQL = """
select r.id, r.kind, r.label, r.operator, r.agency_id, r.capacity,
       r.status::text status, r.status_note, r.unavailable_reason,
       extensions.ST_X(r.location::extensions.geometry) lng,
       extensions.ST_Y(r.location::extensions.geometry) lat,
       (select array_agg(capability_id) from resource_kind_capabilities
         where kind_id = r.kind) caps,
       a.incident_id::text incident_id, a.eta_minutes, i.title incident_title
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

_INCIDENTS_SQL = """
select i.id::text, i.title, i.category, i.ward_id, i.severity,
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
 order by id desc limit 40
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


async def _snapshot(city_id: str, since_event: int) -> tuple[Any, ...]:
    """Eight independent reads, issued together.

    They were sequential, which on a link to a database in another region meant
    a round trip each, on a poll that runs every second. The demo loop was
    competing with it for the same ten connections, ordinary requests started
    queueing behind the two of them, and the browser reported those timeouts as
    CORS failures. Concurrency is the whole fix.
    """
    (
        ward_rows, resource_rows, incident_rows, need_rows,
        decision_rows, event_rows, facility_rows, block_rows,
    ) = await asyncio.gather(
        db.fetch(_WARDS_SQL, city_id),
        db.fetch(_RESOURCES_SQL, city_id),
        db.fetch(_INCIDENTS_SQL, city_id),
        db.fetch(_NEEDS_SQL),
        db.fetch(_DECISIONS_SQL),
        db.fetch(_EVENTS_SQL, since_event),
        db.fetch(_FACILITIES_SQL, city_id),
        db.fetch(_BLOCKS_SQL, city_id),
    )

    wards = [
        {"id": r["id"], "name": r["name"], "number": r["number"],
         "centroid": [float(r["lng"]), float(r["lat"])],
         "boundary": r["boundary"], "population": r["population"],
         "score": float(r["score"]) if r["score"] is not None else None,
         "severity": r["severity"], "populationAtRisk": r["par"]}
        for r in ward_rows
    ]
    resources = [
        {"id": r["id"], "kind": r["kind"], "label": r["label"],
         "operator": r["operator"], "agencyId": r["agency_id"],
         "capacity": r["capacity"], "status": r["status"],
         "statusNote": r["status_note"], "unavailableReason": r["unavailable_reason"],
         "location": [float(r["lng"]), float(r["lat"])],
         "capabilities": list(r["caps"] or []),
         "assignedTo": r["incident_title"], "incidentId": r["incident_id"],
         "etaMinutes": r["eta_minutes"]}
        for r in resource_rows
    ]
    incidents = [
        {"id": r["id"], "title": r["title"], "category": r["category"],
         "wardId": r["ward_id"], "severity": r["severity"], "status": r["status"],
         "reportCount": r["report_count"], "confidence": float(r["confidence"]),
         "location": [float(r["lng"]), float(r["lat"])],
         "createdAt": r["created_at"].isoformat(), "unitsEnRoute": r["units"]}
        for r in incident_rows
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
    return wards, resources, incidents, needs, decisions, events, facilities, blocks
