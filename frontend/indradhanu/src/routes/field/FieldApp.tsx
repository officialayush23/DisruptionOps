import { useCallback, useEffect, useRef, useState } from "react"
import { AlertTriangle, CheckCircle2, Loader2, MapPin, Radio, Send, Truck } from "lucide-react"
import { request } from "@/api/httpClient"
import { LiveMap } from "@/components/map/LiveMap"
import { MapStage } from "@/components/map/MapStage"
import { OfflineBar } from "@/components/common/OfflineBar"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { DemoCredentials } from "@/auth/DemoCredentials"
import { useLiveSync, pollInterval } from "@/hooks/useLiveSync"

/** The crew's interface.
 *
 *  Its own URL, scoped to one agency. A driver does not need the city's fleet,
 *  and the row level security policy on `field_tasks` refuses it independently
 *  of anything this page does.
 *
 *  The point of this screen is the status buttons. A puncture reported here
 *  takes the vehicle out of the fleet and releases its task back into unmet
 *  need; a hospital declaring itself full stops being somewhere the citizen
 *  agent will send anyone. Each one changes the next plan, which is the
 *  difference between a status board and a system.
 */

type Unit = {
  id: string; kind: string; label: string; operator: string; status: string
  statusNote: string | null; unavailableReason: string | null
  location: [number, number]; capacity: number
  assignedTo: string | null; incidentId: string | null
  etaMinutes: number | null; incidentLocation: [number, number] | null
  /** The road the crew is meant to drive, not a bearing to the incident. */
  route?: number[][] | null
  routeEngine?: string | null
  steps?: { instruction: string; street: string; distanceM: number }[]
  distanceKm?: number | null
  progress?: number
}
type Facility = {
  id: string; name: string; kind: string; status: string
  capacity: number | null; occupancy: number | null; location: [number, number]
}
type StatusKind = {
  id: string; label: string; makesOffline: boolean
  severity: string; appliesTo: string
}
type FieldState = {
  operator: string | null
  units: Unit[]
  tasks: { id: string; title: string; instruction: string; status: string
           priority: number; wardId: string }[]
  facilities: Facility[]
  recent: { subjectId: string; statusKind: string; note: string
            reportedBy: string; at: string }[]
  /** Every open incident in the city, so a crew sees what they just reported
   *  land on their own map instead of taking it on faith. */
  incidents?: {
    id: string; title: string; category: string; severity: number
    status: string; wardId: string; reportCount: number
    verification: "confirmed" | "unconfirmed" | "held"
    location: [number, number]
  }[]
}

type Category = { id: string; displayName: string }

/** What a filed hazard came back as. */
type Filed = {
  incidentId: string | null; createdIncident: boolean; linked: boolean
  wardName: string; readAsLabel: string; readHow: string
  trust: number; trustStatus: string; summary: string
}

const TONE: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  info: "secondary", warn: "default", blocking: "destructive",
}

