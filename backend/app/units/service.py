"""Units on the move: position reports, off-route rerouting, replans, and each unit's log.

A unit's position comes from the field app's GPS (or the simulator). Each report:

  1. moves the unit (resources.location) and appends to unit_positions;
  2. measures it against its assignment's road: progress along it, and how
     far off it the unit is;
  3. if it is more than OFF_ROUTE_M off its road on two reports in a row, the
     road is redrawn from where the unit actually is (same assignment, new
     geometry, `assignment.rerouted` with the reason);
  4. if a unit without a job has moved more than REPLAN_MOVE_M since it was
     last planned for, `unit.moved` is logged, which asks the planner to
     replan: its distance to every open need has changed.

The log of a unit is everything that happened to it, in one timeline: events
about it (assignments, reroutes, status), its field reports and its positions.
"""
from __future__ import annotations

import csv
import io
import json
from datetime import datetime, timezone
from typing import Any

from app.core.logging import get_logger
from app.db import session as db
from app.world import clock as clocks
from app.world import events as ev

log = get_logger(__name__)

OFF_ROUTE_M = 150.0
REPLAN_MOVE_M = 1000.0
ACTIVE = ("proposed", "approved", "en_route", "on_site")


async def report_position(unit_id: str, lng: float, lat: float, *, speed_kmh: float | None = None,
                          heading_deg: float | None = None, accuracy_m: float | None = None,
                          source: str = "gps", at: datetime | None = None, reporter: str = "field") -> dict:
    at = at or datetime.now(timezone.utc)
    async with db.transaction() as conn:
        unit = await conn.fetchrow(
            "select id, kind, label, status::text status, city_id, "
            "extensions.ST_X(location::extensions.geometry) lng, extensions.ST_Y(location::extensions.geometry) lat "
            "from resources where id = $1 for update", unit_id)
        if unit is None:
            return {"ok": False, "error": f"no unit {unit_id}"}
        a = await conn.fetchrow(
            f"""
            select a.id::text id, a.incident_id::text incident_id, a.ward_id, a.status::text status,
                   a.route is not null has_route,
                   case when a.route is null then null else
                     extensions.ST_LineLocatePoint(a.route::extensions.geometry,
                       extensions.ST_SetSRID(extensions.ST_MakePoint($2,$3),4326)) end as progress,
                   case when a.route is null then null else
                     extensions.ST_Distance(a.route::extensions.geography,
                       extensions.ST_SetSRID(extensions.ST_MakePoint($2,$3),4326)::extensions.geography) end as off_m,
                   extensions.ST_X(i.location::extensions.geometry) ilng,
                   extensions.ST_Y(i.location::extensions.geometry) ilat, i.title
              from assignments a join incidents i on i.id = a.incident_id
             where a.resource_id = $1 and a.status = any($4::assignment_status[])
             order by a.created_at desc limit 1
            """, unit_id, lng, lat, list(ACTIVE))
        await conn.execute(
            "update resources set location = extensions.ST_SetSRID(extensions.ST_MakePoint($2,$3),4326)::extensions.geography, "
            "last_reported_at = $4 where id = $1", unit_id, lng, lat, at)
        prev_off = await conn.fetchval(
            "select off_route_m from unit_positions where resource_id = $1 order by recorded_at desc limit 1", unit_id)
        await conn.execute(
            "insert into unit_positions (city_id, resource_id, recorded_at, location, speed_kmh, heading_deg, accuracy_m, "
            "source, assignment_id, off_route_m, progress) values ($1,$2,$3, "
            "extensions.ST_SetSRID(extensions.ST_MakePoint($4,$5),4326)::extensions.geography, $6,$7,$8,$9,$10::uuid,$11,$12)",
            unit["city_id"], unit_id, at, lng, lat, speed_kmh, heading_deg, accuracy_m, source,
            a["id"] if a else None, a["off_m"] if a else None, a["progress"] if a else None)
        if a and a["progress"] is not None:
            await conn.execute("update assignments set progress = greatest(progress, $2) where id = $1::uuid",
                               a["id"], float(a["progress"]))

    out: dict[str, Any] = {"ok": True, "unit": unit_id, "assignment": a["id"] if a else None,
                           "progress": round(float(a["progress"]), 3) if a and a["progress"] is not None else None,
                           "offRouteM": round(float(a["off_m"]), 1) if a and a["off_m"] is not None else None,
                           "rerouted": False, "replanAsked": False}

    # off its road twice in a row -> redraw from where it is
    if (a and a["off_m"] is not None and a["off_m"] > OFF_ROUTE_M and prev_off is not None
            and prev_off > OFF_ROUTE_M and a["ilng"] is not None):
        out["rerouted"] = await reroute_from_here(unit, a, (lng, lat), float(a["off_m"]), reporter)

    # a free unit that moved far: every distance changed, so plan again
    if not a:
        anchor = await db.fetchrow(
            "select (payload->>'lng')::float8 lng, (payload->>'lat')::float8 lat from events "
            "where subject_type='resource' and subject_id=$1 and kind='unit.moved' order by id desc limit 1", unit_id)
        if anchor is None:
            anchor = await db.fetchrow(
                "select extensions.ST_X(base_location::extensions.geometry) lng, "
                "extensions.ST_Y(base_location::extensions.geometry) lat from resources where id=$1", unit_id)
        dist = 0.0
        if anchor and anchor["lng"] is not None:
            dist = float(await db.fetchval(
                "select extensions.ST_Distance(extensions.ST_SetSRID(extensions.ST_MakePoint($1,$2),4326)::extensions.geography, "
                "extensions.ST_SetSRID(extensions.ST_MakePoint($3,$4),4326)::extensions.geography)",
                lng, lat, anchor["lng"], anchor["lat"]))
        if dist >= REPLAN_MOVE_M:
            await ev.append(clock=clocks.WALL, kind="unit.moved", actor=f"field:{reporter}", subject_type="resource",
                            subject_id=unit_id, city_id=unit["city_id"],
                            payload={"metres": round(dist), "lng": lng, "lat": lat, "resource_id": unit_id,
                                     "reason": f"{unit['label']} moved {dist / 1000:.1f} km while free; "
                                               "its distance to every open need changed, so the plan is redone"})
            out["replanAsked"] = True
    return out


