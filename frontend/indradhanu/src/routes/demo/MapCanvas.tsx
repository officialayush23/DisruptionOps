import { useMemo, useState } from "react"
import type { DemoState, Incident, Resource, Ward } from "./useDemo"

/** The map.
 *
 *  Plain SVG rather than a tile map, on purpose. A tile map needs a token and a
 *  network round trip before anything appears, and the thing being shown here
 *  is not geography, it is motion and relationships: which unit is going where,
 *  which reports collapsed into one incident, what is uncovered. SVG draws that
 *  precisely, animates with CSS transitions, and cannot fail to load.
 *
 *  Coordinates are projected linearly over the bounding box of the wards. Over
 *  a 25 km city that distortion is invisible, and the alternative would imply a
 *  precision this view is not making claims about.
 */

const W = 900
const H = 620
const PAD = 36

type Props = {
  state: DemoState
  onPickIncident: (id: string) => void
  selectedIncident: string | null
}

const KIND_GLYPH: Record<string, string> = {
  boat: "⛵", pump: "💧", ambulance: "🚑", fire_engine: "🚒",
  rescue_team: "🦺", bus: "🚌", jcb: "🚜",
}

const STATUS_COLOR: Record<string, string> = {
  available: "#64748b", assigned: "#0ea5e9", en_route: "#f59e0b",
  on_site: "#10b981", offline: "#475569",
}

function severityFill(sev: number | null): string {
  if (sev === null) return "rgba(148,163,184,0.10)"
  return [
    "rgba(148,163,184,0.10)", "rgba(56,189,248,0.12)", "rgba(250,204,21,0.16)",
    "rgba(249,115,22,0.20)", "rgba(239,68,68,0.26)",
  ][Math.max(0, Math.min(4, sev - 1))]
}

