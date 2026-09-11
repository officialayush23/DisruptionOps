/* ==========================================================================
   Indradhanu domain model.

   This file is the contract between the UI and whatever is serving it.
   The mock client and the future FastAPI client both satisfy `IndradhanuApi`
   below, so swapping one for the other touches exactly one file.
   ========================================================================== */

export type HazardType = "flood" | "heat" | "fire" | "air" | "seismic"

/** 1 = minimal … 5 = critical. Ordered, so comparisons are meaningful. */
export type Severity = 1 | 2 | 3 | 4 | 5

export type LngLat = [number, number]

/* -------------------------------------------------------------- geography */

export interface Ward {
  id: string
  /** PMC ward number, e.g. "23". */
  number: string
  name: string
  centroid: LngLat
  /** Simplified polygon ring, lng/lat pairs. */
  boundary: LngLat[]
  population: number
  /** Share of population over 60, 0-1. Drives heat and evacuation weighting. */
  elderlyShare: number
  /** Mean elevation, metres above sea level. */
  elevationM: number
  areaSqKm: number
}

export interface Lifeline {
  id: string
  kind: "hospital" | "school" | "shelter" | "pump_station" | "substation"
  name: string
  location: LngLat
  wardId: string
  capacity?: number
}

export interface Shelter extends Lifeline {
  kind: "shelter"
  capacity: number
  occupancy: number
}

/* ------------------------------------------------------------------- risk */

export interface RiskDriver {
  label: string
  /** Share of the score attributable to this driver, 0-1. Sums to ~1. */
  contribution: number
  detail: string
}

export interface WardRisk {
  wardId: string
  hazard: HazardType
  /** 0-1. */
  score: number
  severity: Severity
  /** Hours until expected impact. */
  leadTimeHours: number
  /** Model confidence in this score, 0-1. */
  confidence: number
  populationAtRisk: number
  drivers: RiskDriver[]
  /** Hourly score projection from now, for the sparkline. */
  projection: number[]
}

export interface HazardRun {
  id: string
  hazard: HazardType
  startedAt: string
  /** Which feeds produced this run. */
  sources: string[]
  wardRisks: WardRisk[]
}

/* -------------------------------------------------------------- incidents */

export type IncidentStatus =
  "reported" | "confirmed" | "dispatched" | "in_progress" | "resolved"

export type IncidentCategory =
  | "flooded_road"
  | "waterlogging"
  | "fallen_tree"
  | "blocked_drain"
  | "structural_damage"
  | "person_stranded"
  | "power_line"
  | "heat_casualty"

export interface CitizenReport {
  id: string
  incidentId: string | null
  wardId: string
  category: IncidentCategory
  location: LngLat
  note: string
  photoUrl: string | null
  createdAt: string
  /** What the vision model called it, and how sure it was. */
  classifiedAs: IncidentCategory
  classificationConfidence: number
  reporterName: string
}

export interface Incident {
  id: string
  title: string
  category: IncidentCategory
  hazard: HazardType
  wardId: string
  location: LngLat
  severity: Severity
  status: IncidentStatus
  /** How many citizen reports clustered into this one incident. */
  reportCount: number
  /** Confidence that this cluster is a real, single incident. */
  confidence: number
  createdAt: string
  updatedAt: string
  reportIds: string[]
}

/* -------------------------------------------------------------- resources */

export type ResourceKind =
  "boat" | "pump" | "ambulance" | "fire_engine" | "rescue_team" | "bus" | "jcb"

export type ResourceStatus =
  "available" | "assigned" | "en_route" | "on_site" | "offline"

export interface Resource {
  id: string
  kind: ResourceKind
  label: string
  /** Operating agency — PMC, Fire, NDRF, PMPML, private contractor. */
  operator: string
  baseLocation: LngLat
  location: LngLat
  capacity: number
  status: ResourceStatus
  assignmentId: string | null
}

export interface Assignment {
  id: string
  resourceId: string
  incidentId: string | null
  wardId: string
  purpose: string
  etaMinutes: number
  distanceKm: number
  status: "proposed" | "approved" | "en_route" | "on_site" | "complete"
  createdAt: string
}

export interface UncoveredDemand {
  wardId: string
  incidentId: string | null
  need: string
  reason: string
  shortfall: number
}

export interface AllocationPlan {
  id: string
  hazard: HazardType
  generatedAt: string
  assignments: Assignment[]
  uncovered: UncoveredDemand[]
  /** What the solver minimised, in plain language. */
  objective: string
  solver: {
    /** "cp-sat" when the real solver ran, "greedy-fallback" otherwise. */
    engine: "cp-sat" | "greedy-fallback"
    runtimeMs: number
    variables: number
    constraints: number
    /** 0-1; how much of total demand the plan covers. */
    coverage: number
  }
}

/* -------------------------------------------------------------- decisions */