export default function FieldApp() {
  const [state, setState] = useState<FieldState | null>(null)
  const [kinds, setKinds] = useState<StatusKind[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [note, setNote] = useState("")
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [effects, setEffects] = useState<string[]>([])
  // Reporting what is in front of the crew, as opposed to what is wrong with
  // their vehicle. See the `/field/report` route: same intake door as a
  // resident's report, but credited at 0.95 rather than 0.62 because a trained
  // crew standing at the thing is the best evidence this system gets.
  const [cats, setCats] = useState<Category[]>([])
  const [hazardText, setHazardText] = useState("")
  const [hazardCat, setHazardCat] = useState("")
  const [myPos, setMyPos] = useState<[number, number] | null>(null)
  const [filed, setFiled] = useState<Filed | null>(null)

  /** `selected` as a ref, read inside `load` without `load` depending on it.
   *
   *  It used to be a dependency, which made this poll re-enter itself: the
   *  first load auto-selects a unit, selecting changes `selected`, `load` gets
   *  a new identity, and both effects below tear down and re-run — an extra
   *  pair of requests and a restarted interval every time the operator so much
   *  as picks a different vehicle, on a three-second poll hitting two endpoints
   *  at once. */
  const selectedRef = useRef<string | null>(null)
  useEffect(() => { selectedRef.current = selected }, [selected])

  /** True while a poll is outstanding. `/field/state` on a cold instance can
   *  take longer than the three-second interval, and without this the requests
   *  stack up faster than they drain. */
  const inFlight = useRef(false)

  const load = useCallback(async () => {
    if (inFlight.current) return
    inFlight.current = true
    try {
      const [s, k] = await Promise.all([
        request<FieldState>("/field/state"),
        request<StatusKind[]>("/field/status-kinds"),
      ])
      setState(s); setKinds(k); setError(null)
      if (!selectedRef.current && s.units.length) setSelected(s.units[0].id)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      inFlight.current = false
    }
  }, [])

  // A crew's screen changes because somebody in the control room tasked them.
  // Waiting up to three seconds to find that out is three seconds of a driver
  // sitting still, so the task arrives on the socket and the poll becomes the
  // safety net rather than the mechanism.
  const { live } = useLiveSync(["field_tasks", "incidents"], () => void load())

  // One effect, not two: separately, every change of `load` fired an immediate
  // request *and* rebuilt the interval that was about to fire anyway.
  useEffect(() => {
    void load()
    const id = setInterval(() => void load(), pollInterval(live, 3000))
    return () => clearInterval(id)
  }, [load, live])

  // The hazard list comes from the taxonomy, never a hard-coded array: a second
  // city that adds "landslide" must get it on the crew screen without a deploy.
  useEffect(() => {
    void request<{ incidentCategories: Category[] }>("/taxonomy", {
      query: { cityId: "pune" },
    })
      .then((t) => setCats(t.incidentCategories ?? []))
      .catch(() => setCats([]))
  }, [])

  // Where the crew actually is. Their own GPS first — that is the whole point
  // of "report what is in front of me" — and the position of the unit they have
  // selected as the fallback, because a tablet bolted into a truck cab often
  // has no geolocation permission and a crew should not be blocked by that.
  useEffect(() => {
    if (!navigator.geolocation) return
    const id = navigator.geolocation.watchPosition(
      (p) => setMyPos([p.coords.longitude, p.coords.latitude]),
      () => setMyPos(null),
      { enableHighAccuracy: true, maximumAge: 15000, timeout: 10000 }
    )
    return () => navigator.geolocation.clearWatch(id)
  }, [])

  const unit = state?.units.find((u) => u.id === selected) ?? null
  const reportAt = myPos ?? unit?.location ?? null

  /** File a hazard at the crew's own position, through the same intake door
   *  every other report goes through. */
  async function fileHazard() {
    if (!reportAt) {
      setError("No position yet. Allow location, or pick one of your units.")
      return
    }
    if (!hazardText.trim() && !hazardCat) {
      setError("Say what you can see, or pick a kind from the list.")
      return
    }
    setBusy("hazard")
    try {
      const r = await request<Filed>("/field/report", {
        method: "POST",
        body: {
          lng: reportAt[0], lat: reportAt[1],
          text: hazardText.trim(),
          category: hazardCat || undefined,
          cityId: "pune",
        },
      })
      setFiled(r)
      setHazardText(""); setHazardCat(""); setError(null)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }


  async function declare(subjectType: "resource" | "lifeline", subjectId: string, kind: string) {
    setBusy(kind)
    try {
      const r = await request<{
        effects?: string[]; label?: string; queued?: boolean; message?: string
      }>("/field/status", {
        method: "POST",
        body: {
          subjectType, subjectId, statusKind: kind, note,
          lng: unit?.location?.[0], lat: unit?.location?.[1],
        },
      })
      // Offline, the service worker answers 202 with `queued` and none of the
      // effects a real status change produces. Reporting "no effects" for
      // something that has not reached the control room yet would be a lie a
      // crew acts on, so it says what actually happened instead.
      if (r.queued) {
        setEffects([
          r.message ??
            "No signal. This is saved on the phone and goes the moment there is.",
          "The control room has not seen it yet, so do not assume anyone is coming.",
        ])
        setNote("")
        return
      }
      setEffects(r.effects ?? [])
      setNote("")
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally { setBusy(null) }
  }

  const resourceKinds = kinds.filter((k) => k.appliesTo === "resource")
  const lifelineKinds = kinds.filter((k) => k.appliesTo === "lifeline")

  return (
    <div className="mx-auto max-w-6xl space-y-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold">Field</h1>
          <p className="text-muted-foreground text-xs">
            {state?.operator ?? "All agencies"} · {state?.units.length ?? 0} unit(s)
          </p>
        </div>
        <a href="/login" className="text-muted-foreground text-xs underline">Sign in</a>
      </div>

      {/* The two crew accounts, on the crew screen. The point of the demo is
          that Fire Brigade and PMC Drainage see different units, and switching
          between them is how anyone sees that. */}
      <DemoCredentials portal="field" title="Demo crew sign-ins" />

      {error && (
        <Alert variant="destructive">
          <AlertTriangle className="size-4" />
          <AlertDescription className="text-xs">{error}</AlertDescription>
        </Alert>
      )}
      {effects.length > 0 && (
        <Alert>
          <CheckCircle2 className="size-4" />
          <AlertDescription className="text-xs">
            {effects.map((e, i) => <div key={i}>{e}</div>)}
          </AlertDescription>
        </Alert>
      )}

      <OfflineBar manifest="/field.webmanifest" />

      <div className="grid gap-3 lg:grid-cols-[1fr_380px]">
        <div className="space-y-3">
          <MapStage
            panelTitle="My units"
            panel={
              <div className="space-y-2 text-xs">
                {(state?.units ?? []).map((u) => (
                  <div key={u.id} className="rounded border border-slate-500/25 p-2">
                    <div className="font-medium text-slate-100">{u.label}</div>
                    <div className="text-slate-400">
                      {u.status.replace(/_/g, " ")}
                      {u.assignedTo ? ` → ${u.assignedTo}` : ""}
                      {u.etaMinutes ? `, ${u.etaMinutes} min` : ""}
                    </div>
                  </div>
                ))}
              </div>
            }
            map={(expanded) => (
                  <LiveMap
                    className={expanded ? "h-full w-full" : "h-[420px] w-full rounded-lg border"}
                resources={state?.units.map((u) => ({ ...u, capabilities: [] })) ?? []}
                facilities={state?.facilities ?? []}
                incidents={
                  // Real incidents when the API offers them, the crew's own
                  // tasks as the fallback so an older backend still draws
                  // something rather than an empty map.
                  state?.incidents?.length
                    ? state.incidents.map((i) => ({
                        id: i.id,
                        title:
                          i.verification === "unconfirmed"
                            ? `${i.title} · unconfirmed`
                            : i.title,
                        category: i.category,
                        severity: i.severity,
                        reportCount: i.reportCount,
                        location: i.location,
                      }))
                    : state?.units
                        .filter((u) => u.incidentLocation)
                        .map((u) => ({
                          id: u.incidentId ?? u.id, title: u.assignedTo ?? "Task",
                          category: "", severity: 4, reportCount: 1,
                          location: u.incidentLocation as [number, number],
                        })) ?? []
                }
                routes={
                  state?.units
                    .filter((u) => (u.route?.length ?? 0) > 1)
                    .map((u) => ({
                      id: u.id, resourceId: u.id, resourceLabel: u.label,
                      incidentId: u.incidentId ?? u.id,
                      incidentTitle: u.assignedTo ?? "Task", status: u.status,
                      etaMinutes: u.etaMinutes ?? null,
                      distanceKm: u.distanceKm ?? null,
                      engine: u.routeEngine, progress: u.progress,
                      steps: u.steps, path: u.route as [number, number][],
                    })) ?? []
                }
                route={
                  (unit?.route?.length ?? 0) > 1
                    ? (unit!.route as number[][])
                    : unit?.incidentLocation
                      ? [unit.location, unit.incidentLocation]
                      : undefined
                }
                routeLabel={unit ? `${unit.label} to ${unit.assignedTo ?? "its task"}` : undefined}
                center={unit?.location ?? [73.88, 18.58]}
                zoom={12}
              />
            )}
          />

          {unit && (unit.steps?.length ?? 0) > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">
                  {unit.label} to {unit.assignedTo}
                </CardTitle>
                <CardDescription className="text-xs">
                  {unit.distanceKm ? `${unit.distanceKm.toFixed(1)} km` : ""}
                  {unit.etaMinutes ? ` · about ${unit.etaMinutes} min` : ""}
                  {typeof unit.progress === "number"
                    ? ` · ${Math.round(unit.progress * 100)}% of the way`
                    : ""}
                  {unit.routeEngine && unit.routeEngine !== "straight-line-fallback"
                    ? " · routed around every hazard the control room knows about"
                    : " · straight-line estimate, the router was unreachable"}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <ol className="space-y-1">
                  {unit.steps!.slice(0, 10).map((st, i) => (
                    <li key={i} className="flex gap-2 text-xs">
                      <span className="text-muted-foreground w-14 shrink-0 tabular-nums">
                        {st.distanceM >= 1000
                          ? `${(st.distanceM / 1000).toFixed(1)} km`
                          : `${st.distanceM} m`}
                      </span>
                      <span>{st.instruction}</span>
                    </li>
                  ))}
                </ol>
              </CardContent>
            </Card>
          )}

          {/* Report what is in front of you.
              A crew could always say "my truck has a puncture" and never
              "there is a collapsed wall here", which is a strange gap in a
              system whose argument is that the picture is assembled from
              whoever can see it. The most credible reporters in the city could
              see things and had nowhere to put them. */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-sm">
                <MapPin className="size-4" /> Report a hazard here
              </CardTitle>
              <CardDescription className="text-xs">
                {myPos
                  ? "Filed at your GPS position."
                  : unit
                    ? `No GPS — this will be filed at ${unit.label}'s position.`
                    : "No position yet. Allow location, or pick one of your units."}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              <Textarea
                value={hazardText}
                onChange={(e) => setHazardText(e.target.value)}
                placeholder="Wall collapsed across the lane, nobody trapped"
                className="min-h-16 text-xs"
              />
              <div className="flex flex-wrap gap-1">
                {cats.slice(0, 10).map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => setHazardCat(hazardCat === c.id ? "" : c.id)}
                    className={
                      "rounded border px-2 py-1 text-[11px] " +
                      (hazardCat === c.id
                        ? "border-primary bg-primary/10 font-medium"
                        : "border-muted-foreground/25")
                    }
                  >
                    {c.displayName}
                  </button>
                ))}
              </div>
              <Button
                size="sm"
                className="w-full"
                disabled={busy !== null || !reportAt}
                onClick={() => void fileHazard()}
              >
                {busy === "hazard"
                  ? <Loader2 className="mr-1 size-3 animate-spin" />
                  : <Send className="mr-1 size-3" />}
                File it
              </Button>

              {filed && (
                <div className="space-y-1 rounded border border-emerald-500/30 bg-emerald-500/5 p-2 text-xs">
                  <div className="font-medium">
                    {filed.readAsLabel} in {filed.wardName}
                    {filed.createdIncident
                      ? " — new incident on the map"
                      : filed.linked
                        ? " — merged into an incident already open there"
                        : " — held, no incident"}
                  </div>
                  {/* The trust score, shown rather than applied quietly. A crew
                      whose report was held deserves the sentence explaining
                      why, and a crew whose report dispatched a unit should see
                      that their word did that. */}
                  <div className="text-muted-foreground">
                    Trust {filed.trust.toFixed(2)} · {filed.trustStatus.replace(/_/g, " ")}
                  </div>
                  <div className="text-muted-foreground">{filed.readHow}</div>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">My units</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1">
              {state?.units.map((u) => (
                <button
                  key={u.id}
                  onClick={() => setSelected(u.id)}
                  className={`hover:bg-accent flex w-full items-center gap-2 rounded border p-2 text-left text-xs ${
                    selected === u.id ? "border-primary" : ""
                  }`}
                >
                  <Truck className="size-3.5 shrink-0" />
                  <span className="font-medium">{u.label}</span>
                  <Badge variant={u.status === "offline" ? "destructive" : "outline"}>
                    {u.status.replace(/_/g, " ")}
                  </Badge>
                  {u.assignedTo && (
                    <span className="text-muted-foreground truncate">→ {u.assignedTo}</span>
                  )}
                  {u.etaMinutes ? (
                    <span className="text-muted-foreground ml-auto">{u.etaMinutes} min</span>
                  ) : null}
                </button>
              ))}
              {state?.units.length === 0 && (
                <p className="text-muted-foreground text-xs">
                  No units for this operator. Sign in as a field operator, or pass
                  <code className="mx-1">?operator=</code>.
                </p>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="space-y-3">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-sm">
                <Radio className="size-4" /> Report status
              </CardTitle>
              <CardDescription className="text-xs">
                {unit ? `${unit.label} — ${unit.status.replace(/_/g, " ")}` : "Pick a unit"}
                {unit?.unavailableReason && ` (${unit.unavailableReason})`}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              <Input value={note} onChange={(e) => setNote(e.target.value)}
                     placeholder="Anything to add" className="text-sm" />
              <div className="flex flex-wrap gap-1.5">
                {resourceKinds.map((k) => (
                  <Button
                    key={k.id} size="sm" variant={k.makesOffline ? "destructive" : "outline"}
                    className="h-7 text-xs"
                    disabled={!unit || busy !== null}
                    onClick={() => unit && declare("resource", unit.id, k.id)}
                  >
                    {busy === k.id ? <Loader2 className="size-3 animate-spin" /> : null}
                    {k.label}
                  </Button>
                ))}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Facilities</CardTitle>
              <CardDescription className="text-xs">
                Declaring one full stops the citizen agent sending anyone there.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              {state?.facilities.slice(0, 6).map((f) => (
                <div key={f.id} className="rounded border p-2 text-xs">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{f.name}</span>
                    <Badge variant={f.status === "full" ? "destructive" : "outline"}>
                      {f.status}
                    </Badge>
                    {f.capacity ? (
                      <span className="text-muted-foreground ml-auto">
                        {Math.max(0, f.capacity - (f.occupancy ?? 0))}/{f.capacity} free
                      </span>
                    ) : null}
                  </div>
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {lifelineKinds.map((k) => (
                      <Button key={k.id} size="sm" variant={TONE[k.severity] ?? "outline"}
                              className="h-6 px-2 text-[11px]" disabled={busy !== null}
                              onClick={() => declare("lifeline", f.id, k.id)}>
                        {k.label}
                      </Button>
                    ))}
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Recently reported</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1">
              {state?.recent.slice(0, 10).map((r, i) => (
                <div key={i} className="text-muted-foreground text-xs">
                  <span className="font-medium">{r.subjectId}</span> ·{" "}
                  {r.statusKind.replace(/_/g, " ")}
                  {r.note && ` — ${r.note}`}
                </div>
              ))}
              {state?.recent.length === 0 && (
                <p className="text-muted-foreground text-xs">Nothing reported yet.</p>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
