import { useEffect, useRef, useState } from "react"
import mapboxgl from "mapbox-gl"
import type { Feature, FeatureCollection } from "geojson"
import { imageName, registerIcons } from "./icons"
import "mapbox-gl/dist/mapbox-gl.css"

/** The map, on Mapbox.
 *
 *  One component for all three interfaces. What differs between them is which
 *  layers get data, not how the map works, so the citizen portal and the
 *  operations console cannot drift into disagreeing about where something is.
 *
 *  Data goes in through GeoJSON sources that are *updated* rather than
 *  recreated. Tearing down and rebuilding a layer on every poll makes markers
 *  flicker once a second, which on a projector looks like the system is
 *  struggling. Updating `setData` lets Mapbox interpolate instead.
 */

export type Activity = { at: string; text: string; kind: string }
export type ActivityIndex = Map<string, Activity[]>

export type WardFeature = {
  id: string; name: string; number?: string; boundary: [number, number][] | null
  severity: number | null; score: number | null; population?: number
  populationAtRisk?: number | null
}
export type IncidentFeature = {
  id: string; title: string; category: string; severity: number
  reportCount: number; confidence?: number; unitsEnRoute?: number
  status?: string; createdAt?: string; wardId?: string; street?: string | null
  location: [number, number]
}
export type ResourceFeature = {
  id: string; kind: string; label: string; status: string; operator?: string
  capacity?: number; capabilities?: string[]; assignedTo?: string | null
  etaMinutes?: number | null; location: [number, number]
  incidentId?: string | null; assignmentStatus?: string | null
  distanceKm?: number | null; statusNote?: string | null
  unavailableReason?: string | null
}
export type FacilityFeature = {
  id: string; name: string; kind: string; status: string
  capacity: number | null; occupancy: number | null; location: [number, number]
  acceptsCasualties?: boolean
  kindLabel?: string
  /** Relief stock on hand: food packets, litres of water, medical kits. */
  supplies?: Record<string, number>
  servedPerHour?: number | null
}
export type BlockFeature = {
  id: string; reason: string; location: [number, number]; reportedBy?: string
}
/** A unit's road geometry to what it was tasked with. */
export type RouteFeature = {
  id: string; resourceId: string; resourceLabel: string
  incidentId: string; incidentTitle: string; status: string
  etaMinutes: number | null; distanceKm: number | null
  engine?: string | null; progress?: number
  steps?: { instruction: string; street: string; distanceM: number }[]
  path: [number, number][]
}
export type NeedFeature = {
  incidentId: string; capability: string; required: number; met: number
}

type Props = {
  wards?: WardFeature[]
  incidents?: IncidentFeature[]
  resources?: ResourceFeature[]
  facilities?: FacilityFeature[]
  blocks?: BlockFeature[]
  needs?: NeedFeature[]
  /** id -> what has happened to it, newest first. Drives the hover card. */
  activity?: ActivityIndex
  /** Every committed unit's road geometry, drawn as amber lines it can be
   *  hovered for the turn list. Replaces the dashed straight "link" lines. */
  routes?: RouteFeature[]
  /** A single highlighted route: the citizen's own, or the one an operator is
   *  inspecting. Drawn in green, over everything else. */
  route?: number[][]
  /** Label for that highlighted route, shown on hover. */
  routeLabel?: string
  /** The viewer's own position, if this interface has one. */
  me?: { lng: number; lat: number; label?: string } | null
  center?: [number, number]
  zoom?: number
  className?: string
  onPickIncident?: (id: string) => void
  /** Recentre on `me` whenever it moves. On for the citizen, off for the console. */
  followMe?: boolean
}

const TOKEN = import.meta.env.VITE_MAPBOX_TOKEN as string | undefined

/** Mapbox's own popup stylesheet is a white card with a white arrow, which on
 *  the dark basemap rendered as near-white text on near-white and read as
 *  "hover does nothing". Injected once, from here, so the component carries its
 *  own appearance instead of depending on a global stylesheet that other work
 *  might rewrite. */
