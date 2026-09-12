import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  AlertTriangle, Camera, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Compass,
  Droplets, Hospital, Loader2, Mic, Navigation, Pill, Send, ShieldCheck,
  Siren, Square, Utensils, WifiOff,
} from "lucide-react"
import { apiBaseUrl, deviceId, request } from "@/api/httpClient"
import { LiveMap } from "@/components/map/LiveMap"
import { MapStage } from "@/components/map/MapStage"
import { OfflineBar } from "@/components/common/OfflineBar"
import { DemoCredentials } from "@/auth/DemoCredentials"
import { useLiveSync, pollInterval } from "@/hooks/useLiveSync"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Textarea } from "@/components/ui/textarea"

/* `deviceId` now lives in the http client and is sent as a header on every
   request, because the rate limiter needs the same value the trust scorer does:
   at a demo, every phone in the room is behind one NAT and an IP bucket makes
   them one caller. One definition, one localStorage key — two would drift, and
   the trust attribution is the one that must not. */


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
  /** What this deployment can do. Both are optional upstream services, and a
   *  button that cannot work should say so before somebody presses it. */
  capabilities?: { voice: boolean; vision: boolean }
}

type VoiceResult = {
  heard: string; language: string; languageName: string
  translated: boolean; latencyMs: number; notes: string[]
  readAs: string; readAsLabel: string; readHow: string; readConfidence: number
}

type Guidance = {
  intent: string; headline: string; shouldMove: boolean
  reasoning: string[]; warnings: string[]
  destination: { id: string; name: string; kind: string; why: string[]; distance_km: number } | null
  alternatives: { name: string; why: string[] }[]
  route: number[][]; routeKm: number; routeMinutes: number
  routeEngine: string; hazardsConsidered: number; exposedPoints: number
  routeSteps: { instruction: string; street: string; distanceM: number }[]
}

const STEP = 0.0035
const ALANDI: [number, number] = [73.8989, 18.6773]
/** The worst location fix this screen will act on, in metres.
 *
 *  A laptop with no GPS radio answers a location request from nearby Wi-Fi and
 *  its IP address. That estimate is routinely 5-50 km wide and lands somewhere
 *  different on every page load. Wards here are 1-3 km across, so anything
 *  beyond this is not a rough position, it is a different ward — and a wrong
 *  ward means the wrong shelter, the wrong hospital and the wrong roads. */
