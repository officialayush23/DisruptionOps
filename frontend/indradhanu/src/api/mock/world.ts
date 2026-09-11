import type {
  AgentRun,
  Alert,
  AllocationPlan,
  Assignment,
  CitizenReport,
  Decision,
  FieldTask,
  HazardRun,
  Incident,
  Resource,
  Shelter,
  SystemStatus,
  WardRisk,
} from "@/api/types"
import { scoreToSeverity } from "@/lib/tokens"
import { SHELTERS, WARDS, distanceKm, wardById, wardName } from "./geo"
import { authorityFor } from "./policy"

/** Event day for Replay Mode: the Khadakwasla discharge of 25 July 2024. */
export const EVENT_DAY = "2024-07-25"
const T0 = new Date(`${EVENT_DAY}T18:00:00+05:30`)

export function simTime(minutes: number): string {
  return new Date(T0.getTime() + minutes * 60_000).toISOString()
}

export interface World {
  now: string
  status: SystemStatus
  run: HazardRun | null
  incidents: Incident[]
  reports: CitizenReport[]
  resources: Resource[]
  plan: AllocationPlan | null
  decisions: Decision[]
  agentRuns: AgentRun[]
  alerts: Alert[]
  tasks: FieldTask[]
  shelters: Shelter[]
}

/* ----------------------------------------------------------- ward risk ---- */

/** Handcrafted flood exposure for the 25 July 2024 replay. Ordered worst
 *  first; these mirror the wards that actually flooded. */
const FLOOD_SCORES: Record<string, number> = {
  "w-15": 0.86,
  "w-18": 0.78,
  "w-12": 0.71,
  "w-42": 0.64,
  "w-39": 0.55,
  "w-34": 0.48,
  "w-31": 0.41,
  "w-21": 0.33,
  "w-47": 0.29,
  "w-23": 0.22,
  "w-27": 0.19,
  "w-58": 0.16,
  "w-51": 0.12,
  "w-55": 0.08,
}

const RAINFALL_MM: Record<string, number> = {
  "w-15": 142,
  "w-18": 138,
  "w-12": 131,
  "w-42": 124,
  "w-39": 118,
  "w-34": 126,
  "w-31": 121,
  "w-21": 117,
  "w-47": 104,
  "w-23": 112,
  "w-27": 109,
  "w-58": 101,
  "w-51": 96,
  "w-55": 92,
}

const PAST_EVENTS: Record<string, number> = {
  "w-15": 5,
  "w-18": 4,
  "w-12": 4,
  "w-42": 3,
  "w-39": 2,
  "w-34": 2,
  "w-31": 1,
  "w-21": 1,
  "w-47": 1,
  "w-23": 0,
  "w-27": 0,
  "w-58": 0,
  "w-51": 0,
  "w-55": 0,
}

function buildWardRisk(wardId: string, scale: number): WardRisk {
  const w = wardById(wardId)!
  const base = FLOOD_SCORES[wardId] ?? 0.1
  const score = Math.min(0.97, base * scale)
  const rain = RAINFALL_MM[wardId] ?? 90
  const past = PAST_EVENTS[wardId] ?? 0
  // Elevation relative to the lowest ward in the city.
  const minElev = Math.min(...WARDS.map((x) => x.elevationM))
  const elevPenalty = Math.max(0, 1 - (w.elevationM - minElev) / 80)

  const raw = [
    {
      label: "Forecast rainfall",
      v: rain / 160,
      detail: `${rain} mm expected in 6 h (IMD + Open-Meteo)`,
    },
    {
      label: "Reservoir discharge",
      v: base * 0.9,
      detail: "45,000 cusecs released from Khadakwasla at 17:30",
    },
    {
      label: "Low-lying terrain",
      v: elevPenalty,
      detail: `Mean elevation ${w.elevationM} m, ${Math.round(elevPenalty * 100)}% of ward below flood datum`,
    },
    {
      label: "Drainage capacity",
      v: base * 0.7,
      detail: "Storm drain capacity historically exceeded at this intensity",
    },
    {
      label: "Recorded flood history",
      v: past / 5,
      detail:
        past > 0
          ? `${past} flood events recorded here since 2019`
          : "No recorded flood events since 2019",
    },
  ]
  const total = raw.reduce((a, b) => a + b.v, 0) || 1
  const drivers = raw
    .map((d) => ({
      label: d.label,
      contribution: d.v / total,
      detail: d.detail,
    }))
    .sort((a, b) => b.contribution - a.contribution)

  // Risk climbs, peaks around hour 5, then eases.
  const projection = Array.from({ length: 12 }, (_, h) => {
    const shape = Math.exp(-Math.pow((h - 5) / 3.4, 2))
    return Math.min(0.99, Number((score * (0.42 + 0.58 * shape)).toFixed(3)))
  })

  return {
    wardId,
    hazard: "flood",
    score: Number(score.toFixed(3)),
    severity: scoreToSeverity(score),
    leadTimeHours: score > 0.7 ? 1.2 : score > 0.5 ? 2.5 : score > 0.3 ? 5 : 9,
    confidence: Number((0.72 + base * 0.24).toFixed(2)),
    populationAtRisk: Math.round(w.population * score * 0.34),
    drivers,
    projection,
  }
}

