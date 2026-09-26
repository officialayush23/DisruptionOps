import { useEffect, useRef, useState } from "react"
import { request } from "@/api/httpClient"

/** `GET /mesh/status`: what the mesh gateways have carried in, and who is linked. */
export type MeshNode = {
  id: string
  kind: "gateway" | "camera" | "phone" | "sensor" | string
  label: string | null
  lat: number | null
  lon: number | null
  wardId: string | null
  lastSeen: string
  ageS: number
  meta: {
    peers?: number
    queued?: number
    battery?: number
    appVersion?: string
    app_version?: string
    listen?: boolean
    linked_at?: string
  }
}
export type MeshPacket = {
  id: number
  packetId: string
  type: "R" | "S" | "F" | "H" | "K" | string
  nodeId: string | null
  gatewayId: string | null
  verified: boolean
  outcome: string | null
  outcomeRef: string | null
  receivedAt: string
  body: Record<string, unknown>
}
export type MeshStatus = {
  nodes: MeshNode[]
  recent: MeshPacket[]
  outbox: { pending?: number; sent?: number; acked?: number; expired?: number }
  signing: boolean
  enabled: boolean
}

/** The API answers snake_case here (a plain dict), so read either spelling. */
function norm(raw: unknown): MeshStatus {
  const r = (raw ?? {}) as Record<string, unknown>
  const pick = (o: Record<string, unknown>, a: string, b: string) => o[a] ?? o[b]
  const nodes = ((r.nodes as Record<string, unknown>[]) ?? []).map((n) => ({
    id: String(n.id),
    kind: String(n.kind ?? "phone"),
    label: (n.label as string) ?? null,
    lat: (n.lat as number) ?? null,
    lon: (n.lon as number) ?? null,
    wardId: (pick(n, "ward_id", "wardId") as string) ?? null,
    lastSeen: String(pick(n, "last_seen", "lastSeen") ?? ""),
    ageS: Number(pick(n, "age_s", "ageS") ?? 1e9),
    meta: (n.meta as MeshNode["meta"]) ?? {},
  }))
  const recent = ((r.recent as Record<string, unknown>[]) ?? []).map((m) => ({
    id: Number(m.id ?? 0),
    packetId: String(pick(m, "packet_id", "packetId") ?? ""),
    type: String(m.type ?? "?"),
    nodeId: (pick(m, "node_id", "nodeId") as string) ?? null,
    gatewayId: (pick(m, "gateway_id", "gatewayId") as string) ?? null,
    verified: Boolean(m.verified),
    outcome: (m.outcome as string) ?? null,
    outcomeRef: (pick(m, "outcome_ref", "outcomeRef") as string) ?? null,
    receivedAt: String(pick(m, "received_at", "receivedAt") ?? ""),
    body: (m.body as Record<string, unknown>) ?? {},
  }))
  return {
    nodes,
    recent,
    outbox: (r.outbox as MeshStatus["outbox"]) ?? {},
    signing: Boolean(r.signing),
    enabled: Boolean(r.enabled),
  }
}

/** Polls the mesh status. Overlapping polls are skipped, never stacked. */
export function useMeshStatus(everyMs = 2000) {
  const [data, setData] = useState<MeshStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const busy = useRef(false)
  useEffect(() => {
    let alive = true
    const poll = async () => {
      if (busy.current) return
      busy.current = true
      try {
        const raw = await request<unknown>("/mesh/status")
        if (alive) {
          setData(norm(raw))
          setError(null)
        }
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e))
      } finally {
        busy.current = false
      }
    }
    void poll()
    const id = setInterval(() => void poll(), everyMs)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [everyMs])
  return { data, error }
}

export const PACKET_LABEL: Record<string, string> = {
  R: "Citizen report",
  S: "Camera / VLM",
  F: "Crew update",
  H: "Heartbeat",
  K: "Delivery ack",
}

export const hhmmss = (iso: string | null | undefined) =>
  iso
    ? new Date(iso).toLocaleTimeString(undefined, {
        hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
      })
    : "—"

export function ago(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds > 1e8) return "never"
  if (seconds < 60) return `${Math.max(0, Math.round(seconds))} s ago`
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`
  return `${Math.round(seconds / 3600)} h ago`
}