const POPUP_CSS = `
.indra-pop .mapboxgl-popup-content {
  background: rgb(9 12 20 / 0.96);
  color: #e6edf7;
  border: 1px solid rgb(148 163 184 / 0.28);
  border-radius: 10px;
  padding: 10px 12px;
  box-shadow: 0 10px 30px rgb(0 0 0 / 0.45);
  max-width: 320px;
  font: 12px/1.45 ui-sans-serif, system-ui, sans-serif;
}
.indra-pop .mapboxgl-popup-tip { display: none; }
.indra-pop .ip-title { font-size: 13px; font-weight: 600; color: #fff; }
.indra-pop .ip-sub { color: #93a4bd; margin-top: 1px; }
.indra-pop .ip-row { display: flex; justify-content: space-between; gap: 12px; margin-top: 3px; }
.indra-pop .ip-row span:first-child { color: #93a4bd; }
.indra-pop .ip-row span:last-child { color: #e6edf7; font-variant-numeric: tabular-nums; }
.indra-pop .ip-chip {
  display: inline-block; padding: 1px 7px; border-radius: 999px;
  font-size: 11px; font-weight: 500; margin-top: 6px;
}
.indra-pop .ip-hr { border-top: 1px solid rgb(148 163 184 / 0.2); margin: 8px 0 6px; }
.indra-pop .ip-head { color: #93a4bd; font-size: 10.5px; letter-spacing: .06em;
  text-transform: uppercase; }
.indra-pop .ip-act { display: flex; gap: 7px; margin-top: 4px; }
.indra-pop .ip-act i { color: #64748b; font-style: normal; flex: none;
  font-variant-numeric: tabular-nums; }
.indra-pop .ip-act span { color: #cbd5e1; }
.indra-pop .ip-warn { color: #fca5a5; }
.indra-pop .ip-ok { color: #86efac; }
`

let cssInjected = false
function injectCss() {
  if (cssInjected || typeof document === "undefined") return
  const el = document.createElement("style")
  el.dataset.indraMap = "1"
  el.textContent = POPUP_CSS
  document.head.appendChild(el)
  cssInjected = true
}

/** Report text arrives from the public. It is not markup. */
const esc = (v: unknown) =>
  String(v ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!
  )

const SEVERITY_COLOR = [
  "interpolate", ["linear"], ["coalesce", ["get", "severity"], 0],
  0, "rgba(100,116,139,0.10)",
  2, "rgba(56,189,248,0.18)",
  3, "rgba(250,204,21,0.28)",
  4, "rgba(249,115,22,0.38)",
  5, "rgba(239,68,68,0.48)",
] as unknown as mapboxgl.Expression

/** Which drawn icon, and in what colour.
 *
 *  These replace two-letter codes, which were a correct fix for the emoji
 *  `glyphs > 65535` crash and a poor answer to "what is that dot". A tree reads
 *  as a tree at any zoom; "FT" is a puzzle at every one. The icons are raster
 *  images registered with `addImage`, so there is no codepoint limit to hit.
 */
const HAZARD_ICON: Record<string, string> = {
  flooded_road: "hz-flooded_road",
  waterlogging: "hz-waterlogging",
  fallen_tree: "hz-fallen_tree",
  power_line: "hz-power_line",
  structural_damage: "hz-structural_damage",
  blocked_drain: "hz-blocked_drain",
  person_stranded: "hz-person_stranded",
  heat_casualty: "hz-heat_casualty",
  supply_shortage: "hz-supply_shortage",
  fire: "hz-fire",
}
const hazardIcon = (category: string) =>
  HAZARD_ICON[category] ?? "hz-default"

const KIND_ICON: Record<string, string> = {
  ambulance: "rk-ambulance", boat: "rk-boat", pump: "rk-pump",
  fire_engine: "rk-fire_engine", rescue_team: "rk-rescue_team",
  bus: "rk-bus", jcb: "rk-jcb",
  supply_truck: "rk-supply_truck", water_tanker: "rk-water_tanker",
}
const kindIcon = (kind: string) => KIND_ICON[kind] ?? "rk-default"

const LIFELINE_ICON: Record<string, string> = {
  hospital: "lf-hospital", shelter: "lf-shelter",
  relief_centre: "lf-relief_centre", food_kitchen: "lf-food_kitchen",
  water_point: "lf-water_point", medical_camp: "lf-medical_camp",
  pump_station: "lf-pump_station", school: "lf-school",
  substation: "lf-substation",
}
const lifelineIcon = (kind: string) => LIFELINE_ICON[kind] ?? "lf-default"

const LIFELINE_COLOUR: Record<string, string> = {
  hospital: "#0284c7", shelter: "#0d9488",
  relief_centre: "#7c3aed", food_kitchen: "#7c3aed",
  water_point: "#0891b2", medical_camp: "#db2777",
  pump_station: "#475569", school: "#475569", substation: "#475569",
}

const severityColour = (severity: number) =>
  severity >= 5 ? "#ef4444" : severity >= 4 ? "#f97316" : "#eab308"

const statusColour = (status: string) =>
  status === "on_site" ? "#10b981"
  : status === "en_route" ? "#f59e0b"
  : status === "assigned" ? "#0ea5e9"
  : status === "offline" ? "#dc2626"
  : "#64748b"

