"""The citizen and field surfaces.

Separate from the operations console on purpose, and not only for tidiness. A
ward officer has no use for a marker they can walk around, and a resident must
never be handed the whole fleet's position. The three interfaces answer three
different questions and they should not share an endpoint:

  * **citizen**: what is happening where I am, where should I go, and how do I
    tell someone. Scoped to their surroundings.
  * **field**: what am I assigned to, and how do I tell the control room that my
    vehicle has a puncture. Scoped to their agency.
  * **admin**: everything, and that is `demo.py`.

Scoping is enforced here and again in row level security, so this is the
convenient layer rather than the one holding the line.
"""

from __future__ import annotations

from dataclasses import asdict
from typing import Literal

from fastapi import APIRouter, Query
from pydantic import Field

from app.core.errors import BadRequest, Conflict, NotFound
from app.core.logging import get_logger
from app.core.security import CurrentPrincipal, StaffPrincipal
from app.db import session as db
from app.db.repositories import queries as q
from app.guidance import router as guidance
from app.incidents import intake, parse
from app.schemas.domain import Camel, CategoryId, LngLat
from app.taxonomy import UnknownTaxonomyValue
from app.taxonomy import cache as taxonomy
from app.world import clock as clocks
from app.world import events as ev

log = get_logger(__name__)
router = APIRouter(tags=["personas"])


# =========================================================== citizen =========
class GuideIn(Camel):
    lng: float = Field(ge=-180, le=180)
    lat: float = Field(ge=-90, le=90)
    intent: Literal["shelter", "hospital", "safety", "ambulance"] = "safety"
    #: Free text: "my father is bleeding", "chest pain". Used to pick a facility
    #: that can actually treat it, never to invent one.
    condition: str | None = None
    city_id: str = "pune"


@router.post("/citizen/guide")
async def citizen_guide(body: GuideIn, _: CurrentPrincipal) -> dict:
    """Where should I go, and why?

    Runs on facts: which facilities have room, which are near open incidents,
    which roads have been reported blocked. Returns the decision, the reasoning,
    the two runners-up it rejected and what it does not know. Sometimes the
    answer is "stay where you are", and that is a real answer rather than a
    failure to produce one.
    """
    g = await guidance.guide(
        lng=body.lng, lat=body.lat, intent=body.intent,
        condition=body.condition, city_id=body.city_id,
    )
    return {
        "intent": g.intent,
        "headline": g.headline,
        "shouldMove": g.should_move,
        "reasoning": g.reasoning,
        "warnings": g.warnings,
        "destination": asdict(g.destination) if g.destination else None,
        "alternatives": [asdict(a) for a in g.alternatives],
        "route": g.route,
        "routeKm": g.route_km,
        "routeMinutes": g.route_minutes,
        "routeEngine": g.route_engine,
        "hazardsConsidered": g.avoided_blocks,
    }


class CitizenReportIn(Camel):
    lng: float = Field(ge=-180, le=180)
    lat: float = Field(ge=-90, le=90)
    #: Free text. The category is worked out from it rather than demanded.
    text: str = ""
    #: Optional override when someone does choose from the list.
    category: CategoryId | None = None
    photo_url: str | None = None
    city_id: str = "pune"


