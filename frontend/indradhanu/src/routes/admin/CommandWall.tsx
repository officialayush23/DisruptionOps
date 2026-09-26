import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useNavigate } from "react-router-dom"
import {
  ChevronLeft, ChevronRight, Maximize2, MonitorPlay, Siren, Truck, Users, X,
} from "lucide-react"
import { useDemo } from "@/routes/demo/DemoProvider"
import type { DemoState } from "@/routes/demo/useDemo"
import { LiveMap } from "@/components/map/LiveMap"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import WallAnalytics from "./WallAnalytics"
import { zoneLayers, zonesOf, zoomFor, type Zone } from "./zones"

/** The command wall.
 *
 *  A Liquid Galaxy style row of screens across the top. The first, wider screen
 *  is the whole city. Every ward with an open incident gets its own screen,
 *  zoomed in on just that area, added the moment the first incident opens there
 *  and removed when the last one closes. Expanding a screen takes the whole
 *  display, zoomed further, with the zone's incidents beside it and arrows to
 *  step to the neighbouring screens, the way a galaxy rig pans between displays.
 *
 *  Below the strip, the analytics: every number the system has, each chart with
 *  a jump to the page that acts on it.
 */

const SEV_BAR: Record<number, string> = {
  5: "bg-[#d03b3b]", 4: "bg-[#ec835a]", 3: "bg-[#fab219]", 2: "bg-zinc-400", 1: "bg-zinc-300",
}

/** Mount a map only while its screen is on (or near) the viewport. Nine WebGL
 *  contexts at once is fine; forty is not, and a busy day has forty wards. */
function useOnScreen<T extends Element>(margin = "300px") {
  const ref = useRef<T | null>(null)
  const [seen, setSeen] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const io = new IntersectionObserver(([e]) => setSeen(e.isIntersecting), { rootMargin: margin })
    io.observe(el)
    return () => io.disconnect()
  }, [margin])
  return [ref, seen] as const
}

function ScreenMap({ state, zone, big, className }: {
  state: DemoState; zone: Zone | null; big?: boolean; className: string
}) {
  const navigate = useNavigate()
  const pick = useCallback((id: string) => navigate(`/admin/response?incident=${id}`), [navigate])
  if (!zone) {
    return (
      <LiveMap
        className={className}
        wards={state.wards}
        incidents={state.incidents}
        resources={state.resources}
        facilities={state.facilities}
        blocks={state.roadBlocks}
        needs={state.needs}
        routes={state.routes}
        onPickIncident={pick}
        zoom={big ? 11.8 : 10.9}
      />
    )
  }
  const l = zoneLayers(state, zone)
  return (
    <LiveMap
      // Keyed by zone: a screen's camera is set when it is created, so a new
      // zone in the same slot gets a fresh, correctly centred map.
      key={`${zone.id}-${big ? "big" : "tile"}`}
      className={className}
      wards={l.wards}
      incidents={l.incidents}
      resources={l.resources}
      facilities={l.facilities}
      blocks={l.blocks}
      needs={l.needs}
      routes={l.routes}
      onPickIncident={pick}
      center={zone.center}
      zoom={zoomFor(zone, big)}
    />
  )
}

