"""Where should I go, and why?

This is the citizen-side agent. It answers one question, in one sentence, with a
route attached: given where you are, what you need, and every hazard and road
block currently known, which specific place should you go to?

It is deliberately small and deliberately deterministic, because of where it is
meant to run. The production intent is a quantised model on the phone itself,
offline, during a flood. That rules out anything that needs a large model or a
round trip to decide, so the decision here is arithmetic over facts, and the
only thing prose is used for is explaining a choice that has already been made.

Three things it will not do, and each omission is a decision:

  * It does not invent a place. Every candidate is a row in `lifelines`.
  * It does not route you through a hazard because that path was shorter. A
    route is scored on exposure first and distance second, and it says so.
  * It does not tell you that you are safe. It tells you what is known, what is
    not, and what it would do. A confident evacuation instruction from a system
    that cannot see the water is worse than no instruction.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Literal

from app.core.logging import get_logger
from app.db import session as db
from app.solver import routing

log = get_logger(__name__)

Intent = Literal["shelter", "hospital", "safety", "ambulance", "stay"]

#: A candidate within this many metres of a known hazard is treated as exposed.
HAZARD_RADIUS_M = 400
#: Beyond this, walking is not a realistic instruction during a flood.
WALKABLE_KM = 2.5


@dataclass(slots=True)
class Candidate:
    id: str
    name: str
    kind: str
    lng: float
    lat: float
    distance_km: float
    capacity: int | None
    occupancy: int | None
    status: str
    specialities: list[str]
    hazards_near: int
    ward_severity: int | None
    score: float = 0.0
    why: list[str] = field(default_factory=list)

    @property
    def spare(self) -> int | None:
        if self.capacity is None:
            return None
        return max(0, self.capacity - (self.occupancy or 0))


@dataclass(slots=True)
class Guidance:
    intent: Intent
    headline: str
    reasoning: list[str]
    destination: Candidate | None
    alternatives: list[Candidate]
    route: list[list[float]]
    route_km: float
    route_minutes: int
    route_engine: str
    avoided_blocks: int
    warnings: list[str]
    #: When the honest answer is "do not move", this is False.
    should_move: bool


def _haversine_km(a: tuple[float, float], b: tuple[float, float]) -> float:
    lon1, lat1 = math.radians(a[0]), math.radians(a[1])
    lon2, lat2 = math.radians(b[0]), math.radians(b[1])
    h = (math.sin((lat2 - lat1) / 2) ** 2
         + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2)
    return 2 * 6371.0 * math.asin(math.sqrt(h))


async def _candidates(
    lng: float, lat: float, intent: Intent, city_id: str
) -> list[Candidate]:
    """Places that could actually take this person right now."""
    if intent == "hospital":
        where = "l.kind = 'hospital' and l.accepts_casualties"
    elif intent in ("shelter", "safety"):
        where = "l.kind = 'shelter'"
    else:
        where = "l.kind in ('shelter','hospital')"

    rows = await db.fetch(
        f"""
        with me as (
          select extensions.ST_SetSRID(
                   extensions.ST_MakePoint($1,$2),4326)::extensions.geography g
        )
        select l.id, l.name, l.kind, l.capacity, l.occupancy, l.status,
               l.specialities,
               extensions.ST_X(l.location::extensions.geometry) lng,
               extensions.ST_Y(l.location::extensions.geometry) lat,
               extensions.ST_Distance(l.location, me.g) / 1000.0 km,
               (select count(*) from incidents i
                 where i.status <> 'resolved'
                   and extensions.ST_DWithin(i.location, l.location, $4))::int hazards_near,
               wr.severity ward_severity
          from lifelines l, me
          left join lateral (
            select severity from ward_risks
             where ward_id = l.ward_id order by created_at desc limit 1
          ) wr on true
         where l.city_id = $3 and {where}
         order by km
         limit 12
        """,
        lng, lat, city_id, HAZARD_RADIUS_M,
    )
    return [
        Candidate(
            id=r["id"], name=r["name"], kind=r["kind"],
            lng=float(r["lng"]), lat=float(r["lat"]),
            distance_km=round(float(r["km"]), 2),
            capacity=r["capacity"], occupancy=r["occupancy"],
            status=r["status"], specialities=list(r["specialities"] or []),
            hazards_near=r["hazards_near"], ward_severity=r["ward_severity"],
        )
        for r in rows
    ]


def _score(c: Candidate, intent: Intent, condition: str | None) -> Candidate:
    """Rank a destination. Room first, then exposure, then distance.

    The ordering is the argument. The nearest shelter is the wrong answer if it
    is full, and a slightly further hospital is the right answer if the near one
    cannot treat what you have. Distance only breaks ties between places that
    can actually help.
    """
    why: list[str] = []
    score = 1.0

    if c.status in ("full", "closed"):
        return _reject(c, f"{c.name} has reported itself {c.status}.")

    spare = c.spare
    if spare is not None:
        if spare <= 0:
            return _reject(c, f"{c.name} is at capacity.")
        room = min(1.0, spare / 120.0)
        score *= 0.45 + 0.55 * room
        why.append(f"{spare} place(s) free")
    elif c.status == "limited":
        score *= 0.7
        why.append("reported limited capacity")

    if intent == "hospital" and condition:
        wanted = _speciality_for(condition)
        if wanted and c.specialities and wanted not in c.specialities:
            score *= 0.55
            why.append(f"does not list {wanted}")
        elif wanted:
            why.append(f"handles {wanted}")

    if c.hazards_near:
        score *= max(0.25, 1.0 - 0.22 * c.hazards_near)
        why.append(f"{c.hazards_near} open incident(s) within 400 m of it")
    if c.ward_severity and c.ward_severity >= 4:
        score *= 0.65
        why.append(f"its own ward is at severity {c.ward_severity}")

    # Distance is a tiebreak, not the objective.
    score *= 1.0 / (1.0 + c.distance_km / 3.0)
    why.append(f"{c.distance_km:g} km away")

    c.score = round(score, 4)
    c.why = why
    return c


def _reject(c: Candidate, reason: str) -> Candidate:
    c.score = 0.0
    c.why = [reason]
    return c


def _speciality_for(condition: str) -> str | None:
    text = condition.lower()
    if any(w in text for w in ("bleed", "fracture", "broken", "crush", "accident", "injur")):
        return "trauma"
    if any(w in text for w in ("breath", "chest", "heart", "cardiac")):
        return "cardiac"
    if any(w in text for w in ("baby", "birth", "pregnan", "labour", "labor")):
        return "maternity"
    if any(w in text for w in ("child", "infant")):
        return "paediatric"
    return None


async def _blocks(city_id: str) -> list[tuple[float, float]]:
    rows = await db.fetch(
        """
        select extensions.ST_X(location::extensions.geometry) lng,
               extensions.ST_Y(location::extensions.geometry) lat
          from road_blocks where city_id = $1 and active
        union all
        select extensions.ST_X(i.location::extensions.geometry),
               extensions.ST_Y(i.location::extensions.geometry)
          from incidents i
         where i.city_id = $1 and i.status <> 'resolved'
           and i.category in ('flooded_road','structural_damage','power_line')
        """,
        city_id,
    )
    return [(float(r["lng"]), float(r["lat"])) for r in rows]


async def guide(
    *,
    lng: float,
    lat: float,
    intent: Intent = "safety",
    condition: str | None = None,
    city_id: str = "pune",
) -> Guidance:
    """The whole answer: where, why, how, and what we do not know."""
    warnings: list[str] = []
    reasoning: list[str] = []

    ward = await db.fetchrow(
        """
        select w.id, w.name,
               wr.severity, wr.score, wr.lead_time_hours
          from wards w
          left join lateral (
            select severity, score, lead_time_hours from ward_risks
             where ward_id = w.id order by created_at desc limit 1
          ) wr on true
         where w.city_id = $3
           and extensions.ST_Covers(
                 w.boundary::extensions.geometry,
                 extensions.ST_SetSRID(extensions.ST_MakePoint($1,$2),4326))
         limit 1
        """,
        lng, lat, city_id,
    )
    here_severity = ward["severity"] if ward and ward["severity"] is not None else None
    where_am_i = ward["name"] if ward else None
    if ward is None:
        warnings.append(
            "You are outside the area this deployment covers, so the risk here "
            "is not being scored. Treat the advice below as general."
        )

    # Staying put is sometimes the correct instruction, and a system that always
    # sends people somewhere is one that creates its own crowd crush.
    if intent == "safety" and (here_severity is None or here_severity <= 2):
        return Guidance(
            intent=intent,
            headline=(
                f"Stay where you are. {where_am_i or 'Your area'} is not under a "
                "flood warning right now."
                if here_severity is not None
                else "No flood warning is active for your area."
            ),
            reasoning=[
                "Moving during a flood is itself a risk, so it is only worth "
                "doing when staying is worse.",
                "Avoid low-lying roads and underpasses, and keep your phone charged.",
            ],
            destination=None, alternatives=[], route=[], route_km=0.0,
            route_minutes=0, route_engine="none", avoided_blocks=0,
            warnings=warnings, should_move=False,
        )

    candidates = [_score(c, intent, condition) for c in await _candidates(lng, lat, intent, city_id)]
    usable = sorted([c for c in candidates if c.score > 0], key=lambda c: c.score, reverse=True)
    rejected = [c for c in candidates if c.score == 0]

    if not usable:
        return Guidance(
            intent=intent,
            headline="Nothing nearby can take you right now.",
            reasoning=[c.why[0] for c in rejected[:3]] or
                      ["No facility of that kind is configured near you."],
            destination=None, alternatives=[], route=[], route_km=0.0,
            route_minutes=0, route_engine="none", avoided_blocks=0,
            warnings=warnings + [
                "Call the municipal helpline. This is a shortfall the control "
                "room can see as well, and it is recorded as one."
            ],
            should_move=False,
        )

    best = usable[0]
    blocks = await _blocks(city_id)
    line = await routing.route_line((lng, lat), (best.lng, best.lat), blocks)
    minutes, km, path, engine = line.minutes, line.km, line.coordinates, line.engine

    reasoning.append(f"{best.name} is the best of {len(usable)} open options: " + ", ".join(best.why) + ".")
    if rejected:
        reasoning.append(
            f"Ruled out: " + "; ".join(f"{c.name} ({c.why[0].lower()})" for c in rejected[:2]) + "."
        )
    if blocks:
        reasoning.append(
            f"{len(blocks)} reported hazard(s) and road block(s) were treated as "
            "impassable when working out the way there."
        )
    if km > WALKABLE_KM and intent in ("shelter", "safety"):
        warnings.append(
            f"{km:.1f} km is a long way on foot in water. If you cannot make it, "
            "ask for help instead of starting out."
        )

    headline = (
        f"Go to {best.name}, {km:.1f} km away, about {minutes} minutes."
        if intent != "hospital"
        else f"Go to {best.name}, {km:.1f} km, about {minutes} minutes by road."
    )

    return Guidance(
        intent=intent,
        headline=headline,
        reasoning=reasoning,
        destination=best,
        alternatives=usable[1:3],
        route=path,
        route_km=round(float(km), 2),
        route_minutes=int(minutes),
        route_engine=engine,
        avoided_blocks=len(blocks),
        warnings=warnings,
        should_move=True,
    )
