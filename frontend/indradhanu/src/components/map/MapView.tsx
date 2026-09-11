import { useCallback, useEffect, useRef, useState } from "react"
import mapboxgl from "mapbox-gl"
import "mapbox-gl/dist/mapbox-gl.css"
import { Maximize2, Minimize2 } from "lucide-react"
import type {
  Incident,
  LngLat,
  Resource,
  Shelter,
  Ward,
  WardRisk,
} from "@/api/types"
import { cssColor, severityVar } from "@/lib/tokens"
import { useTheme } from "@/components/theme-provider"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_TOKEN as string

const PUNE_CENTER: LngLat = [73.8567, 18.5104]

/* Minimal GeoJSON shapes, so we do not depend on @types/geojson. */
type Feature = {
  type: "Feature"
  id?: number
  properties: Record<string, unknown>
  geometry:
    | { type: "Polygon"; coordinates: LngLat[][] }
    | { type: "LineString"; coordinates: LngLat[] }
}
type FeatureCollection = { type: "FeatureCollection"; features: Feature[] }

export interface MapViewProps {
  wards: Ward[]
  risks?: WardRisk[]
  incidents?: Incident[]
  resources?: Resource[]
  shelters?: Shelter[]
  route?: LngLat[] | null
  focusWardId?: string | null
  selectedWardId?: string | null
  onSelectWard?: (wardId: string | null) => void
  className?: string
  zoom?: number
  /** Adds a control that takes the map full-screen over the app. */
  expandable?: boolean
}