function Screen({ state, zone, onExpand, main, fresh }: {
  state: DemoState; zone: Zone | null; onExpand: () => void; main?: boolean; fresh?: boolean
}) {
  const [ref, onScreen] = useOnScreen<HTMLDivElement>()
  const openCount = state.incidents.filter((i) => !/resolved|closed|cancel/i.test(i.status)).length
  return (
    <div
      ref={ref}
      className={`group relative shrink-0 snap-start overflow-hidden rounded-lg border-2 bg-black shadow-lg ${
        main ? "w-[520px] border-sky-500/70" : "w-[340px] border-zinc-700"
      } ${fresh ? "ring-4 ring-amber-400/70 animate-pulse" : ""}`}
    >
      <div className="absolute inset-x-0 top-0 z-10 flex items-center gap-2 bg-gradient-to-b from-black/90 to-black/0 px-2.5 py-1.5 text-white">
        {zone ? (
          <span className={`h-3 w-1.5 rounded-sm ${SEV_BAR[zone.severity] ?? "bg-zinc-400"}`} />
        ) : (
          <MonitorPlay className="size-3.5 text-sky-300" />
        )}
        <span className="truncate text-xs font-semibold tracking-wide uppercase">
          {zone ? zone.name : "All zones · city"}
        </span>
        {fresh && <Badge className="h-4 bg-amber-400 px-1 text-[10px] text-black">NEW</Badge>}
        <span className="ml-auto flex items-center gap-2 text-[11px] tabular-nums text-zinc-300">
          {zone ? (
            <>
              <span title="open incidents"><Siren className="mr-0.5 inline size-3" />{zone.incidents.length}</span>
              <span title="units en route"><Truck className="mr-0.5 inline size-3" />{zone.unitsEnRoute}</span>
              {zone.unattended > 0 && (
                <span className="rounded bg-amber-500 px-1 text-black" title="incidents with nobody on the way">
                  {zone.unattended} unassigned
                </span>
              )}
            </>
          ) : (
            <span>{openCount} open</span>
          )}
        </span>
      </div>
      {onScreen ? (
        <ScreenMap state={state} zone={zone} className={main ? "h-[300px] w-full" : "h-[300px] w-full"} />
      ) : (
        <div className="h-[300px] w-full bg-zinc-900" />
      )}
      <button
        onClick={onExpand}
        className="absolute right-2 bottom-2 z-10 rounded-md bg-black/70 p-1.5 text-white opacity-80 transition group-hover:opacity-100 hover:bg-black"
        aria-label={`Expand ${zone ? zone.name : "city"} screen`}
      >
        <Maximize2 className="size-4" />
      </button>
    </div>
  )
}

