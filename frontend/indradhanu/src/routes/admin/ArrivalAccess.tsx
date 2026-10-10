import { useEffect, useMemo, useRef, useState } from "react"
import mapboxgl from "mapbox-gl"
import { Ambulance, Box, Flame, Footprints, Info, Map as MapIcon, RefreshCw } from "lucide-react"
import { request } from "@/api/httpClient"
import { useDemo } from "@/routes/demo/DemoProvider"
import { Segmented } from "@/components/common/MacControls"
import { StatCard } from "@/components/common/StatCard"
import { ribbon, setSource, useMapbox } from "@/components/map/useMapbox"
import { cn } from "@/lib/utils"

/** Road access at the moment a unit arrives (MISC-04, Addition 2).
 *
 *  The passability model scores every PCMC road the live evidence touches for
 *  one unit class (ambulance 0.3 m, fire tender 0.6 m, a resident on foot
 *  0.2 m) and one arrival time (+30/60/90 min). "Now" is the baseline the brief
 *  asks for: what the current-status rule calls blocked right now. In 3D each
 *  road is raised by its probability, with a translucent band up to the
 *  ensemble's pessimistic estimate (p + 2 sd): the taller and wider the band,
 *  the less sure the model is. */

type Profile = "ambulance" | "fire_engine" | "resident"
type When = "now" | "30" | "60" | "90"
type Props = { seg: string; p: number; sd: number; lo: number; hi: number; why: string; now: boolean; avoid: boolean; underpass: boolean; bridge: boolean }
type Arrival = {
  available: boolean; reason?: string; model?: string; computedAt?: number; notes?: string[]
  scored?: number; blockedNow?: number; predictedBlocked?: number; closingBeforeArrival?: number; uncertain?: number
  avoidAt?: number
  segments?: GeoJSON.FeatureCollection<GeoJSON.LineString, Props>
}

const PROFILE: Record<Profile, { label: string; limit: string; icon: typeof Ambulance }> = {
  ambulance: { label: "Ambulance", limit: "0.3 m", icon: Ambulance },
  fire_engine: { label: "Fire tender", limit: "0.6 m", icon: Flame },
  resident: { label: "On foot", limit: "0.2 m", icon: Footprints },
}
const HEIGHT_M = 260
const RAMP: mapboxgl.Expression = ["interpolate", ["linear"], ["get", "c"], 0.1, "#9db8f0", 0.3, "#f2c14e", 0.6, "#ec835a", 0.85, "#d03b3b"]