@router.post("/citizen/report")
async def citizen_report(body: CitizenReportIn, principal: CurrentPrincipal) -> dict:
    """File a report by typing a sentence.

    Nobody picks from a dropdown standing in water. The text is classified by
    keyword first, in English, Hindi and Marathi, and only goes to a model when
    that is not confident. What it was read as, and from which words, comes back
    so the person can correct it.
    """
    loc = await q.locate_ward(body.lng, body.lat, body.city_id)
    if loc.ward is None or not loc.inside:
        raise BadRequest(
            loc.note or "You are outside the area this deployment covers, so "
            "there is no ward to file this against."
        )

    parsed = (
        parse.Parsed(category=body.category, confidence=1.0, method="chosen", note=body.text)
        if body.category
        else await parse.parse_with_model(body.text)
    )

    try:
        result = await intake.receive(
            ward_id=loc.ward.id,
            category=parsed.category,
            location=(body.lng, body.lat),
            note=body.text,
            photo_url=body.photo_url,
            source="app",
            reporter_id=principal.user_id,
            reporter_name=principal.full_name or "Resident",
            device_id=f"citizen-{principal.user_id or 'anon'}",
            city_id=body.city_id,
            clock=clocks.WALL,
        )
    except UnknownTaxonomyValue as exc:
        raise NotFound(str(exc)) from exc

    return {
        "reportId": result.report_id,
        "incidentId": result.incident_id,
        "createdIncident": result.created_incident,
        "linked": result.linked,
        "wardId": loc.ward.id,
        "wardName": loc.ward.name,
        "readAs": parsed.category,
        "readAsLabel": (taxonomy.categories[parsed.category].display_name
                        if parsed.category in taxonomy.categories else parsed.category),
        "readHow": parsed.explanation,
        "readConfidence": parsed.confidence,
        "urgencyBoost": parsed.urgency_boost,
        "trust": result.trust.score,
        "trustStatus": result.trust.status,
        "trustReasons": result.trust.reasons,
        "linkScore": result.link_score,
        "summary": result.summary,
    }


@router.get("/citizen/state")
async def citizen_state(
    _: CurrentPrincipal,
    lng: float = Query(...), lat: float = Query(...),
    city_id: str = Query(default="pune"),
    radius_km: float = Query(default=4.0, ge=0.5, le=25.0),
) -> dict:
    """What a resident needs, and nothing else.

    Not the fleet. A resident is shown the units actually coming to something
    near them, because that is reassurance, and nothing else, because the live
    position of every ambulance in the city is not theirs to have.
    """
    loc = await q.locate_ward(lng, lat, city_id)
    metres = radius_km * 1000

    nearby, alerts, facilities, units = await _citizen_scope(lng, lat, city_id, metres)

    return {
        "ward": (
            {"id": loc.ward.id, "name": loc.ward.name,
             "population": loc.ward.population} if loc.ward else None
        ),
        "inside": loc.inside,
        "note": loc.note,
        "risk": await _ward_risk(loc.ward.id) if loc.ward else None,
        "incidents": nearby,
        "alerts": alerts,
        "facilities": facilities,
        "unitsNearby": units,
        "categories": [
            {"id": c.id, "label": c.display_name, "lifeSafety": c.life_safety}
            for c in taxonomy.categories.values()
        ],
    }


async def _ward_risk(ward_id: str) -> dict | None:
    r = await db.fetchrow(
        """
        select score, severity, lead_time_hours, population_at_risk, drivers
          from ward_risks where ward_id = $1 order by created_at desc limit 1
        """,
        ward_id,
    )
    if r is None:
        return None
    return {
        "score": float(r["score"]), "severity": r["severity"],
        "leadTimeHours": float(r["lead_time_hours"]),
        "populationAtRisk": r["population_at_risk"],
        "drivers": r["drivers"] or [],
    }


