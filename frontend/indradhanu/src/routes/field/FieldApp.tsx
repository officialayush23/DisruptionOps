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
import { REPORT_STATUS, trustWords } from "@/lib/plain"

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
  /** Undefined on an older backend; the card below simply does not render. */
  myReports?: MyReport[]
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

/** A hazard this crew filed, and what became of it.
 *
 *  The crew had exactly one chance to learn the fate of a report: the card that
 *  appeared for a few seconds after pressing send. Reload, or drive to the next
 *  street, and "did anyone act on that?" was answered by faith. These rows
 *  carry the consequence rather than the status — which incident it landed on,
 *  how many other reports are on that incident, whether a unit is coming and
 *  how far out. */
type MyReport = {
  id: string
  text: string
  readAs: string
  trust: number | null
  status: string
  outcome: string | null
  at: string
  incidentId: string | null
  incidentTitle: string | null
  incidentStatus: string | null
  incidentSeverity: number | null
  reportCount: number
  unitsOnIt: number
  etaMinutes: number | null
}

/** The live fix, and why there isn't one.
 *
 *  `stale` is the state that did not exist before and matters most: a fix we
 *  still have and still believe, from a watch that has since stopped answering.
 *  Collapsing that into "no GPS" is what sent reports to the depot.
 */
type Gps = {
  state: "locating" | "ok" | "stale" | "denied" | "failed" | "unsupported"
  fix?: { lng: number; lat: number; accuracy: number; at: number }
}

/** Accuracy at or below which a fix names a street. A phone with a real GPS
 *  lock answers in 5 to 20 m; 250 m still puts a report on the right block. */
const PRECISE_FIX_M = 250
/** Accuracy beyond which a fix is a neighbourhood rather than a place, and the
 *  unit's recorded position is the better of two bad options.
 *
 *  This bound replaced a single 120 m gate that was **too strict and, worse, a
 *  hard block**: a crew standing at a hazard with a ±200 m cell fix — which is
 *  what a phone returns for the first few seconds before GPS refines, and
 *  permanently if the person granted Android's "approximate location" — was
 *  refused and sent to file at the depot instead. The depot can be kilometres
 *  away and carries no accuracy figure at all, so trading a known ±200 m for an
 *  unknown error was the wrong way round.
 *
 *  Three bands now: precise, approximate-but-used, and too coarse. The middle
 *  one is the important one, because it is where a real phone actually sits and
 *  the old code had no room for it. */
const COARSE_FIX_M = 2000
/** Seconds after which a fix is too old to file against. A crew in a truck
 *  covers a few hundred metres in a minute. */