export interface Authority {
  /** e.g. "Municipal DM Plan 2023, cl. 4.2". */
  clause: string
  source: string
  delegatedTo: string
  /** True when the action sits inside the delegated authority. */
  withinDelegation: boolean
}

export type DecisionStatus =
  "auto_issued" | "awaiting_approval" | "approved" | "overridden" | "rejected"

export interface Decision {
  id: string
  createdAt: string
  hazard: HazardType
  action: string
  target: string
  wardId: string | null
  rationale: string
  confidence: number
  authority: Authority
  status: DecisionStatus
  /** Set once a human acts on it. */
  decidedBy: string | null
  decidedAt: string | null
  overrideNote: string | null
  agentRunId: string
}

/* ------------------------------------------------------------ agent trace */

export type AgentName =
  | "hazard_analyst"
  | "impact_exposure"
  | "allocation_planner"
  | "guidance_agent"
  | "policy_retriever"

export interface AgentStep {
  id: string
  agent: AgentName
  startedAt: string
  durationMs: number
  /** One line of reasoning, as the agent recorded it. */
  thought: string
  tool: string | null
  toolInput: string | null
  toolOutput: string | null
  /** Set when this step produced a citable policy clause. */
  citedClause: string | null
  status: "ok" | "fallback" | "error"
}

export interface AgentRun {
  id: string
  hazard: HazardType
  trigger: string
  startedAt: string
  finishedAt: string | null
  /** "gemini" when the live model answered, "fallback" when it did not. */
  engine: "gemini" | "fallback"
  steps: AgentStep[]
  summary: string
}

/* ----------------------------------------------------------------- alerts */

export type AlertChannel = "push" | "sms" | "web" | "whatsapp"

export interface Alert {
  id: string
  wardId: string
  hazard: HazardType
  severity: Severity
  /** Four fields, nothing more. This is what a resident actually reads. */
  headline: string
  action: string
  byTime: string
  safeLocation: { name: string; location: LngLat; distanceKm: number } | null
  channels: AlertChannel[]
  issuedAt: string
  decisionId: string
  language: string
  reach: number
}

/* ------------------------------------------------------------ field tasks */

export interface FieldTask {
  id: string
  assignmentId: string
  operator: string
  resourceId: string
  title: string
  instruction: string
  location: LngLat
  wardId: string
  status: "queued" | "accepted" | "on_site" | "complete"
  acceptedAt: string | null
  completedAt: string | null
  proofNote: string | null
  priority: Severity
}

/* --------------------------------------------------------- system status */

export interface FeedStatus {
  id: string
  label: string
  /** "live" when the upstream API answered, "cached" on fallback. */
  state: "live" | "cached" | "down"
  lastUpdated: string
  detail: string
}

export interface SystemStatus {
  /** Drives the banner. "fallback" when Gemini quota or network failed. */
  mode: "live" | "fallback"
  llm: { engine: "gemini" | "fallback"; note: string }
  feeds: FeedStatus[]
  /** Simulated clock, when Replay Mode is running. */
  simulatedTime: string | null
  scenarioId: string | null
}

/* ------------------------------------------------------------------- api */

export interface CitizenSituation {
  wardId: string
  atRisk: boolean
  risk: WardRisk | null
  alert: Alert | null
  /** Turn-by-turn to the recommended shelter, as a line. */
  route: LngLat[] | null
  shelter: Shelter | null
}

export interface IndradhanuApi {
  getSystemStatus(): Promise<SystemStatus>
  getWards(): Promise<Ward[]>
  getLifelines(): Promise<Lifeline[]>
  getShelters(): Promise<Shelter[]>

  getActiveRun(hazard: HazardType): Promise<HazardRun | null>
  getWardRisks(hazard: HazardType): Promise<WardRisk[]>

  getIncidents(): Promise<Incident[]>
  getReports(incidentId?: string): Promise<CitizenReport[]>
  submitReport(
    input: Pick<CitizenReport, "wardId" | "category" | "location" | "note"> & {
      photoUrl?: string | null
    }
  ): Promise<CitizenReport>

  getResources(): Promise<Resource[]>
  getAllocationPlan(): Promise<AllocationPlan | null>

  getDecisions(): Promise<Decision[]>
  actOnDecision(
    id: string,
    action: "approve" | "reject" | "override",
    note?: string
  ): Promise<Decision>

  getAgentRuns(): Promise<AgentRun[]>
  getAgentRun(id: string): Promise<AgentRun | null>

  getAlerts(): Promise<Alert[]>
  getCitizenSituation(wardId: string): Promise<CitizenSituation>
  askAgent(
    question: string,
    wardId: string
  ): Promise<{ answer: string; engine: "gemini" | "fallback" }>

  getFieldTasks(operator?: string): Promise<FieldTask[]>
  updateFieldTask(
    id: string,
    status: FieldTask["status"],
    proofNote?: string
  ): Promise<FieldTask>
}