async def _citizen_scope(lng: float, lat: float, city_id: str, metres: float):
    incidents = [
        {"id": r["id"], "title": r["title"], "category": r["category"],
         "severity": r["severity"], "status": r["status"],
         "reportCount": r["report_count"],
         "location": [float(r["lng"]), float(r["lat"])],
         "distanceM": round(float(r["m"]))}
        for r in await db.fetch(
            """
            with me as (select extensions.ST_SetSRID(
                          extensions.ST_MakePoint($1,$2),4326)::extensions.geography g)
            select i.id::text, i.title, i.category, i.severity, i.status::text status,
                   i.report_count,
                   extensions.ST_X(i.location::extensions.geometry) lng,
                   extensions.ST_Y(i.location::extensions.geometry) lat,
                   extensions.ST_Distance(i.location, me.g) m
              from incidents i, me
             where i.city_id = $3 and i.status <> 'resolved'
               and extensions.ST_DWithin(i.location, me.g, $4)
             order by m limit 40
            """,
            lng, lat, city_id, metres,
        )
    ]
    alerts = [
        {"id": r["id"], "headline": r["headline"], "action": r["action"],
         "severity": r["severity"], "issuedAt": r["issued_at"].isoformat(),
         "safeLocation": r["safe_location"]}
        for r in await db.fetch(
            """
            select a.id::text, a.headline, a.action, a.severity, a.issued_at,
                   a.safe_location
              from alerts a
              join wards w on w.id = a.ward_id
             where w.city_id = $1
               and extensions.ST_DWithin(
                     w.centroid,
                     extensions.ST_SetSRID(extensions.ST_MakePoint($2,$3),4326)::extensions.geography,
                     $4 * 3)
             order by a.issued_at desc limit 10
            """,
            city_id, lng, lat, metres,
        )
    ]
    facilities = [
        {"id": r["id"], "name": r["name"], "kind": r["kind"],
         "location": [float(r["lng"]), float(r["lat"])],
         "capacity": r["capacity"], "occupancy": r["occupancy"],
         "status": r["status"], "specialities": list(r["specialities"] or []),
         "distanceM": round(float(r["m"]))}
        for r in await db.fetch(
            """
            with me as (select extensions.ST_SetSRID(
                          extensions.ST_MakePoint($1,$2),4326)::extensions.geography g)
            select l.id, l.name, l.kind, l.capacity, l.occupancy, l.status, l.specialities,
                   extensions.ST_X(l.location::extensions.geometry) lng,
                   extensions.ST_Y(l.location::extensions.geometry) lat,
                   extensions.ST_Distance(l.location, me.g) m
              from lifelines l, me
             where l.city_id = $3 and l.kind in ('shelter','hospital')
             order by m limit 12
            """,
            lng, lat, city_id,
        )
    ]
    units = [
        {"id": r["id"], "kind": r["kind"], "label": r["label"],
         "status": r["status"], "location": [float(r["lng"]), float(r["lat"])],
         "etaMinutes": r["eta_minutes"]}
        for r in await db.fetch(
            """
            with me as (select extensions.ST_SetSRID(
                          extensions.ST_MakePoint($1,$2),4326)::extensions.geography g)
            select r.id, r.kind, r.label, r.status::text status, a.eta_minutes,
                   extensions.ST_X(r.location::extensions.geometry) lng,
                   extensions.ST_Y(r.location::extensions.geometry) lat
              from resources r
              join assignments a on a.resource_id = r.id
                   and a.status in ('proposed','approved','en_route','on_site')
              join incidents i on i.id = a.incident_id, me
             where r.city_id = $3
               and extensions.ST_DWithin(i.location, me.g, $4)
             limit 20
            """,
            lng, lat, city_id, metres,
        )
    ]
    return incidents, alerts, facilities, units


# ============================================================= field =========
class FieldStatusIn(Camel):
    subject_type: Literal["resource", "lifeline"] = "resource"
    subject_id: str
    status_kind: str
    note: str = ""
    lng: float | None = None
    lat: float | None = None
    #: For a hospital or shelter declaring how full it is.
    occupancy: int | None = None


@router.get("/field/status-kinds")
async def field_status_kinds(_: CurrentPrincipal) -> list[dict]:
    rows = await db.fetch(
        "select id, label, makes_offline, severity, applies_to from field_status_kinds order by applies_to, id"
    )
    return [
        {"id": r["id"], "label": r["label"], "makesOffline": r["makes_offline"],
         "severity": r["severity"], "appliesTo": r["applies_to"]}
        for r in rows
    ]