const COARSE_FIX_M = 2000

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
  /** When the map we are showing stopped being live, if it has. */
  const [staleSince, setStaleSince] = useState<number | null>(null)
  /** Turn-by-turn is on only when the person asked to go somewhere. */
  const [navOn, setNavOn] = useState(false)
  /** A "stay where you are" answer that arrived while a route was being walked.
   *  Shown next to the navigation rather than replacing it. */
  const [advice, setAdvice] = useState<string | null>(null)
  /** A photo, and what the model made of it.
   *
   *  `token` is the server's receipt for the assessment; `unanalysed` means a
   *  photo is attached and nobody looked at it, which is a different and more
   *  honest state than no photo at all. */
  type PhotoState = {
    token: string | null
    unanalysed?: boolean
    hazards?: string[]
    water?: { present?: boolean | null; depthBand?: string | null; moving?: boolean | null }
    agreement?: number
    confidence?: number
    imageQuality?: string
    lifeSafetySignal?: boolean
    caption?: string | null
    notes?: string[]
  }
  const [photo, setPhoto] = useState<PhotoState | null>(null)
  const [photoPreview, setPhotoPreview] = useState<string | null>(null)
  const photoInput = useRef<HTMLInputElement | null>(null)

  /** How many people this phone is bringing. One phone is usually a family, and
   *  a shelter that counts phones rather than people runs out earlier than its
   *  own numbers say it will. */
  const [partySize, setPartySize] = useState(1)
  /** What the live route was solved for: where they stood, what hazards were
   *  known, and when. A route is an answer to a question asked at a moment; to
   *  know whether it is still the answer you have to remember the moment. */
  const routeSolvedAt = useRef<
    { lng: number; lat: number; hazards: string; at: number } | null
  >(null)
  /** The intent behind the live route, so a re-solve asks the same question. Re-
   *  routing somebody who asked for a hospital to the nearest shelter would be a
   *  different answer wearing the same clothes. */
  const lastIntent = useRef<string>("shelter")
  /** Shown briefly when the route re-solves on its own, because a path that
   *  silently redraws itself is indistinguishable from a glitch. */
  const [rerouted, setRerouted] = useState<string | null>(null)
  /** Bumped by the recentre button. It used to clone `pos` into a new object to
   *  force the map to ease back — which also refetched the whole city state,
   *  because the poll was keyed on that object's identity. Recentring the view
   *  and asking the API a question are different things and now say so. */
  const [recentre, setRecentre] = useState(0)

  /** The request currently in flight, so a newer one can cancel it.
   *
   *  `/citizen/state` costs about 1.5s on a warm instance, and the poll is every
   *  4s, so two can overlap whenever the network is slower than usual. Without
   *  this the older reply can land second and overwrite the newer one, which
   *  shows a resident a shelter they have already walked past. Last request
   *  wins, and the superseded one is cancelled rather than merely ignored, so it
   *  stops costing the phone's radio and the API a query. */
  const active = useRef<AbortController | null>(null)
  /** Whether the person has touched the page yet.
   *
   *  Chrome refuses `navigator.vibrate()` before a gesture and logs an
   *  intervention for each attempt. A poll that fires every four seconds turns
   *  that into a console full of them, which buries whatever real error appears
   *  next. */
  const gestured = useRef(false)

  const load = useCallback(async (p: { lng: number; lat: number }) => {
    active.current?.abort()
    const ctl = new AbortController()
    active.current = ctl
    try {
      let fromCache = false
      const next = await request<State>("/citizen/state", {
        query: { lng: p.lng, lat: p.lat, cityId: "pune" },
        signal: ctl.signal,
        onMeta: (m) => { fromCache = m.stale },
      })
      setState(next)
      setUnreachable(false)
      setError(null)
      // The network failed and the service worker answered from its copy. Worth
      // saying: this screen's whole job is telling somebody which road to
      // avoid, and roads close. A map from ten minutes ago is worth having and
      // is not worth trusting the way a live one is.
      setStaleSince((prev) => (fromCache ? prev ?? Date.now() : null))

      // Anything new since the last poll announces itself. A resident is not
      // watching this screen; the whole reason an alert exists is that
      // something changed while they were doing something else.
      const fresh = (next.alerts ?? []).find((a) => !seenAlerts.current.has(a.id))
      ;(next.alerts ?? []).forEach((a) => seenAlerts.current.add(a.id))
      if (fresh) {
        setNewAlert(fresh.headline)
        try {
          if (gestured.current) navigator.vibrate?.([120, 60, 120])
          if ("Notification" in window && Notification.permission === "granted") {
            new Notification(fresh.headline, { body: fresh.action, tag: fresh.id })
          }
        } catch { /* a browser that will not buzz is not an error worth showing */ }
      }
    } catch (e) {
      // A request we cancelled ourselves is not a failure and must not paint
      // the offline banner: something newer is already on its way.
      if (ctl.signal.aborted) return
      const message = e instanceof Error ? e.message : String(e)
      // `TypeError: Failed to fetch` is what a browser says when nothing
      // answered. It is the most common state during development and the least
      // informative message in it.
      const dead = /failed to fetch|networkerror|load failed/i.test(message)
      setUnreachable(dead)
      setError(dead ? null : message)
    }
  }, [])

  /** The position the API is asked about, rounded.
   *
   *  Geolocation hands back fourteen decimal places — 73.88962765382259 — and
   *  `pos` is a fresh object on every update, so keying the poll on it made
   *  standing still look like movement: six identical queries in four seconds,
   *  each one restarting the interval that was about to fire anyway. Five
   *  decimals is about a metre, which is finer than any decision on this screen
   *  and coarse enough that a stationary phone stays stationary.
   */
  const lng = Math.round(pos.lng * 1e5) / 1e5
  const lat = Math.round(pos.lat * 1e5) / 1e5
  const query = useMemo(() => ({ lng, lat }), [lng, lat])
  /** The current query, for a callback that outlives the render it was made in.
   *  The realtime handler is installed once; reading `query` from its closure
   *  would refetch the position the page happened to hold when the socket
   *  connected, which is the same stale-closure bug that once sent a signed-in
   *  commissioner to the resident portal, wearing a different coat. */
  const queryRef = useRef(query)
  useEffect(() => { queryRef.current = query }, [query])

  // An alert is issued in a control room and matters to a resident *now*. The
  // three tables below are the ones row-level security marks readable by `anon`,
  // which is what lets this work with no account — the same policy that decides
  // what an anonymous query may read decides what an anonymous socket receives.
  const { live } = useLiveSync(["alerts", "incidents", "ward_risks"], () =>
    void load(queryRef.current)
  )

  // One effect, not two. Separately they raced: a position change fired an
  // immediate load *and* tore down and rebuilt the interval, so a held arrow key
  // produced a burst of requests rather than a walk.
  useEffect(() => {
    void load(query)
    const id = setInterval(() => void load(query), pollInterval(live, 4000))
    return () => {
      clearInterval(id)
      active.current?.abort()
    }
  }, [load, query, live])

  useEffect(() => {
    const mark = () => { gestured.current = true }
    window.addEventListener("pointerdown", mark, { once: true })
    window.addEventListener("keydown", mark, { once: true })
    return () => {
      window.removeEventListener("pointerdown", mark)
      window.removeEventListener("keydown", mark)
    }
  }, [])

  // Real GPS if they allow it, arrow keys either way. Declining location is an
  // ordinary choice, not an error state to sit in.
  //
  // `watchPosition`, not `getCurrentPosition`: a device without GPS answers the
  // first call from Wi-Fi and IP trilateration, which is a guess with a radius
  // of kilometres and a different guess every time the page loads. Taking that
  // first answer is what put somebody standing in Alandi at a new random place
  // on each reload. A watch keeps listening, so the coarse fix is replaced the
  // moment a real one arrives instead of being frozen in as the truth.
  useEffect(() => {
    if (!("geolocation" in navigator)) return
    const id = navigator.geolocation.watchPosition(
      (g) => {
        const acc = g.coords.accuracy
        // Every decision on this screen is ward-shaped — which shelter, which
        // hospital, is this road blocked. A fix that cannot say which ward you
        // are in is not a small error, it is a different answer, so it is
        // refused rather than rounded. Wards here run 1-3 km across.
        if (acc > COARSE_FIX_M) {
          setGpsNote(
            `Your device can only place you to about ${Math.round(acc / 1000)} km, ` +
            `which is wider than a ward, so the map is staying in Alandi. ` +
            `Arrow keys move you.`
          )
          return
        }
        // Every fix inside the budget is accepted, including one slightly worse
        // than the last. An "only ever improve" rule looks tempting here and is
        // wrong: after the first good fix it would refuse every later one and
        // freeze somebody in place while they walked, which on this screen is
        // the more dangerous failure.
        setGpsNote(null)
        setPos({ lng: g.coords.longitude, lat: g.coords.latitude })
      },
      (e) => {
        setGpsNote(
          e.code === e.PERMISSION_DENIED
            ? "Location is off, so the map is starting in Alandi. Arrow keys move you."
            : "Your device could not get a location, so the map is starting in Alandi. Arrow keys move you."
        )
      },
      // `maximumAge` lets a fix obtained seconds ago be reused instead of
      // re-triangulating on every reload, which is the other half of why the
      // position moved when the person did not.
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 }
    )
    return () => navigator.geolocation.clearWatch(id)
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
              fileIt: false, cityId: "pune", deviceId: deviceId(),
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

  /** @param fromPerson  They pressed something. An advisory arriving on its own
   *  must not then overrule the destination they chose, so this is what marks
   *  the difference between a route the system offered and one they asked for.
   *
   *  Two things this used to get wrong, both of which ended with somebody under
   *  an advisory and no navigation on screen.
   *
   *  **Asking a question is not choosing a destination.** `chosenByPerson` was
   *  set by any press at all, and the most likely first press on this screen is
   *  "Am I safe?" — which by design answers "stay where you are" and routes
   *  nowhere. From that tap onwards the auto-route was permanently disabled, so
   *  when an advisory did arrive it named a shelter, said "working out the
   *  safest way there", and never worked anything out. It is only a choice if
   *  an actual destination came back.
   *
   *  **A "stay put" answer must not wipe a route somebody is walking.** Tapping
   *  "Am I safe?" halfway to a hospital replaced the live guidance with an
   *  empty one and switched navigation off mid-journey. The answer is worth
   *  showing; it is not worth the route. */
  async function ask(
    intent: string, condition?: string, silent = false, fromPerson = true
  ) {
    lastIntent.current = intent
    if (!silent) setBusy(intent)
    try {
      const g = await request<Guidance>("/citizen/guide", {
        method: "POST",
        body: { lng: pos.lng, lat: pos.lat, intent, condition, cityId: "pune" },
      })
      const movable = Boolean(g.shouldMove && g.route?.length)
      if (fromPerson && movable) chosenByPerson.current = true

      if (!movable && navOn && guide?.route?.length) {
        // Keep the route, show the advice alongside it.
        setAdvice(g.headline)
        return
      }
      setAdvice(null)
      setGuide(g)
      setNavOn(movable)
      routeSolvedAt.current = { lng: pos.lng, lat: pos.lat, hazards: hazardSig, at: Date.now() }
    } catch (e) {
      // A silent re-solve that fails leaves the previous route on screen, which
      // is still the best advice anyone has. Saying "route failed" over working
      // directions would be worse than saying nothing.
      if (!silent) setError(e instanceof Error ? e.message : String(e))
    } finally { if (!silent) setBusy(null) }
  }

  /** Shrink a camera photo to something worth sending.
   *
   *  A modern phone takes a 12-megapixel, four-megabyte image. The model reads
   *  it at 1024 px on the longest edge, so the other three-and-a-half megabytes
   *  are a slower upload over a congested cell in a flood and nothing else. This
   *  runs on the phone, before anything leaves it.
   */
  async function shrink(file: File, maxEdge = 1024): Promise<string> {
    const bitmap = await createImageBitmap(file)
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height))
    const w = Math.round(bitmap.width * scale)
    const h = Math.round(bitmap.height * scale)
    const canvas = document.createElement("canvas")
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext("2d")
    if (!ctx) throw new Error("This browser cannot prepare the photo.")
    ctx.drawImage(bitmap, 0, 0, w, h)
    bitmap.close?.()
    // 0.78 rather than 0.9: at this size the difference is invisible to a
    // person and to the model, and it is a third of the bytes.
    return canvas.toDataURL("image/jpeg", 0.78).split(",")[1] ?? ""
  }

  /** Look at the photo before the report is filed.
   *
   *  Deliberately *before*. The photo can raise or lower how much the report is
   *  trusted, and showing somebody that after they have already sent it is
   *  showing them a verdict rather than their working. It also means an honest
   *  answer is possible when the two disagree: the person can look at what the
   *  model saw and fix the text, which is a correction rather than an argument.
   *
   *  The image does not have to stay. What the server keeps is the assessment,
   *  against a short-lived token; the photo itself is on this phone unless the
   *  reporter uploads it.
   */
  async function attachPhoto(file: File) {
    setError(null)
    setBusy("photo")
    setPhoto(null)
    try {
      const b64 = await shrink(file)
      setPhotoPreview(`data:image/jpeg;base64,${b64}`)
      const r = await request<{
        photoToken: string
        evidence: Omit<PhotoState, "token" | "unanalysed">
      }>("/citizen/vision/analyse", {
        method: "POST",
        body: { imageBase64: b64, category: heard?.readAs ?? "flooded_road" },
      })
      setPhoto({ token: r.photoToken, ...r.evidence })
    } catch (e) {
      // No vision service, or it refused. The photo still counts as a photo —
      // attaching one is itself weak evidence — so the report is not blocked,
      // and the person is told plainly that nobody looked at it.
      setPhoto({ token: null, unanalysed: true })
      setError(
        e instanceof Error && /vision service/i.test(e.message)
          ? "Your photo is attached, but no one has looked at it: photo analysis is not switched on for this deployment. The report goes through either way."
          : e instanceof Error ? e.message : String(e)
      )
    } finally { setBusy(null) }
  }

  function clearPhoto() {
    setPhoto(null)
    setPhotoPreview(null)
    if (photoInput.current) photoInput.current.value = ""
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
        method: "POST",
        body: {
          lng: pos.lng, lat: pos.lat, text, cityId: "pune",
          deviceId: deviceId(),
          photoToken: photo?.token ?? undefined,
          // A photo nobody could look at is still a photo. The trust model
          // scores "attached an image" separately from "the image agreed", so
          // saying so is worth a little rather than nothing.
          photoUrl: photo?.unanalysed ? "device://photo" : undefined,
        },
      })
      setFiled(r)
      setText("")
      clearPhoto()
      // A queued report is a 202 from the service worker, not a 200 from the
      // API. It carries none of the fields a filed report does — no category it
      // was read as, no trust score, no summary — so the receipt below used to
      // render as an empty success box: the worst possible answer, because it
      // looks exactly like it worked. Reloading the world would be wrong too;
      // there is no world to reload.
      if (!(r as { queued?: boolean }).queued) await load(pos)
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
   *
   *  `routedFor` was not enough on its own, and the reason is worth writing
   *  down. The alert list is "the ten most recent advisories near you", so
   *  during a live flood its first element changes every time the city issues
   *  one anywhere nearby — a different id each time, none of it about this
   *  person. Each change looked like a new advisory, re-solved the route, and
   *  put the turn-by-turn back at step one. Somebody halfway to a hospital was
   *  being marched back to a shelter every couple of minutes.
   *
   *  Two guards fix it. Every alert id ever routed for is remembered, not just
   *  the last, so an older advisory rotating back to the top is not mistaken
   *  for a new one. And once the person has chosen a destination themselves,
   *  an advisory no longer overrides it: they know something the alert does
   *  not, which is where they are going.
   */
  const routedAlerts = useRef<Set<string>>(new Set())
  const chosenByPerson = useRef(false)

  useEffect(() => {
    const alert = state?.alerts?.[0]
    if (!alert) return
    // `inside` means inside the wards this deployment scores. An advisory that
    // has already picked a shelter for you does not need that check as well:
    // standing just past a ward boundary is not a reason to be told a shelter
    // exists and then shown no way to it. Without a named safe location the
    // check still holds, because outside the covered area there is nothing to
    // route against.
    if (!state?.inside && !alert.safeLocation) return
    if (routedAlerts.current.has(alert.id)) return
    routedAlerts.current.add(alert.id)
    if (routedFor.current === alert.id) return
    routedFor.current = alert.id
    // They picked a destination. Leave it alone.
    if (chosenByPerson.current) return
    void ask("shelter", undefined, false, false)
    // `ask` is stable enough for this: it closes over `pos`, and routing from
    // the position held when the advisory arrived is correct — the turn-by-turn
    // below re-projects against live position from there.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.alerts?.[0]?.id, state?.inside])

  /** The hazard picture the route was solved against, as a comparable string.
   *
   *  A route is only as current as the obstacles it avoided. If a crew closes a
   *  street after somebody set off along it, the line on their screen is now
   *  advice to walk into the thing it was drawn to avoid — and nothing about
   *  their own movement would reveal that. Road blocks are what the router
   *  actually routes around; incident severity is included because a category
   *  worsening is what turns a passable street into a closed one.
   */
  /** Only the hazards that could actually affect *this* route count.
   *
   *  The first version of this signed every incident within the four-kilometre
   *  radius, severity included. That is a couple of dozen rows in a busy city
   *  and at least one of them changes on almost every four-second poll, so the
   *  signature was never equal to itself twice, "conditions changed" was always
   *  true, and the route re-solved roughly as often as the cooldown allowed —
   *  which is the jump back to step one that made navigation unusable.
   *
   *  A hazard matters to a route if it is near the line you are being asked to
   *  walk. Everything else is news, not an obstruction. So: keep road blocks
   *  and incidents within a corridor of the route, and round severity into
   *  passable / impassable rather than tracking 1-to-5, because a flooded road
   *  going from severity 2 to 3 does not change whether you should walk down
   *  it and re-routing somebody over it is worse than leaving them alone.
   */
  const CORRIDOR_M = 250
  const hazardSig = useMemo(() => {
    const route = guide?.route
    const near = (p: [number, number]) => {
      if (!route?.length) return true // No route yet: everything is relevant.
      for (const q of route) {
        // Rough metres. Precision is not the point — the corridor is.
        const dx = (p[0] - q[0]) * 111_320 * Math.cos((p[1] * Math.PI) / 180)
        const dy = (p[1] - q[1]) * 110_540
        if (dx * dx + dy * dy <= CORRIDOR_M * CORRIDOR_M) return true
      }
      return false
    }
    return [
      ...(state?.roadBlocks ?? [])
        .filter((b) => near(b.location as [number, number]))
        .map((b) => `b${b.id}`),
      ...(state?.incidents ?? [])
        .filter((i) => near(i.location as [number, number]))
        // Two buckets, not five. Only a crossing of the impassable line is a
        // reason to redraw a route somebody is already walking.
        .map((i) => `i${i.id}:${i.severity >= 4 ? "x" : "o"}`),
    ]
      .sort()
      .join("|")
  }, [state?.roadBlocks, state?.incidents, guide?.route])

  const sev = state?.risk?.severity ?? 0
  /** Undefined means an older server that does not report its capabilities; the
   *  button stays enabled there, which is the behaviour that existed before. */
  const voiceOff = state?.capabilities?.voice === false

  /** Recomputed on every position change, which is what makes it navigation
   *  rather than a printed list of directions. */
  const nav = (() => {
    if (!navOn || !guide?.route?.length) return null
    const { travelled, offBy, total } = progressAlong(guide.route, [pos.lng, pos.lat])
    /** No steps is not a reason to show no navigation.
     *
     *  It used to be. A router that returns geometry without instructions —
     *  OSRM answered that way until it was asked for steps, and the
     *  straight-line fallback has none by nature — made `routeSteps` empty, and
     *  an empty list took this whole block to null. The result on a phone was a
     *  line on a map, a distance, and nothing that told anybody to move: the
     *  progress along it, the distance left, the off-route warning and the
     *  arrival check-in were all switched off together, because one field was
     *  missing.
     *
     *  So: fall back to a single step covering the whole line. Distance
     *  remaining, straying and arrival all keep working off the geometry, which
     *  is what they were actually measuring all along. */
    const steps = guide.routeSteps?.length
      ? guide.routeSteps
      : [{
          instruction: `Follow the line to ${guide.destination?.name ?? "the destination"}.`,
          street: "",
          distanceM: Math.round(total),
        }]
    const cur = currentStep(steps, travelled)
    if (!cur) return null
    return {
      ...cur,
      offBy: Math.round(offBy),
      remainingM: Math.max(0, Math.round(total - travelled)),
      arrived: total - travelled < 40,
      strayed: offBy > 120,
    }
  })()

  /** Keep the route true while the world and the person both move.
   *
   *  Until now the route was solved once when the advisory arrived and then
   *  never again: `progressAlong` re-projected the person onto a fixed line, so
   *  the instructions stayed live while the *path* went stale. Two things make
   *  it stale, and only one of them is the person moving.
   *
   *    * They have left the line. Walking round a flooded corner is not being
   *      lost, so this waits for a real departure rather than GPS wobble.
   *    * The hazards changed. A street closed behind them, or an incident got
   *      worse. Nothing they do reveals this and it is the more dangerous of
   *      the two, so it re-solves sooner rather than waiting for drift.
   *
   *  A cooldown sits over both. `/citizen/guide` costs about two seconds and
   *  calls Mapbox Directions; re-solving on every four-second poll would spend
   *  somebody's battery and data to redraw the same line.
   */
  useEffect(() => {
    if (!navOn || !nav || !guide?.route?.length) return
    if (nav.arrived) return

    const solved = routeSolvedAt.current
    if (!solved) return

    const hazardsChanged = solved.hazards !== hazardSig
    // 150 m, a little past the 120 m the screen already calls "off this route",
    // so the advice and the automatic re-solve do not contradict each other.
    const strayed = nav.offBy > 150
    if (!hazardsChanged && !strayed) return

    // A changed hazard picture is worth interrupting for; drift is not.
    const cooldownMs = hazardsChanged ? 8000 : 20000
    if (Date.now() - solved.at < cooldownMs) return

    setRerouted(
      hazardsChanged
        ? "Conditions changed. This route has been redrawn."
        : "You had left the route. It has been redrawn from where you are."
    )
    void ask(lastIntent.current, undefined, true, false)
    // `ask` and `nav` are rebuilt every render by design; the guard above is
    // what decides when this fires, not the dependency list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navOn, nav?.offBy, nav?.arrived, hazardSig, guide?.route?.length])

  /** Arriving is an event the shelter needs to know about.
   *
   *  A route that ends and tells nobody is the whole coordination problem in
   *  miniature. The control room's occupancy figure is otherwise a model of a
   *  crowd, and a model is what it stays even while real people are walking
   *  through the door — so a centre could read "820 of 1,200" on the console
   *  with a queue outside it. This is the one place the system can replace an
   *  estimate with a fact, and it costs one request.
   *
   *  Once per destination, guarded on the facility id rather than on `arrived`,
   *  because `nav` is rebuilt on every position change and GPS jitter around
   *  the door would otherwise check the same family in a dozen times.
   */
  const arrivedAt = useRef<string | null>(null)
  const [arrival, setArrival] = useState<
    { name: string; occupancy: number; capacity: number; turnedAway: number } | null
  >(null)

  useEffect(() => {
    const dest = guide?.destination
    if (!navOn || !nav?.arrived || !dest?.id) return
    if (arrivedAt.current === dest.id) return
    arrivedAt.current = dest.id
    void (async () => {
      try {
        const r = await request<{
          name: string; occupancy: number; capacity: number
          turnedAway: number; admitted: number
        }>("/citizen/arrived", {
          method: "POST",
          body: { lifelineId: dest.id, partySize },
        })
        setArrival({
          name: r.name, occupancy: r.occupancy,
          capacity: r.capacity, turnedAway: r.turnedAway,
        })
        // If it turned out to be full, the honest next move is to route again
        // rather than leave somebody standing at a closed door.
        if (r.turnedAway > 0) void ask(lastIntent.current, undefined, false, false)
        await load(pos)
      } catch {
        // Failing to record an arrival must never look like failing to arrive.
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navOn, nav?.arrived, guide?.destination?.id])

  // The re-route notice is an explanation, not a state to sit in.
  useEffect(() => {
    if (!rerouted) return
    const id = setTimeout(() => setRerouted(null), 6000)
    return () => clearTimeout(id)
  }, [rerouted])

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

      {/* The three things somebody in water actually came here to do.
       *
       *  They used to be below the map, which on a phone means below the fold:
       *  a person standing in a flooded street had to scroll past a map they
       *  cannot read one-handed to find the microphone. Nothing else on this
       *  screen is an action, so nothing else competes for the top of it.
       *
       *  Sticky, because the one time this matters is the one time the person
       *  has already scrolled. */}
      <div className="bg-background/95 sticky top-0 z-20 -mx-4 grid grid-cols-3 gap-2 px-4 py-2 backdrop-blur">
        <Button
          type="button"
          size="lg"
          variant={sev >= 4 || state?.alerts?.length ? "destructive" : "default"}
          className="h-14 flex-col gap-0.5 text-xs"
          disabled={busy === "shelter"}
          onClick={() => void ask("shelter")}
        >
          {busy === "shelter" ? (
            <Loader2 className="size-5 animate-spin" />
          ) : (
            <Navigation className="size-5" />
          )}
          Where do I go
        </Button>
        <Button
          type="button"
          size="lg"
          variant={recording ? "destructive" : "secondary"}
          className="h-14 flex-col gap-0.5 text-xs"
          disabled={busy === "voice" || voiceOff}
          // Hold to talk, exactly as the card below does it — the same handlers,
          // not a second recorder, so there is one answer to "am I recording".
          onPointerDown={() => { if (!recording && !voiceOff) void startRecording() }}
          onPointerUp={() => { if (recording) stopRecording() }}
          onPointerLeave={() => { if (recording) stopRecording() }}
        >
          {busy === "voice" ? (
            <Loader2 className="size-5 animate-spin" />
          ) : recording ? (
            <Square className="size-5" />
          ) : (
            <Mic className="size-5" />
          )}
          {recording ? "Release to stop" : voiceOff ? "Voice is off" : "Hold to talk"}
        </Button>
        <Button
          type="button"
          size="lg"
          variant="secondary"
          className="h-14 flex-col gap-0.5 text-xs"
          disabled={busy === "photo"}
          onClick={() => photoInput.current?.click()}
        >
          {busy === "photo" ? (
            <Loader2 className="size-5 animate-spin" />
          ) : (
            <Camera className="size-5" />
          )}
          {photo ? "Change photo" : "Take a photo"}
        </Button>
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
            {/* Never a dead end. If the automatic route did not happen — the
                person had already chosen somewhere, the guidance call failed,
                they pressed stop — an advisory naming a shelter still has one
                press between it and directions. This banner used to say
                "working out the safest way there" and offer nothing. */}
            {state.alerts[0].safeLocation && !navOn && (
              <button
                type="button"
                className="mt-2 rounded-md bg-background/90 px-3 py-1.5 text-sm font-medium text-foreground disabled:opacity-60"
                disabled={busy === "shelter"}
                onClick={() => void ask("shelter")}
              >
                {busy === "shelter" ? "Finding the way…" : "Take me there"}
              </button>
            )}
          </AlertDescription>
        </Alert>
      )}

      <OfflineBar manifest="/manifest.webmanifest" />

      {staleSince !== null && (
        <Alert className="border-amber-500/40 bg-amber-500/10 py-2">
          <AlertDescription className="text-xs">
            This is the last map this phone managed to fetch
            {Date.now() - staleSince > 60_000
              ? `, about ${Math.round((Date.now() - staleSince) / 60_000)} minute(s) ago`
              : ""}
            . Roads close faster than that, so treat closures as the minimum
            rather than the whole picture.
          </AlertDescription>
        </Alert>
      )}

      {/* The report box, above the map.
       *
       *  It was in the right-hand column, and on a phone that column stacks
       *  *after* the map — so a resident had to scroll past a full-height map
       *  they cannot read one-handed to reach a text box and a Send button.
       *  Moving the three action buttons up fixed reaching the microphone and
       *  not this; typing is what most people do, and it was still below the
       *  fold. */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Tell us what you can see</CardTitle>
          <CardDescription>
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
            disabled={busy === "voice" || voiceOff}
            onPointerDown={() => { if (!recording && !voiceOff) void startRecording() }}
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
          {voiceOff && (
            <p className="text-muted-foreground text-xs">
              Speaking a report is not switched on for this deployment, so
              type it instead. Everything after the words is identical —
              spoken reports go through the same parser and the same
              scoring.
            </p>
          )}

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
            className="text-base"
          />

          {/* A photo, if there is one to take.
              `capture="environment"` opens the rear camera straight away on
              a phone and is ignored on a laptop, where it falls back to a
              file picker — which is the right behaviour in both places
              without asking which one you are on. */}
          <input
            ref={photoInput}
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void attachPhoto(f)
            }}
          />
          <Button
            type="button"
            variant="secondary"
            className="w-full"
            disabled={busy === "photo"}
            onClick={() => photoInput.current?.click()}
            title={
              state?.capabilities?.vision === false
                ? "Your photo will be attached, but no model will look at it here."
                : undefined
            }
          >
            {busy === "photo" ? (
              <><Loader2 className="size-4 animate-spin" /> Looking at the photo…</>
            ) : (
              <><Camera className="size-4" /> {photo ? "Change photo" : "Add a photo"}</>
            )}
          </Button>

          {photoPreview && (
            <div className="space-y-2 rounded border p-2">
              <div className="flex items-start gap-2">
                <img
                  src={photoPreview}
                  alt="The photo attached to this report"
                  className="size-20 shrink-0 rounded object-cover"
                />
                <div className="min-w-0 flex-1 space-y-1 text-xs">
                  {photo?.unanalysed ? (
                    <p className="text-muted-foreground">
                      Attached. Nobody has looked at it — photo analysis is
                      not switched on here — so it counts for a little and
                      not for much.
                    </p>
                  ) : photo ? (
                    <>
                      {/* What the model saw, said plainly, before the
                          report goes. The agreement number is the whole
                          point: a photo that backs the text raises how much
                          this report is trusted, one that contradicts it
                          lowers it, and either way the person gets to see
                          that and fix their wording first. */}
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Badge
                          variant={
                            (photo.agreement ?? 0) > 0.15
                              ? "default"
                              : (photo.agreement ?? 0) < -0.15
                                ? "destructive"
                                : "outline"
                          }
                        >
                          {(photo.agreement ?? 0) > 0.15
                            ? "Backs up what you wrote"
                            : (photo.agreement ?? 0) < -0.15
                              ? "Does not match what you wrote"
                              : "Adds little either way"}
                        </Badge>
                        {photo.lifeSafetySignal && (
                          <Badge variant="destructive">People visible</Badge>
                        )}
                        {photo.water?.depthBand && (
                          <Badge variant="outline">
                            water {photo.water.depthBand}
                          </Badge>
                        )}
                      </div>
                      {photo.hazards?.length ? (
                        <p className="text-muted-foreground">
                          Seen in the photo: {photo.hazards.join(", ")}.
                        </p>
                      ) : (
                        <p className="text-muted-foreground">
                          Nothing it recognises as a hazard.
                        </p>
                      )}
                      {photo.imageQuality && photo.imageQuality !== "good" && (
                        <p className="text-muted-foreground">
                          The image is {photo.imageQuality}, so this counts
                          for less.
                        </p>
                      )}
                      <p className="text-muted-foreground">
                        A photo can only raise or lower how much your report
                        is believed. It never decides what happens next.
                      </p>
                    </>
                  ) : null}
                </div>
              </div>
              <button
                type="button"
                className="text-muted-foreground text-xs underline"
                onClick={clearPhoto}
              >
                Remove photo
              </button>
            </div>
          )}
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
          {filed?.queued ? (
            <div className="space-y-1 rounded border border-amber-500/40 bg-amber-500/10 p-2 text-xs">
              <div className="font-medium">Saved on this phone.</div>
              <div className="text-muted-foreground">
                {String(
                  filed.message ??
                    "There is no signal right now. It sends itself the moment there is."
                )}
              </div>
              <div className="text-muted-foreground">
                It will be timed from now, not from when it finally sends, so
                nothing is lost by the wait.
              </div>
            </div>
          ) : filed ? (
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
              {filed.photo != null && (
                <div className="text-muted-foreground">
                  Your photo was taken into account when scoring this report.
                </div>
              )}
            </div>
          ) : null}
        </CardContent>
      </Card>

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
                zoom={14.3}
                followMe
                recentreKey={recentre}
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
                          onClick={() => setRecentre((n) => n + 1)}>
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
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-sm">
                <Compass className="size-4" /> Where should I go?
              </CardTitle>
              <CardDescription>
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
                            onClick={() => { setNavOn(false); setAdvice(null) }}>
                      Stop
                    </button>
                  </div>

                  {nav.arrived ? (
                    <>
                      <p className="text-base font-semibold">
                        You have arrived at {guide?.destination?.name ?? "your destination"}.
                      </p>
                      {/* What the building now knows, said back to the person
                          who changed it. Somebody who has just walked two
                          kilometres in the rain deserves confirmation that it
                          counted, and the control room is reading the same
                          number at the same moment. */}
                      {arrival && (
                        <p className="text-muted-foreground text-xs tabular-nums">
                          {arrival.turnedAway > 0 ? (
                            <>
                              {arrival.name} is full. {arrival.turnedAway} of your
                              party could not be taken in — finding you somewhere
                              else now.
                            </>
                          ) : (
                            <>
                              Checked in. {arrival.name} now holds{" "}
                              {arrival.occupancy.toLocaleString()}
                              {arrival.capacity
                                ? ` of ${arrival.capacity.toLocaleString()}`
                                : ""}
                              .
                            </>
                          )}
                        </p>
                      )}
                    </>
                  ) : (
                    <>
                      {/* Asked before arrival, not after, because at the door
                          nobody is looking at a phone. One phone is usually a
                          family and a shelter counting handsets rather than
                          heads runs out sooner than its own figures say. */}
                      <div className="flex items-center gap-2 text-xs">
                        <span className="text-muted-foreground">People with you</span>
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            className="size-6 rounded border tabular-nums disabled:opacity-40"
                            disabled={partySize <= 1}
                            onClick={() => setPartySize((n) => Math.max(1, n - 1))}
                            aria-label="One fewer"
                          >
                            −
                          </button>
                          <span className="w-6 text-center tabular-nums">{partySize}</span>
                          <button
                            type="button"
                            className="size-6 rounded border tabular-nums disabled:opacity-40"
                            disabled={partySize >= 20}
                            onClick={() => setPartySize((n) => Math.min(20, n + 1))}
                            aria-label="One more"
                          >
                            +
                          </button>
                        </div>
                      </div>
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
                  {/* The route redrew itself. Said out loud, because a line
                      that moves on its own otherwise reads as a glitch and
                      somebody may keep following the one they memorised. */}
                  {rerouted && !nav.arrived && (
                    <Alert className="py-2">
                      <AlertDescription className="text-xs">{rerouted}</AlertDescription>
                    </Alert>
                  )}

                  {/* They asked something while walking and the answer was
                      "stay put". Worth saying, not worth their directions. */}
                  {advice && !nav.arrived && (
                    <Alert className="py-2">
                      <AlertDescription className="text-xs">
                        {advice} Your route to{" "}
                        {guide?.destination?.name ?? "the destination"} is still
                        on screen.
                      </AlertDescription>
                    </Alert>
                  )}

                  {/* Being off the line is not a failure, but it does mean the
                      instruction above is about a street you are not on. Hidden
                      while the automatic re-solve is handling it, so the screen
                      never asks for something it is already doing. */}
                  {nav.strayed && !nav.arrived && !rerouted && (
                    <Alert variant="destructive" className="py-2">
                      <AlertDescription className="text-xs">
                        You are about {readable(nav.offBy)} off this route.
                        Redrawing it from where you are now.
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


          {/* The resident account, on the resident's screen. Nothing here
              requires an account, so this is for the person being handed a
              tablet who wants the signed-in version with a report history. */}
          <DemoCredentials
            portal="citizen"
            title="Demo resident sign-in (optional)"
          />

          {state?.risk && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Why this area is rated as it is</CardTitle>
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
