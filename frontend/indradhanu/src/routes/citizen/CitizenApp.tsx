import { useCallback, useEffect, useState } from "react"
import {
  AlertTriangle, Compass, Hospital, Loader2, Navigation, Send, ShieldCheck, Siren,
} from "lucide-react"
import { request } from "@/api/httpClient"
import { LiveMap } from "@/components/map/LiveMap"
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
  categories: { id: string; label: string; lifeSafety: boolean }[]
}

type Guidance = {
  intent: string; headline: string; shouldMove: boolean
  reasoning: string[]; warnings: string[]
  destination: { name: string; kind: string; why: string[]; distance_km: number } | null
  alternatives: { name: string; why: string[] }[]
  route: number[][]; routeKm: number; routeMinutes: number
  routeEngine: string; hazardsConsidered: number
}

const STEP = 0.0035
const ALANDI: [number, number] = [73.8989, 18.6773]

export default function CitizenApp() {
  const [pos, setPos] = useState<{ lng: number; lat: number }>({ lng: ALANDI[0], lat: ALANDI[1] })
  const [state, setState] = useState<State | null>(null)
  const [guide, setGuide] = useState<Guidance | null>(null)
  const [text, setText] = useState("")
  const [busy, setBusy] = useState<string | null>(null)
  const [filed, setFiled] = useState<Record<string, unknown> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [gpsNote, setGpsNote] = useState<string | null>(null)

  const load = useCallback(async (p: { lng: number; lat: number }) => {
    try {
      setState(await request<State>("/citizen/state", {
        query: { lng: p.lng, lat: p.lat, cityId: "pune" },
      }))
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
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

  async function ask(intent: string, condition?: string) {
    setBusy(intent)
    try {
      setGuide(await request<Guidance>("/citizen/guide", {
        method: "POST",
        body: { lng: pos.lng, lat: pos.lat, intent, condition, cityId: "pune" },
      }))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally { setBusy(null) }
  }

  async function fileReport() {
    if (!text.trim()) return
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

  const sev = state?.risk?.severity ?? 0

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

      {state?.alerts?.[0] && (
        <Alert variant="destructive">
          <Siren className="size-4" />
          <AlertDescription>
            <div className="font-medium">{state.alerts[0].headline}</div>
            <div className="text-sm">{state.alerts[0].action}</div>
          </AlertDescription>
        </Alert>
      )}

      <div className="grid gap-3 lg:grid-cols-[1fr_360px]">
        <div className="space-y-3">
          <LiveMap
            className="h-[460px] w-full rounded-lg border"
            wards={[]}
            incidents={state?.incidents ?? []}
            resources={state?.unitsNearby?.map((u) => ({ ...u, capabilities: [] })) ?? []}
            facilities={state?.facilities ?? []}
            route={guide?.route}
            me={{ lng: pos.lng, lat: pos.lat, label: "You" }}
            center={[pos.lng, pos.lat]}
            zoom={13.5}
            followMe
          />
          <p className="text-muted-foreground text-xs">
            Arrow keys or WASD move you. Green line is the route the agent
            recommends. Red dots are open incidents.
          </p>
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
              </div>

              {guide && (
                <div className="space-y-2 rounded border p-2">
                  <p className="text-sm font-medium">{guide.headline}</p>
                  {guide.shouldMove && guide.destination && (
                    <div className="text-muted-foreground text-xs">
                      {guide.routeKm} km · about {guide.routeMinutes} min ·{" "}
                      {guide.routeEngine === "osrm" ? "road route" : "straight-line estimate"}
                      {guide.hazardsConsidered > 0 &&
                        ` · ${guide.hazardsConsidered} hazard(s) taken into account`}
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
                Type it however you like, in English, Hindi or Marathi. No account needed.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              <Textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="रस्त्यावर पाणी आले आहे / water on the road, cannot cross"
                rows={3}
              />
              <Button className="w-full" onClick={fileReport}
                      disabled={busy !== null || !text.trim() || !state?.inside}>
                {busy === "report" ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
                Send report
              </Button>
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