async def reroute_from_here(unit, a, here: tuple[float, float], off_m: float, reporter: str) -> bool:
    from app.agents.replan import _blocked_points
    from app.solver import routing
    async with db.transaction() as conn:
        blocked = await _blocked_points(conn, unit["city_id"], None)
    line = await routing.route_line(here, (float(a["ilng"]), float(a["ilat"])), blocked)
    if len(line.coordinates) < 2:
        return False
    geometry = {"type": "LineString", "coordinates": line.coordinates}
    async with db.transaction() as conn:
        await conn.execute(
            "update assignments set route = extensions.ST_SetSRID(extensions.ST_GeomFromGeoJSON($2::text),4326), "
            "route_engine = $3, eta_minutes = $4, distance_km = $5, steps = $6, progress = 0 where id = $1::uuid",
            a["id"], json.dumps(geometry), line.engine, line.minutes, round(line.km, 2),
            [{"instruction": s.instruction, "street": s.street, "distanceM": s.distance_m} for s in line.steps])
        await ev.append(
            clock=clocks.WALL, kind="assignment.rerouted", actor=f"field:{reporter}", subject_type="resource",
            subject_id=unit["id"], city_id=unit["city_id"], ward_id=a["ward_id"],
            payload={"to_incident": a["incident_id"], "resource_id": unit["id"], "trigger": "off_route",
                     "reason": f"{unit['label']} is {off_m:.0f} m off its road to \"{a['title']}\". "
                               f"Redrawn from where it is; {line.minutes} min now.",
                     "off_route_m": round(off_m), "eta_minutes": line.minutes, "engine": line.engine,
                     "still_exposed": line.passes_near_blocks},
            conn=conn)
    return True


