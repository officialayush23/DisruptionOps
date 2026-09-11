import { useEffect, useRef, useState } from "react"
import mapboxgl from "mapbox-gl"
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

export type WardFeature = {
  id: string; name: string; number?: string; boundary: [number, number][] | null
  severity: number | null; score: number | null; population?: number
}
export type IncidentFeature = {
  id: string; title: string; category: string; severity: number
  reportCount: number; confidence?: number; unitsEnRoute?: number
  location: [number, number]
}
export type ResourceFeature = {
  id: string; kind: string; label: string; status: string; operator?: string
  capacity?: number; capabilities?: string[]; assignedTo?: string | null
  etaMinutes?: number | null; location: [number, number]
  incidentId?: string | null
}
export type FacilityFeature = {
  id: string; name: string; kind: string; status: string
  capacity: number | null; occupancy: number | null; location: [number, number]
}
export type BlockFeature = {
  id: string; reason: string; location: [number, number]
}

type Props = {
  wards?: WardFeature[]
  incidents?: IncidentFeature[]
  resources?: ResourceFeature[]
  facilities?: FacilityFeature[]
  blocks?: BlockFeature[]
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

function fc(features: GeoJSON.Feature[]): GeoJSON.FeatureCollection {
  return { type: "FeatureCollection", features }
}
const point = (lng: number, lat: number, props: Record<string, unknown>): GeoJSON.Feature => ({
  type: "Feature", geometry: { type: "Point", coordinates: [lng, lat] }, properties: props,
})

export function LiveMap({
  wards = [], incidents = [], resources = [], facilities = [], blocks = [],
  route, me, center = [73.88, 18.58], zoom = 10.2, className,
  onPickIncident, followMe = false,
}: Props) {
  const container = useRef<HTMLDivElement>(null)
  const map = useRef<mapboxgl.Map | null>(null)
  const popup = useRef<mapboxgl.Popup | null>(null)
  const [ready, setReady] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)

  useEffect(() => {
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
      popup.current = new mapboxgl.Popup({ closeButton: false, closeOnClick: false, offset: 12 })

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
          layout: { "text-field": ["to-string", ["get", "reportCount"]],
                    "text-size": 11, "text-allow-overlap": true },
          paint: { "text-color": "#fff" },
        })

        m.addSource("resources", { type: "geojson", data: fc([]) })
        m.addLayer({
          id: "resource-dot", type: "circle", source: "resources",
          paint: {
            "circle-radius": 9, "circle-color": STATUS_COLOR,
            "circle-stroke-width": 2, "circle-stroke-color": "#fff",
          },
        })
        m.addLayer({
          id: "resource-glyph", type: "symbol", source: "resources",
          layout: { "text-field": ["get", "glyph"], "text-size": 11,
                    "text-allow-overlap": true },
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

        const hoverable = ["incident-dot", "resource-dot", "facility-dot", "block-dot", "ward-fill"]
        for (const layer of hoverable) {
          m.on("mousemove", layer, (e) => {
            const f = e.features?.[0]
            if (!f) return
            m.getCanvas().style.cursor = layer === "ward-fill" ? "" : "pointer"
            popup.current
              ?.setLngLat(e.lngLat)
              .setHTML(String(f.properties?.tip ?? ""))
              .addTo(m)
          })
          m.on("mouseleave", layer, () => {
            m.getCanvas().style.cursor = ""
            popup.current?.remove()
          })
        }
        m.on("click", "incident-dot", (e) => {
          const id = e.features?.[0]?.properties?.id
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

  const set = (id: string, data: GeoJSON.FeatureCollection) => {
    const src = map.current?.getSource(id) as mapboxgl.GeoJSONSource | undefined
    src?.setData(data)
  }

  useEffect(() => {
    if (!ready) return
    set("wards", fc(
      wards
        .filter((w) => (w.boundary?.length ?? 0) >= 3)
        .map((w) => ({
          type: "Feature",
          geometry: { type: "Polygon", coordinates: [w.boundary as number[][]] },
          properties: {
            id: w.id, severity: w.severity ?? 0,
            tip: `<strong>${w.name}</strong><br/>${
              w.score !== null && w.score !== undefined
                ? `Flood risk ${(w.score * 100).toFixed(0)}%, severity ${w.severity}`
                : "Not scored yet"
            }${w.population ? `<br/>Population ${w.population.toLocaleString()}` : ""}`,
          },
        }))
    ))
  }, [ready, wards])

  useEffect(() => {
    if (!ready) return
    set("incidents", fc(incidents.map((i) =>
      point(i.location[0], i.location[1], {
        id: i.id, severity: i.severity, reportCount: i.reportCount,
        tip: `<strong>${i.title}</strong><br/>Severity ${i.severity}${
          i.reportCount > 1
            ? `<br/><em>${i.reportCount} reports merged, ${i.reportCount - 1} dispatch${i.reportCount - 1 === 1 ? "" : "es"} avoided</em>`
            : ""
        }${i.unitsEnRoute ? `<br/>${i.unitsEnRoute} unit(s) committed` : ""}`,
      })
    )))
  }, [ready, incidents])

  useEffect(() => {
    if (!ready) return
    const glyph: Record<string, string> = {
      boat: "⛵", pump: "💧", ambulance: "🚑", fire_engine: "🚒",
      rescue_team: "🦺", bus: "🚌", jcb: "🚜",
    }
    set("resources", fc(resources.map((r) =>
      point(r.location[0], r.location[1], {
        id: r.id, status: r.status, glyph: glyph[r.kind] ?? "•",
        tip: `<strong>${r.label}</strong><br/>${r.operator ?? ""}<br/>Status ${
          r.status.replace(/_/g, " ")
        }${r.assignedTo ? `<br/>Tasked to ${r.assignedTo}` : ""}${
          r.etaMinutes ? `<br/>ETA ${r.etaMinutes} min` : ""
        }${r.capabilities?.length ? `<br/><em>${r.capabilities.map((c) => c.replace(/_/g, " ")).join(", ")}</em>` : ""}`,
      })
    )))
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
  }, [ready, resources, incidents])

  useEffect(() => {
    if (!ready) return
    set("facilities", fc(facilities.map((f) =>
      point(f.location[0], f.location[1], {
        id: f.id, status: f.status,
        tip: `<strong>${f.name}</strong><br/>${f.kind}${
          f.capacity ? `<br/>${Math.max(0, f.capacity - (f.occupancy ?? 0))} of ${f.capacity} free` : ""
        }<br/>Reported ${f.status}`,
      })
    )))
  }, [ready, facilities])

  useEffect(() => {
    if (!ready) return
    set("blocks", fc(blocks.map((b) =>
      point(b.location[0], b.location[1], {
        id: b.id, tip: `<strong>Road blocked</strong><br/>${b.reason}`,
      })
    )))
  }, [ready, blocks])

  useEffect(() => {
    if (!ready) return
    set("route", route && route.length > 1
      ? fc([{ type: "Feature", geometry: { type: "LineString", coordinates: route }, properties: {} }])
      : fc([]))
  }, [ready, route])

  useEffect(() => {
    if (!ready) return
    set("me", me ? fc([point(me.lng, me.lat, { tip: me.label ?? "You" })]) : fc([]))
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