const FONT = ["DIN Offc Pro Medium", "Arial Unicode MS Bold"]

const TIME = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit", minute: "2-digit", hour12: false,
})
const clock = (iso: string) => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? "" : TIME.format(d)
}

const ago = (iso?: string) => {
  if (!iso) return ""
  const s = (Date.now() - new Date(iso).getTime()) / 1000
  if (!Number.isFinite(s) || s < 0) return ""
  if (s < 90) return `${Math.round(s)}s ago`
  if (s < 5400) return `${Math.round(s / 60)} min ago`
  return `${Math.round(s / 3600)} h ago`
}

const row = (k: string, v: unknown) =>
  v === null || v === undefined || v === ""
    ? ""
    : `<div class="ip-row"><span>${esc(k)}</span><span>${esc(v)}</span></div>`

const chip = (text: string, color: string) =>
  `<div class="ip-chip" style="background:${color}22;color:${color}">${esc(text)}</div>`

/** The recent-activity block. This is the answer to "what happened here": the
 *  agent's own audit lines and the runner's narration, merged and timestamped,
 *  rather than a static label. */
function activityBlock(entries: Activity[] | undefined, heading = "Recent") {
  if (!entries?.length) {
    return `<div class="ip-hr"></div><div class="ip-head">${heading}</div>
            <div class="ip-act"><span style="color:#64748b">Nothing recorded yet.</span></div>`
  }
  return (
    `<div class="ip-hr"></div><div class="ip-head">${heading}</div>` +
    entries
      .slice(0, 5)
      .map(
        (a) =>
          `<div class="ip-act"><i>${esc(clock(a.at))}</i><span>${esc(a.text)}</span></div>`
      )
      .join("")
  )
}

function fc(features: Feature[]): FeatureCollection {
  return { type: "FeatureCollection", features }
}
const point = (lng: number, lat: number, props: Record<string, unknown>): Feature => ({
  type: "Feature", geometry: { type: "Point", coordinates: [lng, lat] }, properties: props,
})

/** Mapbox v3 types a hovered feature as `GeoJSONFeature`, which does not expose
 *  `properties` even though every runtime feature has it. The properties we read
 *  are ones this component wrote a few lines above, so the narrowing is safe;
 *  the cast is here rather than inline so there is one of it. */
const propsOf = (f: unknown): Record<string, unknown> =>
  (f as { properties?: Record<string, unknown> } | undefined)?.properties ?? {}