export function buildRun(scale = 1): HazardRun {
  return {
    id: "run-flood-2024-07-25",
    hazard: "flood",
    startedAt: simTime(0),
    sources: [
      "Open-Meteo forecast (rainfall, 1 h)",
      "Open-Meteo Flood / GloFAS v4 (river discharge)",
      "IMD district warning bulletin",
      "CWC reservoir bulletin — Khadakwasla",
      "PMC ward boundaries + Copernicus DEM (PostGIS)",
    ],
    wardRisks: WARDS.map((w) => buildWardRisk(w.id, scale)).sort(
      (a, b) => b.score - a.score
    ),
  }
}

/* ------------------------------------------------------------ resources ---- */

interface ResSeed {
  kind: Resource["kind"]
  label: string
  operator: string
  ward: string
  capacity: number
}

const RES_SEEDS: ResSeed[] = [
  {
    kind: "boat",
    label: "Rescue Boat R-1",
    operator: "PMC Fire Brigade",
    ward: "w-18",
    capacity: 8,
  },
  {
    kind: "boat",
    label: "Rescue Boat R-2",
    operator: "PMC Fire Brigade",
    ward: "w-12",
    capacity: 8,
  },
  {
    kind: "boat",
    label: "Rescue Boat R-3",
    operator: "NDRF 5th Bn",
    ward: "w-39",
    capacity: 12,
  },
  {
    kind: "pump",
    label: "Dewatering Pump P-1",
    operator: "PMC Drainage",
    ward: "w-15",
    capacity: 1,
  },
  {
    kind: "pump",
    label: "Dewatering Pump P-2",
    operator: "PMC Drainage",
    ward: "w-18",
    capacity: 1,
  },
  {
    kind: "pump",
    label: "Dewatering Pump P-3",
    operator: "PMC Drainage",
    ward: "w-23",
    capacity: 1,
  },
  {
    kind: "pump",
    label: "Dewatering Pump P-4",
    operator: "PMC Drainage",
    ward: "w-47",
    capacity: 1,
  },
  {
    kind: "ambulance",
    label: "Ambulance A-1",
    operator: "PMC Health",
    ward: "w-12",
    capacity: 2,
  },
  {
    kind: "ambulance",
    label: "Ambulance A-2",
    operator: "PMC Health",
    ward: "w-31",
    capacity: 2,
  },
  {
    kind: "ambulance",
    label: "Ambulance A-3",
    operator: "108 Service",
    ward: "w-47",
    capacity: 2,
  },
  {
    kind: "fire_engine",
    label: "Fire Tender F-1",
    operator: "PMC Fire Brigade",
    ward: "w-21",
    capacity: 6,
  },
  {
    kind: "fire_engine",
    label: "Fire Tender F-2",
    operator: "PMC Fire Brigade",
    ward: "w-39",
    capacity: 6,
  },
  {
    kind: "rescue_team",
    label: "Rescue Team T-1",
    operator: "NDRF 5th Bn",
    ward: "w-18",
    capacity: 10,
  },
  {
    kind: "rescue_team",
    label: "Rescue Team T-2",
    operator: "PMC Disaster Cell",
    ward: "w-31",
    capacity: 8,
  },
  {
    kind: "bus",
    label: "PMPML Bus B-1",
    operator: "PMPML",
    ward: "w-23",
    capacity: 45,
  },
  {
    kind: "bus",
    label: "PMPML Bus B-2",
    operator: "PMPML",
    ward: "w-21",
    capacity: 45,
  },
  {
    kind: "bus",
    label: "PMPML Bus B-3",
    operator: "PMPML",
    ward: "w-47",
    capacity: 45,
  },
  {
    kind: "jcb",
    label: "JCB Unit J-1",
    operator: "PMC Works",
    ward: "w-27",
    capacity: 1,
  },
]

