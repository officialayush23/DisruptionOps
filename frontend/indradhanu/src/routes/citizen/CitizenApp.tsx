import { useCallback, useEffect, useRef, useState } from "react"
import {
  AlertTriangle, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Compass,
  Droplets, Hospital, Loader2, Mic, Navigation, Pill, Send, ShieldCheck,
  Siren, Square, Utensils, WifiOff,
} from "lucide-react"
import { apiBaseUrl, request } from "@/api/httpClient"
import { LiveMap } from "@/components/map/LiveMap"
import { MapStage } from "@/components/map/MapStage"
import { OfflineBar } from "@/components/common/OfflineBar"
import { DemoCredentials } from "@/auth/DemoCredentials"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Textarea } from "@/components/ui/textarea"

/** The resident's interface.
 *
 *  Its own URL, because a resident and a ward officer need different things and
 *  putting a walkable marker on a control room console was simply wrong.
 *
 *  Three things, in the order someone under stress would want them: what is
 *  happening here, where should I go, and how do I tell someone. No account
 *  required for any of it.
 */

type State = {
  ward: { id: string; name: string; population: number } | null
  inside: boolean
  note: string
  risk: { score: number; severity: number; leadTimeHours: number; populationAtRisk: number
          drivers: { label: string; contribution: number; detail: string }[] } | null
  incidents: { id: string; title: string; category: string; severity: number
               reportCount: number; location: [number, number]; distanceM: number }[]
  alerts: { id: string; headline: string; action: string; severity: number
            issuedAt: string; safeLocation: { name: string; distance_km: number } | null }[]
  facilities: { id: string; name: string; kind: string; status: string
                capacity: number | null; occupancy: number | null
                location: [number, number]; distanceM: number }[]
  unitsNearby: { id: string; kind: string; label: string; status: string
                 location: [number, number]; etaMinutes: number | null }[]
  /** Roads crews have declared impassable near you. The most actionable thing
   *  on this screen: not "your ward is at severity four" but "not that street". */
  roadBlocks: { id: string; reason: string; reportedBy: string
                radiusM: number; location: [number, number] }[]
  categories: { id: string; label: string; lifeSafety: boolean }[]
}

type VoiceResult = {
  heard: string; language: string; languageName: string
  translated: boolean; latencyMs: number; notes: string[]
  readAs: string; readAsLabel: string; readHow: string; readConfidence: number
}

type Guidance = {
  intent: string; headline: string; shouldMove: boolean
  reasoning: string[]; warnings: string[]
  destination: { name: string; kind: string; why: string[]; distance_km: number } | null
  alternatives: { name: string; why: string[] }[]
  route: number[][]; routeKm: number; routeMinutes: number
  routeEngine: string; hazardsConsidered: number; exposedPoints: number
  routeSteps: { instruction: string; street: string; distanceM: number }[]
}

const STEP = 0.0035
const ALANDI: [number, number] = [73.8989, 18.6773]

/** Metres between two lng/lat pairs. Equirectangular rather than haversine:
 *  over the few kilometres a person walks it agrees to well under a metre, and
 *  this runs on every position change. */
function metres(a: [number, number], b: [number, number]): number {
  const R = 6371000
  const la = (a[1] * Math.PI) / 180
  const lb = (b[1] * Math.PI) / 180
  const x = ((b[0] - a[0]) * Math.PI) / 180 * Math.cos((la + lb) / 2)
  const y = lb - la
  return Math.sqrt(x * x + y * y) * R
}

/** Where along the route this person actually is.
 *
 *  Returns how far they have travelled measured along the line, and how far
 *  they are from it. The second number is the one that matters: a route is only
 *  advice, and somebody who has walked around a flooded corner is not lost, but
 *  somebody 300 metres off it is being given directions for a street they are
 *  not on, which is worse than no directions.
 */