export function MapCanvas({ state, onPickIncident, selectedIncident }: Props) {
  const [hover, setHover] = useState<{ x: number; y: number; lines: string[] } | null>(null)

  const project = useMemo(() => {
    const pts: [number, number][] = [
      ...state.wards.map((w) => w.centroid),
      ...state.wards.flatMap((w) => w.boundary ?? []),
    ]
    if (pts.length === 0) {
      return (lng: number, lat: number) => [W / 2, H / 2] as [number, number]
    }
    const lngs = pts.map((p) => p[0])
    const lats = pts.map((p) => p[1])
    const minLng = Math.min(...lngs), maxLng = Math.max(...lngs)
    const minLat = Math.min(...lats), maxLat = Math.max(...lats)
    const spanLng = Math.max(1e-6, maxLng - minLng)
    const spanLat = Math.max(1e-6, maxLat - minLat)
    // Keep aspect roughly honest so the city is not stretched into the frame.
    const scale = Math.min((W - PAD * 2) / spanLng, (H - PAD * 2) / spanLat)
    const offX = (W - spanLng * scale) / 2
    const offY = (H - spanLat * scale) / 2
    return (lng: number, lat: number): [number, number] => [
      offX + (lng - minLng) * scale,
      // SVG y grows downward; latitude grows north.
      H - offY - (lat - minLat) * scale,
    ]
  }, [state.wards])

  const incidentById = useMemo(
    () => new Map(state.incidents.map((i) => [i.id, i])),
    [state.incidents]
  )

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="bg-muted/20 w-full rounded-lg border"
        onMouseLeave={() => setHover(null)}
      >
        <defs>
          <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="4" result="b" />
            <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
        </defs>

        {/* Wards, shaded by current hazard severity. */}
        {state.wards.map((w: Ward) => {
          const ring = (w.boundary ?? []).map(([lng, lat]) => project(lng, lat))
          if (ring.length < 3) return null
          return (
            <polygon
              key={w.id}
              points={ring.map((p) => p.join(",")).join(" ")}
              fill={severityFill(w.severity)}
              stroke="currentColor"
              strokeOpacity={0.25}
              strokeWidth={1}
              className="text-muted-foreground transition-[fill] duration-700"
              onMouseMove={(e) => {
                const r = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect()
                setHover({
                  x: e.clientX - r.left, y: e.clientY - r.top,
                  lines: [
                    `${w.name} (ward ${w.number})`,
                    `Population ${w.population.toLocaleString()}`,
                    w.score !== null
                      ? `Flood risk ${(w.score * 100).toFixed(0)}%, severity ${w.severity}`
                      : "Not scored yet",
                    w.populationAtRisk ? `${w.populationAtRisk.toLocaleString()} exposed` : "",
                  ].filter(Boolean),
                })
              }}
            />
          )
        })}

        {/* Assignment lines: who is going where, and how far along. */}
        {state.resources
          .filter((r) => r.incidentId && incidentById.has(r.incidentId))
          .map((r) => {
            const inc = incidentById.get(r.incidentId!)!
            const [x1, y1] = project(r.location[0], r.location[1])
            const [x2, y2] = project(inc.location[0], inc.location[1])
            return (
              <line
                key={`link-${r.id}`}
                x1={x1} y1={y1} x2={x2} y2={y2}
                stroke={STATUS_COLOR[r.status] ?? "#94a3b8"}
                strokeWidth={1.5}
                strokeDasharray="5 4"
                strokeOpacity={0.75}
                className="transition-all duration-1000 ease-linear"
              >
                <animate attributeName="stroke-dashoffset" from="9" to="0"
                         dur="0.9s" repeatCount="indefinite" />
              </line>
            )
          })}

        {/* Incidents. Radius grows with how many reports collapsed into it. */}
        {state.incidents.map((i: Incident) => {
          const [x, y] = project(i.location[0], i.location[1])
          const r = 6 + Math.min(10, (i.reportCount - 1) * 2.5)
          const colour = i.severity >= 5 ? "#ef4444" : i.severity >= 4 ? "#f97316" : "#eab308"
          const selected = selectedIncident === i.id
          return (
            <g key={i.id} className="cursor-pointer" onClick={() => onPickIncident(i.id)}
               onMouseMove={(e) => {
                 const rect = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect()
                 setHover({
                   x: e.clientX - rect.left, y: e.clientY - rect.top,
                   lines: [
                     i.title,
                     `Severity ${i.severity} · ${i.status}`,
                     i.reportCount > 1
                       ? `${i.reportCount} reports merged, ${i.reportCount - 1} dispatch${i.reportCount - 1 === 1 ? "" : "es"} avoided`
                       : "1 report",
                     `Confidence ${(i.confidence * 100).toFixed(0)}%`,
                     `${i.unitsEnRoute} unit(s) committed`,
                   ],
                 })
               }}>
              <circle cx={x} cy={y} r={r + 6} fill={colour} opacity={0.18}>
                <animate attributeName="r" values={`${r + 3};${r + 12};${r + 3}`}
                         dur="2.4s" repeatCount="indefinite" />
                <animate attributeName="opacity" values="0.26;0.02;0.26"
                         dur="2.4s" repeatCount="indefinite" />
              </circle>
              <circle cx={x} cy={y} r={r} fill={colour}
                      stroke={selected ? "#fff" : "none"} strokeWidth={selected ? 2.5 : 0}
                      className="transition-all duration-500" />
              {i.reportCount > 1 && (
                <text x={x} y={y + 3.5} textAnchor="middle" fontSize={9}
                      fill="#fff" fontWeight={700}>{i.reportCount}</text>
              )}
            </g>
          )
        })}

        {/* Units. These move between polls; the transition does the animating. */}
        {state.resources.map((r: Resource) => {
          const [x, y] = project(r.location[0], r.location[1])
          return (
            <g key={r.id}
               style={{ transform: `translate(${x}px, ${y}px)`, transition: "transform 1s linear" }}
               onMouseMove={(e) => {
                 const rect = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect()
                 setHover({
                   x: e.clientX - rect.left, y: e.clientY - rect.top,
                   lines: [
                     `${r.label} (${r.id})`,
                     `${r.operator} · capacity ${r.capacity}`,
                     `Status ${r.status.replace(/_/g, " ")}`,
                     r.assignedTo ? `Tasked to ${r.assignedTo}` : "Not tasked",
                     r.etaMinutes ? `ETA ${r.etaMinutes} min` : "",
                     `Can do: ${r.capabilities.map((c) => c.replace(/_/g, " ")).join(", ")}`,
                   ].filter(Boolean),
                 })
               }}>
              <circle r={10} fill={STATUS_COLOR[r.status] ?? "#64748b"} opacity={0.9}
                      filter={r.status === "en_route" ? "url(#glow)" : undefined} />
              <text textAnchor="middle" y={3.5} fontSize={10}>
                {KIND_GLYPH[r.kind] ?? "•"}
              </text>
            </g>
          )
        })}

        {/* You. Arrow keys move this, and a report from here is a real report. */}
        {(() => {
          const [x, y] = project(state.citizen.lng, state.citizen.lat)
          return (
            <g style={{ transform: `translate(${x}px, ${y}px)`, transition: "transform 0.25s ease-out" }}>
              <circle r={16} fill="#8b5cf6" opacity={0.18}>
                <animate attributeName="r" values="12;22;12" dur="2s" repeatCount="indefinite" />
              </circle>
              <circle r={7} fill="#8b5cf6" stroke="#fff" strokeWidth={2} />
              <text y={-16} textAnchor="middle" fontSize={10} fill="currentColor"
                    className="fill-foreground font-medium">You</text>
            </g>
          )
        })()}
      </svg>

      {hover && (
        <div
          className="bg-popover text-popover-foreground pointer-events-none absolute z-10 max-w-64 rounded-md border p-2 text-xs shadow-md"
          style={{
            left: Math.min(hover.x + 12, W - 220),
            top: Math.max(4, hover.y - 8),
          }}
        >
          {hover.lines.map((l, idx) => (
            <div key={idx} className={idx === 0 ? "font-medium" : "text-muted-foreground"}>{l}</div>
          ))}
        </div>
      )}
    </div>
  )
}