export function MapView({
  wards,
  risks = [],
  incidents = [],
  resources = [],
  shelters = [],
  route = null,
  focusWardId = null,
  selectedWardId = null,
  onSelectWard,
  className,
  zoom = 11.1,
  expandable = false,
}: MapViewProps) {
  const container = useRef<HTMLDivElement | null>(null)
  const map = useRef<mapboxgl.Map | null>(null)
  const ready = useRef(false)
  const framed = useRef(false)
  const markers = useRef<mapboxgl.Marker[]>([])
  /** Mapbox feature state needs numeric ids, so keep a stable index per ward. */
  const idIndex = useRef(new Map<string, number>())
  const [expanded, setExpanded] = useState(false)
  const { theme } = useTheme()
  const dark =
    theme === "dark" ||
    (theme === "system" &&
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches)

  const styleUrl = dark
    ? "mapbox://styles/mapbox/dark-v11"
    : "mapbox://styles/mapbox/light-v11"

  const drawMarkers = useCallback(() => {
    const m = map.current
    if (!m) return
    markers.current.forEach((mk) => mk.remove())
    markers.current = []

    const add = (loc: LngLat, el: HTMLElement) => {
      markers.current.push(
        new mapboxgl.Marker({ element: el }).setLngLat(loc).addTo(m)
      )
    }

    shelters.forEach((s) => {
      const el = document.createElement("div")
      el.className =
        "flex size-5 items-center justify-center rounded-sm border border-background bg-foreground text-background text-[9px] font-bold shadow"
      el.textContent = "S"
      el.title = `${s.name} — ${s.occupancy}/${s.capacity}`
      add(s.location, el)
    })

    resources.forEach((r) => {
      const el = document.createElement("div")
      const tone =
        r.status === "en_route"
          ? "bg-status-active"
          : r.status === "assigned"
            ? "bg-status-pending"
            : "bg-muted-foreground"
      el.className = `size-2.5 rounded-full border border-background ${tone} shadow`
      el.title = `${r.label} — ${r.status.replace("_", " ")}`
      add(r.location, el)
    })

    incidents.forEach((i) => {
      const el = document.createElement("div")
      el.className =
        "flex size-6 items-center justify-center rounded-full border-2 border-background text-[10px] font-bold text-white shadow-md"
      el.style.backgroundColor = cssColor(severityVar[i.severity], "#b23a24")
      el.textContent = String(i.reportCount)
      el.title = `${i.title} — ${i.reportCount} reports`
      add(i.location, el)
    })
  }, [shelters, resources, incidents])

  const draw = useCallback(() => {
    const m = map.current
    if (!m || !m.isStyleLoaded()) return

    idIndex.current = new Map(wards.map((w, i) => [w.id, i + 1]))
    const riskBy = new Map(risks.map((r) => [r.wardId, r]))
    const noRisk = dark ? "#3a3a3a" : "#e9edf1"

    const fc: FeatureCollection = {
      type: "FeatureCollection",
      features: wards.map((w, i) => {
        const r = riskBy.get(w.id)
        return {
          type: "Feature",
          id: i + 1,
          properties: {
            id: w.id,
            name: w.name,
            number: w.number,
            score: r?.score ?? 0,
            severity: r?.severity ?? 0,
            color: r ? cssColor(severityVar[r.severity], noRisk) : noRisk,
            hasRisk: r ? 1 : 0,
          },
          geometry: { type: "Polygon", coordinates: [w.boundary] },
        }
      }),
    }

    const src = m.getSource("wards") as mapboxgl.GeoJSONSource | undefined
    if (src) {
      src.setData(fc as never)
    } else {
      m.addSource("wards", { type: "geojson", data: fc as never })
      m.addLayer({
        id: "ward-fill",
        type: "fill",
        source: "wards",
        paint: {
          "fill-color": ["get", "color"],
          "fill-opacity": [
            "case",
            ["boolean", ["feature-state", "selected"], false],
            0.78,
            ["==", ["get", "hasRisk"], 1],
            0.55,
            0.25,
          ],
        },
      })
      m.addLayer({
        id: "ward-line",
        type: "line",
        source: "wards",
        paint: {
          "line-color": dark ? "#9aa7b2" : "#5a6b7b",
          "line-width": [
            "case",
            ["boolean", ["feature-state", "selected"], false],
            2.6,
            0.8,
          ],
        },
      })
      m.addLayer({
        id: "ward-label",
        type: "symbol",
        source: "wards",
        layout: {
          "text-field": ["concat", ["get", "number"], " · ", ["get", "name"]],
          "text-size": 10.5,
          "text-allow-overlap": false,
        },
        paint: {
          "text-color": dark ? "#eaeef2" : "#22303c",
          "text-halo-color": dark ? "#0d0d0d" : "#ffffff",
          "text-halo-width": 1.3,
        },
      })
      m.on("click", "ward-fill", (e) => {
        const f = e.features?.[0] as
          { properties?: Record<string, unknown> } | undefined
        if (f?.properties) onSelectWard?.(String(f.properties.id))
      })
      m.on("mouseenter", "ward-fill", () => {
        m.getCanvas().style.cursor = "pointer"
      })
      m.on("mouseleave", "ward-fill", () => {
        m.getCanvas().style.cursor = ""
      })
    }

    const routeFc: FeatureCollection = {
      type: "FeatureCollection",
      features: route
        ? [
            {
              type: "Feature",
              properties: {},
              geometry: { type: "LineString", coordinates: route },
            },
          ]
        : [],
    }
    const rsrc = m.getSource("route") as mapboxgl.GeoJSONSource | undefined
    if (rsrc) {
      rsrc.setData(routeFc as never)
    } else {
      m.addSource("route", { type: "geojson", data: routeFc as never })
      m.addLayer({
        id: "route-line",
        type: "line",
        source: "route",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": cssColor("--primary", "#7bd320"),
          "line-width": 4,
          "line-dasharray": [1.6, 1.1],
        },
      })
    }

    // Frame the city once we actually have geometry. Doing this rather than
    // trusting a hardcoded centre means the map is never looking at ocean
    // because the container measured zero on first paint.
    if (!framed.current && wards.length) {
      const bounds = new mapboxgl.LngLatBounds()
      wards.forEach((w) =>
        w.boundary.forEach((p) => bounds.extend(p as [number, number]))
      )
      if (!bounds.isEmpty()) {
        m.fitBounds(bounds, { padding: 48, duration: 0, maxZoom: 13 })
        framed.current = true
      }
    }

    drawMarkers()
  }, [wards, risks, route, dark, onSelectWard, drawMarkers])

  /* ---- init ---- */
  useEffect(() => {
    if (!container.current || map.current) return
    const m = new mapboxgl.Map({
      container: container.current,
      style: styleUrl,
      center: PUNE_CENTER,
      zoom,
      attributionControl: false,
    })
    map.current = m
    m.addControl(
      new mapboxgl.NavigationControl({ showCompass: false }),
      "top-right"
    )
    m.on("load", () => {
      ready.current = true
      m.resize()
      draw()
    })
    m.on("error", (e) => {
      // A tile or style failure should be visible, not swallowed.
      console.error("[mapbox]", e?.error?.message ?? e)
    })
    return () => {
      m.remove()
      map.current = null
      ready.current = false
      framed.current = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* ---- keep the canvas the size of its container ----
     Essential inside a resizable panel: the map is created before the panel
     has laid out, so without this the canvas keeps its initial size and the
     tiles render into a corner of a mostly black area. */
  useEffect(() => {
    const el = container.current
    if (!el || typeof ResizeObserver === "undefined") return
    const ro = new ResizeObserver(() => map.current?.resize())
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    // Expanding changes the container size outside the observer's first frame.
    const id = window.setTimeout(() => map.current?.resize(), 60)
    return () => window.clearTimeout(id)
  }, [expanded])

  /* ---- theme swap ---- */
  useEffect(() => {
    const m = map.current
    if (!m || !ready.current) return
    m.setStyle(styleUrl)
    m.once("styledata", () => draw())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [styleUrl])

  /* ---- data ---- */
  useEffect(() => {
    if (ready.current) draw()
  }, [draw])

  /* ---- selection ---- */
  useEffect(() => {
    const m = map.current
    if (!m || !ready.current || !m.getSource("wards")) return
    idIndex.current.forEach((numericId, wardId) => {
      m.setFeatureState(
        { source: "wards", id: numericId },
        { selected: wardId === selectedWardId }
      )
    })
  }, [selectedWardId, wards])

  /* ---- focus ---- */
  useEffect(() => {
    const m = map.current
    if (!m || !focusWardId) return
    const w = wards.find((x) => x.id === focusWardId)
    if (w)
      m.flyTo({
        center: w.centroid,
        zoom: 12.6,
        duration: 1600,
        essential: true,
      })
  }, [focusWardId, wards])

  /* ---- escape closes the expanded map ---- */
  useEffect(() => {
    if (!expanded) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExpanded(false)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [expanded])

  return (
    <div
      className={cn(
        "relative",
        expanded ? "fixed inset-0 z-50 bg-background" : className
      )}
    >
      <div ref={container} className="h-full w-full" />
      {expandable && (
        <Button
          size="icon"
          variant="outline"
          className="absolute top-2 left-2 z-10 size-8"
          onClick={() => setExpanded((v) => !v)}
          title={expanded ? "Exit full screen (Esc)" : "Expand map"}
          aria-label={expanded ? "Exit full screen" : "Expand map"}
        >
          {expanded ? (
            <Minimize2 className="size-4" />
          ) : (
            <Maximize2 className="size-4" />
          )}
        </Button>
      )}
    </div>
  )
}
