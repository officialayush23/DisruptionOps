import type {
  AgentRun,
  AgentStep,
  Assignment,
  Decision,
  FieldTask,
} from "@/api/types"
import { SHELTERS, wardById } from "@/api/mock/geo"
import {
  BASE_RESOURCES,
  buildRun,
  makeAlert,
  makeAssignment,
  makeDecision,
  makeIncident,
  makeReport,
  makeTask,
  nearestAvailable,
  planFrom,
  simTime,
  type World,
} from "@/api/mock/world"

export interface ScenarioStep {
  id: string
  /** Minutes after 18:00 IST on 25 July 2024. */
  atMin: number
  title: string
  /** One line the demo guide reads out. */
  narration: string
  /** Where the tour should be looking when this step fires. */
  route: string
  /** Ward to fly the map to, if any. */
  focusWardId?: string
  /** True when the step needs the judge to do something. */
  interactive?: boolean
  apply: (w: World) => World
}

const RUN_ID = "agentrun-1"

function step(
  agent: AgentStep["agent"],
  atMin: number,
  ms: number,
  thought: string,
  tool: string | null,
  toolInput: string | null,
  toolOutput: string | null,
  citedClause: string | null = null,
  status: AgentStep["status"] = "ok"
): AgentStep {
  return {
    id: `${agent}-${atMin}-${Math.round(ms)}`,
    agent,
    startedAt: simTime(atMin),
    durationMs: ms,
    thought,
    tool,
    toolInput,
    toolOutput,
    citedClause,
    status,
  }
}

function withRun(w: World, patch: (r: AgentRun) => AgentRun): World {
  const existing = w.agentRuns.find((r) => r.id === RUN_ID)
  const base: AgentRun = existing ?? {
    id: RUN_ID,
    hazard: "flood",
    trigger:
      "GloFAS discharge threshold exceeded for Mutha basin + IMD red bulletin, Pune district",
    startedAt: simTime(0),
    finishedAt: null,
    engine: "gemini",
    steps: [],
    summary: "",
  }
  const next = patch(base)
  return {
    ...w,
    agentRuns: [next, ...w.agentRuns.filter((r) => r.id !== RUN_ID)],
  }
}

