"""Wire models.

These mirror `frontend/src/api/types.ts` exactly. When one changes the other
must change with it; that is the price of not generating one from the other,
and it is worth paying to keep both sides readable.
"""

from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field

LngLat = Annotated[list[float], Field(min_length=2, max_length=2)]
Severity = Annotated[int, Field(ge=1, le=5)]
UnitInterval = Annotated[float, Field(ge=0.0, le=1.0)]


class Camel(BaseModel):
    """Serialises as camelCase for the TypeScript client, parses either."""

    model_config = ConfigDict(
        alias_generator=lambda s: "".join(
            w if i == 0 else w.capitalize() for i, w in enumerate(s.split("_"))
        ),
        populate_by_name=True,
        from_attributes=True,
    )


class HazardType(StrEnum):
    FLOOD = "flood"
    HEAT = "heat"
    FIRE = "fire"
    AIR = "air"
    SEISMIC = "seismic"


class IncidentStatus(StrEnum):
    REPORTED = "reported"
    CONFIRMED = "confirmed"
    DISPATCHED = "dispatched"
    IN_PROGRESS = "in_progress"
    RESOLVED = "resolved"


class IncidentCategory(StrEnum):
    FLOODED_ROAD = "flooded_road"
    WATERLOGGING = "waterlogging"
    FALLEN_TREE = "fallen_tree"
    BLOCKED_DRAIN = "blocked_drain"
    STRUCTURAL_DAMAGE = "structural_damage"
    PERSON_STRANDED = "person_stranded"
    POWER_LINE = "power_line"
    HEAT_CASUALTY = "heat_casualty"


class DecisionStatus(StrEnum):
    AUTO_ISSUED = "auto_issued"
    AWAITING_APPROVAL = "awaiting_approval"
    APPROVED = "approved"
    OVERRIDDEN = "overridden"
    REJECTED = "rejected"


class TaskStatus(StrEnum):
    QUEUED = "queued"
    ACCEPTED = "accepted"
    ON_SITE = "on_site"
    COMPLETE = "complete"


# ------------------------------------------------------------- geography ---
class Ward(Camel):
    id: str
    number: str
    name: str
    centroid: LngLat
    boundary: list[LngLat]
    population: int
    elderly_share: float
    elevation_m: float
    area_sq_km: float


class Lifeline(Camel):
    id: str
    kind: Literal["hospital", "school", "shelter", "pump_station", "substation"]
    name: str
    location: LngLat
    ward_id: str
    capacity: int | None = None


class Shelter(Lifeline):
    kind: Literal["shelter"] = "shelter"
    capacity: int
    occupancy: int


# ------------------------------------------------------------------ risk ---
class RiskDriver(Camel):
    label: str
    contribution: UnitInterval
    detail: str


class WardRisk(Camel):
    ward_id: str
    hazard: HazardType
    score: UnitInterval
    severity: Severity
    lead_time_hours: float
    confidence: UnitInterval
    population_at_risk: int
    drivers: list[RiskDriver]
    projection: list[float]


class HazardRun(Camel):
    id: str
    hazard: HazardType
    started_at: datetime
    sources: list[str]
    ward_risks: list[WardRisk] = Field(default_factory=list)


# ------------------------------------------------------------- incidents ---
class CitizenReport(Camel):
    id: str
    incident_id: str | None
    ward_id: str
    category: IncidentCategory
    location: LngLat
    note: str
    photo_url: str | None = None
    created_at: datetime
    classified_as: IncidentCategory
    classification_confidence: UnitInterval
    reporter_name: str


class ReportCreate(Camel):
    ward_id: str
    category: IncidentCategory
    location: LngLat
    note: str = ""
    photo_url: str | None = None


class Incident(Camel):
    id: str
    title: str
    category: IncidentCategory
    hazard: HazardType
    ward_id: str
    location: LngLat
    severity: Severity
    status: IncidentStatus
    report_count: int
    confidence: UnitInterval
    created_at: datetime
    updated_at: datetime
    report_ids: list[str] = Field(default_factory=list)


