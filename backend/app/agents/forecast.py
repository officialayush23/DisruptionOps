"""What is likely to happen next, learned from what happened before.

This is the part that was missing, and the reason it was missing is worth
stating plainly: on the first run the database is empty. A model that needs
history produces nothing on day one, and a system that produces nothing on day
one gets replaced by a rule somebody wrote in a hurry. So the question is not
"learned or deterministic", it is **how does a learned thing behave before it
has learned anything**.

The answer here is a Gamma-Poisson model, which is the standard one for counts
and has exactly the property that matters: it starts as a prior and becomes the
data as the data arrives, continuously, with no retraining step and no cliff.

  * Incidents of a category in a ward arrive as a Poisson process with some
    unknown rate λ.
  * The prior on λ is the **city-wide** rate for that category, which every ward
    contributes to, so a ward with no history of its own borrows the city's.
  * Observing k incidents over t hours in that ward updates it to
    Gamma(α₀ + k, β₀ + t), and the posterior mean is (α₀ + k) / (β₀ + t).

A ward with one flooded road in its whole history barely moves off the city
rate. A ward with forty moves almost entirely onto its own. Nobody has to decide
when there is "enough data" — the arithmetic decides, and it reports how much of
the answer came from this ward rather than from the prior, which is the number
an officer should actually be shown.

Two things this deliberately is not:

  * **It is not a severity model.** It predicts *how often*, not *how bad*. How
    bad is still the deterministic score, because that one has to be auditable
    and this one only has to be useful.
  * **It never dispatches on its own.** A forecast prepositions and warns. A
    unit moves because something was reported. Acting on a prediction of an
    incident that has not happened is how you empty a ward of boats an hour
    before the flood arrives somewhere else.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

from app.core.logging import get_logger
from app.db import session as db

log = get_logger(__name__)

#: Prior strength, in ward-hours. The city rate is worth this much observation
#: before a ward's own history starts to dominate. Twelve hours is about one
#: event's worth of evidence: enough that a single unusual night does not
#: rewrite a ward's profile, little enough that a genuinely bad ward separates
#: itself within a shift.
PRIOR_HOURS = 12.0
#: How far back counts are drawn from.
LOOKBACK_DAYS = 30
#: Default forecast horizon.
HORIZON_HOURS = 3.0

#: Roughly what fraction of incidents of each category send somebody to a
#: hospital. Deterministic, because we have no outcome data at all — nothing
#: records whether a rescue ended at a hospital — and a learned number with no
#: labels behind it would be a guess wearing a lab coat. Stated here so it can
#: be replaced the moment outcomes are recorded.
CASUALTY_FRACTION: dict[str, float] = {
    "person_stranded": 0.55,
    "structural_damage": 0.35,
    "heat_casualty": 0.80,
    "power_line": 0.20,
    "fallen_tree": 0.10,
    "flooded_road": 0.04,
    "waterlogging": 0.02,
    "blocked_drain": 0.01,
}
DEFAULT_CASUALTY_FRACTION = 0.08

#: Facilities within this of a ward centroid are treated as receiving from it.
CATCHMENT_KM = 6.0


@dataclass(slots=True)
class Recurrence:
    """How often this category happens in this ward."""

    ward_id: str
    ward_name: str
    category: str
    #: Posterior mean rate, incidents per hour.
    rate_per_hour: float
    #: Expected count over the horizon, before the hazard multiplier.
    expected: float
    #: Probability of at least one, over the horizon.
    p_at_least_one: float
    observed: int
    observed_hours: float
    #: 0 = the answer is entirely the city prior, 1 = entirely this ward's own
    #: history. This is the honesty number.
    evidence: float
    #: What the current hazard state multiplies the base rate by.
    hazard_multiplier: float

    @property
    def explanation(self) -> str:
        if self.evidence < 0.15:
            basis = (
                f"almost entirely the city-wide rate: this ward has only "
                f"{self.observed} in {int(self.observed_hours)} h of history"
            )
        elif self.evidence > 0.7:
            basis = (
                f"mostly this ward's own record of {self.observed} in "
                f"{int(self.observed_hours)} h"
            )
        else:
            basis = (
                f"a blend of the city rate and this ward's {self.observed} in "
                f"{int(self.observed_hours)} h"
            )
        tail = (
            f", multiplied by {self.hazard_multiplier:.1f}× for the current "
            "hazard state"
            if abs(self.hazard_multiplier - 1.0) > 0.05
            else ""
        )
        return (
            f"{self.expected:.1f} expected in the next few hours "
            f"({self.p_at_least_one:.0%} chance of at least one), from {basis}{tail}."
        )


@dataclass(slots=True)
class FacilityLoad:
    """What is likely to turn up at a hospital or shelter, and when it fills."""

    id: str
    name: str
    kind: str
    capacity: int | None
    occupancy: int | None
    status: str
    #: Expected arrivals per hour from the wards in its catchment.
    arrivals_per_hour: float
    #: Expected arrivals over the horizon.
    expected_arrivals: float
    #: Hours until occupancy reaches capacity at this rate. None = not projected
    #: to saturate, or capacity unknown.
    hours_to_full: float | None
    #: Which wards are feeding it, largest first.
    from_wards: list[tuple[str, float]] = field(default_factory=list)

    @property
    def spare(self) -> int | None:
        if self.capacity is None:
            return None
        return max(0, self.capacity - (self.occupancy or 0))

    @property
    def pressure(self) -> str:
        if self.status in ("full", "closed"):
            return "full"
        if self.hours_to_full is None:
            return "steady"
        if self.hours_to_full <= 1:
            return "saturating"
        if self.hours_to_full <= 3:
            return "tightening"
        return "steady"

    @property
    def explanation(self) -> str:
        if self.capacity is None:
            return (
                f"About {self.expected_arrivals:.0f} arrival(s) expected. No "
                "capacity is recorded for this one, so saturation cannot be projected."
            )
        if self.hours_to_full is None:
            return (
                f"About {self.expected_arrivals:.0f} arrival(s) expected against "
                f"{self.spare} free. Not projected to fill within the horizon."
            )
        return (
            f"{self.arrivals_per_hour:.1f} arrival(s) per hour against {self.spare} "
            f"free: full in about {self.hours_to_full:.1f} h if the rate holds."
        )


@dataclass(slots=True)
class DemandForecast:
    """What capability is likely to be wanted, city-wide, over the horizon."""

    capability: str
    expected_units: float
    committed_now: int
    available_now: int

    @property
    def shortfall(self) -> float:
        return max(0.0, self.expected_units - self.available_now)


@dataclass(slots=True)
class Forecast:
    horizon_hours: float
    generated_at: datetime
    recurrence: list[Recurrence]
    facilities: list[FacilityLoad]
    demand: list[DemandForecast]
    #: Total history the whole thing rests on. A forecast built on nothing says
    #: so rather than presenting a prior as a prediction.
    incidents_seen: int
    history_hours: float

    @property
    def confidence_note(self) -> str:
        if self.incidents_seen < 10:
            return (
                f"Only {self.incidents_seen} incident(s) of history. These are "
                "city-wide priors, not learned ward behaviour, and they will "
                "sharpen as the run continues."
            )
        if self.incidents_seen < 60:
            return (
                f"{self.incidents_seen} incidents of history. Wards with a few "
                "events of their own have started to separate from the city rate."
            )
        return (
            f"{self.incidents_seen} incidents over {self.history_hours / 24:.1f} "
            "days. Ward rates are mostly their own."
        )


def _haversine_km(a: tuple[float, float], b: tuple[float, float]) -> float:
    lon1, lat1 = math.radians(a[0]), math.radians(a[1])
    lon2, lat2 = math.radians(b[0]), math.radians(b[1])
    h = (math.sin((lat2 - lat1) / 2) ** 2
         + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2)
    return 2 * 6371.0 * math.asin(math.sqrt(h))


def _hazard_multiplier(severity: int | None, score: float | None) -> float:
    """How much the current hazard state lifts a ward's base rate.

    A base rate is what happens on an average day, and today is not an average
    day or nobody would be looking at this screen. Severity 5 roughly triples
    the arrival rate in the flood literature; that is the shape encoded here,
    and it is deliberately mild rather than dramatic, because a forecast that
    doubles on every update teaches people to ignore it.
    """
    if severity is None and score is None:
        return 1.0
    s = severity if severity is not None else 1 + round((score or 0) * 4)
    return {1: 0.8, 2: 1.0, 3: 1.5, 4: 2.2, 5: 3.0}.get(int(s), 1.0)


_COUNTS_SQL = """
with span as (
  select greatest(
           extract(epoch from (now() - min(created_at))) / 3600.0, 1.0
         ) as hours
    from incidents
   where city_id = $1 and sim_run_id is null
     and created_at > now() - ($2 || ' days')::interval
),
counts as (
  select ward_id, category, count(*)::int n
    from incidents
   where city_id = $1 and sim_run_id is null
     and created_at > now() - ($2 || ' days')::interval
   group by ward_id, category
)
select c.ward_id, c.category, c.n, s.hours
  from counts c, span s