# ------------------------------------------------------------------------ log --
async def unit_log(unit_id: str, since: datetime | None = None, until: datetime | None = None,
                   positions: bool = True, limit: int = 2000) -> list[dict]:
    rows: list[dict] = []
    evs = await db.fetch(
        """
        select id, occurred_at, kind, actor, subject_type, subject_id, ward_id, payload,
               hazard_id, sector_id
          from agent_log
         where ((subject_type = 'resource' and subject_id = $1) or payload->>'resource_id' = $1)
           and ($2::timestamptz is null or occurred_at >= $2)
           and ($3::timestamptz is null or occurred_at <= $3)
         order by occurred_at desc limit $4
        """, unit_id, since, until, limit)
    for r in evs:
        p = r["payload"] if isinstance(r["payload"], dict) else json.loads(r["payload"] or "{}")
        rows.append({"at": r["occurred_at"].isoformat(), "type": "event", "kind": r["kind"], "actor": r["actor"],
                     "summary": p.get("reason") or p.get("note") or p.get("label") or _summarise(r["kind"], p),
                     "incident": p.get("to_incident") or (r["subject_id"] if r["subject_type"] == "assignment" else None),
                     "ward": r["ward_id"], "hazard": r["hazard_id"], "sector": r["sector_id"], "eventId": r["id"],
                     "detail": p})
    frs = await db.fetch(
        "select created_at, status_kind, note, reported_by, extensions.ST_X(location::extensions.geometry) lng, "
        "extensions.ST_Y(location::extensions.geometry) lat from field_reports "
        "where subject_type='resource' and subject_id=$1 and ($2::timestamptz is null or created_at >= $2) "
        "and ($3::timestamptz is null or created_at <= $3) order by created_at desc limit $4",
        unit_id, since, until, limit)
    for r in frs:
        rows.append({"at": r["created_at"].isoformat(), "type": "field_report", "kind": r["status_kind"],
                     "actor": r["reported_by"], "summary": r["note"] or r["status_kind"], "lng": r["lng"], "lat": r["lat"]})
    if positions:
        ps = await db.fetch(
            "select recorded_at, extensions.ST_X(location::extensions.geometry) lng, "
            "extensions.ST_Y(location::extensions.geometry) lat, speed_kmh, off_route_m, progress, source "
            "from unit_positions where resource_id=$1 and ($2::timestamptz is null or recorded_at >= $2) "
            "and ($3::timestamptz is null or recorded_at <= $3) order by recorded_at desc limit $4",
            unit_id, since, until, limit)
        for r in ps:
            rows.append({"at": r["recorded_at"].isoformat(), "type": "position", "kind": r["source"],
                         "summary": f"at {r['lat']:.5f}, {r['lng']:.5f}"
                                    + (f", {r['off_route_m']:.0f} m off route" if r["off_route_m"] else ""),
                         "lng": r["lng"], "lat": r["lat"], "speedKmh": r["speed_kmh"],
                         "offRouteM": r["off_route_m"], "progress": r["progress"]})
    rows.sort(key=lambda x: x["at"], reverse=True)
    return rows[:limit]


def _summarise(kind: str, p: dict) -> str:
    if kind == "assignment.created":
        return f"Dispatched ({p.get('capability') or p.get('capability_id') or 'task'}), {p.get('eta_minutes', '?')} min out"
    if kind == "assignment.cancelled":
        return "Assignment cancelled"
    if kind == "assignment.changed":
        return "Re-tasked"
    return kind.replace(".", " ").replace("_", " ")


def to_csv(rows: list[dict], unit_id: str | None = None) -> str:
    buf = io.StringIO()
    cols = ["unit", "at", "type", "kind", "actor", "summary", "incident", "ward", "sector", "hazard", "lng", "lat",
            "speedKmh", "offRouteM", "progress", "eventId"]
    w = csv.DictWriter(buf, fieldnames=cols, extrasaction="ignore")
    w.writeheader()
    for r in rows:
        w.writerow({"unit": r.get("unit", unit_id), **r})
    return buf.getvalue()


