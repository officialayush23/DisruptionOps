import { memo, useMemo } from "react"
import type { DemoState } from "@/routes/demo/useDemo"
import { zoomFor, type Zone } from "./zones"

/** A wall screen without WebGL.
 *
 *  Each live Mapbox map costs tens of megabytes (its own GL context, workers,
 *  tile and glyph caches, icon atlas). A wall of them was most of the page's
 *  memory and what made clicks lag. A screen now is one static basemap image
 *  from Mapbox's Static Images API (fetched once, then served from the browser
 *  cache) with the live layer drawn over it as SVG: the ward outline, incidents
 *  by severity, units working it, road blocks. Expanding a screen opens one
 *  real, interactive map.
 */

const TOKEN = import.meta.env.VITE_MAPBOX_TOKEN as string | undefined
const SEV: Record<number, string> = { 5: "#d03b3b", 4: "#ec835a", 3: "#fab219", 2: "#94a3b8", 1: "#cbd5e1" }
const STEP = 40            // image sizes snap to this, so resizing reuses cached images
const MAX = 1280           // Static Images API limit

/** Web Mercator at Mapbox GL zoom (512 px tiles). */
function px(lng: number, lat: number, zoom: number): [number, number] {
  const world = 512 * 2 ** zoom
  const s = Math.sin((Math.max(-85, Math.min(85, lat)) * Math.PI) / 180)
  return [((lng + 180) / 360) * world, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * world]
}

function WallMiniMapImpl({ state, zone, w, h }: {
  state: DemoState; zone: Zone | null; w: number; h: number
}) {
  const W = Math.min(MAX, Math.max(STEP, Math.round(w / STEP) * STEP))
  const H = Math.min(MAX, Math.max(STEP, Math.round(h / STEP) * STEP))
  const center = useMemo<[number, number]>(() => (zone ? zone.center : [73.86, 18.53]), [zone])
  const zoom = zone ? zoomFor(zone) - 0.4 : 10.4
  const dark = typeof document !== "undefined" && document.documentElement.classList.contains("dark")

  const src = TOKEN
    ? `https://api.mapbox.com/styles/v1/mapbox/${dark ? "dark-v11" : "light-v11"}/static/` +
      `${center[0].toFixed(4)},${center[1].toFixed(4)},${zoom.toFixed(2)},0/${W}x${H}` +
      `?attribution=false&logo=false&access_token=${TOKEN}`
    : null

  const layer = useMemo(() => {
    const [cx, cy] = px(center[0], center[1], zoom)
    const at = (loc: [number, number]) => {
      const [x, y] = px(loc[0], loc[1], zoom)
      return [x - cx + W / 2, y - cy + H / 2] as const
    }
    const inView = ([x, y]: readonly [number, number]) => x > -10 && y > -10 && x < W + 10 && y < H + 10
    const incidents = (zone ? zone.incidents : state.incidents.filter((i) => !/resolved|closed|cancel/i.test(i.status)))
    const ids = new Set(incidents.map((i) => i.id))
    const ring = zone ? state.wards.find((x) => x.id === zone.id)?.boundary : null
    const wardPath = ring && ring.length >= 3
      ? ring.map((p, k) => {
          const [x, y] = at(p)
          return `${k ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`
        }).join(" ") + " Z"
      : null
    return {
      wardPath,
      incidents: incidents.map((i) => ({ id: i.id, p: at(i.location), sev: i.severity, un: !i.unitsEnRoute }))
        .filter((d) => inView(d.p)),
      units: state.resources
        .filter((r) => r.incidentId && (!zone || ids.has(r.incidentId)))
        .map((r) => ({ id: r.id, p: at(r.location) }))
        .filter((d) => inView(d.p)),
      blocks: state.roadBlocks.map((b) => ({ id: b.id, p: at(b.location) })).filter((d) => inView(d.p)),
    }
  }, [state, zone, center, zoom, W, H])

  return (
    <div className="relative h-full w-full bg-zinc-900">
      {src && (
        <img
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          className="absolute inset-0 h-full w-full object-cover"
        />
      )}
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="xMidYMid slice"
        className="pointer-events-none absolute inset-0 h-full w-full"
      >
        {layer.wardPath && (
          <path d={layer.wardPath} fill="rgba(239,68,68,0.08)" stroke="#ef4444" strokeWidth={1.5} strokeDasharray="4 3" />
        )}
        {layer.blocks.map((b) => (
          <g key={b.id} transform={`translate(${b.p[0]},${b.p[1]})`} stroke="#b91c1c" strokeWidth={2.5}>
            <line x1={-4} y1={-4} x2={4} y2={4} />
            <line x1={-4} y1={4} x2={4} y2={-4} />
          </g>
        ))}
        {layer.units.map((u) => (
          <circle key={u.id} cx={u.p[0]} cy={u.p[1]} r={3.5} fill="#0ea5e9" stroke="white" strokeWidth={1} />
        ))}
        {layer.incidents.map((i) => (
          <g key={i.id}>
            {i.un && <circle cx={i.p[0]} cy={i.p[1]} r={10} fill="none" stroke="#f59e0b" strokeWidth={1.5} strokeDasharray="3 2" />}
            <circle cx={i.p[0]} cy={i.p[1]} r={i.sev >= 4 ? 6.5 : 5} fill={SEV[i.sev] ?? "#94a3b8"} stroke="white" strokeWidth={1.5} />
          </g>
        ))}
      </svg>
      {!TOKEN && (
        <div className="absolute inset-0 flex items-center justify-center text-xs text-zinc-400">
          VITE_MAPBOX_TOKEN not set
        </div>
      )}
    </div>
  )
}

/** Only redraws when its inputs change; the wall passes a throttled state. */
export const WallMiniMap = memo(WallMiniMapImpl)
