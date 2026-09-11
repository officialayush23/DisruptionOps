import { create } from "zustand"

export interface TourStep {
  /** CSS selector for the element to point at. */
  target: string
  title: string
  body: string
  /** Preferred side; falls back automatically when there is no room. */
  side?: "top" | "bottom"
}

/** The coach marks a judge sees before anything happens, so they know what
 *  they are looking at and how to drive it. Separate from the scripted
 *  scenario, which shows the system working. */
export const TOUR_STEPS: TourStep[] = [
  {
    target: '[data-tour="personas"]',
    title: "Three interfaces, one event",
    body: "Indradhanu has three faces: the administration console you are in now, the citizen portal, and the field operator portal. Switch here at any time to see the same moment from another side.",
    side: "bottom",
  },
  {
    target: '[data-tour="scenario"]',
    title: "Start here — the guided demo",
    body: "This replays the real Pune flood of 25 July 2024 through the live pipeline. It drives the app itself: screens change, alerts fire, and it will stop and wait when a human decision is required. Pause, step back, or scrub with the ticks below.",
    side: "bottom",
  },
  {
    target: '[data-tour="nav"]',
    title: "The operational spine",
    body: "Top to bottom, this is the path an event takes: risk is scored, citizen reports become incidents, the solver allocates units, actions pass the authority gate, and everything lands in the after-action record.",
    side: "bottom",
  },
  {
    target: '[data-tour="feeds"]',
    title: "Where the data comes from",
    body: "Live hazard feeds — Open-Meteo, GloFAS river discharge, IMD, CWC reservoir levels — with their current state. If an upstream API fails, the badge flips to cached and the system keeps running.",
    side: "top",
  },
  {
    target: '[data-tour="map"]',
    title: "Ward-level risk, not district-level",
    body: "Each polygon is a real PMC ward, shaded by severity. Click one to see the reasoning behind its score. This is the granularity a resident actually lives at.",
    side: "top",
  },
  {
    target: '[data-tour="wardtable"]',
    title: "Ranked, with the evidence attached",
    body: "Wards ordered worst first, with population at risk, lead time and a twelve-hour projection. Selecting a row opens the driver breakdown — the answer to “why am I being warned?”.",
    side: "top",
  },
]

interface TourState {
  open: boolean
  index: number
  start: () => void
  next: () => void
  prev: () => void
  close: () => void
}

const SEEN_KEY = "indradhanu.tour.seen"

export const useTour = create<TourState>((set, get) => ({
  open: false,
  index: 0,
  start: () => set({ open: true, index: 0 }),
  next: () => {
    const i = get().index + 1
    if (i >= TOUR_STEPS.length) {
      try {
        localStorage.setItem(SEEN_KEY, "1")
      } catch {
        /* private mode */
      }
      set({ open: false, index: 0 })
      return
    }
    set({ index: i })
  },
  prev: () => set({ index: Math.max(0, get().index - 1) }),
  close: () => {
    try {
      localStorage.setItem(SEEN_KEY, "1")
    } catch {
      /* private mode */
    }
    set({ open: false, index: 0 })
  },
}))

export function hasSeenTour(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === "1"
  } catch {
    return false
  }
}