# ------------------------------------------------------------- resources ---
class Resource(Camel):
    id: str
    kind: Literal["boat", "pump", "ambulance", "fire_engine", "rescue_team", "bus", "jcb"]
    label: str
    operator: str
    base_location: LngLat
    location: LngLat
    capacity: int
    status: Literal["available", "assigned", "en_route", "on_site", "offline"]
    assignment_id: str | None = None


class Assignment(Camel):
    id: str
    resource_id: str
    incident_id: str | None
    ward_id: str
    purpose: str
    eta_minutes: int
    distance_km: float
    status: Literal["proposed", "approved", "en_route", "on_site", "complete"]
    created_at: datetime


class UncoveredDemand(Camel):
    ward_id: str
    incident_id: str | None = None
    need: str
    reason: str
    shortfall: int


class SolverStats(Camel):
    engine: Literal["cp-sat", "greedy-fallback"]
    runtime_ms: int
    variables: int
    constraints: int
    coverage: UnitInterval


class AllocationPlan(Camel):
    id: str
    hazard: HazardType
    generated_at: datetime
    assignments: list[Assignment]
    uncovered: list[UncoveredDemand]
    objective: str
    solver: SolverStats


# ------------------------------------------------------------- decisions ---
class Authority(Camel):
    clause: str
    source: str
    delegated_to: str
    within_delegation: bool


class Decision(Camel):
    id: str
    created_at: datetime
    hazard: HazardType
    action: str
    target: str
    ward_id: str | None
    rationale: str
    confidence: UnitInterval
    authority: Authority
    status: DecisionStatus
    decided_by: str | None = None
    decided_at: datetime | None = None
    override_note: str | None = None
    agent_run_id: str | None = None


class DecisionAction(Camel):
    action: Literal["approve", "reject", "override"]
    note: str | None = None


# ------------------------------------------------------------ agent trace --
class AgentStep(Camel):
    id: str
    agent: str
    started_at: datetime
    duration_ms: int
    thought: str
    tool: str | None = None
    tool_input: str | None = None
    tool_output: str | None = None
    cited_clause: str | None = None
    status: Literal["ok", "fallback", "error"] = "ok"


class AgentRun(Camel):
    id: str
    hazard: HazardType
    trigger: str
    started_at: datetime
    finished_at: datetime | None
    engine: Literal["gemini", "bedrock", "fallback"]
    steps: list[AgentStep] = Field(default_factory=list)
    summary: str = ""


# ----------------------------------------------------------------- alerts --
class SafeLocation(Camel):
    name: str
    location: LngLat
    distance_km: float


class Alert(Camel):
    id: str
    ward_id: str
    hazard: HazardType
    severity: Severity
    headline: str
    action: str
    by_time: datetime
    safe_location: SafeLocation | None
    channels: list[str]
    issued_at: datetime
    decision_id: str | None
    language: str
    reach: int


# ------------------------------------------------------------ field tasks --
class FieldTask(Camel):
    id: str
    assignment_id: str | None
    operator: str
    resource_id: str
    title: str
    instruction: str
    location: LngLat
    ward_id: str
    status: TaskStatus
    accepted_at: datetime | None = None
    completed_at: datetime | None = None
    proof_note: str | None = None
    priority: Severity


class FieldTaskUpdate(Camel):
    status: TaskStatus
    proof_note: str | None = None


# ---------------------------------------------------------------- system ---
class FeedStatus(Camel):
    id: str
    label: str
    state: Literal["live", "cached", "down"]
    last_updated: datetime | None
    detail: str


class LLMStatus(Camel):
    engine: Literal["gemini", "bedrock", "fallback"]
    note: str


class SystemStatus(Camel):
    mode: Literal["live", "fallback"]
    llm: LLMStatus
    feeds: list[FeedStatus]
    simulated_time: datetime | None = None
    scenario_id: str | None = None


# --------------------------------------------------------------- citizen ---
class CitizenSituation(Camel):
    ward_id: str
    at_risk: bool
    risk: WardRisk | None
    alert: Alert | None
    route: list[LngLat] | None
    shelter: Shelter | None


class AskRequest(Camel):
    question: str
    ward_id: str


class AskResponse(Camel):
    answer: str
    engine: Literal["gemini", "bedrock", "fallback"]