@router.post("/field/status")
async def field_status(body: FieldStatusIn, principal: CurrentPrincipal) -> dict:
    """A crew tells the control room what is actually true.

    This is not a log entry. A puncture takes the vehicle out of the fleet, a
    hospital declaring itself full stops being a destination the guidance agent
    will send anyone to, and a blocked route becomes a point the router treats
    as impassable. Each of those changes the next plan, which is the difference
    between a status board and a system.
    """
    kind = await db.fetchrow(
        "select id, label, makes_offline, severity, applies_to from field_status_kinds where id = $1",
        body.status_kind,
    )
    if kind is None:
        raise NotFound(f"Unknown status {body.status_kind!r}.")
    if kind["applies_to"] != body.subject_type:
        raise Conflict(f"{kind['label']!r} applies to a {kind['applies_to']}, not a {body.subject_type}.")

    reporter = principal.full_name or principal.operator or "Field"
    effects: list[str] = []

    async with db.transaction() as conn:
        await conn.execute(
            """
            insert into field_reports
              (subject_type, subject_id, status_kind, note, reported_by, location)
            values ($1,$2,$3,$4,$5,
                    case when $6::float8 is null then null else
                      extensions.ST_SetSRID(extensions.ST_MakePoint($6,$7),4326)::extensions.geography
                    end)
            """,
            body.subject_type, body.subject_id, body.status_kind, body.note,
            reporter, body.lng, body.lat,
        )

        if body.subject_type == "resource":
            if kind["makes_offline"]:
                await conn.execute(
                    """
                    update resources
                       set status = 'offline', unavailable_reason = $2,
                           status_note = $3, last_reported_at = now()
                     where id = $1
                    """,
                    body.subject_id, kind["label"], body.note,
                )
                # Anything it was doing is now nobody's job, so it goes back into
                # the pool of unmet need rather than sitting assigned to a
                # vehicle that is not moving.
                released = await conn.fetchval(
                    """
                    update assignments set status = 'complete'
                     where resource_id = $1
                       and status in ('proposed','approved','en_route','on_site')
                    returning incident_id::text
                    """,
                    body.subject_id,
                )
                effects.append(f"{body.subject_id} is out of service: {kind['label'].lower()}.")
                if released:
                    effects.append("Its task was released and will be re-planned.")
            elif body.status_kind == "task_complete":
                await conn.execute(
                    """
                    update assignments set status = 'complete'
                     where resource_id = $1 and status in ('en_route','on_site')
                    """,
                    body.subject_id,
                )
                await conn.execute(
                    "update resources set status = 'available', status_note = $2, "
                    "last_reported_at = now() where id = $1",
                    body.subject_id, body.note,
                )
                effects.append("Task closed, unit back in the pool.")
            else:
                await conn.execute(
                    "update resources set status_note = $2, last_reported_at = now() where id = $1",
                    body.subject_id, f"{kind['label']}. {body.note}".strip(),
                )
                effects.append(f"Noted: {kind['label'].lower()}.")

            if body.status_kind == "route_blocked" and body.lng is not None:
                await conn.execute(
                    """
                    insert into road_blocks (location, reason, reported_by)
                    values (extensions.ST_SetSRID(
                              extensions.ST_MakePoint($1,$2),4326)::extensions.geography,
                            $3, $4)
                    """,
                    body.lng, body.lat, body.note or "Reported impassable by a crew", reporter,
                )
                effects.append(
                    "The point is now treated as impassable when routing anyone, "
                    "including residents."
                )

        else:  # lifeline
            status = {"beds_full": "full", "shelter_full": "full",
                      "beds_limited": "limited", "reopened": "open"}.get(
                          body.status_kind, "limited")
            await conn.execute(
                """
                update lifelines
                   set status = $2,
                       occupancy = coalesce($3, occupancy),
                       last_reported_at = now()
                 where id = $1
                """,
                body.subject_id, status, body.occupancy,
            )
            effects.append(
                f"{body.subject_id} is now {status}."
                + (" Guidance will stop sending people there."
                   if status == "full" else "")
            )

    await ev.append(
        clock=clocks.WALL, kind=f"field.{body.status_kind}",
        actor=f"field:{reporter}", subject_type=body.subject_type,
        subject_id=body.subject_id,
        payload={"status": body.status_kind, "label": kind["label"],
                 "note": body.note, "effects": effects},
    )

    from app.demo import runner as demo_runner

    demo_runner.state.beat("field", f"{reporter}: {kind['label']}. " + " ".join(effects))
    demo_runner.state.dirty = True

    return {"ok": True, "statusKind": body.status_kind, "label": kind["label"],
            "effects": effects}