function Expanded({ state, zones, index, onClose, onStep }: {
  state: DemoState; zones: Zone[]; index: number; onClose: () => void; onStep: (d: number) => void
}) {
  const navigate = useNavigate()
  const zone = index < 0 ? null : zones[index]
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
      if (e.key === "ArrowRight") onStep(1)
      if (e.key === "ArrowLeft") onStep(-1)
    }
    window.addEventListener("keydown", onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = "hidden"
    return () => {
      window.removeEventListener("keydown", onKey)
      document.body.style.overflow = prev
    }
  }, [onClose, onStep])

  const list = zone ? zone.incidents : state.incidents.filter((i) => !/resolved|closed|cancel/i.test(i.status))
  const wardName = new Map(state.wards.map((w) => [w.id, w.name]))

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black text-white">
      <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-2">
        <Button size="icon" variant="ghost" className="text-white hover:bg-zinc-800" onClick={() => onStep(-1)} aria-label="Previous screen">
          <ChevronLeft className="size-5" />
        </Button>
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold uppercase tracking-wide">
            {zone ? zone.name : "All zones · city"}
          </div>
          <div className="text-xs text-zinc-400">
            Screen {index + 2} of {zones.length + 1} · ← → to move between screens · Esc to close
          </div>
        </div>
        <Button size="icon" variant="ghost" className="text-white hover:bg-zinc-800" onClick={() => onStep(1)} aria-label="Next screen">
          <ChevronRight className="size-5" />
        </Button>
        <Button size="icon" variant="ghost" className="ml-auto text-white hover:bg-zinc-800" onClick={onClose} aria-label="Close">
          <X className="size-5" />
        </Button>
      </div>
      <div className="grid min-h-0 flex-1 lg:grid-cols-[1fr_360px]">
        <ScreenMap state={state} zone={zone} big className="h-full min-h-[50vh] w-full" />
        <aside className="min-h-0 overflow-y-auto border-l border-zinc-800 p-3">
          {zone && (
            <div className="mb-3 grid grid-cols-3 gap-2 text-center">
              <Kpi label="Incidents" value={zone.incidents.length} />
              <Kpi label="Units en route" value={zone.unitsEnRoute} />
              <Kpi label="Reports" value={zone.reports} />
            </div>
          )}
          <ul className="space-y-1.5">
            {list.map((i) => (
              <li key={i.id}>
                <button
                  onClick={() => navigate(`/admin/response?incident=${i.id}`)}
                  className="w-full rounded-md border border-zinc-800 bg-zinc-900 p-2 text-left text-sm hover:border-sky-500"
                >
                  <div className="flex items-start gap-2">
                    <span className={`mt-1 h-3 w-1.5 shrink-0 rounded-sm ${SEV_BAR[i.severity] ?? "bg-zinc-400"}`} />
                    <span className="flex-1 leading-tight">{i.title}</span>
                    <span className="text-xs text-zinc-400">S{i.severity}</span>
                  </div>
                  <div className="mt-1 pl-3.5 text-xs text-zinc-400">
                    {!zone && `${wardName.get(i.wardId) ?? i.wardId} · `}
                    {i.reportCount} report{i.reportCount === 1 ? "" : "s"} ·{" "}
                    {i.unitsEnRoute ? (
                      `${i.unitsEnRoute} unit${i.unitsEnRoute === 1 ? "" : "s"} en route`
                    ) : (
                      <span className="text-amber-400">nobody assigned</span>
                    )}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </aside>
      </div>
    </div>
  )
}

function Kpi({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-900 p-2">
      <div className="text-lg font-semibold tabular-nums">{value}</div>
      <div className="text-[11px] text-zinc-400">{label}</div>
    </div>
  )
}

export default function CommandWall() {
  const { state } = useDemo()
  const zones = useMemo(() => zonesOf(state), [state])
  // -2 = closed, -1 = the city screen, 0..n-1 = a zone.
  const [open, setOpen] = useState(-2)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 5000)
    return () => clearInterval(id)
  }, [])
  const step = useCallback(
    (d: number) => setOpen((i) => {
      const n = zones.length + 1
      const pos = (((i + 1 + d) % n) + n) % n
      return pos - 1
    }),
    [zones.length],
  )
  const strip = useRef<HTMLDivElement | null>(null)
  const scroll = (d: number) => strip.current?.scrollBy({ left: d * 360, behavior: "smooth" })

  const unattended = zones.reduce((s, z) => s + z.unattended, 0)

  return (
    <div className="space-y-5 p-4 md:p-6">
      <section className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <MonitorPlay className="size-4" />
          <h2 className="text-sm font-semibold">Live wall</h2>
          <span className="text-muted-foreground text-xs">
            {zones.length} active zone{zones.length === 1 ? "" : "s"}
            {unattended > 0 && <> · <b className="text-amber-600 dark:text-amber-400">{unattended} incident{unattended === 1 ? "" : "s"} with nobody assigned</b></>}
            {" "}· a screen is added for every ward with an open incident
          </span>
          <div className="ml-auto flex gap-1">
            <Button size="icon" variant="outline" className="size-8" onClick={() => scroll(-1)} aria-label="Scroll left">
              <ChevronLeft className="size-4" />
            </Button>
            <Button size="icon" variant="outline" className="size-8" onClick={() => scroll(1)} aria-label="Scroll right">
              <ChevronRight className="size-4" />
            </Button>
          </div>
        </div>
        <div
          ref={strip}
          className="flex snap-x gap-2 overflow-x-auto rounded-xl bg-zinc-950 p-2 [scrollbar-width:thin]"
        >
          <Screen state={state} zone={null} main onExpand={() => setOpen(-1)} />
          {zones.map((z, i) => (
            <Screen
              key={z.id}
              state={state}
              zone={z}
              fresh={now - z.since < 2 * 60_000}
              onExpand={() => setOpen(i)}
            />
          ))}
          {zones.length === 0 && (
            <div className="flex w-[340px] shrink-0 items-center justify-center rounded-lg border-2 border-dashed border-zinc-700 p-6 text-center text-sm text-zinc-400">
              <Users className="mr-2 size-4" /> No open incidents. Zone screens appear here as soon as one opens.
            </div>
          )}
        </div>
      </section>

      <WallAnalytics zones={zones} now={now} />

      {open > -2 && (
        <Expanded
          state={state}
          zones={zones}
          index={Math.min(open, zones.length - 1)}
          onClose={() => setOpen(-2)}
          onStep={step}
        />
      )}
    </div>
  )
}