async def units_overview(city_id: str = "pune", prefix: str | None = None) -> list[dict]:
    rows = await db.fetch(
        """
        select r.id, r.kind, r.label, r.status::text status, r.agency_id, r.status_note, r.unavailable_reason,
               r.last_reported_at, extensions.ST_X(r.location::extensions.geometry) lng,
               extensions.ST_Y(r.location::extensions.geometry) lat,
               a.id::text assignment_id, a.incident_id::text incident_id, a.capability_id, a.eta_minutes,
               a.progress, a.status::text assignment_status, i.title incident_title, i.category,
               (select count(*) from unit_positions p where p.resource_id = r.id) positions,
               (select count(*) from events e where e.subject_type='resource' and e.subject_id=r.id
                 and e.kind = 'assignment.rerouted') reroutes
          from resources r
          left join lateral (select * from assignments a where a.resource_id = r.id
                               and a.status = any($2::assignment_status[]) order by a.created_at desc limit 1) a on true
          left join incidents i on i.id = a.incident_id
         where r.city_id = $1 and ($3::text is null or r.id like $3 || '%')
         order by r.kind, r.id
        """, city_id, list(ACTIVE), prefix)
    return [{k: (v.isoformat() if isinstance(v, datetime) else v) for k, v in dict(r).items()} for r in rows]


async def track(unit_id: str, since: datetime | None = None, limit: int = 1000) -> dict:
    ps = await db.fetch(
        "select recorded_at, extensions.ST_X(location::extensions.geometry) lng, "
        "extensions.ST_Y(location::extensions.geometry) lat from unit_positions where resource_id=$1 "
        "and ($2::timestamptz is null or recorded_at >= $2) order by recorded_at desc limit $3", unit_id, since, limit)
    coords = [[r["lng"], r["lat"]] for r in reversed(ps)]
    route = await db.fetchrow(
        "select extensions.ST_AsGeoJSON(a.route)::text g, a.progress, a.eta_minutes, a.incident_id::text incident_id "
        "from assignments a where a.resource_id=$1 and a.status = any($2::assignment_status[]) and a.route is not null "
        "order by a.created_at desc limit 1", unit_id, list(ACTIVE))
    return {"unit": unit_id, "trail": {"type": "LineString", "coordinates": coords},
            "times": [r["recorded_at"].isoformat() for r in reversed(ps)],
            "route": json.loads(route["g"]) if route and route["g"] else None,
            "progress": route["progress"] if route else None, "etaMinutes": route["eta_minutes"] if route else None,
            "incidentId": route["incident_id"] if route else None}


async def teams(city_id: str = "pune") -> list[dict]:
    """Each open incident with its needs per capability and the units covering them."""
    rows = await db.fetch(
        """
        select i.id::text incident_id, i.title, i.category, i.severity, i.ward_id,
               coalesce(json_agg(distinct jsonb_build_object('capability', n.capability_id, 'required', n.required))
                        filter (where n.capability_id is not null), '[]') needs,
               coalesce(json_agg(distinct jsonb_build_object('unit', a.resource_id, 'kind', r.kind, 'label', r.label,
                        'capability', a.capability_id, 'status', a.status::text, 'eta', a.eta_minutes,
                        'progress', a.progress)) filter (where a.id is not null), '[]') units
          from incidents i
          left join incident_needs n on n.incident_id = i.id
          left join assignments a on a.incident_id = i.id and a.status = any($2::assignment_status[])
          left join resources r on r.id = a.resource_id
         where i.city_id = $1 and i.status <> 'resolved'
         group by i.id order by i.severity desc nulls last, i.created_at desc limit 200
        """, city_id, list(ACTIVE))
    out = []
    for r in rows:
        needs = r["needs"] if isinstance(r["needs"], list) else json.loads(r["needs"])
        units = r["units"] if isinstance(r["units"], list) else json.loads(r["units"])
        covered = {}
        for u in units:
            covered[u.get("capability")] = covered.get(u.get("capability"), 0) + 1
        for n in needs:
            n["met"] = covered.get(n["capability"], 0)
        out.append({"incidentId": r["incident_id"], "title": r["title"], "category": r["category"],
                    "severity": r["severity"], "wardId": r["ward_id"], "needs": needs, "units": units,
                    "complete": all(n["met"] >= n["required"] for n in needs) if needs else bool(units)})
    return out