export default function ArrivalAccess() {
  const { state } = useDemo()
  const [profile, setProfile] = useState<Profile>("ambulance")
  const [when, setWhen] = useState<When>("30")
  const [three, setThree] = useState(true)
  const [data, setData] = useState<Arrival | null>(null)
  const [trend, setTrend] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(false)
  const [tick, setTick] = useState(0)
  const { ref, map, ready, failed } = useMapbox({ center: [73.8, 18.63], zoom: 12.4, pitch: 55 })
  const popup = useRef<mapboxgl.Popup | null>(null)

  // the selected view
  useEffect(() => {
    let alive = true
    setLoading(true)
    const h = when === "now" ? "30" : when
    request<Arrival>(`/nav/arrival?profile=${profile}&horizon=${h}&min_p=0.15`, { toast: false })
      .then((d) => alive && setData(d))
      .catch((e) => alive && setData({ available: false, reason: String((e as Error).message ?? e) }))
      .finally(() => alive && setLoading(false))
    return () => { alive = false }
  }, [profile, when, tick])

  // predicted-blocked counts at each horizon, for the trend strip
  useEffect(() => {
    let alive = true
    Promise.all(["30", "60", "90"].map((h) =>
      request<Arrival>(`/nav/arrival?profile=${profile}&horizon=${h}&min_p=0.15&segments=false`, { toast: false })
        .then((d) => [h, d.predictedBlocked ?? 0] as const).catch(() => [h, 0] as const)))
      .then((rows) => alive && setTrend(Object.fromEntries(rows)))
    return () => { alive = false }
  }, [profile, tick])

  // refresh with the live evidence (the server re-scores every few minutes)
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 120_000)
    return () => clearInterval(id)
  }, [])

  const features = useMemo(() => {
    const all = data?.segments?.features ?? []
    return when === "now" ? all.filter((f) => f.properties.now) : all
  }, [data, when])

  // draw
  useEffect(() => {
    const m = map.current
    if (!m || !ready) return
    const lines: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: features.map((f) => ({
      ...f, properties: { ...f.properties, c: when === "now" ? 1 : f.properties.p, mode: when },
    })) }
    const ribbons: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: three ? features.map((f) => ({
      type: "Feature", geometry: ribbon(f.geometry.coordinates as [number, number][], 7),
      properties: { ...f.properties, c: when === "now" ? 1 : f.properties.p, mode: when, h: (when === "now" ? 1 : f.properties.p) * HEIGHT_M,
                    hi: (when === "now" ? 1 : f.properties.hi) * HEIGHT_M },
    })) : [] }
    setSource(m, "arr-lines", lines)
    setSource(m, "arr-ribbons", ribbons)
    if (!m.getLayer("arr-line")) {
      m.addLayer({ id: "arr-line", type: "line", source: "arr-lines",
        paint: { "line-color": RAMP, "line-width": ["interpolate", ["linear"], ["zoom"], 11, 1.5, 15, 5], "line-opacity": 0.9 },
        layout: { "line-cap": "round" } })
      m.addLayer({ id: "arr-uncertain", type: "line", source: "arr-lines",
        filter: ["all", ["!=", ["get", "mode"], "now"], [">=", ["get", "hi"], 0.6], ["<", ["get", "p"], 0.6]],
        paint: { "line-color": "#ec835a", "line-width": ["interpolate", ["linear"], ["zoom"], 11, 1, 15, 3], "line-dasharray": [1.5, 1.5], "line-offset": 3 } })
      m.addLayer({ id: "arr-band", type: "fill-extrusion", source: "arr-ribbons",
        paint: { "fill-extrusion-color": "#ec835a", "fill-extrusion-base": ["get", "h"], "fill-extrusion-height": ["get", "hi"], "fill-extrusion-opacity": 0.22 } })
      m.addLayer({ id: "arr-volume", type: "fill-extrusion", source: "arr-ribbons",
        paint: { "fill-extrusion-color": RAMP, "fill-extrusion-height": ["get", "h"], "fill-extrusion-base": 0, "fill-extrusion-opacity": 0.85 } })
      const show = (e: mapboxgl.MapLayerMouseEvent) => {
        const f = e.features?.[0]
        if (!f) return
        const p = f.properties as unknown as Props & { mode: string }
        m.getCanvas().style.cursor = "pointer"
        popup.current ??= new mapboxgl.Popup({ closeButton: false, closeOnClick: false, offset: 10, className: "indra-pop", maxWidth: "300px" })
        const pct = (x: number) => `${Math.round(Number(x) * 100)}%`
        popup.current.setLngLat(e.lngLat).setHTML(
          (p.mode === "now"
            ? `<div class="ip-title">Blocked now (current status)</div><div class="ip-sub">model at +30 min: ${pct(p.p)}</div>`
            : `<div class="ip-title">${pct(p.p)} chance blocked at +${p.mode} min</div>`) +
          `<div class="ip-sub">likely range ${pct(p.lo)}–${pct(p.hi)} · ${String(p.why)}</div>` +
          `<div class="ip-hr"></div>` +
          `<div class="ip-row"><span>Right now (current status)</span><span>${String(p.now) === "true" ? "blocked" : "open"}</span></div>` +
          `<div class="ip-row"><span>Router</span><span>${String(p.avoid) === "true" ? "avoids this road" : "may use it"}</span></div>` +
          (String(p.underpass) === "true" ? `<div class="ip-row"><span>Road</span><span>underpass</span></div>` : "") +
          (String(p.bridge) === "true" ? `<div class="ip-row"><span>Road</span><span>bridge</span></div>` : ""),
        ).addTo(m)
      }
      const hide = () => { m.getCanvas().style.cursor = ""; popup.current?.remove() }
      for (const id of ["arr-line", "arr-volume"]) {
        m.on("mousemove", id, show)
        m.on("mouseleave", id, hide)
      }
    }
    m.easeTo({ pitch: three ? 55 : 0, duration: 600 })
  }, [features, three, ready, map, when])

  // incidents and units for context
  useEffect(() => {
    const m = map.current
    if (!m || !ready) return
    const pts: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [
      ...state.incidents.filter((i) => !/resolved|closed|cancel/i.test(i.status)).map((i) => ({
        type: "Feature" as const, geometry: { type: "Point" as const, coordinates: i.location }, properties: { k: "incident", sev: i.severity } })),
      ...state.resources.map((r) => ({
        type: "Feature" as const, geometry: { type: "Point" as const, coordinates: r.location }, properties: { k: "unit", busy: !!r.incidentId } })),
    ] }
    setSource(m, "arr-ctx", pts)
    if (!m.getLayer("arr-ctx")) {
      m.addLayer({ id: "arr-ctx", type: "circle", source: "arr-ctx", paint: {
        "circle-radius": ["case", ["==", ["get", "k"], "incident"], 6, 4],
        "circle-color": ["case", ["==", ["get", "k"], "incident"], "#d03b3b", ["get", "busy"], "#3b6fe0", "#ffffff"],
        "circle-stroke-color": ["case", ["==", ["get", "k"], "incident"], "#ffffff", "#3b6fe0"],
        "circle-stroke-width": 1.5,
      } })
    }
  }, [state.incidents, state.resources, ready, map])

  const P = PROFILE[profile]
  const maxTrend = Math.max(1, ...Object.values(trend))

  return (
    <div className="space-y-8 p-5 md:p-8 xl:px-10">
      <p className="max-w-3xl text-sm text-muted-foreground">
        Whether each road will still be passable <b className="font-medium text-foreground">when the unit gets there</b>, for
        one kind of unit and one arrival time, from the passability model on the live evidence. <b className="font-medium text-foreground">Now</b> is
        the current-status baseline. In 3D, height is the chance a road is blocked and the faint band above it is how unsure the model is.
      </p>

      <div className="grid gap-5 xl:grid-cols-[1fr_360px]">
        <div className="relative h-[68vh] min-h-[520px] overflow-hidden rounded-2xl border shadow-card">
          <div className="absolute inset-0"><div ref={ref} className="h-full w-full" /></div>
          {failed && (
            <div className="absolute inset-0 grid place-items-center bg-muted/80 p-6 text-center text-sm text-muted-foreground">{failed}</div>
          )}
          <div className="pointer-events-none absolute inset-x-0 top-0 flex flex-wrap items-start gap-2 p-3">
            <div className="pointer-events-auto flex flex-wrap items-center gap-2 rounded-2xl border bg-card/95 p-2 shadow-md backdrop-blur">
              <Segmented size="sm" value={profile} onChange={setProfile} ariaLabel="Unit"
                options={(Object.keys(PROFILE) as Profile[]).map((k) => ({ value: k, label: PROFILE[k].label, icon: PROFILE[k].icon, title: `water limit ${PROFILE[k].limit}` }))} />
              <Segmented size="sm" value={when} onChange={setWhen} ariaLabel="Arrival time"
                options={[{ value: "now", label: "Now" }, { value: "30", label: "+30 min" }, { value: "60", label: "+60 min" }, { value: "90", label: "+90 min" }]} />
              <Segmented size="sm" value={three ? "3d" : "2d"} onChange={(v) => setThree(v === "3d")} ariaLabel="View"
                options={[{ value: "2d", label: "2D", icon: MapIcon }, { value: "3d", label: "3D", icon: Box }]} />
            </div>
          </div>
          <div className="pointer-events-none absolute bottom-3 left-3 rounded-xl border bg-card/95 px-3 py-2 text-[11px] shadow-sm backdrop-blur">
            <div className="mb-1 font-medium">Chance blocked at arrival</div>
            <div className="h-2 w-44 rounded-full" style={{ background: "linear-gradient(90deg,#9db8f0,#f2c14e,#ec835a,#d03b3b)" }} />
            <div className="mt-0.5 flex w-44 justify-between text-muted-foreground"><span>15%</span><span>30%</span><span>60% avoided</span><span>85%</span></div>
            <div className="mt-1.5 flex items-center gap-1.5 text-muted-foreground">
              <span className="h-0 w-5 border-t-2 border-dashed border-[#ec835a]" /> uncertain: could cross 60%
            </div>
          </div>
          {loading && (
            <div className="absolute right-14 top-3 rounded-lg border bg-card/95 px-2.5 py-1.5 text-xs text-muted-foreground shadow-sm">Scoring…</div>
          )}
        </div>

        <div className="space-y-5">
          {data && !data.available ? (
            <div className="rounded-2xl border bg-card p-5 text-sm text-muted-foreground shadow-card">
              <Info className="mb-2 size-4" />
              {data.reason ?? "The model is not available."} The live model covers the PCMC district (Pune).
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-4">
                <StatCard label="Blocked now" value={data?.blockedNow ?? "—"} sub="current status" />
                <StatCard label={`Blocked at +${when === "now" ? 30 : when}`} value={data?.predictedBlocked ?? "—"} sub="router avoids" tone={(data?.predictedBlocked ?? 0) > 0 ? "warn" : undefined} />
                <StatCard label="Close before arrival" value={data?.closingBeforeArrival ?? "—"} sub="open now, blocked by then" tone={(data?.closingBeforeArrival ?? 0) > 0 ? "bad" : undefined} />
                <StatCard label="Uncertain" value={data?.uncertain ?? "—"} sub="could cross the line" />
              </div>

              <section className="rounded-2xl border bg-card p-5 shadow-card">
                <h3 className="mb-1 text-sm font-semibold">{P.label}: roads it cannot use, by arrival time</h3>
                <p className="mb-4 text-xs text-muted-foreground">Water limit {P.limit}. Predicted blocked (p ≥ 60%), same evidence.</p>
                <div className="flex items-end gap-4">
                  {(["30", "60", "90"] as const).map((h) => (
                    <button key={h} onClick={() => setWhen(h)} className="flex flex-1 flex-col items-center gap-1.5">
                      <span className="text-sm font-semibold tabular-nums">{trend[h] ?? "—"}</span>
                      <span className={cn("w-full rounded-md transition-colors", when === h ? "bg-primary" : "bg-primary/25 hover:bg-primary/40")}
                            style={{ height: `${Math.max(6, ((trend[h] ?? 0) / maxTrend) * 96)}px` }} />
                      <span className="text-[11px] text-muted-foreground">+{h} min</span>
                    </button>
                  ))}
                </div>
              </section>

              <section className="space-y-2 rounded-2xl border bg-card p-5 text-xs leading-relaxed text-muted-foreground shadow-card">
                <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                  How to read it
                  <button onClick={() => setTick((n) => n + 1)} className="ml-auto inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline">
                    <RefreshCw className="size-3" /> Refresh
                  </button>
                </div>
                <p>The router avoids a road at p ≥ 60%, or when the pessimistic estimate crosses 60% and p is at least 40%.</p>
                <p>"Close before arrival" is the gap the brief asks about: roads the current-status rule still calls open that the model expects blocked when the unit gets there.</p>
                <p className="text-[11px]">
                  Model {data?.model ?? "—"}
                  {data?.computedAt ? ` · scored ${new Date(data.computedAt * 1000).toLocaleTimeString(undefined, { hour12: false })}` : ""}
                  {data?.scored ? ` · ${data.scored.toLocaleString()} roads scored` : ""}
                </p>
                {!!data?.notes?.length && <p className="text-[11px]">{data.notes.join(" · ")}</p>}
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