export const STEPS: ScenarioStep[] = [
  {
    id: "s1",
    atMin: 0,
    title: "Hazard signal ingested",
    narration:
      "18:00. GloFAS river discharge for the Mutha basin crosses threshold and IMD issues a red bulletin for Pune district. Indradhanu opens a hazard run.",
    route: "/admin/risk",
    apply: (w) => {
      const run = buildRun(0.72)
      return withRun(
        {
          ...w,
          now: simTime(0),
          run,
          status: {
            ...w.status,
            simulatedTime: simTime(0),
            scenarioId: "pune-flood-2024-07-25",
          },
        },
        (r) => ({
          ...r,
          steps: [
            step(
              "hazard_analyst",
              0,
              210,
              "Discharge forecast for the Mutha basin exceeds the 90th percentile for July. Opening a flood run for Pune.",
              "open_meteo.flood",
              "lat=18.52 lon=73.86 daily=river_discharge",
              "river_discharge 2024-07-25: 1,284 m³/s (p95 = 940 m³/s)"
            ),
            step(
              "hazard_analyst",
              0,
              340,
              "Rainfall forecast confirms sustained intensity over the catchment for the next six hours.",
              "open_meteo.forecast",
              "hourly=precipitation&forecast_hours=12",
              "peak 31 mm/h at 21:00; 6 h total 118–142 mm across ward centroids"
            ),
            step(
              "hazard_analyst",
              0,
              180,
              "Khadakwasla is discharging. This is the dominant driver, not the rainfall alone.",
              "cwc.reservoir",
              "reservoir=Khadakwasla",
              "gates open 17:30, outflow 45,000 cusecs, storage 98.2%"
            ),
          ],
        })
      )
    },
  },
  {
    id: "s2",
    atMin: 5,
    title: "Exposure joined, wards ranked",
    narration:
      "18:05. The hazard grid is joined against ward geometry, terrain and population. Fourteen wards are ranked; Vitthalwadi–Ekta Nagar comes out critical.",
    route: "/admin/risk",
    focusWardId: "w-15",
    apply: (w) => {
      const run = buildRun(1)
      const atRisk = run.wardRisks
        .filter((r) => r.severity >= 4)
        .reduce((a, r) => a + r.populationAtRisk, 0)
      return withRun(
        {
          ...w,
          now: simTime(5),
          run,
          status: { ...w.status, simulatedTime: simTime(5) },
        },
        (r) => ({
          ...r,
          steps: [
            ...r.steps,
            step(
              "impact_exposure",
              5,
              520,
              "Joining the hazard grid to ward polygons, the elevation model and census population.",
              "postgis.exposure_join",
              "ST_Intersects(hazard_cells, pmc_wards) + dem + census",
              `4 wards at severity 4+, ${atRisk.toLocaleString("en-IN")} residents in the affected footprint`
            ),
            step(
              "impact_exposure",
              5,
              260,
              "Checking which lifelines fall inside the high-severity footprint.",
              "postgis.lifelines",
              "wards in ('w-15','w-18','w-12','w-42')",
              "3 schools, 1 hospital, 2 pump stations, 1 substation"
            ),
            step(
              "impact_exposure",
              5,
              150,
              "Vitthalwadi–Ekta Nagar is the worst cell: lowest elevation, five recorded flood events since 2019, and it sits directly downstream of the discharge.",
              null,
              null,
              null
            ),
          ],
        })
      )
    },
  },
  {
    id: "s3",
    atMin: 7,
    title: "Policy retrieved, plan solved",
    narration:
      "18:07. The agent retrieves the clauses that govern each candidate action, then the solver allocates units against the ranked wards.",
    route: "/admin/allocation",
    apply: (w) => {
      const resources = w.resources.map((r) => ({ ...r }))
      const assignments: Assignment[] = []
      const take = (
        kind: Assignment extends never
          ? never
          : Parameters<typeof nearestAvailable>[1],
        wardId: string,
        purpose: string
      ) => {
        const ward = wardById(wardId)!
        const res = nearestAvailable(resources, kind, ward.centroid)
        if (!res) return null
        const a = makeAssignment(res, wardId, purpose, null, 7)
        res.status = "assigned"
        res.assignmentId = a.id
        assignments.push(a)
        return a
      }
      take("pump", "w-15", "Pre-position at Vitthalwadi storm pump inlet")
      take("boat", "w-15", "Stage for shallow-water rescue at Ekta Nagar")
      take("rescue_team", "w-18", "Stage at Sinhagad Road municipal hall")
      take("pump", "w-18", "Clear the Mutha right-bank outfall")
      take("bus", "w-15", "Shuttle to Sinhagad Road Municipal Hall shelter")
      take("ambulance", "w-12", "Stand by at Sassoon approach road")
      take("boat", "w-12", "Stage at Kasba riverside ghat")

      const plan = planFrom(assignments, ["w-42"], 7, "cp-sat")
      return withRun(
        {
          ...w,
          now: simTime(7),
          resources,
          plan,
          status: { ...w.status, simulatedTime: simTime(7) },
        },
        (r) => ({
          ...r,
          steps: [
            ...r.steps,
            step(
              "policy_retriever",
              7,
              410,
              "Retrieving the clauses that authorise each candidate action before proposing any of them.",
              "policy.search",
              "advisory, pre-position, road closure, school evacuation, shelter activation",
              "5 clauses matched across the PMC DM Plan and the NDMA urban flooding guidelines",
              "PMC DMP 2023, cl. 4.2"
            ),
            step(
              "policy_retriever",
              7,
              190,
              "School evacuation is not delegated to the Ward Officer. That one has to go to a human.",
              "policy.check_delegation",
              "action=evacuate_school severity=5",
              "NDMA UF Guidelines §7.3 — Municipal Commissioner only",
              "NDMA UF Guidelines 2010, §7.3"
            ),
            step(
              "allocation_planner",
              7,
              384,
              "Solving the assignment: minimise population-weighted arrival time, respecting unit capacity and the flood-adjusted road graph.",
              "ortools.cp_sat",
              "252 vars, 246 constraints, 18 units, 14 wards",
              `optimal in 384 ms — ${assignments.length} units assigned, 1 ward left uncovered`
            ),
            step(
              "allocation_planner",
              7,
              120,
              "Kalyani Nagar cannot be covered: the nearest free pump is 31 minutes out and already committed to a higher-severity ward. Flagging it rather than hiding it.",
              null,
              null,
              null
            ),
          ],
        })
      )
    },
  },
  {
    id: "s4",
    atMin: 8,
    title: "Actions reach the authority gate",
    narration:
      "18:08. Seven actions are proposed. Five sit inside the Ward Officer's delegation and issue automatically. Two do not, and stop for a human.",
    route: "/admin/decisions",
    apply: (w) => {
      const D = (
        id: string,
        action: string,
        label: string,
        target: string,
        ward: string | null,
        rationale: string,
        conf: number,
        sev: number
      ) =>
        makeDecision(
          id,
          action,
          label,
          target,
          ward,
          rationale,
          conf,
          sev,
          8,
          RUN_ID
        )

      const decisions: Decision[] = [
        D(
          "dec-1",
          "issue_warning",
          "Issue red flood advisory",
          "Ward 15 — Vitthalwadi–Ekta Nagar",
          "w-15",
          "Severity 5 with 1.2 h lead time. Advisory is delegated and the forecast is competent.",
          0.94,
          5
        ),
        D(
          "dec-2",
          "issue_warning",
          "Issue red flood advisory",
          "Ward 18 — Sinhagad Road",
          "w-18",
          "Severity 4 with 2.5 h lead time, downstream of the same discharge.",
          0.91,
          4
        ),
        D(
          "dec-3",
          "preposition_equipment",
          "Pre-position 2 pumps and 2 boats",
          "Wards 15 and 18",
          "w-15",
          "Units are free and within 12 minutes. Pre-positioning is delegated during an active alert.",
          0.88,
          5
        ),
        D(
          "dec-4",
          "activate_shelter",
          "Activate shelter and deploy transport",
          "Sinhagad Road Municipal Hall",
          "w-18",
          "Red advisory is in force for the ward, which is the condition the clause requires.",
          0.86,
          5
        ),
        D(
          "dec-5",
          "close_road",
          "Close road and divert traffic",
          "Vitthalwadi underpass",
          "w-15",
          "Standing water projected above 0.3 m within the hour at this point.",
          0.79,
          4
        ),
        D(
          "dec-6",
          "evacuate_school",
          "Evacuate school",
          "Vitthalwadi Municipal School — 340 children",
          "w-15",
          "The school sits inside the severity-5 footprint. Evacuation is not delegated to the Ward Officer, so this escalates.",
          0.82,
          5
        ),
        D(
          "dec-7",
          "requisition_ndrf",
          "Requisition NDRF assistance",
          "2 additional teams for Wards 15 and 18",
          "w-15",
          "Committed units cover 6 of 7 demands. A second wave would need capacity the corporation does not hold.",
          0.64,
          5
        ),
      ]

      return withRun(
        {
          ...w,
          now: simTime(8),
          decisions,
          status: { ...w.status, simulatedTime: simTime(8) },
        },
        (r) => ({
          ...r,
          steps: [
            ...r.steps,
            step(
              "guidance_agent",
              8,
              230,
              "Five actions are inside delegated authority and clear the gate automatically. Two are not.",
              "gate.evaluate",
              "7 proposed actions",
              "5 auto-issued · 2 awaiting officer approval",
              "PMC DMP 2023, cl. 4.2"
            ),
          ],
        })
      )
    },
  },
  {
    id: "s5",
    atMin: 10,
    title: "Officer decides the escalated actions",
    narration:
      "18:10. The school evacuation and the NDRF request are waiting. Approve or override them — the system will not issue either on its own.",
    route: "/admin/decisions",
    interactive: true,
    apply: (w) => ({
      ...w,
      now: simTime(10),
      status: { ...w.status, simulatedTime: simTime(10) },
    }),
  },
  {
    id: "s6",
    atMin: 12,
    title: "Alerts reach residents",
    narration:
      "18:12. Advisories go out to three wards in Marathi, Hindi and English — four fields only: what, where you are in it, by when, and where to go.",
    route: "/citizen",
    focusWardId: "w-15",
    apply: (w) => {
      const alerts = [
        makeAlert("w-15", 5, "dec-1", 12),
        makeAlert("w-18", 4, "dec-2", 12),
        makeAlert("w-12", 4, "dec-2", 12),
      ]
      const shelters = w.shelters.map((s) =>
        s.name === "Sinhagad Road Municipal Hall" ? { ...s, occupancy: 86 } : s
      )
      return withRun(
        {
          ...w,
          now: simTime(12),
          alerts,
          shelters,
          status: { ...w.status, simulatedTime: simTime(12) },
        },
        (r) => ({
          ...r,
          steps: [
            ...r.steps,
            step(
              "guidance_agent",
              12,
              640,
              "Writing the resident-facing instruction. Naming a specific reachable shelter, not 'move to safety'.",
              "guidance.compose",
              "ward=w-15 severity=5 lang=mr,hi,en",
              "3 advisories issued · reach 96,400 residents · push, SMS, web, WhatsApp"
            ),
          ],
        })
      )
    },
  },
  {
    id: "s7",
    atMin: 20,
    title: "Citizen reports start arriving",
    narration:
      "18:20. Residents begin sending photos. Seven reports land within five minutes, most of them from the same stretch of road.",
    route: "/admin/incidents",
    focusWardId: "w-15",
    apply: (w) => {
      const reports = [
        makeReport(
          1,
          "w-15",
          "flooded_road",
          "Water above knee level near the bridge",
          [0.001, 0.0008],
          20,
          null,
          0.93
        ),
        makeReport(
          2,
          "w-15",
          "flooded_road",
          "Cannot cross, water rising fast",
          [0.0013, 0.0006],
          21,
          null,
          0.9
        ),
        makeReport(
          3,
          "w-15",
          "waterlogging",
          "Whole lane is under water",
          [0.0009, 0.0011],
          21,
          null,
          0.87
        ),
        makeReport(
          4,
          "w-15",
          "flooded_road",
          "Bike stalled in the middle of the road",
          [0.0016, 0.0009],
          22,
          null,
          0.91
        ),
        makeReport(
          5,
          "w-18",
          "blocked_drain",
          "Drain overflowing on the service road",
          [-0.0012, 0.0007],
          22,
          null,
          0.84
        ),
        makeReport(
          6,
          "w-15",
          "person_stranded",
          "Two people on a scooter stuck near the underpass",
          [0.0011, 0.0012],
          23,
          null,
          0.79
        ),
        makeReport(
          7,
          "w-12",
          "fallen_tree",
          "Tree down across the lane",
          [0.0008, -0.0009],
          23,
          null,
          0.88
        ),
      ]
      return {
        ...w,
        now: simTime(20),
        reports,
        status: { ...w.status, simulatedTime: simTime(20) },
      }
    },
  },
  {
    id: "s8",
    atMin: 25,
    title: "Vision model clusters them into one incident",
    narration:
      "18:25. Five reports within 180 metres of each other, all classified as standing water, collapse into a single confirmed incident — not five tickets.",
    route: "/admin/incidents",
    focusWardId: "w-15",
    apply: (w) => {
      const clustered = ["rep-1", "rep-2", "rep-3", "rep-4", "rep-6"]
      const inc1 = makeIncident(
        "inc-1",
        "Road impassable — Vitthalwadi underpass approach",
        "flooded_road",
        "w-15",
        [0.0012, 0.0009],
        5,
        5,
        0.92,
        25,
        clustered
      )
      inc1.status = "confirmed"
      const inc2 = makeIncident(
        "inc-2",
        "Drain overflow — Sinhagad Road service lane",
        "blocked_drain",
        "w-18",
        [-0.0012, 0.0007],
        3,
        1,
        0.84,
        25,
        ["rep-5"]
      )
      const inc3 = makeIncident(
        "inc-3",
        "Tree down across carriageway",
        "fallen_tree",
        "w-12",
        [0.0008, -0.0009],
        2,
        1,
        0.88,
        25,
        ["rep-7"]
      )
      const reports = w.reports.map((r) =>
        clustered.includes(r.id)
          ? { ...r, incidentId: "inc-1" }
          : r.id === "rep-5"
            ? { ...r, incidentId: "inc-2" }
            : r.id === "rep-7"
              ? { ...r, incidentId: "inc-3" }
              : r
      )
      return withRun(
        {
          ...w,
          now: simTime(25),
          incidents: [inc1, inc2, inc3],
          reports,
          status: { ...w.status, simulatedTime: simTime(25) },
        },
        (r) => ({
          ...r,
          steps: [
            ...r.steps,
            step(
              "impact_exposure",
              25,
              470,
              "Classifying each photo, then clustering by location and category so the console shows incidents rather than a report feed.",
              "vision.classify_cluster",
              "7 reports · DBSCAN eps=180 m",
              "3 incidents · largest cluster 5 reports · confidence 0.92"
            ),
          ],
        })
      )
    },
  },
  {
    id: "s9",
    atMin: 27,
    title: "Re-plan and dispatch",
    narration:
      "18:27. The confirmed incident changes the picture. The solver re-runs with the flooded stretch removed from the road graph, and field teams are dispatched.",
    route: "/field",
    focusWardId: "w-15",
    apply: (w) => {
      const resources = w.resources.map((r) => ({ ...r }))
      const assignments = [...(w.plan?.assignments ?? [])]
      const tasks: FieldTask[] = []

      const boat = resources.find(
        (r) => r.kind === "boat" && r.status === "assigned"
      )
      const team = nearestAvailable(
        resources,
        "rescue_team",
        wardById("w-15")!.centroid
      )
      const jcb = nearestAvailable(resources, "jcb", wardById("w-12")!.centroid)

      if (team) {
        const a = makeAssignment(
          team,
          "w-15",
          "Shallow-water rescue at the underpass approach",
          "inc-1",
          27
        )
        a.status = "approved"
        team.status = "en_route"
        team.assignmentId = a.id
        assignments.push(a)
        tasks.push(
          makeTask(
            a,
            team,
            "Rescue — Vitthalwadi underpass",
            "Two people reported stranded on a scooter. Approach from the north side; the south approach is under 0.6 m of water.",
            [73.8343, 18.4771],
            5
          )
        )
      }
      if (boat) {
        const a = assignments.find((x) => x.resourceId === boat.id)
        if (a) {
          a.status = "approved"
          boat.status = "en_route"
          tasks.push(
            makeTask(
              a,
              boat,
              "Stage rescue boat — Ekta Nagar",
              "Launch point at the community hall slipway. Hold until the rescue team confirms access.",
              [73.8336, 18.4766],
              5
            )
          )
        }
      }
      if (jcb) {
        const a = makeAssignment(
          jcb,
          "w-12",
          "Clear fallen tree from carriageway",
          "inc-3",
          27
        )
        a.status = "approved"
        jcb.status = "en_route"
        jcb.assignmentId = a.id
        assignments.push(a)
        tasks.push(
          makeTask(
            a,
            jcb,
            "Clear fallen tree — Kasba Peth",
            "Tree across both lanes. Clear and confirm the lane is passable before closing the task.",
            [73.8575, 18.5187],
            3
          )
        )
      }

      const incidents = w.incidents.map((i) =>
        i.id === "inc-1" || i.id === "inc-3"
          ? { ...i, status: "dispatched" as const, updatedAt: simTime(27) }
          : i
      )
      const plan = planFrom(assignments, ["w-42"], 27, "cp-sat")
      return withRun(
        {
          ...w,
          now: simTime(27),
          resources,
          plan,
          tasks,
          incidents,
          status: { ...w.status, simulatedTime: simTime(27) },
        },
        (r) => ({
          ...r,
          steps: [
            ...r.steps,
            step(
              "allocation_planner",
              27,
              412,
              "Re-solving with the flooded stretch removed from the routing graph, so no unit is sent through water it cannot cross.",
              "ortools.cp_sat",
              "graph edges -14 · 3 new demands",
              "optimal in 412 ms — 3 units dispatched, ETA 6–14 min"
            ),
          ],
        })
      )
    },
  },
  {
    id: "s10",
    atMin: 45,
    title: "Closed out, and the loop feeds back",
    narration:
      "18:45. Field teams close their tasks with proof. The incident resolves, and every decision, approval and override on this event is now an auditable record.",
    route: "/admin/after-action",
    apply: (w) => {
      const tasks = w.tasks.map((t) => ({
        ...t,
        status: "complete" as const,
        acceptedAt: simTime(29),
        completedAt: simTime(43),
        proofNote: t.title.startsWith("Rescue")
          ? "Both persons recovered and moved to Sinhagad Road Municipal Hall. Underpass remains closed."
          : t.title.startsWith("Clear")
            ? "Tree removed, both lanes passable. Debris stacked on the verge for collection."
            : "Boat stood down; rescue completed on foot. Unit returning to base.",
      }))
      const incidents = w.incidents.map((i) => ({
        ...i,
        status: "resolved" as const,
        updatedAt: simTime(45),
      }))
      const resources = w.resources.map((r) =>
        r.status === "en_route" || r.status === "on_site"
          ? { ...r, status: "available" as const, assignmentId: null }
          : r
      )
      const shelters = w.shelters.map((s) =>
        s.name === "Sinhagad Road Municipal Hall" ? { ...s, occupancy: 214 } : s
      )
      return withRun(
        {
          ...w,
          now: simTime(45),
          tasks,
          incidents,
          resources,
          shelters,
          status: { ...w.status, simulatedTime: simTime(45) },
        },
        (r) => ({
          ...r,
          finishedAt: simTime(45),
          summary:
            "Flood run for Pune, 25 July 2024. 14 wards scored, 4 at severity 4 or above. 7 actions proposed: 5 auto-issued under Ward Officer delegation, 2 escalated. 3 advisories issued reaching 96,400 residents. 7 citizen reports clustered into 3 incidents. 3 units dispatched, all tasks closed with proof.",
          steps: [
            ...r.steps,
            step(
              "guidance_agent",
              45,
              180,
              "All dispatched tasks closed with proof. Writing the after-action record and returning units to available.",
              "audit.finalise",
              "run=agentrun-1",
              "12 decisions · 3 incidents · 3 tasks · 1 uncovered demand logged"
            ),
          ],
        })
      )
    },
  },
]

export const SHELTER_COUNT = SHELTERS.length
export const RESOURCE_COUNT = BASE_RESOURCES.length
