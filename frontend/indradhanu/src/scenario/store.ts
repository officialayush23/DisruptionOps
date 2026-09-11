import { create } from "zustand"
import type { Decision, FieldTask } from "@/api/types"
import { initialWorld, type World } from "@/api/mock/world"
import { STEPS } from "./steps"

/** Officer actions and field updates live outside the scripted timeline, so a
 *  judge can approve, override or close something and then scrub the scenario
 *  without losing what they did. The world is recomputed by replaying the
 *  steps, then these overlays are applied on top. */
interface DecisionOverride {
  status: Decision["status"]
  decidedBy: string
  decidedAt: string
  overrideNote: string | null
}

interface TaskOverride {
  status: FieldTask["status"]
  proofNote: string | null
  at: string
}

interface ScenarioState {
  /** -1 = idle, nothing has happened yet. */
  index: number
  playing: boolean
  /** Real milliseconds per scenario step. */
  speedMs: number
  world: World
  decisionOverrides: Record<string, DecisionOverride>
  taskOverrides: Record<string, TaskOverride>
  extraReportIds: string[]
  /** Set by the tour when it wants the app to navigate. */
  pendingRoute: string | null
  focusWardId: string | null

  start: () => void
  play: () => void
  pause: () => void
  next: () => void
  prev: () => void
  goto: (i: number) => void
  reset: () => void
  setSpeed: (ms: number) => void
  consumeRoute: () => void

  decide: (
    id: string,
    status: Decision["status"],
    by: string,
    note?: string
  ) => void
  updateTask: (
    id: string,
    status: FieldTask["status"],
    proofNote?: string
  ) => void
}

function computeWorld(
  index: number,
  decisionOverrides: Record<string, DecisionOverride>,
  taskOverrides: Record<string, TaskOverride>
): World {
  let w = initialWorld()
  for (let i = 0; i <= index && i < STEPS.length; i++) {
    w = STEPS[i].apply(w)
  }
  if (Object.keys(decisionOverrides).length) {
    w = {
      ...w,
      decisions: w.decisions.map((d) => {
        const o = decisionOverrides[d.id]
        return o
          ? {
              ...d,
              status: o.status,
              decidedBy: o.decidedBy,
              decidedAt: o.decidedAt,
              overrideNote: o.overrideNote,
            }
          : d
      }),
    }
  }
  if (Object.keys(taskOverrides).length) {
    w = {
      ...w,
      tasks: w.tasks.map((t) => {
        const o = taskOverrides[t.id]
        if (!o) return t
        return {
          ...t,
          status: o.status,
          proofNote: o.proofNote ?? t.proofNote,
          acceptedAt:
            o.status !== "queued" ? (t.acceptedAt ?? o.at) : t.acceptedAt,
          completedAt: o.status === "complete" ? o.at : t.completedAt,
        }
      }),
    }
  }
  return w
}

let timer: ReturnType<typeof setTimeout> | null = null

export const useScenario = create<ScenarioState>((set, get) => {
  const schedule = () => {
    if (timer) clearTimeout(timer)
    const { playing, index, speedMs } = get()
    if (!playing) return
    if (index >= STEPS.length - 1) {
      set({ playing: false })
      return
    }
    // An interactive step holds the tour until the judge acts.
    if (index >= 0 && STEPS[index].interactive) {
      const pending = get().world.decisions.some(
        (d) => d.status === "awaiting_approval"
      )
      if (pending) {
        timer = setTimeout(schedule, 400)
        return
      }
    }
    timer = setTimeout(() => {
      get().next()
      schedule()
    }, speedMs)
  }

  const apply = (index: number) => {
    const { decisionOverrides, taskOverrides } = get()
    const world = computeWorld(index, decisionOverrides, taskOverrides)
    const step = index >= 0 ? STEPS[index] : null
    set({
      index,
      world,
      pendingRoute: step?.route ?? null,
      focusWardId: step?.focusWardId ?? null,
    })
  }

  return {
    index: -1,
    playing: false,
    speedMs: 5200,
    world: initialWorld(),
    decisionOverrides: {},
    taskOverrides: {},
    extraReportIds: [],
    pendingRoute: null,
    focusWardId: null,

    start: () => {
      apply(0)
      set({ playing: true })
      schedule()
    },
    play: () => {
      set({ playing: true })
      if (get().index < 0) apply(0)
      schedule()
    },
    pause: () => {
      if (timer) clearTimeout(timer)
      set({ playing: false })
    },
    next: () => {
      const i = Math.min(get().index + 1, STEPS.length - 1)
      apply(i)
    },
    prev: () => {
      const i = Math.max(get().index - 1, 0)
      apply(i)
    },
    goto: (i) => apply(Math.max(-1, Math.min(i, STEPS.length - 1))),
    reset: () => {
      if (timer) clearTimeout(timer)
      set({
        index: -1,
        playing: false,
        world: initialWorld(),
        decisionOverrides: {},
        taskOverrides: {},
        pendingRoute: null,
        focusWardId: null,
      })
    },
    setSpeed: (ms) => {
      set({ speedMs: ms })
      if (get().playing) schedule()
    },
    consumeRoute: () => set({ pendingRoute: null }),

    decide: (id, status, by, note) => {
      const overrides = {
        ...get().decisionOverrides,
        [id]: {
          status,
          decidedBy: by,
          decidedAt: new Date().toISOString(),
          overrideNote: note ?? null,
        },
      }
      set({ decisionOverrides: overrides })
      set({ world: computeWorld(get().index, overrides, get().taskOverrides) })
    },

    updateTask: (id, status, proofNote) => {
      const overrides = {
        ...get().taskOverrides,
        [id]: {
          status,
          proofNote: proofNote ?? null,
          at: new Date().toISOString(),
        },
      }
      set({ taskOverrides: overrides })
      set({
        world: computeWorld(get().index, get().decisionOverrides, overrides),
      })
    },
  }
})

export { STEPS }