@router.get("/field/state")
async def field_state(
    principal: CurrentPrincipal,
    operator: str | None = Query(default=None),
    city_id: str = Query(default="pune"),
) -> dict:
    """A crew sees their own agency's units and tasks, and nothing else.

    A field operator has no need for the whole city's fleet, and the row level
    security policy on `field_tasks` refuses it independently of this filter.
    """
    scope = operator if principal.is_staff and operator else principal.operator
    args: list = [city_id]
    where = "r.city_id = $1"
    if scope:
        args.append(scope)
        where += f" and r.operator = ${len(args)}"

    units = [
        {"id": r["id"], "kind": r["kind"], "label": r["label"],
         "operator": r["operator"], "status": r["status"],
         "statusNote": r["status_note"], "unavailableReason": r["unavailable_reason"],
         "location": [float(r["lng"]), float(r["lat"])],
         "capacity": r["capacity"], "assignedTo": r["incident_title"],
         "incidentId": r["incident_id"], "etaMinutes": r["eta_minutes"],
         "incidentLocation": (
             [float(r["ilng"]), float(r["ilat"])] if r["ilng"] is not None else None
         )}
        for r in await db.fetch(
            f"""
            select r.id, r.kind, r.label, r.operator, r.status::text status,
                   r.status_note, r.unavailable_reason, r.capacity,
                   extensions.ST_X(r.location::extensions.geometry) lng,
                   extensions.ST_Y(r.location::extensions.geometry) lat,
                   a.incident_id::text incident_id, a.eta_minutes,
                   i.title incident_title,
                   extensions.ST_X(i.location::extensions.geometry) ilng,
                   extensions.ST_Y(i.location::extensions.geometry) ilat
              from resources r
              left join lateral (
                select * from assignments x where x.resource_id = r.id
                   and x.status in ('proposed','approved','en_route','on_site')
                   and x.sim_run_id is null
                 order by x.created_at desc limit 1) a on true
              left join incidents i on i.id = a.incident_id
             where {where}
             order by r.kind, r.label
            """,
            *args,
        )
    ]

    tasks = await q.list_field_tasks(scope)
    facilities = [
        {"id": r["id"], "name": r["name"], "kind": r["kind"], "status": r["status"],
         "capacity": r["capacity"], "occupancy": r["occupancy"],
         "location": [float(r["lng"]), float(r["lat"])]}
        for r in await db.fetch(
            """
            select id, name, kind, status, capacity, occupancy,
                   extensions.ST_X(location::extensions.geometry) lng,
                   extensions.ST_Y(location::extensions.geometry) lat
              from lifelines where city_id = $1 and kind in ('hospital','shelter')
             order by kind, name
            """,
            city_id,
        )
    ]
    recent = [
        {"subjectId": r["subject_id"], "statusKind": r["status_kind"],
         "note": r["note"], "reportedBy": r["reported_by"],
         "at": r["created_at"].isoformat()}
        for r in await db.fetch(
            "select subject_id, status_kind, note, reported_by, created_at "
            "from field_reports order by created_at desc limit 20"
        )
    ]

    return {"operator": scope, "units": units,
            "tasks": [t.model_dump(by_alias=True) for t in tasks],
            "facilities": facilities, "recent": recent}
