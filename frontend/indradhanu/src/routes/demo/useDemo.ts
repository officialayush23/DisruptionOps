import { useCallback, useEffect, useRef, useState } from "react"
import { request } from "@/api/httpClient"

export type Ward = {
  id: string; name: string; number: string; centroid: [number, number]
  boundary: [number, number][] | null; population: number
  score: number | null; severity: number | null; populationAtRisk: number | null
}
export type Resource = {
  id: string; kind: string; label: string; operator: string; agencyId: string | null
  capacity: number; status: string; location: [number, number]
  capabilities: string[]; assignedTo: string | null
  incidentId: string | null; etaMinutes: number | null
}
export type Incident = {
  id: string; title: string; category: string; wardId: string; severity: number
  status: string; reportCount: number; confidence: number
  location: [number, number]; createdAt: string; unitsEnRoute: number
}
export type Decision = {
  id: string; action: string; target: string; wardId: string | null
  rationale: string; confidence: number; status: string
  clause: string | null; delegatedTo: string | null
  withinDelegation: boolean | null; createdAt: string
}
export type Beat = {
  tick: number; at: string; kind: string; text: string
  detail: Record<string, unknown>
}
export type DemoState = {
  running: boolean; tick: number; simNow: string | null; error: string | null
  citizen: { lng: number; lat: number; wardId: string | null; wardName: string; inside: boolean; note?: string }
  wards: Ward[]; resources: Resource[]; incidents: Incident[]
  needs: { incidentId: string; capability: string; required: number; met: number }[]
  decisions: Decision[]
  events: { id: number; kind: string; actor: string; wardId: string | null; payload: Record<string, unknown>; occurredAt: string }[]
  duplicates: { kind: string; incidentIds: string[]; wardId: string | null; agencies: string[]; detail: string; wastedUnits: number }[]
  plan: null | {
    headline: string; engine: string; coverage: number
    assigned: RawChange[]; reassigned: RawChange[]; released: RawChange[]; kept: RawChange[]
    uncovered: { ward_id?: string; capability?: string; reason: string }[]
  }
  beats: Beat[]
}
export type RawChange = {
  kind: string; resource_id: string; resource_label: string
  incident_id: string | null; incident_title: string; ward_id: string
  from_incident_id: string | null; from_incident_title: string
  eta_minutes: number; reason: string
}

const EMPTY: DemoState = {
  running: false, tick: 0, simNow: null, error: null,
  citizen: { lng: 73.8989, lat: 18.6773, wardId: null, wardName: "", inside: true },
  wards: [], resources: [], incidents: [], needs: [], decisions: [],
  events: [], duplicates: [], plan: null, beats: [],
}

/** Polls the one snapshot endpoint.
 *
 *  One request per second, not eight. A map assembled from several concurrent
 *  requests tears, and a tearing map during a live demo reads as a broken
 *  system even when every number in it is correct.
 *
 *  Overlapping responses are dropped rather than queued: if the network hiccups
 *  we want the newest world, not a backlog of stale ones replayed in order.
 */
export function useDemo(pollMs = 1000) {
  const [state, setState] = useState<DemoState>(EMPTY)
  const [error, setError] = useState<string | null>(null)
  const inFlight = useRef(false)
  const seq = useRef(0)

  const refresh = useCallback(async () => {
    if (inFlight.current) return
    inFlight.current = true
    const mine = ++seq.current
    try {
      const next = await request<DemoState>("/demo/state")
      if (mine === seq.current) {
        setState(next)
        setError(null)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      inFlight.current = false
    }
  }, [])

  useEffect(() => {
    void refresh()
    const id = setInterval(() => void refresh(), pollMs)
    return () => clearInterval(id)
  }, [refresh, pollMs])

  const act = useCallback(
    async (path: string, body?: unknown) => {
      try {
        const r = await request<unknown>(path, { method: "POST", body: body ?? {} })
        await refresh()
        return r
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
        throw e
      }
    },
    [refresh]
  )

  return { state, error, refresh, act }
}
