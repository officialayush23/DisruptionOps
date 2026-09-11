import { accessToken } from "@/lib/supabase"

/** The real HTTP client.
 *
 *  `client.ts` has had a `VITE_API_MODE=http` branch since the beginning that
 *  fell back to the mock with a console warning, because this file did not
 *  exist. It exists now.
 *
 *  Every request carries the Supabase access token as a bearer, read fresh from
 *  the session each time rather than captured once: an access token lasts about
 *  an hour and a flood shift does not, so `supabase-js` refreshes it underneath
 *  us and we always send the current one.
 */

export const apiBaseUrl =
  (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "") ??
  "http://localhost:8000/api/v1"

export class ApiError extends Error {
  // Written out rather than as constructor parameter properties: this project
  // builds with `erasableSyntaxOnly`, which forbids the shorthand because it is
  // TypeScript that emits runtime code rather than type syntax that erases.
  readonly status: number
  readonly detail?: unknown

  constructor(status: number, message: string, detail?: unknown) {
    super(message)
    this.status = status
    this.detail = detail
    this.name = "ApiError"
  }

  /** The caller is not signed in, or the session expired. */
  get isUnauthorised() {
    return this.status === 401
  }

  /** Signed in, but this role may not do it. Shown as the clause that blocked
   *  them rather than a generic refusal, because the API says which one. */
  get isForbidden() {
    return this.status === 403
  }
}

type RequestOptions = {
  method?: "GET" | "POST" | "PATCH" | "DELETE"
  body?: unknown
  query?: Record<string, string | number | boolean | undefined | null>
  signal?: AbortSignal
}

function buildUrl(path: string, query?: RequestOptions["query"]): string {
  const url = new URL(
    `${apiBaseUrl}${path.startsWith("/") ? path : `/${path}`}`,
    window.location.origin
  )
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v))
    }
  }
  return url.toString()
}

export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const token = await accessToken()
  const headers: Record<string, string> = { Accept: "application/json" }
  if (token) headers.Authorization = `Bearer ${token}`
  if (opts.body !== undefined) headers["Content-Type"] = "application/json"

  const res = await fetch(buildUrl(path, opts.query), {
    method: opts.method ?? "GET",
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    signal: opts.signal,
  })

  if (res.status === 204) return undefined as T

  const text = await res.text()
  const payload = text ? safeJson(text) : null

  if (!res.ok) {
    // The API's error handler returns {detail: ...} or {message, clause, ...}.
    // Prefer whatever human sentence it gave us over "Request failed".
    const message =
      pick(payload, "message") ??
      pick(payload, "detail") ??
      `${res.status} ${res.statusText}`
    throw new ApiError(res.status, message, payload)
  }
  return payload as T
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function pick(payload: unknown, key: string): string | undefined {
  if (payload && typeof payload === "object" && key in payload) {
    const v = (payload as Record<string, unknown>)[key]
    if (typeof v === "string") return v
  }
  return undefined
}

/* ------------------------------------------------------------------ auth -- */

export type Me = {
  authenticated: boolean
  userId: string | null
  role: "citizen" | "field_operator" | "ward_officer" | "commissioner" | "admin"
  fullName: string
  wardId: string | null
  operator: string | null
  isStaff: boolean
  canEscalate: boolean
  interfaces: string[]
  developmentIdentity: boolean
}

export const fetchMe = () => request<Me>("/auth/me")

/* -------------------------------------------------------------- taxonomy -- */

export type Taxonomy = {
  city: {
    id: string
    name: string
    languages: string[]
    adminUnitSingular: string
    adminUnitPlural: string
  }
  hazards: { id: string; displayName: string; maturity: string | null; sortOrder: number }[]
  capabilities: { id: string; label: string; description: string }[]
  resourceKinds: { id: string; displayName: string; capabilities: string[] }[]
  lifelineKinds: { id: string; displayName: string; sheltersPeople: boolean }[]
  incidentCategories: {
    id: string
    displayName: string
    hazardId: string | null
    dedupRadiusM: number
    dedupWindowMin: number
    baseSeverity: number
    lifeSafety: boolean
  }[]
  agencies: { id: string; name: string; shortName: string; capabilities: string[] }[]
}

/** Fetched once at boot. Nothing in the UI should hard-code a hazard list, a
 *  category list or a resource kind: a second city would invalidate all three. */
export const fetchTaxonomy = (cityId = "pune") =>
  request<Taxonomy>("/taxonomy", { query: { cityId } })

/* ------------------------------------------------------------------ runs -- */

export type RunResult = {
  runId: string
  agentRunId: string
  hazard: string
  engine: string
  mode: string
  wardsScored: number
  decisions: number
  autoIssued: number
  awaitingApproval: number
  assignments: number
  uncovered: number
  alerts: number
  fieldTasks: number
  events: number
  durationMs: number
}

export const startRun = (hazard = "flood", cityId = "pune", simRunId?: string) =>
  request<RunResult>("/runs", {
    method: "POST",
    body: { hazard, cityId, simRunId: simRunId ?? null },
  })

/* ----------------------------------------------------------------- events -- */

export type EventRow = {
  id: number
  cityId: string
  simRunId: string | null
  occurredAt: string
  recordedAt: string
  kind: string
  actor: string
  subjectType: string
  subjectId: string
  wardId: string | null
  payload: Record<string, unknown>
  causationId: number | null
}

export const fetchEvents = (params: {
  simRunId?: string
  subjectType?: string
  subjectId?: string
  limit?: number
} = {}) => request<EventRow[]>("/events", { query: params })

/** Why did this happen? Oldest cause first. */
export const fetchEventChain = (eventId: number) =>
  request<EventRow[]>(`/events/${eventId}/chain`)

/* ------------------------------------------------------- operational reads -- */

export const fetchWards = () => request<unknown[]>("/wards")
export const fetchIncidents = () => request<unknown[]>("/incidents")
export const fetchResources = () => request<unknown[]>("/resources")
export const fetchDecisions = () => request<unknown[]>("/decisions")
export const fetchLatestPlan = () => request<unknown>("/allocation/latest")
export const fetchAlerts = (wardId?: string) =>
  request<unknown[]>("/alerts", { query: { wardId } })
export const fetchTasks = (operator?: string) =>
  request<unknown[]>("/tasks", { query: { operator } })

export const actOnDecision = (
  decisionId: string,
  action: "approve" | "reject" | "override",
  note?: string
) => request<unknown>(`/decisions/${decisionId}`, { method: "POST", body: { action, note } })

export const updateTask = (
  taskId: string,
  status: "queued" | "accepted" | "on_site" | "complete",
  proofNote?: string
) => request<unknown>(`/tasks/${taskId}`, { method: "PATCH", body: { status, proofNote } })

export const submitReport = (report: {
  wardId: string
  category: string
  location: [number, number]
  note?: string
  photoUrl?: string | null
}) => request<unknown>("/reports", { method: "POST", body: report })

export const fetchSituation = (wardId: string) =>
  request<unknown>(`/situation/${wardId}`)