function progressAlong(route: number[][], at: [number, number]) {
  if (!route || route.length < 2) return { travelled: 0, offBy: 0, total: 0 }
  let total = 0
  let travelled = 0
  let offBy = Infinity
  let running = 0
  for (let i = 0; i < route.length - 1; i++) {
    const a = route[i] as [number, number]
    const b = route[i + 1] as [number, number]
    const segment = metres(a, b)
    // Project onto the segment in flat lng/lat, which is fine at this scale.
    const dx = b[0] - a[0]
    const dy = b[1] - a[1]
    const len2 = dx * dx + dy * dy
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1,
      ((at[0] - a[0]) * dx + (at[1] - a[1]) * dy) / len2))
    const foot: [number, number] = [a[0] + t * dx, a[1] + t * dy]
    const d = metres(at, foot)
    if (d < offBy) {
      offBy = d
      travelled = running + segment * t
    }
    running += segment
    total += segment
  }
  return { travelled, offBy, total }
}

/** Which instruction applies right now, and how far until the next one.
 *
 *  The steps carry a distance each and no coordinates, so the position is
 *  matched to them by walking the cumulative distances rather than by looking
 *  for the nearest turn. That is also the honest reading of the data: a step
 *  says "in 240 m, turn left", and 240 m along the line is exactly where that
 *  stops being true.
 */
function currentStep(
  steps: { instruction: string; street: string; distanceM: number }[],
  travelled: number
) {
  if (!steps?.length) return null
  let acc = 0
  for (let i = 0; i < steps.length; i++) {
    const end = acc + steps[i].distanceM
    if (travelled < end || i === steps.length - 1) {
      return {
        index: i,
        step: steps[i],
        next: steps[i + 1] ?? null,
        toNextM: Math.max(0, Math.round(end - travelled)),
        remaining: steps.length - i - 1,
      }
    }
    acc = end
  }
  return null
}