export function LiveMap({
  wards = [], incidents = [], resources = [], facilities = [], blocks = [],
  needs = [], activity, routes = [],
  route, routeLabel, me, center = [73.88, 18.58], zoom = 10.2, className,
  onPickIncident, followMe = false,
}: Props) {
  const container = useRef<HTMLDivElement>(null)
  const map = useRef<mapboxgl.Map | null>(null)
  const popup = useRef<mapboxgl.Popup | null>(null)
  const [ready, setReady] = useState(false)
  const [, setIconsReady] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)

  useEffect(() => {
    injectCss()
    if (!container.current || map.current) return
    if (!TOKEN) {
      setFailed("VITE_MAPBOX_TOKEN is not set in frontend/indradhanu/.env.local")
      return
    }
    mapboxgl.accessToken = TOKEN
    const dark = document.documentElement.classList.contains("dark")
    try {
      const m = new mapboxgl.Map({
        container: container.current,
        style: dark ? "mapbox://styles/mapbox/dark-v11" : "mapbox://styles/mapbox/light-v11",
        center, zoom, attributionControl: true,
      })
      map.current = m
      m.addControl(new mapboxgl.NavigationControl({ showCompass: false }), "top-right")
      popup.current = new mapboxgl.Popup({
        closeButton: false, closeOnClick: false, offset: 14,
        className: "indra-pop", maxWidth: "340px",
      })

      m.on("error", (e) => {
        // A tile 401 is almost always a bad or restricted token, and the map
        // otherwise just sits there blank looking like our bug.
        const msg = (e as unknown as { error?: { message?: string } })?.error?.message
        if (msg?.includes("401") || msg?.toLowerCase().includes("unauthorized")) {
          setFailed("Mapbox rejected the token (401). Check VITE_MAPBOX_TOKEN and its URL restrictions.")
        }
      })

      m.on("load", () => {
        // Register the drawn icons before any source gets data, so the first
        // poll does not land on a sprite that does not exist yet and fill the
        // console with missing-image warnings.
        void registerIcons(m as unknown as Parameters<typeof registerIcons>[0])
          .then(() => setIconsReady(true))
          .catch(() => setIconsReady(true))

        m.addSource("wards", { type: "geojson", data: fc([]) })
        m.addLayer({
          id: "ward-fill", type: "fill", source: "wards",
          paint: { "fill-color": SEVERITY_COLOR },
        })
        m.addLayer({
          id: "ward-line", type: "line", source: "wards",
          paint: { "line-color": "#94a3b8", "line-opacity": 0.45, "line-width": 1 },
        })

        m.addSource("route", { type: "geojson", data: fc([]) })
        m.addLayer({
          id: "route-casing", type: "line", source: "route",
          layout: { "line-cap": "round", "line-join": "round" },
          paint: { "line-color": "#0f172a", "line-width": 9, "line-opacity": 0.35 },
        })
        m.addLayer({
          id: "route-line", type: "line", source: "route",
          layout: { "line-cap": "round", "line-join": "round" },
          paint: { "line-color": "#22c55e", "line-width": 4 },
        })

        // Unit routes: the streets each committed vehicle is actually driving.
        // This was a dashed straight line from the dot to the incident, which
        // was honest about nothing: the unit was not taking that path and the
        // path did not exist.
        m.addSource("links", { type: "geojson", data: fc([]) })
        m.addLayer({
          id: "link-casing", type: "line", source: "links",
          layout: { "line-cap": "round", "line-join": "round" },
          paint: { "line-color": "#0b1220", "line-width": 6, "line-opacity": 0.5 },
        })
        m.addLayer({
          id: "link-line", type: "line", source: "links",
          layout: { "line-cap": "round", "line-join": "round" },
          paint: {
            "line-color": [
              "match", ["get", "status"],
              "on_site", "#10b981",
              "en_route", "#f59e0b",
              "#0ea5e9",
            ] as unknown as mapboxgl.Expression,
            "line-width": 3,
            "line-opacity": 0.9,
          },
        })

        m.addSource("facilities", { type: "geojson", data: fc([]) })
        m.addLayer({
          id: "facility-dot", type: "symbol", source: "facilities",
          layout: {
            "icon-image": ["get", "icon"],
            "icon-size": ["interpolate", ["linear"], ["zoom"], 10, 0.55, 13, 0.8, 16, 1.0],
            "icon-anchor": "bottom",
            "icon-allow-overlap": true, "icon-ignore-placement": true,
          },
        })
        // A ring for anything that has reported itself full or closed. Colour
        // alone is not enough when there are four kinds of facility on screen.
        m.addLayer({
          id: "facility-alarm", type: "circle", source: "facilities",
          filter: ["in", ["get", "status"], ["literal", ["full", "closed"]]],
          paint: {
            "circle-radius": 13, "circle-color": "rgba(0,0,0,0)",
            "circle-stroke-width": 2, "circle-stroke-color": "#ef4444",
          },
        }, "facility-dot")

        m.addSource("blocks", { type: "geojson", data: fc([]) })
        m.addLayer({
          id: "block-dot", type: "symbol", source: "blocks",
          layout: {
            "icon-image": ["get", "icon"],
            "icon-size": ["interpolate", ["linear"], ["zoom"], 10, 0.6, 14, 0.95],
            "icon-anchor": "bottom",
            "icon-allow-overlap": true, "icon-ignore-placement": true,
          },
        })

        m.addSource("incidents", { type: "geojson", data: fc([]) })
        // The halo still carries severity and merge count — it is the thing you
        // read across a whole city — and the icon on top of it carries what kind
        // of hazard it is, which is the thing you read once you have found it.
        m.addLayer({
          id: "incident-halo", type: "circle", source: "incidents",
          paint: {
            "circle-radius": ["+", 12, ["*", 3, ["get", "reportCount"]]],
            "circle-color": ["get", "colour"],
            "circle-opacity": 0.18,
            "circle-stroke-width": 1, "circle-stroke-color": ["get", "colour"],
            "circle-stroke-opacity": 0.4,
          },
        })
        m.addLayer({
          id: "incident-dot", type: "symbol", source: "incidents",
          layout: {
            "icon-image": ["get", "icon"],
            "icon-size": ["interpolate", ["linear"], ["zoom"], 10, 0.65, 13, 0.95, 16, 1.2],
            "icon-anchor": "bottom",
            "icon-allow-overlap": true, "icon-ignore-placement": true,
          },
        })
        // The merge count sits beside the icon rather than inside it, so the
        // hazard stays legible. It is the whole argument for deduplication and
        // it should not be hidden behind a picture of a tree.
        m.addLayer({
          id: "incident-count", type: "symbol", source: "incidents",
          filter: [">", ["get", "reportCount"], 1],
          layout: {
            "text-field": ["to-string", ["get", "reportCount"]],
            "text-font": FONT, "text-size": 11, "text-allow-overlap": true,
            "text-offset": [1.3, -2.3], "text-anchor": "left",
          },
          paint: {
            "text-color": "#ffffff",
            "text-halo-color": "rgba(9,12,20,0.9)", "text-halo-width": 1.4,
          },
        })

        m.addSource("resources", { type: "geojson", data: fc([]) })
        m.addLayer({
          id: "resource-dot", type: "symbol", source: "resources",
          layout: {
            "icon-image": ["get", "icon"],
            "icon-size": ["interpolate", ["linear"], ["zoom"], 10, 0.6, 13, 0.85, 16, 1.05],
            "icon-anchor": "bottom",
            "icon-allow-overlap": true, "icon-ignore-placement": true,
          },
        })

        m.addSource("me", { type: "geojson", data: fc([]) })
        m.addLayer({
          id: "me-halo", type: "circle", source: "me",
          paint: { "circle-radius": 20, "circle-color": "#8b5cf6", "circle-opacity": 0.18 },
        })
        m.addLayer({
          id: "me-dot", type: "symbol", source: "me",
          layout: {
            "icon-image": ["get", "icon"],
            "icon-size": 1.0,
            "icon-anchor": "bottom",
            "icon-allow-overlap": true, "icon-ignore-placement": true,
          },
        })

        // Where each route ends, which is the hazard the unit is going to.
        // A line that fades out into a dot is a line going nowhere in
        // particular; the endpoint names its destination.
        m.addSource("endpoints", { type: "geojson", data: fc([]) })
        m.addLayer({
          id: "endpoint-ring", type: "circle", source: "endpoints",
          paint: {
            "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 8, 15, 15],
            "circle-color": "rgba(0,0,0,0)",
            "circle-stroke-width": 2.4,
            "circle-stroke-color": ["get", "colour"],
            "circle-stroke-opacity": 0.95,
          },
        })
        m.addLayer({
          id: "endpoint-label", type: "symbol", source: "endpoints",
          minzoom: 12,
          layout: {
            "text-field": ["get", "label"], "text-font": FONT,
            "text-size": 10.5, "text-offset": [0, 1.6], "text-anchor": "top",
            "text-max-width": 12,
          },
          paint: {
            "text-color": "#e6edf7",
            "text-halo-color": "rgba(9,12,20,0.92)", "text-halo-width": 1.6,
          },
        })

        // One handler, one priority order.
        //
        // Per-layer `mousemove` handlers were the bug: Mapbox fires them for
        // every layer under the cursor independently, and a ward polygon covers
        // the entire city, so the ward's handler fired last and overwrote
        // whatever the incident or the unit had just put in the popup. Nothing
        // on top of a ward was ever hoverable.
        //
        // Querying once and taking the first match in a deliberate order fixes
        // it properly: the ward is the fallback rather than the winner, and the
        // order here is "smallest and most specific first", which is also the
        // order somebody's attention moves in.
        const HOVER_ORDER = [
          "me-dot", "incident-dot", "resource-dot", "facility-dot",
          "block-dot", "endpoint-ring", "route-line", "link-line", "ward-fill",
        ]
        const present = () => HOVER_ORDER.filter((id) => m.getLayer(id))

        m.on("mousemove", (e) => {
          const hits = m.queryRenderedFeatures(e.point, { layers: present() })
          if (!hits.length) {
            m.getCanvas().style.cursor = ""
            popup.current?.remove()
            return
          }
          const rank = new Map(HOVER_ORDER.map((id, i) => [id, i] as const))
          let best = hits[0]
          for (const f of hits) {
            const a = rank.get(String(f.layer?.id)) ?? 99
            const b = rank.get(String(best.layer?.id)) ?? 99
            if (a < b) best = f
          }
          const html = propsOf(best).tip
          if (!html) {
            m.getCanvas().style.cursor = ""
            popup.current?.remove()
            return
          }
          m.getCanvas().style.cursor =
            best.layer?.id === "ward-fill" ? "" : "pointer"
          popup.current?.setLngLat(e.lngLat).setHTML(String(html)).addTo(m)
        })

        m.on("mouseout", () => {
          m.getCanvas().style.cursor = ""
          popup.current?.remove()
        })

        // Clicking picks the incident under the cursor, whether that was the
        // hazard icon itself or the ring at the end of a route pointing at it.
        m.on("click", (e) => {
          const layers = ["incident-dot", "endpoint-ring"].filter((id) => m.getLayer(id))
          if (!layers.length) return
          const hits = m.queryRenderedFeatures(e.point, { layers })
          const id = hits.length ? propsOf(hits[0]).incidentId ?? propsOf(hits[0]).id : null
          if (id && onPickIncident) onPickIncident(String(id))
        })

        setReady(true)
      })
    } catch (err) {
      setFailed(err instanceof Error ? err.message : String(err))
    }

    return () => {
      map.current?.remove()
      map.current = null
    }
    // Intentionally mounts once. Data arrives through the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const set = (id: string, data: FeatureCollection) => {
    const src = map.current?.getSource(id) as mapboxgl.GeoJSONSource | undefined
    src?.setData(data)
  }

  useEffect(() => {
    if (!ready) return
    set("wards", fc(
      wards
        .filter((w) => (w.boundary?.length ?? 0) >= 3)
        .map((w) => {
          const scored = w.score !== null && w.score !== undefined
          const sev = w.severity ?? 0
          const tip =
            `<div class="ip-title">${esc(w.name)}</div>` +
            `<div class="ip-sub">Ward ${esc(w.number ?? "—")}</div>` +
            (scored
              ? chip(
                  `Severity ${sev} · flood risk ${(w.score! * 100).toFixed(0)}%`,
                  sev >= 4 ? "#ef4444" : sev >= 3 ? "#f59e0b" : "#38bdf8"
                )
              : chip("Not scored yet", "#94a3b8")) +
            row("Population", w.population?.toLocaleString()) +
            row("Estimated exposed", w.populationAtRisk?.toLocaleString()) +
            activityBlock(activity?.get(w.id), "In this ward")
          return {
            type: "Feature" as const,
            geometry: { type: "Polygon" as const, coordinates: [w.boundary as number[][]] },
            properties: { id: w.id, severity: w.severity ?? 0, tip },
          }
        })
    ))
  }, [ready, wards, activity])

  useEffect(() => {
    if (!ready) return
    const needsBy = new Map<string, NeedFeature[]>()
    for (const n of needs) {
      const list = needsBy.get(n.incidentId)
      if (list) list.push(n)
      else needsBy.set(n.incidentId, [n])
    }
    set("incidents", fc(incidents.map((i) => {
      const mine = needsBy.get(i.id) ?? []
      const short = mine.filter((n) => n.met < n.required)
      const tip =
        `<div class="ip-title">${esc(i.title)}</div>` +
        `<div class="ip-sub">${esc(i.category.replace(/_/g, " "))}` +
        (i.street ? ` · ${esc(i.street)}` : "") +
        (i.createdAt ? ` · opened ${esc(ago(i.createdAt))}` : "") + `</div>` +
        chip(
          `Severity ${i.severity}${i.status ? ` · ${i.status.replace(/_/g, " ")}` : ""}`,
          i.severity >= 5 ? "#ef4444" : i.severity >= 4 ? "#f97316" : "#eab308"
        ) +
        row("Reports merged into it", i.reportCount) +
        (i.reportCount > 1
          ? row("Duplicate dispatches avoided", i.reportCount - 1)
          : "") +
        row("Confidence", i.confidence !== undefined
          ? `${(i.confidence * 100).toFixed(0)}%` : null) +
        row("Units committed", i.unitsEnRoute ?? 0) +
        (mine.length
          ? `<div class="ip-hr"></div><div class="ip-head">Needs</div>` +
            mine
              .map(
                (n) =>
                  `<div class="ip-row"><span>${esc(n.capability.replace(/_/g, " "))}</span>` +
                  `<span class="${n.met >= n.required ? "ip-ok" : "ip-warn"}">` +
                  `${n.met}/${n.required}</span></div>`
              )
              .join("")
          : "") +
        (short.length
          ? `<div class="ip-act ip-warn"><span>Short by ` +
            `${short.reduce((s, n) => s + (n.required - n.met), 0)} unit(s).</span></div>`
          : "") +
        activityBlock(activity?.get(i.id), "What happened") +
        `<div class="ip-act"><span style="color:#64748b">Click to open it.</span></div>`
      return point(i.location[0], i.location[1], {
        id: i.id, severity: i.severity, reportCount: i.reportCount, tip,
        colour: severityColour(i.severity),
        icon: imageName(hazardIcon(i.category), severityColour(i.severity)),
      })
    })))
  }, [ready, incidents, needs, activity])

  useEffect(() => {
    if (!ready) return
    set("resources", fc(resources.map((r) => {
      const colour = statusColour(r.status)
      const tip =
        `<div class="ip-title">${esc(r.label)}</div>` +
        `<div class="ip-sub">${esc(r.operator ?? "")}` +
        (r.capacity ? ` · capacity ${esc(r.capacity)}` : "") + `</div>` +
        chip(r.status.replace(/_/g, " "), colour) +
        row("Tasked to", r.assignedTo) +
        row("ETA", r.etaMinutes ? `${r.etaMinutes} min` : null) +
        row("Distance", r.distanceKm ? `${r.distanceKm.toFixed(1)} km` : null) +
        row("Task state", r.assignmentStatus?.replace(/_/g, " ")) +
        (r.statusNote ? row("Crew note", r.statusNote) : "") +
        (r.unavailableReason
          ? `<div class="ip-act ip-warn"><span>${esc(r.unavailableReason)}</span></div>`
          : "") +
        (r.capabilities?.length
          ? `<div class="ip-hr"></div><div class="ip-head">Can do</div>` +
            `<div class="ip-act"><span>${esc(
              r.capabilities.map((c) => c.replace(/_/g, " ")).join(", ")
            )}</span></div>`
          : "") +
        activityBlock(activity?.get(r.id), "Agent actions")
      return point(r.location[0], r.location[1], {
        id: r.id, status: r.status, tip,
        icon: imageName(kindIcon(r.kind), statusColour(r.status)),
      })
    })))
  }, [ready, resources, activity])

  useEffect(() => {
    if (!ready) return
    const drawable = routes.filter((r) => r.path.length > 1)

    set("links", fc(
      drawable.map((r) => {
        const turns = (r.steps ?? []).filter((s) => s.street)
        const tip =
          `<div class="ip-title">${esc(r.resourceLabel)} &rarr; ${esc(r.incidentTitle)}</div>` +
          `<div class="ip-sub">${esc((r.engine ?? "route").replace(/-/g, " "))}` +
          ` · ${Math.round((r.progress ?? 0) * 100)}% of the way</div>` +
          chip(r.status.replace(/_/g, " "), statusColour(r.status)) +
          row("Distance", r.distanceKm ? `${r.distanceKm.toFixed(1)} km` : null) +
          row("ETA", r.etaMinutes ? `${r.etaMinutes} min` : null) +
          (turns.length
            ? `<div class="ip-hr"></div><div class="ip-head">Streets</div>` +
              turns.slice(0, 5).map((s) =>
                `<div class="ip-act"><i>${Math.round(s.distanceM)}m</i>` +
                `<span>${esc(s.instruction)}</span></div>`).join("")
            : "")
        return {
          type: "Feature" as const,
          geometry: { type: "LineString" as const, coordinates: r.path as number[][] },
          properties: { id: r.id, status: r.status, incidentId: r.incidentId, tip },
        }
      })
    ))

    // Where each line ends, and what it ends at.
    //
    // A route that just fades out into the dot soup is a line going nowhere in
    // particular. Marking the last vertex with a ring in the route's own colour,
    // labelled with the incident, makes "this unit is going to that hazard"
    // readable without hovering anything. One ring per destination, not one per
    // unit, because three boats converging on one rescue is one place.
    const byDestination = new Map<string, { at: [number, number]; title: string; n: number; status: string; incidentId: string }>()
    for (const r of drawable) {
      const last = r.path[r.path.length - 1] as [number, number]
      const key = r.incidentId || `${last[0].toFixed(5)},${last[1].toFixed(5)}`
      const held = byDestination.get(key)
      if (held) {
        held.n += 1
        if (r.status === "on_site") held.status = "on_site"
      } else {
        byDestination.set(key, {
          at: last, title: r.incidentTitle, n: 1,
          status: r.status, incidentId: r.incidentId,
        })
      }
    }

    set("endpoints", fc(
      [...byDestination.values()].map((d) =>
        point(d.at[0], d.at[1], {
          incidentId: d.incidentId,
          colour: statusColour(d.status),
          label: d.n > 1 ? `${d.title} · ${d.n} units` : d.title,
          tip:
            `<div class="ip-title">${esc(d.title)}</div>` +
            `<div class="ip-sub">Destination of ${d.n} committed unit${d.n === 1 ? "" : "s"}</div>` +
            chip(d.status.replace(/_/g, " "), statusColour(d.status)) +
            activityBlock(activity?.get(d.incidentId), "What happened"),
        })
      )
    ))
  }, [ready, routes, activity])

  useEffect(() => {
    if (!ready) return
    set("facilities", fc(facilities.map((f) => {
      const spare = f.capacity === null || f.capacity === 0 ? null
        : Math.max(0, f.capacity - (f.occupancy ?? 0))
      const colour = LIFELINE_COLOUR[f.kind] ?? "#0d9488"
      const stock = Object.entries(f.supplies ?? {}).filter(
        ([, v]) => typeof v === "number"
      ) as [string, number][]
      // What is actually on the shelf. A relief centre with no food is a
      // building, and that is a thing an operator must be able to see from the
      // map rather than from a report somebody files later.
      const lowest = stock.length
        ? stock.reduce((a, b) => (b[1] < a[1] ? b : a))
        : null

      const tip =
        `<div class="ip-title">${esc(f.name)}</div>` +
        `<div class="ip-sub">${esc(f.kindLabel ?? f.kind.replace(/_/g, " "))}</div>` +
        chip(
          f.status.replace(/_/g, " "),
          f.status === "full" || f.status === "closed" ? "#ef4444"
            : f.status === "limited" ? "#f59e0b" : colour
        ) +
        (f.capacity ? row("Capacity", f.capacity) : "") +
        (f.occupancy ? row("Occupied", f.occupancy) : "") +
        (spare !== null
          ? `<div class="ip-row"><span>Places free</span>` +
            `<span class="${spare > 0 ? "ip-ok" : "ip-warn"}">${spare}</span></div>`
          : "") +
        (f.servedPerHour ? row("Serving", `${f.servedPerHour}/hour`) : "") +
        (stock.length
          ? `<div class="ip-hr"></div><div class="ip-head">Stock on hand</div>` +
            stock
              .map(([line, qty]) =>
                `<div class="ip-row"><span>${esc(line.replace(/_/g, " "))}</span>` +
                `<span class="${qty <= 0 ? "ip-warn" : ""}">` +
                `${qty.toLocaleString()}</span></div>`)
              .join("")
          : "") +
        (lowest && lowest[1] <= 0
          ? `<div class="ip-act ip-warn"><span>Out of ` +
            `${esc(lowest[0].replace(/_/g, " "))}. The citizen agent has stopped ` +
            `sending anybody here for it.</span></div>`
          : "") +
        (f.acceptsCasualties === false && f.kind === "hospital"
          ? `<div class="ip-act ip-warn"><span>Not accepting casualties.</span></div>`
          : "") +
        activityBlock(activity?.get(f.id), "Reported by the crew")

      return point(f.location[0], f.location[1], {
        id: f.id, status: f.status, tip,
        icon: imageName(lifelineIcon(f.kind), colour),
      })
    })))
  }, [ready, facilities, activity])

  useEffect(() => {
    if (!ready) return
    set("blocks", fc(blocks.map((b) =>
      point(b.location[0], b.location[1], {
        id: b.id,
        icon: imageName("ui-block", "#dc2626"),
        tip:
          `<div class="ip-title">Road blocked</div>` +
          `<div class="ip-sub">${esc(b.reason)}</div>` +
          chip("Routing around it", "#ef4444") +
          row("Reported by", b.reportedBy) +
          activityBlock(activity?.get(b.id), "Since"),
      })
    )))
  }, [ready, blocks, activity])

  useEffect(() => {
    if (!ready) return
    set("route", route && route.length > 1
      ? fc([{
          type: "Feature",
          geometry: { type: "LineString", coordinates: route },
          properties: {
            tip:
              `<div class="ip-title">${esc(routeLabel ?? "Recommended route")}</div>` +
              `<div class="ip-sub">Scored on hazard exposure first, distance second.</div>`,
          },
        }])
      : fc([]))
  }, [ready, route, routeLabel])

  useEffect(() => {
    if (!ready) return
    set("me", me
      ? fc([point(me.lng, me.lat, {
          icon: imageName("ui-me", "#8b5cf6"),
          tip: `<div class="ip-title">${esc(me.label ?? "You")}</div>` +
               `<div class="ip-sub">${me.lat.toFixed(5)}, ${me.lng.toFixed(5)}</div>`,
        })])
      : fc([]))
    if (me && followMe) {
      map.current?.easeTo({ center: [me.lng, me.lat], duration: 400 })
    }
  }, [ready, me, followMe])

  if (failed) {
    return (
      <div className={`bg-muted/30 flex items-center justify-center rounded-lg border p-6 text-center text-sm ${className ?? "h-[520px]"}`}>
        <div>
          <p className="font-medium">The map could not load.</p>
          <p className="text-muted-foreground mt-1 max-w-md text-xs">{failed}</p>
        </div>
      </div>
    )
  }

  return <div ref={container} className={className ?? "h-[520px] w-full rounded-lg border"} />
}