"""

_WARDS_SQL = """
select w.id, w.name,
       extensions.ST_X(w.centroid::extensions.geometry) lng,
       extensions.ST_Y(w.centroid::extensions.geometry) lat,
       r.severity, r.score
  from wards w
  left join lateral (
    select severity, score from ward_risks
     where ward_id = w.id order by created_at desc limit 1
  ) r on true
 where w.city_id = $1
"""

_FACILITIES_SQL = """
select id, name, kind, capacity, occupancy, status,
       extensions.ST_X(location::extensions.geometry) lng,
       extensions.ST_Y(location::extensions.geometry) lat
  from lifelines
 where city_id = $1 and kind in ('hospital','shelter')
"""

_FLEET_SQL = """
select rk.capability_id, count(*) filter (where r.status = 'available')::int free,
       count(*) filter (where r.status not in ('available','offline'))::int busy
  from resources r
  join resource_kind_capabilities rk on rk.kind_id = r.kind
 where r.city_id = $1
 group by rk.capability_id
"""

_NEEDS_PER_CATEGORY_SQL = """
select category_id, capability_id, qty_per_incident required
  from incident_category_needs
"""


async def build(
    *, city_id: str = "pune", horizon_hours: float = HORIZON_HOURS
) -> Forecast:
    """One pass over history, producing every projection the console shows."""
    count_rows, ward_rows, facility_rows, fleet_rows, need_rows = (
        await db.fetch(_COUNTS_SQL, city_id, str(LOOKBACK_DAYS)),
        await db.fetch(_WARDS_SQL, city_id),
        await db.fetch(_FACILITIES_SQL, city_id),
        await db.fetch(_FLEET_SQL, city_id),
        await db.fetch(_NEEDS_PER_CATEGORY_SQL),
    )

    history_hours = float(count_rows[0]["hours"]) if count_rows else 1.0
    total = sum(int(r["n"]) for r in count_rows)
    n_wards = max(1, len(ward_rows))

    # City-wide prior: the average ward-hour rate for each category. Every ward
    # contributes, which is exactly what makes it a usable prior for a ward that
    # has contributed nothing.
    city_counts: dict[str, int] = {}
    for r in count_rows:
        city_counts[r["category"]] = city_counts.get(r["category"], 0) + int(r["n"])
    city_rate = {
        cat: n / (history_hours * n_wards) for cat, n in city_counts.items()
    }

    observed = {(r["ward_id"], r["category"]): int(r["n"]) for r in count_rows}

    recurrence: list[Recurrence] = []
    ward_rate: dict[str, dict[str, float]] = {}
    for w in ward_rows:
        multiplier = _hazard_multiplier(w["severity"], float(w["score"]) if w["score"] is not None else None)
        per_category: dict[str, float] = {}
        for category, prior_rate in city_rate.items():
            # Gamma(alpha0, beta0) with mean = prior_rate and strength =
            # PRIOR_HOURS of pretend observation.
            beta0 = PRIOR_HOURS
            alpha0 = prior_rate * beta0
            k = observed.get((w["id"], category), 0)
            t = history_hours
            posterior = (alpha0 + k) / (beta0 + t)
            # How much of the posterior came from this ward rather than the
            # prior. This is the number to show, not the rate.
            evidence = t / (beta0 + t) if (beta0 + t) else 0.0

            rate = posterior * multiplier
            per_category[category] = rate
            expected = rate * horizon_hours
            recurrence.append(
                Recurrence(
                    ward_id=w["id"], ward_name=w["name"], category=category,
                    rate_per_hour=round(rate, 5),
                    expected=round(expected, 3),
                    p_at_least_one=round(1.0 - math.exp(-expected), 4),
                    observed=k, observed_hours=round(t, 1),
                    evidence=round(evidence, 3),
                    hazard_multiplier=multiplier,
                )
            )
        ward_rate[w["id"]] = per_category

    # ---------------------------------------------------------- facilities ---
    ward_point = {
        w["id"]: (float(w["lng"]), float(w["lat"])) for w in ward_rows
    }
    ward_name = {w["id"]: w["name"] for w in ward_rows}

    facilities: list[FacilityLoad] = []
    for f in facility_rows:
        here = (float(f["lng"]), float(f["lat"]))
        contributions: list[tuple[str, float]] = []
        arrivals = 0.0
        for ward_id, point in ward_point.items():
            km = _haversine_km(here, point)
            if km > CATCHMENT_KM:
                continue
            # Nearer wards send more of their casualties here. Linear taper,
            # because anything fancier would be unfalsifiable at this scale.
            share = max(0.0, 1.0 - km / CATCHMENT_KM)
            from_ward = 0.0
            for category, rate in ward_rate.get(ward_id, {}).items():
                fraction = CASUALTY_FRACTION.get(category, DEFAULT_CASUALTY_FRACTION)
                from_ward += rate * fraction * share
            if from_ward > 0:
                arrivals += from_ward
                contributions.append((ward_name.get(ward_id, ward_id), round(from_ward, 3)))

        contributions.sort(key=lambda t: t[1], reverse=True)
        capacity = f["capacity"]
        occupancy = f["occupancy"]
        spare = None if capacity is None else max(0, capacity - (occupancy or 0))
        hours_to_full = None
        if spare is not None and arrivals > 0.01:
            projected = spare / arrivals
            if projected <= horizon_hours * 4:
                hours_to_full = round(projected, 2)

        facilities.append(
            FacilityLoad(
                id=f["id"], name=f["name"], kind=f["kind"],
                capacity=capacity, occupancy=occupancy, status=f["status"],
                arrivals_per_hour=round(arrivals, 3),
                expected_arrivals=round(arrivals * horizon_hours, 2),
                hours_to_full=hours_to_full,
                from_wards=contributions[:3],
            )
        )
    facilities.sort(
        key=lambda f: (f.hours_to_full if f.hours_to_full is not None else 1e9)
    )

    # -------------------------------------------------------------- demand ---
    needs_by_category: dict[str, dict[str, int]] = {}
    for r in need_rows:
        needs_by_category.setdefault(r["category_id"], {})[r["capability_id"]] = int(
            r["required"]
        )

    wanted: dict[str, float] = {}
    for per_category in ward_rate.values():
        for category, rate in per_category.items():
            for capability, required in needs_by_category.get(category, {}).items():
                wanted[capability] = wanted.get(capability, 0.0) + rate * horizon_hours * required

    fleet = {r["capability_id"]: (int(r["free"]), int(r["busy"])) for r in fleet_rows}
    demand = [
        DemandForecast(
            capability=capability,
            expected_units=round(units, 2),
            available_now=fleet.get(capability, (0, 0))[0],
            committed_now=fleet.get(capability, (0, 0))[1],
        )
        for capability, units in sorted(wanted.items(), key=lambda kv: kv[1], reverse=True)
    ]

    recurrence.sort(key=lambda r: r.expected, reverse=True)
    return Forecast(
        horizon_hours=horizon_hours,
        generated_at=datetime.now(UTC),
        recurrence=recurrence[:60],
        facilities=facilities,
        demand=demand,
        incidents_seen=total,
        history_hours=round(history_hours, 1),
    )


# ------------------------------------------------------- used in guidance ---
async def saturation_risk(city_id: str = "pune") -> dict[str, float]:
    """facility id -> hours until it is projected to be full.

    Consumed by the citizen routing agent, which is the one place a forecast
    legitimately changes an instruction: sending somebody on a forty-minute walk
    to a hospital that fills in twenty is worse than sending them further to one
    that will still be open when they arrive.
    """
    try:
        f = await build(city_id=city_id, horizon_hours=1.0)
    except Exception as exc:  # noqa: BLE001 - guidance must survive this failing
        log.warning("forecast_unavailable", error=str(exc)[:160])
        return {}
    return {
        x.id: x.hours_to_full
        for x in f.facilities
        if x.hours_to_full is not None
    }


def as_dict(f: Forecast) -> dict[str, Any]:
    """The shape the console reads."""
    return {
        "horizonHours": f.horizon_hours,
        "generatedAt": f.generated_at.isoformat(),
        "incidentsSeen": f.incidents_seen,
        "historyHours": f.history_hours,
        "confidenceNote": f.confidence_note,
        "recurrence": [
            {"wardId": r.ward_id, "wardName": r.ward_name, "category": r.category,
             "ratePerHour": r.rate_per_hour, "expected": r.expected,
             "pAtLeastOne": r.p_at_least_one, "observed": r.observed,
             "observedHours": r.observed_hours, "evidence": r.evidence,
             "hazardMultiplier": r.hazard_multiplier,
             "explanation": r.explanation}
            for r in f.recurrence
        ],
        "facilities": [
            {"id": x.id, "name": x.name, "kind": x.kind, "capacity": x.capacity,
             "occupancy": x.occupancy, "status": x.status, "spare": x.spare,
             "arrivalsPerHour": x.arrivals_per_hour,
             "expectedArrivals": x.expected_arrivals,
             "hoursToFull": x.hours_to_full, "pressure": x.pressure,
             "fromWards": [{"ward": w, "rate": v} for w, v in x.from_wards],
             "explanation": x.explanation}
            for x in f.facilities
        ],
        "demand": [
            {"capability": d.capability, "expectedUnits": d.expected_units,
             "availableNow": d.available_now, "committedNow": d.committed_now,
             "shortfall": round(d.shortfall, 2)}
            for d in f.demand
        ],
    }