function readable(m: number) {
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m / 10) * 10} m`
}

export default function CitizenApp() {
  const [pos, setPos] = useState<{ lng: number; lat: number }>({ lng: ALANDI[0], lat: ALANDI[1] })
  const [state, setState] = useState<State | null>(null)
  const [guide, setGuide] = useState<Guidance | null>(null)
  const [recording, setRecording] = useState(false)
  const [heard, setHeard] = useState<VoiceResult | null>(null)
  const recorder = useRef<MediaRecorder | null>(null)
  const [text, setText] = useState("")
  const [busy, setBusy] = useState<string | null>(null)
  const [filed, setFiled] = useState<Record<string, unknown> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [gpsNote, setGpsNote] = useState<string | null>(null)
  /** Set when the API cannot be reached at all, as opposed to refusing us.
   *  Distinct from `error` because the remedy is different and a resident being
   *  told "failed to fetch" learns nothing. */
  const [unreachable, setUnreachable] = useState(false)
  /** Alert ids already shown, so a new one can announce itself rather than
   *  appearing silently at the top of a page nobody is looking at. */
  const seenAlerts = useRef<Set<string>>(new Set())
  /** The alert we have already routed for. An advisory should produce a route
   *  once, not a fresh solve on every four-second poll. */
  const routedFor = useRef<string | null>(null)
  const [newAlert, setNewAlert] = useState<string | null>(null)
  /** Turn-by-turn is on only when the person asked to go somewhere. */
  const [navOn, setNavOn] = useState(false)

  const load = useCallback(async (p: { lng: number; lat: number }) => {
    try {
      const next = await request<State>("/citizen/state", {
        query: { lng: p.lng, lat: p.lat, cityId: "pune" },
      })
      setState(next)
      setUnreachable(false)
      setError(null)

      // Anything new since the last poll announces itself. A resident is not
      // watching this screen; the whole reason an alert exists is that
      // something changed while they were doing something else.
      const fresh = (next.alerts ?? []).find((a) => !seenAlerts.current.has(a.id))
      ;(next.alerts ?? []).forEach((a) => seenAlerts.current.add(a.id))
      if (fresh) {
        setNewAlert(fresh.headline)
        try {
          navigator.vibrate?.([120, 60, 120])
          if ("Notification" in window && Notification.permission === "granted") {
            new Notification(fresh.headline, { body: fresh.action, tag: fresh.id })
          }
        } catch { /* a browser that will not buzz is not an error worth showing */ }
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      // `TypeError: Failed to fetch` is what a browser says when nothing
      // answered. It is the most common state during development and the least
      // informative message in it.
      const dead = /failed to fetch|networkerror|load failed/i.test(message)
      setUnreachable(dead)
      setError(dead ? null : message)
    }
  }, [])

  useEffect(() => { void load(pos) }, [load, pos])
  useEffect(() => {
    const id = setInterval(() => void load(pos), 4000)
    return () => clearInterval(id)
  }, [load, pos])

  // Real GPS if they allow it, arrow keys either way. Declining location is an
  // ordinary choice, not an error state to sit in.
  useEffect(() => {
    if (!("geolocation" in navigator)) return
    navigator.geolocation.getCurrentPosition(
      (g) => setPos({ lng: g.coords.longitude, lat: g.coords.latitude }),
      () => setGpsNote("Location is off, so the map is starting in Alandi. Arrow keys move you."),
      { enableHighAccuracy: true, timeout: 8000 }
    )
  }, [])

  // Asked once, quietly. Declining is fine: the banner above still appears,
  // it just will not reach them on a locked phone.
  useEffect(() => {
    if ("Notification" in window && Notification.permission === "default") {
      void Notification.requestPermission().catch(() => {})
    }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === "INPUT" || tag === "TEXTAREA") return
      const d: Record<string, [number, number]> = {
        ArrowUp: [0, STEP], ArrowDown: [0, -STEP], ArrowLeft: [-STEP, 0], ArrowRight: [STEP, 0],
        w: [0, STEP], s: [0, -STEP], a: [-STEP, 0], d: [STEP, 0],
      }
      const delta = d[e.key]
      if (!delta) return
      e.preventDefault()
      setPos((p) => ({ lng: p.lng + delta[0], lat: p.lat + delta[1] }))
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  /** Hold to talk.
   *
   *  Typing is the wrong input here. Somebody standing in water, on a phone, in
   *  the dark, with one hand free is not going to fill in a form, and the
   *  fastest report is the one that asked least of the person making it.
   *
   *  What comes back is put in the text box rather than filed straight away, so
   *  the person reads what was heard before it becomes a report. A misheard
   *  report filed automatically is worse than a slow one.
   */
  async function startRecording() {
    setError(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const chunks: BlobPart[] = []
      const mime = MediaRecorder.isTypeSupported("audio/webm")
        ? "audio/webm"
        : "audio/mp4"
      const rec = new MediaRecorder(stream, { mimeType: mime })
      rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data) }
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop())
        setRecording(false)
        const blob = new Blob(chunks, { type: mime })
        if (blob.size < 1200) {
          setError("That was too short to make out. Hold the button while you speak.")
          return
        }
        setBusy("voice")
        try {
          const b64 = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader()
            reader.onloadend = () => resolve(String(reader.result).split(",")[1] ?? "")
            reader.onerror = () => reject(new Error("Could not read the recording."))
            reader.readAsDataURL(blob)
          })
          const r = await request<VoiceResult>("/citizen/report/voice", {
            method: "POST",
            body: {
              lng: pos.lng, lat: pos.lat, audioBase64: b64,
              contentType: mime, language: "unknown",
              fileIt: false, cityId: "pune",
            },
          })
          setHeard(r)
          setText(r.heard)
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e))
        } finally { setBusy(null) }
      }
      recorder.current = rec
      rec.start()
      setRecording(true)
    } catch {
      setError(
        "The microphone is not available. Check the permission, or type the " +
        "report instead."
      )
    }
  }

  function stopRecording() {
    recorder.current?.stop()
    recorder.current = null
  }

  async function ask(intent: string, condition?: string) {
    setBusy(intent)
    try {
      const g = await request<Guidance>("/citizen/guide", {
        method: "POST",
        body: { lng: pos.lng, lat: pos.lat, intent, condition, cityId: "pune" },
      })
      setGuide(g)
      setNavOn(Boolean(g.shouldMove && g.route?.length))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally { setBusy(null) }
  }

  async function fileReport() {
    if (!text.trim()) return
    // The button used to be disabled whenever `state.inside` was not true,
    // which meant it was also dead whenever `state` was null — that is, every
    // time the API was unreachable, with nothing on screen saying so. A button
    // that cannot be pressed cannot explain itself, so it is pressable now and
    // the refusal is a sentence instead.
    if (!state) {
      setError(
        "Your report has not been sent: this app cannot reach the server yet. " +
        "Your text is still here — try again in a moment."
      )
      return
    }
    if (!state.inside) {
      setError(
        state.note ||
        "You are outside the area this deployment covers, so there is no ward " +
        "to file this against. Move the marker into the city, or call 112."
      )
      return
    }
    setBusy("report")
    try {
      const r = await request<Record<string, unknown>>("/citizen/report", {
        method: "POST", body: { lng: pos.lng, lat: pos.lat, text, cityId: "pune" },
      })
      setFiled(r)
      setText("")
      await load(pos)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally { setBusy(null) }
  }

  /** An alert in force routes you, without being asked.
   *
   *  This was the gap. An advisory said "move to a shelter" and then waited for
   *  the person to notice a button labelled "Nearest shelter" and press it.
   *  Somebody standing in water at night does not go looking for a button, and
   *  the one thing the system already knows is where they should go — the
   *  shelter is chosen by PostGIS on distance and spare capacity, and the route
   *  avoids every hazard that has been reported. Withholding that until asked
   *  was the interface getting in the way of the product.
   *
   *  Once per alert, not once per poll: `routedFor` holds the alert the route
   *  belongs to. A new advisory re-routes, because it may name a different
   *  shelter; the same one re-arriving does not, because the person may have
   *  deliberately asked for something else since and having the screen snap
   *  back to a shelter every four seconds is worse than not routing at all.
   */
  useEffect(() => {
    const alert = state?.alerts?.[0]
    if (!alert || !state?.inside) return
    if (routedFor.current === alert.id) return
    routedFor.current = alert.id
    void ask("shelter")
    // `ask` is stable enough for this: it closes over `pos`, and routing from
    // the position held when the advisory arrived is correct — the turn-by-turn
    // below re-projects against live position from there.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.alerts?.[0]?.id, state?.inside])

  const sev = state?.risk?.severity ?? 0

  /** Recomputed on every position change, which is what makes it navigation
   *  rather than a printed list of directions. */
  const nav = (() => {
    if (!navOn || !guide?.route?.length || !guide.routeSteps?.length) return null
    const { travelled, offBy, total } = progressAlong(guide.route, [pos.lng, pos.lat])
    const cur = currentStep(guide.routeSteps, travelled)
    if (!cur) return null
    return {
      ...cur,
      offBy: Math.round(offBy),
      remainingM: Math.max(0, Math.round(total - travelled)),
      arrived: total - travelled < 40,
      strayed: offBy > 120,
    }
  })()

  /** One step of movement, shared by the keyboard and the on-screen pad. */
  const nudge = useCallback((dx: number, dy: number) => {
    setPos((p) => ({ lng: p.lng + dx * STEP, lat: p.lat + dy * STEP }))
  }, [])

  return (
    <div className="mx-auto max-w-6xl space-y-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold">Indradhanu</h1>
          <p className="text-muted-foreground text-xs">
            {state?.ward ? state.ward.name : "Finding your area…"}
            {state && !state.inside && " · outside the covered area"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {sev >= 4 && <Badge variant="destructive">Severity {sev}</Badge>}
          {sev > 0 && sev < 4 && <Badge variant="secondary">Severity {sev}</Badge>}
          <a href="/login" className="text-muted-foreground text-xs underline">Sign in</a>
        </div>
      </div>

      {gpsNote && <Alert><AlertDescription className="text-xs">{gpsNote}</AlertDescription></Alert>}
      {state && !state.inside && (
        <Alert variant="destructive">
          <AlertTriangle className="size-4" />
          <AlertDescription className="text-xs">{state.note}</AlertDescription>
        </Alert>
      )}
      {error && (
        <Alert variant="destructive"><AlertDescription className="text-xs">{error}</AlertDescription></Alert>
      )}

      {/* Nothing answered. Said plainly, with the address it tried, because the
          person who most often sees this is the one who can start the server. */}
      {unreachable && (
        <Alert variant="destructive">
          <WifiOff className="size-4" />
          <AlertDescription className="text-xs">
            Cannot reach the service at <code>{apiBaseUrl}</code>. The map and
            your reports will not update until it answers. Nothing you type is
            lost — it stays in the box and sends when the connection is back.
          </AlertDescription>
        </Alert>
      )}

      {/* A new alert, announced. Dismissible, because it has been read by the
          time somebody is deciding to close it. */}
      {newAlert && (
        <Alert variant="destructive" className="border-2">
          <Siren className="size-4 animate-pulse" />
          <AlertDescription className="flex items-start justify-between gap-3">
            <span className="text-sm font-medium">{newAlert}</span>
            <button
              type="button"
              className="shrink-0 text-xs underline"
              onClick={() => setNewAlert(null)}
            >
              Dismiss
            </button>
          </AlertDescription>
        </Alert>
      )}

      {state?.alerts?.[0] && (
        <Alert variant="destructive">
          <Siren className="size-4" />
          <AlertDescription>
            <div className="font-medium">{state.alerts[0].headline}</div>
            <div className="text-sm">{state.alerts[0].action}</div>
            {state.alerts[0].safeLocation && (
              <div className="mt-1 text-sm">
                Go to <span className="font-medium">{state.alerts[0].safeLocation.name}</span>,{" "}
                {state.alerts[0].safeLocation.distance_km} km away.{" "}
                {guide?.route?.length
                  ? "The route is on the map and the directions are below."
                  : "Working out the safest way there…"}
              </div>
            )}
          </AlertDescription>
        </Alert>
      )}

      <OfflineBar manifest="/manifest.webmanifest" />

      <div className="grid gap-3 lg:grid-cols-[1fr_360px]">
        <div className="space-y-3">
          <MapStage
            panelTitle="Near you"
            panel={
              <div className="space-y-2 text-xs">
                {(state?.incidents ?? []).slice(0, 12).map((i) => (
                  <div key={i.id} className="rounded border border-slate-500/25 p-2">
                    <div className="font-medium text-slate-100">{i.title}</div>
                    <div className="text-slate-400">
                      severity {i.severity} · {(i.distanceM / 1000).toFixed(1)} km away
                    </div>
                  </div>
                ))}
                {(state?.incidents?.length ?? 0) === 0 && (
                  <p className="text-slate-400">Nothing reported near you.</p>
                )}
              </div>
            }
            map={(expanded) => (
              <LiveMap
                className={expanded ? "h-full w-full" : "h-[460px] w-full rounded-lg border"}
                wards={[]}
                incidents={state?.incidents ?? []}
                resources={state?.unitsNearby?.map((u) => ({ ...u, capabilities: [] })) ?? []}
                facilities={state?.facilities ?? []}
                route={guide?.route}
                routeLabel={guide?.headline}
                blocks={state?.roadBlocks ?? []}
                me={{ lng: pos.lng, lat: pos.lat, label: "You" }}
                center={[pos.lng, pos.lat]}
                zoom={13.5}
                followMe
              />
            )}
            footer={
              /* The keys have always worked. They were also invisible, needed a
                 focused window, and did nothing at all on a phone — which is
                 the device this screen is for. Buttons, then, with the keys
                 kept for anyone at a desk. */
              <div className="flex flex-wrap items-center gap-3">
                <div className="grid w-[132px] shrink-0 grid-cols-3 gap-1">
                  <span />
                  <Button size="icon" variant="secondary" aria-label="Move north"
                          className="size-10" onClick={() => nudge(0, 1)}>
                    <ChevronUp className="size-5" />
                  </Button>
                  <span />
                  <Button size="icon" variant="secondary" aria-label="Move west"
                          className="size-10" onClick={() => nudge(-1, 0)}>
                    <ChevronLeft className="size-5" />
                  </Button>
                  <Button size="icon" variant="outline" aria-label="Recentre on me"
                          className="size-10"
                          onClick={() => setPos((pp) => ({ ...pp }))}>
                    <Navigation className="size-4" />
                  </Button>
                  <Button size="icon" variant="secondary" aria-label="Move east"
                          className="size-10" onClick={() => nudge(1, 0)}>
                    <ChevronRight className="size-5" />
                  </Button>
                  <span />
                  <Button size="icon" variant="secondary" aria-label="Move south"
                          className="size-10" onClick={() => nudge(0, -1)}>
                    <ChevronDown className="size-5" />
                  </Button>
                  <span />
                </div>
                <p className="text-muted-foreground min-w-[220px] flex-1 text-xs">
                  These buttons, or WASD and the arrow keys, move you. The green
                  line is the route the agent recommends, on real streets, chosen
                  against every hazard that has been reported rather than for
                  being shortest. Open the legend for what the colours mean.
                </p>
              </div>
            }
          />
        </div>

        <div className="space-y-3">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-sm">
                <Compass className="size-4" /> Where should I go?
              </CardTitle>
              <CardDescription className="text-xs">
                Decided from what has room, what is near an open incident, and
                which roads crews have reported blocked.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="secondary" disabled={busy !== null}
                        onClick={() => ask("safety")}>
                  {busy === "safety" ? <Loader2 className="size-3.5 animate-spin" /> : <ShieldCheck className="size-3.5" />}
                  Am I safe?
                </Button>
                <Button size="sm" variant="secondary" disabled={busy !== null}
                        onClick={() => ask("shelter")}>
                  <Navigation className="size-3.5" /> Nearest shelter
                </Button>
                <Button size="sm" variant="secondary" disabled={busy !== null}
                        onClick={() => ask("hospital", text || undefined)}>
                  <Hospital className="size-3.5" /> Hospital
                </Button>
                {/* PS20's first sentence is food, medical supplies and shelter.
                    A resident could be told where to shelter and never where to
                    eat, which is most of a relief operation missing. Each of
                    these excludes places that have run the line out rather than
                    ranking them low: queueing for food that is not there is
                    worse than walking further. */}
                <Button size="sm" variant="secondary" disabled={busy !== null}
                        onClick={() => ask("food")}>
                  {busy === "food" ? <Loader2 className="size-3.5 animate-spin" /> : <Utensils className="size-3.5" />}
                  Food
                </Button>
                <Button size="sm" variant="secondary" disabled={busy !== null}
                        onClick={() => ask("water")}>
                  {busy === "water" ? <Loader2 className="size-3.5 animate-spin" /> : <Droplets className="size-3.5" />}
                  Drinking water
                </Button>
                <Button size="sm" variant="secondary" disabled={busy !== null}
                        onClick={() => ask("medical_supplies")}>
                  {busy === "medical_supplies" ? <Loader2 className="size-3.5 animate-spin" /> : <Pill className="size-3.5" />}
                  Medicine
                </Button>
              </div>

              {/* Turn by turn, as you move.
                  The static list is still below, because a person wants to see
                  the whole way before they set off. This is the one instruction
                  that is true right now, in the size you can read while
                  walking, and it changes as the position does. */}
              {nav && (
                <div className="space-y-2 rounded-lg border-2 border-emerald-500/50 bg-emerald-500/5 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <Badge variant="secondary" className="gap-1">
                      <Navigation className="size-3" /> Navigating
                    </Badge>
                    <button type="button" className="text-muted-foreground text-xs underline"
                            onClick={() => setNavOn(false)}>
                      Stop
                    </button>
                  </div>

                  {nav.arrived ? (
                    <p className="text-base font-semibold">
                      You have arrived at {guide?.destination?.name ?? "your destination"}.
                    </p>
                  ) : (
                    <>
                      <div className="text-2xl font-semibold tabular-nums leading-tight">
                        {readable(nav.toNextM)}
                      </div>
                      <p className="text-base leading-snug">{nav.step.instruction}</p>
                      {nav.next && (
                        <p className="text-muted-foreground text-xs">
                          Then: {nav.next.instruction}
                        </p>
                      )}
                      <p className="text-muted-foreground text-xs tabular-nums">
                        {readable(nav.remainingM)} left · {nav.remaining} turn(s) to go
                      </p>
                    </>
                  )}

                  {/* Being off the line is not a failure, but it does mean the
                      instruction above is about a street you are not on. */}
                  {nav.strayed && !nav.arrived && (
                    <Alert variant="destructive" className="py-2">
                      <AlertDescription className="text-xs">
                        You are about {readable(nav.offBy)} off this route. Ask
                        again to get one from where you are now.
                      </AlertDescription>
                    </Alert>
                  )}
                </div>
              )}

              {guide && (
                <div className="space-y-2 rounded border p-2">
                  <p className="text-sm font-medium">{guide.headline}</p>
                  {guide.shouldMove && guide.destination && (
                    <div className="text-muted-foreground text-xs">
                      {guide.routeKm} km · about {guide.routeMinutes} min ·{" "}
                      {guide.routeEngine === "mapbox" || guide.routeEngine === "osrm"
                        ? "road route"
                        : "straight-line estimate, the router was unreachable"}
                      {guide.hazardsConsidered > 0 &&
                        ` · ${guide.hazardsConsidered} hazard(s) taken into account`}
                    </div>
                  )}

                  {guide.shouldMove && guide.routeSteps?.length > 0 && (
                    <div className="rounded border p-2">
                      <div className="text-muted-foreground mb-1 text-xs font-medium uppercase tracking-wide">
                        The way there
                      </div>
                      <ol className="space-y-1">
                        {guide.routeSteps.slice(0, 8).map((st, i) => (
                          <li key={i} className="flex gap-2 text-xs">
                            <span className="text-muted-foreground w-12 shrink-0 tabular-nums">
                              {st.distanceM >= 1000
                                ? `${(st.distanceM / 1000).toFixed(1)} km`
                                : `${st.distanceM} m`}
                            </span>
                            <span>{st.instruction}</span>
                          </li>
                        ))}
                      </ol>
                      {guide.exposedPoints > 0 && (
                        <p className="text-destructive mt-2 text-xs">
                          This is the least exposed way we could find, but it still
                          passes close to {guide.exposedPoints} reported hazard(s).
                          Turn back if the water is moving.
                        </p>
                      )}
                    </div>
                  )}
                  <ul className="space-y-1">
                    {guide.reasoning.map((r, i) => (
                      <li key={i} className="text-muted-foreground text-xs">• {r}</li>
                    ))}
                  </ul>
                  {guide.alternatives.length > 0 && (
                    <p className="text-muted-foreground text-xs">
                      Also open: {guide.alternatives.map((a) => a.name).join(", ")}
                    </p>
                  )}
                  {guide.warnings.map((w, i) => (
                    <Alert key={i} variant="destructive" className="py-2">
                      <AlertDescription className="text-xs">{w}</AlertDescription>
                    </Alert>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Tell us what you can see</CardTitle>
              <CardDescription className="text-xs">
                Say it or type it, in English, Hindi or Marathi. No account needed.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              {/* Hold to talk. One hand, no form, no dropdown. The transcript
                  lands in the box below so the person can read it before it
                  becomes a report. */}
              <Button
                type="button"
                variant={recording ? "destructive" : "secondary"}
                className="w-full"
                disabled={busy === "voice"}
                onPointerDown={() => { if (!recording) void startRecording() }}
                onPointerUp={() => { if (recording) stopRecording() }}
                onPointerLeave={() => { if (recording) stopRecording() }}
              >
                {busy === "voice" ? (
                  <><Loader2 className="size-4 animate-spin" /> Listening back…</>
                ) : recording ? (
                  <><Square className="size-4" /> Release to stop</>
                ) : (
                  <><Mic className="size-4" /> Hold to speak</>
                )}
              </Button>

              {heard && (
                <div className="space-y-1 rounded border p-2 text-xs">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge variant="outline">{heard.languageName}</Badge>
                    {heard.translated && (
                      <Badge variant="secondary">translated to English</Badge>
                    )}
                    <span className="text-muted-foreground tabular-nums">
                      {heard.latencyMs} ms
                    </span>
                  </div>
                  <div className="text-muted-foreground">
                    Read as <span className="text-foreground">{heard.readAsLabel}</span>.
                    Correct the text below if that is wrong, then send.
                  </div>
                  {heard.notes.map((n, i) => (
                    <div key={i} className="text-muted-foreground italic">{n}</div>
                  ))}
                </div>
              )}

              <Textarea
                value={text}
                onChange={(e) => { setText(e.target.value); setHeard(null) }}
                placeholder="रस्त्यावर पाणी आले आहे / water on the road, cannot cross"
                rows={3}
              />
              <Button className="w-full" onClick={fileReport}
                      disabled={busy !== null || !text.trim()}>
                {busy === "report" ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
                Send report
              </Button>
              {state && !state.inside && (
                <p className="text-muted-foreground text-xs">
                  You are outside the covered area, so this will be refused
                  until you move inside it. Pressing send will say so.
                </p>
              )}
              {filed && (
                <div className="space-y-1 rounded border p-2 text-xs">
                  <div className="font-medium">{String(filed.readHow ?? "")}</div>
                  <div className="text-muted-foreground">{String(filed.summary ?? "")}</div>
                  {Boolean(filed.linked) && (
                    <Badge variant="outline">
                      Merged with an existing report at{" "}
                      {((filed.linkScore as number) * 100).toFixed(0)}%
                    </Badge>
                  )}
                  {Number(filed.urgencyBoost ?? 0) > 0 && (
                    <Badge variant="destructive">Flagged urgent</Badge>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          {/* The resident account, on the resident's screen. Nothing here
              requires an account, so this is for the person being handed a
              tablet who wants the signed-in version with a report history. */}
          <DemoCredentials
            portal="citizen"
            title="Demo resident sign-in (optional)"
          />

          {state?.risk && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Why this area is rated as it is</CardTitle>
              </CardHeader>
              <CardContent className="space-y-1">
                {state.risk.drivers.slice(0, 4).map((d, i) => (
                  <div key={i} className="text-xs">
                    <span className="font-medium">{d.label}</span>{" "}
                    <span className="text-muted-foreground">
                      {(d.contribution * 100).toFixed(0)}% — {d.detail}
                    </span>
                  </div>
                ))}
                <p className="text-muted-foreground pt-1 text-xs">
                  About {state.risk.leadTimeHours}h of lead time.
                </p>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  )
}