export const BASE_RESOURCES: Resource[] = RES_SEEDS.map((r, i) => {
  const w = wardById(r.ward)!
  return {
    id: `res-${i + 1}`,
    kind: r.kind,
    label: r.label,
    operator: r.operator,
    baseLocation: w.centroid,
    location: w.centroid,
    capacity: r.capacity,
    status: "available",
    assignmentId: null,
  }
})

export const RESOURCE_LABEL: Record<Resource["kind"], string> = {
  boat: "Rescue boat",
  pump: "Dewatering pump",
  ambulance: "Ambulance",
  fire_engine: "Fire tender",
  rescue_team: "Rescue team",
  bus: "Evacuation bus",
  jcb: "JCB / earthmover",
}

/* ------------------------------------------------------- initial world ---- */

export function idleStatus(): SystemStatus {
  return {
    mode: "live",
    llm: { engine: "gemini", note: "Gemini 2.0 Flash responding" },
    simulatedTime: null,
    scenarioId: null,
    feeds: [
      {
        id: "om",
        label: "Open-Meteo forecast",
        state: "live",
        lastUpdated: new Date().toISOString(),
        detail: "Hourly rainfall, 16-day horizon",
      },
      {
        id: "glofas",
        label: "GloFAS river discharge",
        state: "live",
        lastUpdated: new Date().toISOString(),
        detail: "Mutha basin, 5 km resolution",
      },
      {
        id: "imd",
        label: "IMD warnings",
        state: "live",
        lastUpdated: new Date().toISOString(),
        detail: "Pune district bulletin",
      },
      {
        id: "cwc",
        label: "CWC reservoir levels",
        state: "live",
        lastUpdated: new Date().toISOString(),
        detail: "Khadakwasla, Panshet, Varasgaon",
      },
      {
        id: "gis",
        label: "PMC ward geometry",
        state: "live",
        lastUpdated: new Date().toISOString(),
        detail: "14 wards, DEM + exposure layers",
      },
    ],
  }
}

export function initialWorld(): World {
  return {
    now: new Date().toISOString(),
    status: idleStatus(),
    run: null,
    incidents: [],
    reports: [],
    resources: BASE_RESOURCES.map((r) => ({ ...r })),
    plan: null,
    decisions: [],
    agentRuns: [],
    alerts: [],
    tasks: [],
    shelters: SHELTERS.map((s) => ({ ...s })),
  }
}

/* ------------------------------------------------------------- helpers ---- */

export function nearestAvailable(
  resources: Resource[],
  kind: Resource["kind"],
  to: [number, number]
): Resource | null {
  const pool = resources.filter(
    (r) => r.kind === kind && r.status === "available"
  )
  if (!pool.length) return null
  return pool.sort(
    (a, b) => distanceKm(a.location, to) - distanceKm(b.location, to)
  )[0]
}

export function makeAssignment(
  resource: Resource,
  wardId: string,
  purpose: string,
  incidentId: string | null,
  atMin: number
): Assignment {
  const w = wardById(wardId)!
  const d = distanceKm(resource.location, w.centroid)
  // Urban travel: ~18 km/h effective during an active flood event.
  const eta = Math.max(4, Math.round((d / 18) * 60))
  return {
    id: `as-${resource.id}-${wardId}`,
    resourceId: resource.id,
    incidentId,
    wardId,
    purpose,
    etaMinutes: eta,
    distanceKm: Number(d.toFixed(1)),
    status: "proposed",
    createdAt: simTime(atMin),
  }
}

export function makeDecision(
  id: string,
  action: string,
  actionLabel: string,
  target: string,
  wardId: string | null,
  rationale: string,
  confidence: number,
  severity: number,
  atMin: number,
  agentRunId: string
): Decision {
  const authority = authorityFor(action, severity)
  return {
    id,
    createdAt: simTime(atMin),
    hazard: "flood",
    action: actionLabel,
    target,
    wardId,
    rationale,
    confidence,
    authority,
    status:
      authority.withinDelegation && confidence >= 0.7
        ? "auto_issued"
        : "awaiting_approval",
    decidedBy: null,
    decidedAt: null,
    overrideNote: null,
    agentRunId,
  }
}