const STALE_FIX_S = 120

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
  const [gps, setGps] = useState<Gps>({ state: "locating" })
  /** Bumped by "Try again", which restarts the watch. A permission granted
   *  after the first refusal does not reach a watch that was already running. */
  const [gpsAttempt, setGpsAttempt] = useState(0)
  const [now, setNow] = useState(() => Date.now())
  /** Whether the map rides with the crew. On by default; a drag releases it. */
  const [follow, setFollow] = useState(true)
  /** Bumped to force one re-centre even while `follow` is off. */
  const [recentre, setRecentre] = useState(0)
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
  //
  // The first version of this was three lines and wrong in four ways, all of
  // which ended with a hazard filed at the truck's registered depot rather than
  // where the crew was standing, and nothing on screen saying so.
  //
  //  1. **The error handler wiped a good fix.** `watchPosition` calls it on
  //     every failure, including a momentary timeout under a flyover, and
  //     `setMyPos(null)` threw away a perfectly good position from four seconds
  //     ago. One bad moment and the crew silently fell back to the depot.
  //  2. **A ten-second timeout with `enableHighAccuracy`.** A cold GPS fix
  //     routinely takes longer than that, so the very first callback on a phone
  //     that had just been unlocked was usually an error — see (1).
  //  3. **No accuracy gate.** A phone indoors answers from Wi-Fi with a radius
  //     of kilometres. Filing "wall collapsed here" against that is worse than
  //     filing nothing, because it is wrong with confidence.
  //  4. **No way to say any of this.** The card said "Filed at your GPS
  //     position" or "No GPS", with nothing about how good the fix was, how old
  //     it was, or how to fix a denied permission.
  //
  // What follows keeps the last good fix, states its accuracy and age, and only
  // treats a fix as usable for reporting when it is actually good enough to
  // report against.
  useEffect(() => {
    if (!navigator.geolocation) {
      setGps({ state: "unsupported" })
      return
    }
    setGps((g) => (g.fix ? g : { state: "locating" }))
    const id = navigator.geolocation.watchPosition(
      (p) =>
        setGps({
          state: "ok",
          fix: {
            lng: p.coords.longitude,
            lat: p.coords.latitude,
            accuracy: p.coords.accuracy,
            at: Date.now(),
          },
        }),
      (e) =>
        setGps((g) => ({
          // A denied permission is a decision and sticks. A timeout or a lost
          // signal is weather: keep the last fix and let the age counter say
          // how stale it has become.
          state: e.code === e.PERMISSION_DENIED ? "denied" : g.fix ? "stale" : "failed",
          fix: e.code === e.PERMISSION_DENIED ? undefined : g.fix,
        })),
      // 30s, because a cold fix is slow and a timeout used to cost the crew
      // their position. `maximumAge` small: a crew moves.
      { enableHighAccuracy: true, maximumAge: 10_000, timeout: 30_000 }
    )
    return () => navigator.geolocation.clearWatch(id)
  }, [gpsAttempt])

  /** Ages the fix on its own clock, so "42s ago" is the real age rather than
   *  the age it had when something else last re-rendered.
   *
   *  Ten seconds, not one. This re-renders the whole screen including the map's
   *  props, and the staleness gate is a two-minute line — a second of precision
   *  on it buys nothing and costs a redraw a second. It also only runs while
   *  there is a fix to age. */
  const hasFix = Boolean(gps.fix)
  useEffect(() => {
    if (!hasFix) return
    const id = setInterval(() => setNow(Date.now()), 10_000)
    return () => clearInterval(id)
  }, [hasFix])

  const fix = gps.fix ?? null
  const fixAgeS = fix ? Math.max(0, Math.round((now - fix.at) / 1000)) : null
  const fresh = (fixAgeS ?? Infinity) <= STALE_FIX_S
  /** Good enough to file against — which is a lower bar than "good enough to
   *  navigate by", and the two were conflated. The competition is not a perfect
   *  fix, it is the truck's recorded position. */
  const fixUsable = Boolean(fix && fix.accuracy <= COARSE_FIX_M && fresh)
  /** Good enough that nothing needs to be said about it. */
  const fixPrecise = Boolean(fix && fix.accuracy <= PRECISE_FIX_M && fresh)
  const myPos: [number, number] | null = fix ? [fix.lng, fix.lat] : null

  const unit = state?.units.find((u) => u.id === selected) ?? null
  /** The position a report is filed at, and the reason for it. Both, because a
   *  crew has to be able to see that it is about to file against the depot. */
  const reportAt = (fixUsable ? myPos : null) ?? unit?.location ?? null
  const reportSource: "gps" | "unit" | "none" =
    fixUsable && myPos ? "gps" : unit?.location ? "unit" : "none"

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
          // The crew's own fix when it is good enough, the unit's record
          // position otherwise. A crew standing at a hospital declaring it full
          // is better evidence of where that happened than the row the truck
          // was last written to, which is where this used to send.
          lng: reportAt?.[0], lat: reportAt?.[1],
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

      <div className="grid gap-4 lg:grid-cols-[1fr_380px]">
        <div className="space-y-3">
          {/* Where the crew is, above the map rather than buried under the
              report card. This is the line a driver checks first — "does it
              know where I am" — and it was three cards down. */}
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2.5">
            <div className="text-muted-foreground min-w-0 text-xs">
              <GpsLine
                gps={gps}
                fixAgeS={fixAgeS}
                usable={fixUsable}
                precise={fixPrecise}
                source={reportSource}
                unitLabel={unit?.label}
                onRetry={() => setGpsAttempt((n) => n + 1)}
              />
            </div>
            <Button
              size="sm"
              variant={follow ? "secondary" : "outline"}
              className="h-8 shrink-0 text-xs"
              disabled={!myPos}
              onClick={() => {
                // Pressing it always re-centres, and turns following back on.
                // Two behaviours in one button because they are the same
                // intent: put me back on the map.
                setRecentre((n) => n + 1)
                setFollow(true)
              }}
            >
              <MapPin className="size-3.5" />
              {myPos ? (follow ? "Following you" : "Centre on me") : "No position"}
            </Button>
          </div>

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
                // The crew on their own map. `LiveMap` has taken a `me` marker
                // all along and this screen never passed one, so a driver could
                // see their truck's last recorded position and every incident
                // in the city, and not themselves.
                me={myPos ? { lng: myPos[0], lat: myPos[1], label: "You" } : null}
                // Locked to the crew by default. A driver does not pan a map
                // one-handed: the one thing this view has to do is stay on them
                // as they move, and it was doing the opposite — `LiveMap` has
                // taken `followMe` since it was written and this screen passed
                // neither it nor `recentreKey`, so the camera sat wherever the
                // truck's *recorded* position put it at mount and never moved
                // again. That is the "free flow".
                //
                // Turned off the moment they drag, because a crew checking what
                // is two streets over should not be yanked back mid-look, and
                // turned on again by the button below.
                followMe={follow}
                recentreKey={recentre}
                onUserMove={() => setFollow(false)}
                center={myPos ?? unit?.location ?? [73.88, 18.58]}
                zoom={13.2}
              />
            )}
          />

          {unit && (unit.steps?.length ?? 0) > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">
                  {unit.label} to {unit.assignedTo}
                </CardTitle>
                <CardDescription>
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
              <CardDescription className="space-y-1 text-xs">
                <GpsLine
                  gps={gps}
                  fixAgeS={fixAgeS}
                  usable={fixUsable}
                  precise={fixPrecise}
                  source={reportSource}
                  unitLabel={unit?.label}
                  onRetry={() => setGpsAttempt((n) => n + 1)}
                />
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              <Textarea
                value={hazardText}
                onChange={(e) => setHazardText(e.target.value)}
                placeholder="Wall collapsed across the lane, nobody trapped"
                className="min-h-20 text-base"
              />
              <div className="flex flex-wrap gap-1">
                {cats.slice(0, 10).map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => setHazardCat(hazardCat === c.id ? "" : c.id)}
                    className={
                      "rounded-md border px-3 py-2 text-sm " +
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
              <CardDescription>
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
              <CardDescription>
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

          {/* What became of what this crew filed.
              The one thing a crew asks after reporting a hazard, and the one
              thing the screen could not answer once the confirmation card
              faded. Every row carries the consequence, not the status: which
              incident it landed on, how many others are on that incident, and
              whether anyone is coming. */}
          {(state?.myReports?.length ?? 0) > 0 && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-sm">
                  <Send className="size-4" /> What you reported
                </CardTitle>
                <CardDescription>
                  Live. A report is worth filing only if you can see what it did.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-2.5">
                {state!.myReports!.map((r) => {
                  const held = r.status === "quarantined" || r.status === "rejected"
                  const closed = r.incidentStatus === "resolved"
                  return (
                    <div
                      key={r.id}
                      className={
                        "space-y-1.5 rounded-md border p-2.5 " +
                        (closed
                          ? "border-emerald-500/40 bg-emerald-500/5"
                          : held
                            ? "border-amber-500/40 bg-amber-500/5"
                            : "")
                      }
                    >
                      <p className="line-clamp-2 text-xs">{r.text}</p>
                      <div className="flex flex-wrap items-center gap-1.5 text-xs">
                        <Badge variant="outline" className="font-normal">
                          {r.readAs.replace(/_/g, " ")}
                        </Badge>
                        {/* "trust 0.62" tells a driver nothing: nobody said the
                            scale, or which end is good. The word does both, and
                            the number stays for anyone who wants it. */}
                        {r.trust !== null && (
                          <span className="text-muted-foreground">
                            trust {trustWords(r.trust)}
                            <span className="tabular-nums"> ({r.trust.toFixed(2)})</span>
                          </span>
                        )}
                        <span className="text-muted-foreground">
                          {new Date(r.at).toLocaleTimeString(undefined, {
                            hour: "2-digit", minute: "2-digit", hour12: false,
                          })}
                        </span>
                      </div>

                      {/* The chain, in one sentence each. Three outcomes, and
                          the middle one is the one a crew most needs said out
                          loud — filed, believed, and nobody free to send. */}
                      {held ? (
                        <p className="text-xs">
                          <span className="font-medium">
                            {REPORT_STATUS[r.status]?.label ?? "Held"}.
                          </span>{" "}
                          {REPORT_STATUS[r.status]?.hint ??
                            "Nothing has been dispatched for it."}{" "}
                          It has not opened an incident, so treat it as not yet
                          acted on.
                        </p>
                      ) : r.incidentTitle ? (
                        <div className="space-y-0.5 text-xs">
                          <p>
                            {closed ? "Closed: " : "On "}
                            <span className="font-medium">{r.incidentTitle}</span>
                            {r.incidentSeverity != null && (
                              <span className="text-muted-foreground">
                                {" "}· severity {r.incidentSeverity}
                              </span>
                            )}
                          </p>
                          <p className="text-muted-foreground">
                            {r.reportCount > 1
                              ? `${r.reportCount} reports on it`
                              : "the only report on it"}
                            {" · "}
                            {closed
                              ? "worked and closed"
                              : r.unitsOnIt > 0
                                ? `${r.unitsOnIt} unit${r.unitsOnIt === 1 ? "" : "s"} on the way` +
                                  (r.etaMinutes != null ? `, ${r.etaMinutes} min out` : "")
                                : "nobody assigned yet"}
                          </p>
                        </div>
                      ) : (
                        <p className="text-muted-foreground text-xs">
                          Filed, not yet on an incident. The next plan will look
                          at it.
                        </p>
                      )}
                    </div>
                  )
                })}
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">Unit status changes</CardTitle>
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

/** What the GPS is doing, in a sentence a driver can act on.
 *
 *  The rule this follows: never claim a position the fix does not support, and
 *  never make the crew guess which position a report is about to carry. Every
 *  branch below names the place the report will be filed, because that is the
 *  only fact on this card that changes what lands in the control room.
 */
function GpsLine({
  gps, fixAgeS, usable, precise, source, unitLabel, onRetry,
}: {
  gps: Gps
  fixAgeS: number | null
  usable: boolean
  precise: boolean
  source: "gps" | "unit" | "none"
  unitLabel?: string
  onRetry: () => void
}) {
  const fix = gps.fix
  const age =
    fixAgeS === null
      ? ""
      : fixAgeS < 15
        ? "just now"
        : fixAgeS < 90
          ? `${Math.round(fixAgeS / 10) * 10}s ago`
          : `${Math.round(fixAgeS / 60)} min ago`

  const fallback =
    source === "unit" && unitLabel
      ? ` Reports will be filed at ${unitLabel}'s recorded position instead.`
      : source === "none"
        ? " Nothing will file until there is a position — allow location, or pick one of your units."
        : ""

  const retry = (
    <button type="button" onClick={onRetry} className="underline underline-offset-2">
      Get a better fix
    </button>
  )

  if (gps.state === "unsupported") {
    return <span>This device has no location service.{fallback}</span>
  }
  if (gps.state === "denied") {
    return (
      <span>
        Location is blocked for this site. Allow it in the address bar, then{" "}
        {retry}.{fallback}
      </span>
    )
  }
  if (!fix) {
    return (
      <span>
        {gps.state === "locating"
          ? "Finding you — a first fix outdoors takes a few seconds."
          : "No position yet."}
        {gps.state === "failed" && <> {retry}.</>}
        {fallback}
      </span>
    )
  }

  const accuracy = `±${Math.round(fix.accuracy)} m`
  const coords = `${fix.lat.toFixed(5)}, ${fix.lng.toFixed(5)}`

  // Precise: say where, and nothing else. A line that explains a fix which is
  // working is noise.
  if (precise) {
    return (
      <span>
        Filed at where you are standing — {coords}, {accuracy}, {age}.
      </span>
    )
  }

  // Usable but coarse. **This is the band a real phone sits in**, and the old
  // code had none: it refused the fix and sent the report to the depot. The
  // fix is used, the figure is stated, and the offer to improve it is there
  // without being a precondition.
  if (usable) {
    return (
      <span>
        Filed at where you are standing, to {accuracy} — {coords}, {age}. Good
        enough for the block, not the doorway.{" "}
        {fix.accuracy > PRECISE_FIX_M ? (
          <>
            {retry} for a GPS-grade fix, or step outside.
          </>
        ) : null}
      </span>
    )
  }

  // Genuinely useless, or stale.
  return (
    <span>
      {fix.accuracy > COARSE_FIX_M
        ? `Your device can only place you to ${accuracy}, which is a neighbourhood rather than a place.`
        : `Your last fix is ${age} and too old to file against.`}{" "}
      {coords}. {retry}.{fallback}
    </span>
  )
}
