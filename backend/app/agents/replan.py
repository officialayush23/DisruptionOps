"""Re-allocation, when the world changes.

The hazard run produces a plan once. This produces the next one, and the
difference between those two jobs is the whole of PS20's "dynamic re-allocation
on new reports".

Re-planning naively is worse than not re-planning. Solve from scratch on every
new report and the entire city reshuffles every few seconds: units that were
two minutes from a rescue turn around because some arithmetic found a marginally
better global arrangement, and the field stops trusting the screen. So this
does three things a fresh solve does not:

  * it tells the solver what every unit is **already committed to**, and how far
    along it is, so moving one costs something and moving one that is nearly
    there costs a lot;
  * it returns a **diff**, not a plan. Kept, reassigned, newly assigned,
    released, uncovered. The console shows what changed and why, which is the
    only form an officer can actually check;
  * it is **debounced**. Ten reports arriving in twenty seconds produce one
    re-plan, not ten.

Demand comes from incident needs rather than from reports, because four reports
of one flooded road need one pump between them.
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Sequence

from app.core.logging import get_logger
from app.db import session as db
from app.solver import routing
from app.solver.allocation import Demand, Unit, allocate
from app.world import events as ev
from app.world.clock import WALL, Clock

log = get_logger(__name__)

#: Statuses that mean a unit is committed but has not finished.
ACTIVE = ("proposed", "approved", "en_route", "on_site")


@dataclass(slots=True)
class Change:
    kind: str            # kept | reassigned | assigned | released
    resource_id: str
    resource_label: str
    incident_id: str | None
    incident_title: str
    ward_id: str
    from_incident_id: str | None = None
    from_incident_title: str = ""
    eta_minutes: int = 0
    reason: str = ""


@dataclass(slots=True)
class PlanDiff:
    plan_id: str | None
    engine: str
    runtime_ms: int
    coverage: float
    kept: list[Change] = field(default_factory=list)
    assigned: list[Change] = field(default_factory=list)
    reassigned: list[Change] = field(default_factory=list)
    released: list[Change] = field(default_factory=list)
    uncovered: list[dict[str, Any]] = field(default_factory=list)

    @property
    def changed(self) -> int:
        return len(self.assigned) + len(self.reassigned) + len(self.released)

    @property
    def headline(self) -> str:
        if not self.changed:
            return (
                f"No change. {len(self.kept)} unit(s) stay where they are; the new "
                "information did not outweigh what they are already doing."
            )
        bits = []
        if self.assigned:
            bits.append(f"{len(self.assigned)} newly tasked")
        if self.reassigned:
            bits.append(f"{len(self.reassigned)} re-tasked")
        if self.released:
            bits.append(f"{len(self.released)} released")
        tail = f", {len(self.uncovered)} need(s) still unmet" if self.uncovered else ""
        return f"{', '.join(bits)}; {len(self.kept)} unchanged{tail}."


# ------------------------------------------------------------------ inputs ---
async def _open_demands(conn: Any, city_id: str, sim_run_id: str | None) -> list[Demand]:
    """One demand per unit of unmet capability, per open incident."""
    rows = await conn.fetch(
        """
        select i.id::text as incident_id, i.title, i.ward_id, i.severity,
               n.capability_id, n.required,
               extensions.ST_X(i.location::extensions.geometry) as lng,
               extensions.ST_Y(i.location::extensions.geometry) as lat,
               coalesce(wr.population_at_risk, w.population / 8) as exposed
          from incidents i
          join incident_needs n on n.incident_id = i.id
          join wards w on w.id = i.ward_id
          left join lateral (
            select population_at_risk from ward_risks
             where ward_id = i.ward_id order by created_at desc limit 1
          ) wr on true
         where i.city_id = $1
           and i.sim_run_id is not distinct from $2::uuid
           and i.status <> 'resolved'
           and n.required > 0
         order by i.severity desc, i.updated_at desc
        """,
        city_id, sim_run_id,
    )
    demands: list[Demand] = []
    for r in rows:
        for k in range(int(r["required"])):
            demands.append(
                Demand(
                    id=f"{r['incident_id']}:{r['capability_id']}:{k}",
                    ward_id=r["ward_id"],
                    incident_id=r["incident_id"],
                    capability=r["capability_id"],
                    purpose=r["title"],
                    location=(float(r["lng"]), float(r["lat"])),
                    severity=int(r["severity"]),
                    population_at_risk=int(r["exposed"] or 0),
                )
            )
    return demands


async def _fleet(
    conn: Any, city_id: str, sim_run_id: str | None, now: datetime
) -> tuple[list[Unit], dict[str, str], dict[str, float], dict[str, dict]]:
    """Every unit that could be used, plus what it is doing and how far along.

    Units that are already committed are included rather than excluded. That is
    the point: the solver has to be able to move one, and to know what moving it
    would cost.
    """
    rows = await conn.fetch(
        """
        select r.id, r.kind, r.label, r.operator, r.capacity, r.status,
               extensions.ST_X(r.location::extensions.geometry) as lng,
               extensions.ST_Y(r.location::extensions.geometry) as lat,
               a.id::text          as assignment_id,
               a.incident_id::text as incident_id,
               a.eta_minutes,
               a.created_at,
               i.title             as incident_title
          from resources r
          left join lateral (
            select * from assignments x
             where x.resource_id = r.id
               and x.status = any($3::assignment_status[])
               and x.sim_run_id is not distinct from $2::uuid
             order by x.created_at desc limit 1
          ) a on true
          left join incidents i on i.id = a.incident_id
         where r.city_id = $1
           and r.status <> 'offline'
         order by r.kind, r.label
        """,
        city_id, sim_run_id, list(ACTIVE),
    )

    units: list[Unit] = []
    current: dict[str, str] = {}
    progress: dict[str, float] = {}
    context: dict[str, dict] = {}

    for r in rows:
        units.append(
            Unit(
                id=r["id"], kind=r["kind"], label=r["label"], operator=r["operator"],
                location=(float(r["lng"]), float(r["lat"])), capacity=r["capacity"],
            )
        )
        context[r["id"]] = {
            "assignment_id": r["assignment_id"],
            "incident_id": r["incident_id"],
            "incident_title": r["incident_title"] or "",
            "label": r["label"],
            "operator": r["operator"],
        }
        if r["incident_id"]:
            # Any demand of this incident counts as "where it is already going".
            current[r["id"]] = r["incident_id"]
            eta = max(1, int(r["eta_minutes"] or 1))
            elapsed = (now - r["created_at"]).total_seconds() / 60.0
            progress[r["id"]] = max(0.0, min(1.0, elapsed / eta))
    return units, current, progress, context


async def _blocked_points(
    conn: Any, city_id: str, sim_run_id: str | None
) -> list[tuple[float, float]]:
    """Places a vehicle should not be routed through.

    Two sources, both real: roads a crew has declared impassable, and open
    incidents whose category means the road itself is the problem. A waterlogged
    basement does not block a street; a collapsed wall across one does, and the
    taxonomy already knows the difference.
    """
    rows = await conn.fetch(
        """
        select extensions.ST_X(location::extensions.geometry) lng,
               extensions.ST_Y(location::extensions.geometry) lat
          from road_blocks where city_id = $1 and active
        union all
        select extensions.ST_X(i.location::extensions.geometry),
               extensions.ST_Y(i.location::extensions.geometry)
          from incidents i
         where i.city_id = $1
           and i.sim_run_id is not distinct from $2::uuid
           and i.status <> 'resolved'
           and i.category in ('flooded_road','structural_damage','power_line','fallen_tree')
        """,
        city_id, sim_run_id,
    )
    return [(float(r["lng"]), float(r["lat"])) for r in rows]


# ------------------------------------------------------------------ replan ---
async def replan(
    *,
    city_id: str = "pune",
    clock: Clock = WALL,
    trigger: str = "manual",
    caused_by: int | None = None,
    actor: str = "agent:allocation_planner",
) -> PlanDiff:
    """Re-solve against the current world and return what changed."""
    now = clock.now()
    sim_run_id = clock.sim_run_id

    async with db.transaction() as conn:
        demands = await _open_demands(conn, city_id, sim_run_id)
        units, current_raw, progress, context = await _fleet(conn, city_id, sim_run_id, now)

        if not demands:
            return PlanDiff(plan_id=None, engine="none", runtime_ms=0, coverage=1.0)

        # `current` maps unit -> demand id. A unit committed to an incident is
        # treated as committed to any demand of that incident, so staying on the
        # same job is free even when the specific demand row was rebuilt.
        by_incident: dict[str, list[str]] = {}
        for d in demands:
            if d.incident_id:
                by_incident.setdefault(d.incident_id, []).append(d.id)
        current: dict[str, str] = {}
        for unit_id, incident_id in current_raw.items():
            ids = by_incident.get(incident_id)
            if ids:
                current[unit_id] = ids[0]

        # Every hazard the city currently believes in, as a point a route should
        # not pass through. Fed to both the matrix (so a blocked pairing costs
        # more and the solver prefers a unit that can actually get there) and to
        # each route (so the geometry itself goes round).
        blocked = await _blocked_points(conn, city_id, sim_run_id)

        started = time.perf_counter()
        matrix = await routing.travel_matrix(
            [u.location for u in units], [d.location for d in demands], blocked
        )
        result = allocate(demands, units, matrix, current=current, progress=progress)
        runtime = int((time.perf_counter() - started) * 1000)

        plan = await conn.fetchrow(
            """
            insert into allocation_plans
              (hazard, objective, solver, uncovered, sim_run_id, generated_at)
            values ($1,$2,$3,$4,$5::uuid,$6)
            returning id::text
            """,
            "flood", result.objective_text,
            {
                "engine": result.engine, "runtime_ms": result.runtime_ms,
                "variables": result.variables, "constraints": result.constraints,
                "coverage": round(result.coverage, 4), "trigger": trigger,
            },
            [
                {"ward_id": u.demand.ward_id, "incident_id": u.demand.incident_id,
                 "need": u.demand.capability, "reason": u.reason, "shortfall": u.shortfall}
                for u in result.unmet
            ],
            sim_run_id, now,
        )
        plan_id = plan["id"]

        diff = PlanDiff(
            plan_id=plan_id, engine=result.engine, runtime_ms=runtime,
            coverage=round(result.coverage, 4),
            uncovered=[
                {"ward_id": u.demand.ward_id, "incident_id": u.demand.incident_id,
                 "capability": u.demand.capability, "reason": u.reason}
                for u in result.unmet
            ],
        )

        plan_event = await ev.append(
            clock=clock, kind=ev.Kind.PLAN_GENERATED, actor=actor,
            subject_type="plan", subject_id=plan_id, city_id=city_id,
            payload={"trigger": trigger, "engine": result.engine,
                     "demands": len(demands), "units": len(units),
                     "coverage": diff.coverage},
            caused_by=caused_by, conn=conn,
        )

        new_by_unit = {a.unit.id: a for a in result.allocations}

        for unit_id, ctx in context.items():
            was = current_raw.get(unit_id)
            now_alloc = new_by_unit.get(unit_id)
            to = now_alloc.demand.incident_id if now_alloc else None

            if was and to and was == to:
                diff.kept.append(Change(
                    kind="kept", resource_id=unit_id, resource_label=ctx["label"],
                    incident_id=to, incident_title=ctx["incident_title"],
                    ward_id=now_alloc.demand.ward_id, eta_minutes=now_alloc.eta_minutes,
                    reason="Already committed here and still the right unit for it.",
                ))
                continue

            if was and to and was != to:
                pct = int(progress.get(unit_id, 0.0) * 100)
                change = Change(
                    kind="reassigned", resource_id=unit_id, resource_label=ctx["label"],
                    incident_id=to, incident_title=now_alloc.demand.purpose,
                    ward_id=now_alloc.demand.ward_id,
                    from_incident_id=was, from_incident_title=ctx["incident_title"],
                    eta_minutes=now_alloc.eta_minutes,
                    reason=(
                        f"Moved from \"{ctx['incident_title']}\" ({pct}% of the way there) "
                        f"because \"{now_alloc.demand.purpose}\" is severity "
                        f"{now_alloc.demand.severity} with "
                        f"{now_alloc.demand.population_at_risk:,} exposed."
                    ),
                )
                diff.reassigned.append(change)
                await conn.execute(
                    "update assignments set status = 'complete' where id = $1::uuid",
                    ctx["assignment_id"],
                )
                await _write_assignment(conn, plan_id, now_alloc, sim_run_id, now, blocked)
                await ev.append(
                    clock=clock, kind=ev.Kind.ASSIGNMENT_CHANGED, actor=actor,
                    subject_type="resource", subject_id=unit_id, city_id=city_id,
                    ward_id=now_alloc.demand.ward_id,
                    payload={"from_incident": was, "to_incident": to,
                             "progress_pct": pct, "reason": change.reason},
                    caused_by=plan_event.id, conn=conn,
                )
                continue

            if not was and to and now_alloc:
                change = Change(
                    kind="assigned", resource_id=unit_id, resource_label=ctx["label"],
                    incident_id=to, incident_title=now_alloc.demand.purpose,
                    ward_id=now_alloc.demand.ward_id, eta_minutes=now_alloc.eta_minutes,
                    reason=f"Nearest available unit able to provide {now_alloc.demand.capability}.",
                )
                diff.assigned.append(change)
                await conn.execute(
                    "update resources set status = 'assigned', updated_at = $2 where id = $1",
                    unit_id, now,
                )
                await _write_assignment(conn, plan_id, now_alloc, sim_run_id, now, blocked)
                await ev.append(
                    clock=clock, kind=ev.Kind.ASSIGNMENT_CREATED, actor=actor,
                    subject_type="assignment", subject_id=to, city_id=city_id,
                    ward_id=now_alloc.demand.ward_id,
                    payload={"resource_id": unit_id, "eta_minutes": now_alloc.eta_minutes,
                             "capability": now_alloc.demand.capability},
                    caused_by=plan_event.id, conn=conn,
                )
                continue

            if was and not to:
                diff.released.append(Change(
                    kind="released", resource_id=unit_id, resource_label=ctx["label"],
                    incident_id=None, incident_title="", ward_id="",
                    from_incident_id=was, from_incident_title=ctx["incident_title"],
                    reason="No longer needed there, and nothing else is closer to it.",
                ))
                await conn.execute(
                    "update assignments set status = 'complete' where id = $1::uuid",
                    ctx["assignment_id"],
                )
                await conn.execute(
                    "update resources set status = 'available', updated_at = $2 where id = $1",
                    unit_id, now,
                )
                await ev.append(
                    clock=clock, kind=ev.Kind.ASSIGNMENT_CANCELLED, actor=actor,
                    subject_type="resource", subject_id=unit_id, city_id=city_id,
                    payload={"from_incident": was},
                    caused_by=plan_event.id, conn=conn,
                )

        # Needs coverage, so the console can show a shortfall rather than make
        # someone derive it from two other screens.
        # One aggregate pass, and only rows whose number actually moved.
        #
        # This was a correlated `select count(*)` evaluated once per need row,
        # inside the same transaction that had just rewritten assignments and
        # resources, while the demo tick loop was moving the whole fleet. Every
        # need row took a row lock whether or not its value changed, the tick's
        # fleet update waited on those locks, and the statement timed out. The
        # `is distinct from` guard is the important half: on a normal re-plan
        # almost nothing changes, so almost nothing is locked.
        await conn.execute(
            """
            with counts as (
              select a.incident_id, count(*)::int n
                from assignments a
               where a.status = any($1::assignment_status[])
               group by a.incident_id
            )
            update incident_needs n
               set met = coalesce(c.n, 0), updated_at = $2
              from incidents i
              left join counts c on c.incident_id = i.id
             where i.id = n.incident_id
               and i.status <> 'resolved'
               and n.met is distinct from coalesce(c.n, 0)
            """,
            list(ACTIVE), now,
        )

        for u in result.unmet:
            await ev.append(
                clock=clock, kind=ev.Kind.DEMAND_UNCOVERED, actor=actor,
                subject_type="incident", subject_id=u.demand.incident_id or u.demand.ward_id,
                city_id=city_id, ward_id=u.demand.ward_id,
                payload={"capability": u.demand.capability, "reason": u.reason},
                caused_by=plan_event.id, conn=conn,
            )

    log.info(
        "replan_complete", trigger=trigger, engine=result.engine,
        kept=len(diff.kept), assigned=len(diff.assigned),
        reassigned=len(diff.reassigned), released=len(diff.released),
        uncovered=len(diff.uncovered),
    )
    return diff


async def _write_assignment(conn: Any, plan_id: str, alloc: Any, sim_run_id: str | None,
                            now: datetime, blocked: Sequence[tuple[float, float]] = ()) -> str:
    # The road, not the line. A crew given a straight bearing to a flooded
    # junction is being given nothing, and a unit that moves across blocks on
    # the console looks like a simulation rather than a dispatch. The geometry
    # is stored so the unit drives it, the field app can show it, and the
    # console can draw what every committed unit is actually doing.
    line = await routing.route_line(alloc.unit.location, alloc.demand.location, blocked)
    geometry = (
        {"type": "LineString", "coordinates": line.coordinates}
        if len(line.coordinates) > 1
        else None
    )
    steps = [
        {"instruction": s.instruction, "street": s.street, "distanceM": s.distance_m}
        for s in line.steps
    ]

    row = await conn.fetchrow(
        """
        insert into assignments
          (plan_id, resource_id, incident_id, ward_id, purpose, eta_minutes,
           distance_km, status, sim_run_id, created_at,
           route, route_engine, progress, steps)
        values ($1::uuid,$2,$3::uuid,$4,$5,$6,$7,'proposed',$8::uuid,$9,
                case when $10::text is null then null
                     else extensions.ST_SetSRID(
                            extensions.ST_GeomFromGeoJSON($10::text), 4326) end,
                $11, 0, $12)
        returning id::text
        """,
        plan_id, alloc.unit.id, alloc.demand.incident_id, alloc.demand.ward_id,
        alloc.demand.purpose,
        # The router's own number when it answered, the solver's estimate when
        # it did not. Never the optimistic one.
        line.minutes if line.is_real_road else alloc.eta_minutes,
        round(line.km if line.is_real_road else alloc.distance_km, 2),
        sim_run_id, now,
        json.dumps(geometry) if geometry else None,
        line.engine,
        steps,
    )
    await conn.execute(
        """
        insert into field_tasks
          (assignment_id, resource_id, operator, title, instruction, location,
           ward_id, priority, sim_run_id, created_at)
        values ($1::uuid,$2,$3,$4,$5,
                extensions.ST_SetSRID(extensions.ST_MakePoint($6,$7),4326)::extensions.geography,
                $8,$9,$10::uuid,$11)
        """,
        row["id"], alloc.unit.id, alloc.unit.operator, alloc.demand.purpose,
        f"{alloc.demand.purpose}. {alloc.unit.label}, {alloc.eta_minutes} minutes out. "
        "Confirm on arrival and record what you found before closing the task.",
        alloc.demand.location[0], alloc.demand.location[1], alloc.demand.ward_id,
        alloc.demand.severity, sim_run_id, now,
    )
    return row["id"]