export function makeAlert(
  wardId: string,
  severity: Alert["severity"],
  decisionId: string,
  atMin: number
): Alert {
  const w = wardById(wardId)!
  const shelter = SHELTERS.filter((s) => s.occupancy < s.capacity).sort(
    (a, b) =>
      distanceKm(w.centroid, a.location) - distanceKm(w.centroid, b.location)
  )[0]
  const d = distanceKm(w.centroid, shelter.location)
  const byTime = new Date(T0.getTime() + (atMin + 70) * 60_000)
  return {
    id: `al-${wardId}`,
    wardId,
    hazard: "flood",
    severity,
    headline:
      severity >= 5
        ? "Flooding expected on your street within the hour"
        : "Heavy flooding likely in your area tonight",
    action:
      severity >= 5
        ? "Move to higher ground now. Do not use the underpass."
        : "Avoid low-lying roads. Keep documents and medicines ready.",
    byTime: byTime.toISOString(),
    safeLocation: {
      name: shelter.name,
      location: shelter.location,
      distanceKm: Number(d.toFixed(1)),
    },
    channels:
      severity >= 4 ? ["push", "sms", "web", "whatsapp"] : ["push", "web"],
    issuedAt: simTime(atMin),
    decisionId,
    language: "Marathi · Hindi · English",
    reach: Math.round(w.population * 0.61),
  }
}

export function makeIncident(
  id: string,
  title: string,
  category: Incident["category"],
  wardId: string,
  offset: [number, number],
  severity: Incident["severity"],
  reportCount: number,
  confidence: number,
  atMin: number,
  reportIds: string[]
): Incident {
  const w = wardById(wardId)!
  return {
    id,
    title,
    category,
    hazard: "flood",
    wardId,
    location: [w.centroid[0] + offset[0], w.centroid[1] + offset[1]],
    severity,
    status: "reported",
    reportCount,
    confidence,
    createdAt: simTime(atMin),
    updatedAt: simTime(atMin),
    reportIds,
  }
}

export function makeTask(
  assignment: Assignment,
  resource: Resource,
  title: string,
  instruction: string,
  location: [number, number],
  priority: FieldTask["priority"]
): FieldTask {
  return {
    id: `ft-${assignment.id}`,
    assignmentId: assignment.id,
    operator: resource.operator,
    resourceId: resource.id,
    title,
    instruction,
    location,
    wardId: assignment.wardId,
    status: "queued",
    acceptedAt: null,
    completedAt: null,
    proofNote: null,
    priority,
  }
}

export function planFrom(
  assignments: Assignment[],
  uncoveredWards: string[],
  atMin: number,
  engine: AllocationPlan["solver"]["engine"]
): AllocationPlan {
  return {
    id: `plan-${atMin}`,
    hazard: "flood",
    generatedAt: simTime(atMin),
    assignments,
    uncovered: uncoveredWards.map((wid) => ({
      wardId: wid,
      incidentId: null,
      need: "1 dewatering pump",
      reason:
        "No pump within 25 min travel time; nearest unit already committed to a higher-severity ward",
      shortfall: 1,
    })),
    objective:
      "Minimise total population-weighted time-to-arrival, subject to unit capacity, one assignment per unit, and travel times over the flood-adjusted road graph.",
    solver: {
      engine,
      runtimeMs: engine === "cp-sat" ? 384 : 12,
      variables: 18 * 14,
      constraints: 246,
      coverage:
        assignments.length / (assignments.length + uncoveredWards.length || 1),
    },
  }
}

export const REPORTERS = [
  "Priya Deshmukh",
  "Rahul Jadhav",
  "Aarti Kulkarni",
  "Imran Shaikh",
  "Sneha Pawar",
  "Vikram Patil",
  "Meera Joshi",
  "Sagar Gaikwad",
]

export function makeReport(
  i: number,
  wardId: string,
  category: CitizenReport["category"],
  note: string,
  offset: [number, number],
  atMin: number,
  incidentId: string | null,
  confidence: number
): CitizenReport {
  const w = wardById(wardId)!
  return {
    id: `rep-${i}`,
    incidentId,
    wardId,
    category,
    location: [w.centroid[0] + offset[0], w.centroid[1] + offset[1]],
    note,
    photoUrl: null,
    createdAt: simTime(atMin),
    classifiedAs: category,
    classificationConfidence: confidence,
    reporterName: REPORTERS[i % REPORTERS.length],
  }
}

export { wardName, wardById, distanceKm }
