import { useEffect, useRef, useState } from "react"
import mapboxgl from "mapbox-gl"
import type { Feature, FeatureCollection } from "geojson"
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
  status?: string; createdAt?: string; wardId?: string
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
}
export type BlockFeature = {
  id: string; reason: string; location: [number, number]; reportedBy?: string
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
  /** A route to draw, as [lng,lat] pairs. */
  route?: number[][]
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

const STATUS_COLOR = [
  "match", ["get", "status"],
  "available", "#64748b",
  "assigned", "#0ea5e9",
  "en_route", "#f59e0b",
  "on_site", "#10b981",
  "offline", "#dc2626",
  "#94a3b8",
] as unknown as mapboxgl.Expression

/** Two letters, not an emoji.
 *
 *  The symbol layer used ⛵🚑🚒 and Mapbox answered `glyphs > 65535 not
 *  supported` on every frame: emoji live outside the Basic Multilingual Plane
 *  and the SDF glyph pipeline only covers codepoints below 65536, so the layer
 *  drew nothing and filled the console with errors. Latin letters are inside it.
 */
const GLYPH: Record<string, string> = {
  boat: "BT", pump: "PU", ambulance: "AM", fire_engine: "FE",
  rescue_team: "RT", bus: "BU", jcb: "JC", tanker: "TK",
  medical_team: "MD", drone: "DR",
}
const glyphFor = (kind: string) =>
  GLYPH[kind] ?? (kind.slice(0, 2).toUpperCase() || "UN")

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
  needs = [], activity,
  route, me, center = [73.88, 18.58], zoom = 10.2, className,
  onPickIncident, followMe = false,
}: Props) {
  const container = useRef<HTMLDivElement>(null)
  const map = useRef<mapboxgl.Map | null>(null)
  const popup = useRef<mapboxgl.Popup | null>(null)
  const [ready, setReady] = useState(false)
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

        m.addSource("links", { type: "geojson", data: fc([]) })
        m.addLayer({
          id: "link-line", type: "line", source: "links",
          paint: {
            "line-color": "#f59e0b", "line-width": 1.6,
            "line-dasharray": [2, 2], "line-opacity": 0.8,
          },
        })

        m.addSource("facilities", { type: "geojson", data: fc([]) })
        m.addLayer({
          id: "facility-dot", type: "circle", source: "facilities",
          paint: {
            "circle-radius": 6,
            "circle-color": ["match", ["get", "status"], "full", "#dc2626",
                             "limited", "#f59e0b", "#0284c7"],
            "circle-stroke-width": 1.5, "circle-stroke-color": "#fff",
          },
        })

        m.addSource("blocks", { type: "geojson", data: fc([]) })
        m.addLayer({
          id: "block-dot", type: "circle", source: "blocks",
          paint: {
            "circle-radius": 7, "circle-color": "#ef4444", "circle-opacity": 0.5,
            "circle-stroke-width": 2, "circle-stroke-color": "#ef4444",
          },
        })

        m.addSource("incidents", { type: "geojson", data: fc([]) })
        m.addLayer({
          id: "incident-halo", type: "circle", source: "incidents",
          paint: {
            "circle-radius": ["+", 10, ["*", 3, ["get", "reportCount"]]],
            "circle-color": ["match", ["to-string", ["get", "severity"]],
                             "5", "#ef4444", "4", "#f97316", "#eab308"],
            "circle-opacity": 0.16,
          },
        })
        m.addLayer({
          id: "incident-dot", type: "circle", source: "incidents",
          paint: {
            "circle-radius": ["+", 5, ["*", 1.8, ["get", "reportCount"]]],
            "circle-color": ["match", ["to-string", ["get", "severity"]],
                             "5", "#ef4444", "4", "#f97316", "#eab308"],
            "circle-stroke-width": 1.5, "circle-stroke-color": "#fff",
          },
        })
        m.addLayer({
          id: "incident-count", type: "symbol", source: "incidents",
          filter: [">", ["get", "reportCount"], 1],
          layout: {
            "text-field": ["to-string", ["get", "reportCount"]],
            "text-font": FONT, "text-size": 11, "text-allow-overlap": true,
          },
          paint: { "text-color": "#fff" },
        })

        m.addSource("resources", { type: "geojson", data: fc([]) })
        m.addLayer({
          id: "resource-dot", type: "circle", source: "resources",
          paint: {
            "circle-radius": 10, "circle-color": STATUS_COLOR,
            "circle-stroke-width": 2, "circle-stroke-color": "#fff",
          },
        })
        m.addLayer({
          id: "resource-glyph", type: "symbol", source: "resources",
          layout: {
            "text-field": ["get", "glyph"], "text-font": FONT,
            "text-size": 9.5, "text-allow-overlap": true,
            "text-ignore-placement": true, "text-letter-spacing": 0.02,
          },
          paint: {
            "text-color": "#ffffff",
            "text-halo-color": "rgba(15,23,42,0.65)", "text-halo-width": 0.8,
          },
        })

        m.addSource("me", { type: "geojson", data: fc([]) })
        m.addLayer({
          id: "me-halo", type: "circle", source: "me",
          paint: { "circle-radius": 20, "circle-color": "#8b5cf6", "circle-opacity": 0.18 },
        })
        m.addLayer({
          id: "me-dot", type: "circle", source: "me",
          paint: { "circle-radius": 8, "circle-color": "#8b5cf6",
                   "circle-stroke-width": 3, "circle-stroke-color": "#fff" },
        })

        // Points first: a ward polygon covers the whole city, so if it answers
        // the hover before the dot on top of it does, nothing else is ever
        // hoverable.
        const hoverable = [
          "incident-dot", "resource-dot", "facility-dot", "block-dot",
          "me-dot", "ward-fill",
        ]
        for (const layer of hoverable) {
          m.on("mousemove", layer, (e) => {
            const html = propsOf(e.features?.[0]).tip
            if (!html) return
            m.getCanvas().style.cursor = layer === "ward-fill" ? "" : "pointer"
            popup.current?.setLngLat(e.lngLat).setHTML(String(html)).addTo(m)
          })
          m.on("mouseleave", layer, () => {
            m.getCanvas().style.cursor = ""
            popup.current?.remove()
          })
        }
        m.on("click", "incident-dot", (e) => {
          const id = propsOf(e.features?.[0]).id
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
      })
    })))
  }, [ready, incidents, needs, activity])

  useEffect(() => {
    if (!ready) return
    set("resources", fc(resources.map((r) => {
      const colour =
        r.status === "on_site" ? "#10b981"
        : r.status === "en_route" ? "#f59e0b"
        : r.status === "assigned" ? "#0ea5e9"
        : r.status === "offline" ? "#dc2626"
        : "#64748b"
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
        id: r.id, status: r.status, glyph: glyphFor(r.kind), tip,
      })
    })))
    // Lines from each committed unit to what it was sent to.
    const byId = new Map(incidents.map((i) => [i.id, i]))
    set("links", fc(
      resources
        .filter((r) => r.incidentId && byId.has(r.incidentId))
        .map((r) => ({
          type: "Feature",
          geometry: {
            type: "LineString",
            coordinates: [r.location, byId.get(r.incidentId!)!.location],
          },
          properties: {},
        }))
    ))
  }, [ready, resources, incidents, activity])

  useEffect(() => {
    if (!ready) return
    set("facilities", fc(facilities.map((f) => {
      const spare = f.capacity === null ? null
        : Math.max(0, f.capacity - (f.occupancy ?? 0))
      const tip =
        `<div class="ip-title">${esc(f.name)}</div>` +
        `<div class="ip-sub">${esc(f.kind.replace(/_/g, " "))}</div>` +
        chip(
          f.status.replace(/_/g, " "),
          f.status === "full" || f.status === "closed" ? "#ef4444"
            : f.status === "limited" ? "#f59e0b" : "#0284c7"
        ) +
        row("Capacity", f.capacity) +
        row("Occupied", f.occupancy) +
        (spare !== null
          ? `<div class="ip-row"><span>Places free</span>` +
            `<span class="${spare > 0 ? "ip-ok" : "ip-warn"}">${spare}</span></div>`
          : "") +
        (f.acceptsCasualties === false
          ? `<div class="ip-act ip-warn"><span>Not accepting casualties.</span></div>`
          : "") +
        activityBlock(activity?.get(f.id), "Reported by the crew")
      return point(f.location[0], f.location[1], { id: f.id, status: f.status, tip })
    })))
  }, [ready, facilities, activity])

  useEffect(() => {
    if (!ready) return
    set("blocks", fc(blocks.map((b) =>
      point(b.location[0], b.location[1], {
        id: b.id,
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
      ? fc([{ type: "Feature", geometry: { type: "LineString", coordinates: route }, properties: {} }])
      : fc([]))
  }, [ready, route])

  useEffect(() => {
    if (!ready) return
    set("me", me
      ? fc([point(me.lng, me.lat, {
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
