"""Resource allocation.

The model proposes and explains; this decides the numbers.

Formulated as a constrained assignment problem and solved with OR-Tools
CP-SAT. If the solver is unavailable or hits its time budget, a greedy
nearest-first heuristic takes over and the result says so — a dispatch plan
that silently degrades is worse than one that admits it degraded.

What the objective actually minimises is population-weighted arrival time:
sending the only free boat to the ward with 40 people rather than the one with
2,300 is arithmetically defensible, and an officer can see why.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Mapping, Sequence

from app.core.logging import get_logger
from app.solver.routing import TravelMatrix

log = get_logger(__name__)

#: Beyond this, a unit is not meaningfully responding to the incident.
MAX_ETA_MINUTES = 45
#: Seconds the solver is allowed. A dispatch decision that takes a minute to
#: compute is not a dispatch decision.
SOLVER_TIME_BUDGET_S = 4.0


@dataclass(frozen=True, slots=True)
class Unit:
    id: str
    kind: str
    label: str
    operator: str
    location: tuple[float, float]
    capacity: int


@dataclass(frozen=True, slots=True)
class Demand:
    """One thing that needs a unit."""

    id: str
    ward_id: str
    incident_id: str | None
    kind: str
    purpose: str
    location: tuple[float, float]
    severity: int
    population_at_risk: int

    @property
    def weight(self) -> float:
        """Severity dominates; population breaks ties within a severity band."""
        return (self.severity**2) * (1.0 + self.population_at_risk / 10_000.0)


@dataclass(slots=True)
class Allocation:
    demand: Demand
    unit: Unit
    eta_minutes: int
    distance_km: float


@dataclass(slots=True)
class Unmet:
    demand: Demand
    reason: str
    shortfall: int = 1


@dataclass(slots=True)
class AllocationResult:
    allocations: list[Allocation] = field(default_factory=list)
    unmet: list[Unmet] = field(default_factory=list)
    engine: str = "cp-sat"
    runtime_ms: int = 0
    variables: int = 0
    constraints: int = 0

    @property
    def coverage(self) -> float:
        total = len(self.allocations) + len(self.unmet)
        return len(self.allocations) / total if total else 1.0

    @property
    def objective_text(self) -> str:
        return (
            "Minimise total population-weighted time-to-arrival, subject to one "
            "assignment per unit, kind compatibility, a 45-minute reachability "
            "limit, and travel times over the flood-adjusted road graph."
        )


def _greedy(
    demands: Sequence[Demand],
    units: Sequence[Unit],
    matrix: TravelMatrix,
) -> AllocationResult:
    """Nearest compatible unit, worst demand first. Always terminates."""
    started = time.perf_counter()
    taken: set[str] = set()
    allocations: list[Allocation] = []
    unmet: list[Unmet] = []

    for d_idx, demand in sorted(
        enumerate(demands), key=lambda p: p[1].weight, reverse=True
    ):
        best: tuple[float, int] | None = None
        for u_idx, unit in enumerate(units):
            if unit.id in taken or unit.kind != demand.kind:
                continue
            eta = matrix.durations[u_idx][d_idx]
            if eta > MAX_ETA_MINUTES:
                continue
            if best is None or eta < best[0]:
                best = (eta, u_idx)

        if best is None:
            unmet.append(
                Unmet(
                    demand=demand,
                    reason=(
                        f"No {demand.kind.replace('_', ' ')} within "
                        f"{MAX_ETA_MINUTES} minutes; the nearest free unit is "
                        "already committed to a higher-severity ward."
                    ),
                )
            )
            continue

        eta, u_idx = best
        taken.add(units[u_idx].id)
        allocations.append(
            Allocation(
                demand=demand,
                unit=units[u_idx],
                eta_minutes=max(4, round(eta)),
                distance_km=matrix.distances[u_idx][d_idx],
            )
        )

    return AllocationResult(
        allocations=allocations,
        unmet=unmet,
        engine="greedy-fallback",
        runtime_ms=int((time.perf_counter() - started) * 1000),
        variables=len(demands) * len(units),
        constraints=len(units) + len(demands),
    )


def allocate(
    demands: Sequence[Demand],
    units: Sequence[Unit],
    matrix: TravelMatrix,
    *,
    time_budget_s: float = SOLVER_TIME_BUDGET_S,
) -> AllocationResult:
    """Assign units to demands. Never raises; degrades to greedy instead."""
    if not demands or not units:
        return AllocationResult(
            unmet=[Unmet(d, "No units in the fleet for this demand.") for d in demands],
            engine="greedy-fallback",
        )

    try:
        from ortools.sat.python import cp_model
    except ImportError:
        log.warning("ortools_missing", note="falling back to greedy allocation")
        return _greedy(demands, units, matrix)

    started = time.perf_counter()
    model = cp_model.CpModel()

    # x[u][d] = 1 when unit u serves demand d. Only feasible pairs get a var,
    # which keeps the model small enough to solve inside the time budget.
    x: dict[tuple[int, int], object] = {}
    for u_idx, unit in enumerate(units):
        for d_idx, demand in enumerate(demands):
            if unit.kind != demand.kind:
                continue
            if matrix.durations[u_idx][d_idx] > MAX_ETA_MINUTES:
                continue
            x[(u_idx, d_idx)] = model.NewBoolVar(f"x_{u_idx}_{d_idx}")

    if not x:
        return _greedy(demands, units, matrix)

    constraints = 0

    # A unit does one job at a time.
    for u_idx in range(len(units)):
        vars_for_unit = [v for (u, _), v in x.items() if u == u_idx]
        if vars_for_unit:
            model.AddAtMostOne(vars_for_unit)
            constraints += 1

    # A demand is served at most once.
    served: list[object] = []
    for d_idx in range(len(demands)):
        vars_for_demand = [v for (_, d), v in x.items() if d == d_idx]
        if vars_for_demand:
            model.AddAtMostOne(vars_for_demand)
            constraints += 1
            served.append(sum(vars_for_demand))

    # Objective: reward coverage heavily, then minimise weighted arrival time.
    # Integers only - CP-SAT is an integer solver.
    UNSERVED_PENALTY = 10_000
    terms = []
    for (u_idx, d_idx), var in x.items():
        demand = demands[d_idx]
        eta = matrix.durations[u_idx][d_idx]
        cost = int(demand.weight * eta * 10)
        terms.append(cost * var)

    coverage_bonus = [
        UNSERVED_PENALTY * int(demands[d].weight) * (1 - s)
        for d, s in enumerate(served)
    ]
    model.Minimize(sum(terms) + sum(coverage_bonus))

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = time_budget_s
    solver.parameters.num_search_workers = 4
    status = solver.Solve(model)

    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        log.warning("cp_sat_no_solution", status=solver.StatusName(status))
        return _greedy(demands, units, matrix)

    allocations: list[Allocation] = []
    assigned_demands: set[int] = set()
    for (u_idx, d_idx), var in x.items():
        if solver.Value(var):
            allocations.append(
                Allocation(
                    demand=demands[d_idx],
                    unit=units[u_idx],
                    eta_minutes=max(4, round(matrix.durations[u_idx][d_idx])),
                    distance_km=matrix.distances[u_idx][d_idx],
                )
            )
            assigned_demands.add(d_idx)

    unmet = [
        Unmet(
            demand=demands[d_idx],
            reason=(
                f"No {demands[d_idx].kind.replace('_', ' ')} could reach this ward "
                f"within {MAX_ETA_MINUTES} minutes without pulling a unit off a "
                "higher-severity ward."
            ),
        )
        for d_idx in range(len(demands))
        if d_idx not in assigned_demands
    ]

    allocations.sort(key=lambda a: (-a.demand.severity, a.eta_minutes))

    return AllocationResult(
        allocations=allocations,
        unmet=unmet,
        engine="cp-sat",
        runtime_ms=int((time.perf_counter() - started) * 1000),
        variables=len(x),
        constraints=constraints,
    )


def demands_from_actions(
    actions: Sequence[Mapping[str, object]],
) -> list[Demand]:  # pragma: no cover - thin adapter, exercised via the API
    """Flatten `ProposedAction.resource_need` into individual demands."""
    demands: list[Demand] = []
    for action in actions:
        need = action.get("resource_need") or {}
        for kind, count in need.items():  # type: ignore[union-attr]
            for i in range(int(count)):
                demands.append(
                    Demand(
                        id=f"{action['action_key']}:{kind}:{i}",  # type: ignore[index]
                        ward_id=str(action.get("ward_id") or ""),
                        incident_id=None,
                        kind=str(kind),
                        purpose=str(action.get("action") or ""),
                        location=action["location"],  # type: ignore[index]
                        severity=int(action.get("severity") or 3),
                        population_at_risk=int(action.get("population_at_risk") or 0),
                    )
                )
    return demands
