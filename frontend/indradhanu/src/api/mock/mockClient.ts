import type {
  AgentRun,
  Alert,
  AllocationPlan,
  CitizenReport,
  CitizenSituation,
  Decision,
  FieldTask,
  HazardRun,
  HazardType,
  IndradhanuApi,
  Incident,
  Lifeline,
  Resource,
  Shelter,
  SystemStatus,
  Ward,
  WardRisk,
} from "@/api/types"
import { useScenario } from "@/scenario/store"
import {
  LIFELINES,
  WARDS,
  distanceKm,
  nearestShelter,
  routeTo,
  wardById,
} from "./geo"
import { REPORTERS, simTime } from "./world"

const w = () => useScenario.getState().world
const wait = <T>(v: T, ms = 90): Promise<T> =>
  new Promise((res) => setTimeout(() => res(v), ms))

/** Extra reports a judge files through the citizen portal during the demo.
 *  Kept outside the scripted world so scrubbing the timeline does not erase
 *  something the judge just did. */
const submitted: CitizenReport[] = []

export const mockClient: IndradhanuApi = {
  getSystemStatus: () => wait<SystemStatus>(w().status),
  getWards: () => wait<Ward[]>(WARDS),
  getLifelines: () => wait<Lifeline[]>(LIFELINES),
  getShelters: () => wait<Shelter[]>(w().shelters),

  getActiveRun: (hazard: HazardType) =>
    wait<HazardRun | null>(
      w().run && w().run!.hazard === hazard ? w().run : null
    ),

  getWardRisks: (hazard: HazardType) =>
    wait<WardRisk[]>(w().run?.hazard === hazard ? w().run!.wardRisks : []),

  getIncidents: () => wait<Incident[]>(w().incidents),

  getReports: (incidentId?: string) => {
    const all = [...w().reports, ...submitted]
    return wait<CitizenReport[]>(
      incidentId ? all.filter((r) => r.incidentId === incidentId) : all
    )
  },

  submitReport: (input) => {
    const n = w().reports.length + submitted.length + 1
    const rec: CitizenReport = {
      id: `rep-user-${n}`,
      incidentId: null,
      wardId: input.wardId,
      category: input.category,
      location: input.location,
      note: input.note,
      photoUrl: input.photoUrl ?? null,
      createdAt: new Date().toISOString(),
      classifiedAs: input.category,
      classificationConfidence: 0.81 + Math.random() * 0.14,
      reporterName: REPORTERS[n % REPORTERS.length],
    }
    submitted.push(rec)
    return wait(rec, 420)
  },

  getResources: () => wait<Resource[]>(w().resources),
  getAllocationPlan: () => wait<AllocationPlan | null>(w().plan),
  getDecisions: () => wait<Decision[]>(w().decisions),

  actOnDecision: (id, action, note) => {
    const status: Decision["status"] =
      action === "approve"
        ? "approved"
        : action === "reject"
          ? "rejected"
          : "overridden"
    useScenario.getState().decide(id, status, "A. Kulkarni, Ward Officer", note)
    const d = w().decisions.find((x) => x.id === id)!
    return wait(d, 260)
  },

  getAgentRuns: () => wait<AgentRun[]>(w().agentRuns),
  getAgentRun: (id) =>
    wait<AgentRun | null>(w().agentRuns.find((r) => r.id === id) ?? null),
  getAlerts: () => wait<Alert[]>(w().alerts),

  getCitizenSituation: (wardId) => {
    const ward = wardById(wardId)
    const risk = w().run?.wardRisks.find((r) => r.wardId === wardId) ?? null
    const alert = w().alerts.find((a) => a.wardId === wardId) ?? null
    if (!ward) {
      return wait<CitizenSituation>({
        wardId,
        atRisk: false,
        risk: null,
        alert: null,
        route: null,
        shelter: null,
      })
    }
    const shelter = alert ? nearestShelter(ward.centroid) : null
    return wait<CitizenSituation>({
      wardId,
      atRisk: !!risk && risk.severity >= 3,
      risk,
      alert,
      route: shelter ? routeTo(ward.centroid, shelter.location) : null,
      shelter,
    })
  },

  askAgent: (question, wardId) => {
    const ward = wardById(wardId)
    const risk = w().run?.wardRisks.find((r) => r.wardId === wardId)
    const alert = w().alerts.find((a) => a.wardId === wardId)
    const shelter = ward ? nearestShelter(ward.centroid) : null
    const q = question.toLowerCase()

    let answer: string
    if (!risk) {
      answer = `There is no active hazard for ${ward?.name ?? "your area"} right now. I will tell you the moment that changes — you do not need to keep checking.`
    } else if (
      q.includes("safe") ||
      q.includes("should i") ||
      q.includes("leave") ||
      q.includes("evacuat")
    ) {
      answer = alert
        ? `${ward!.name} is at ${risk.severity >= 5 ? "critical" : "high"} flood risk. ${alert.action} The nearest open shelter is ${shelter!.name}, ${distanceKm(ward!.centroid, shelter!.location).toFixed(1)} km away, and it has space. Leave before ${new Date(alert.byTime).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}.`
        : `${ward!.name} is at moderate risk. You do not need to move yet. Avoid low-lying roads and keep your phone charged — I will send an instruction if that changes.`
    } else if (q.includes("why") || q.includes("reason")) {
      const d = risk.drivers
        .slice(0, 3)
        .map((x) => `${x.label} (${Math.round(x.contribution * 100)}%)`)
        .join(", ")
      answer = `Your risk score is ${Math.round(risk.score * 100)} out of 100. The main reasons are ${d}. ${risk.drivers[0].detail}.`
    } else if (q.includes("shelter") || q.includes("where")) {
      answer = shelter
        ? `Go to ${shelter.name}. It is ${distanceKm(ward!.centroid, shelter.location).toFixed(1)} km away and currently holding ${shelter.occupancy} of ${shelter.capacity} people, so there is room. Avoid the underpass route — it is under water.`
        : `No shelter has been activated for your ward yet.`
    } else if (
      q.includes("road") ||
      q.includes("route") ||
      q.includes("drive")
    ) {
      answer = `The Vitthalwadi underpass approach is impassable — five residents have reported standing water there and a rescue team is on site. Use the north approach instead.`
    } else {
      answer = `${ward!.name} is currently at ${Math.round(risk.score * 100)}/100 flood risk with about ${risk.leadTimeHours} hours of lead time. ${alert ? alert.action : "No action is needed from you yet."} Ask me why if you want the reasoning behind that score.`
    }
    return wait({ answer, engine: "fallback" as const }, 700)
  },

  getFieldTasks: (operator?: string) =>
    wait<FieldTask[]>(
      operator ? w().tasks.filter((t) => t.operator === operator) : w().tasks
    ),

  updateFieldTask: (id, status, proofNote) => {
    useScenario.getState().updateTask(id, status, proofNote)
    const t = w().tasks.find((x) => x.id === id)!
    return wait(t, 220)
  },
}

export { simTime }
