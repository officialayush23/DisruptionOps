import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useNavigate } from "react-router-dom"
import {
  ChevronLeft, ChevronRight, Database, Maximize2, MonitorPlay, Siren, Truck, Users, X,
} from "lucide-react"
import { useDemo } from "@/routes/demo/DemoProvider"
import type { DemoState } from "@/routes/demo/useDemo"
import { LiveMap } from "@/components/map/LiveMap"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import WallAnalytics from "./WallAnalytics"
import { WallMiniMap } from "./WallMiniMap"
import { WardPanel } from "./WardPanel"
import {
  REGIONS, scopeState, zoneLayers, zonesOf, zoomFor, type Region, type Zone,
} from "./zones"

/** The command wall.
 *
 *  A Liquid Galaxy style row of screens across the top. The first, wider screen
 *  is the whole city. Every ward with an open incident gets its own screen,
 *  zoomed in on just that area, added the moment the first incident opens there
 *  and removed when the last one closes — the row grows and shrinks with the
 *  disaster. Every screen can be resized by its corner handle (or all at once
 *  with S / M / L), and remembers its size. Expanding a screen takes the whole
 *  display with ← → to step between screens. Clicking a ward on any screen
 *  opens that ward's numbers and its approvals.
 *
 *  Speed: maps are built once and kept (scrolling past a screen does not tear
 *  it down), each screen shows its last picture from the local cache until the
 *  live map has painted, the world itself is cached so the wall draws before
 *  the server answers, and the small screens refresh their data every few
 *  seconds rather than every poll.
 */

const SEV_BAR: Record<number, string> = {
  5: "bg-[#d03b3b]", 4: "bg-[#ec835a]", 3: "bg-[#fab219]", 2: "bg-zinc-400", 1: "bg-zinc-300",
}

type Size = { w: number; h: number }
const PRESETS: Record<"S" | "M" | "L", Size> = {
  S: { w: 280, h: 210 }, M: { w: 360, h: 290 }, L: { w: 520, h: 390 },
}
const SIZE_KEY = "wall:sizes:v1"
const PRESET_KEY = "wall:preset:v1"

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}
function save(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* private mode: sizes just are not remembered */
  }
}

/** Build a screen's map the first time it comes near the viewport, then keep
 *  it. Rebuilding on every scroll was the slowest thing on this page. */
function useSeenOnce<T extends Element>(margin = "400px") {
  const ref = useRef<T | null>(null)
  const [seen, setSeen] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el || seen) return
    const io = new IntersectionObserver(([e]) => {
      if (e.isIntersecting) {
        setSeen(true)
        io.disconnect()
      }
    }, { rootMargin: margin })
    io.observe(el)
    return () => io.disconnect()
  }, [margin, seen])
  return [ref, seen] as const
}

/** The world, refreshed at most every `ms`. Small screens do not need the
 *  once-a-second poll, and re-feeding ten maps every second is what made them
 *  stutter. */
function useThrottledState(state: DemoState, ms: number, resetKey = ""): DemoState {
  const latest = useRef(state)
  const [slow, setSlow] = useState(state)
  // A different region is a different picture: show it now, not in 4 s.
  const [key, setKey] = useState(resetKey)
  if (key !== resetKey) {
    setKey(resetKey)
    setSlow(state)
  }
  useEffect(() => {
    latest.current = state
  }, [state])
  useEffect(() => {
    const id = setInterval(() => setSlow(latest.current), ms)
    return () => clearInterval(id)
  }, [ms])
  return slow
}

function ScreenMap({ state, zone, region, big, className, onPickWard }: {
  state: DemoState; zone: Zone | null; region?: Region | null; big?: boolean; className: string
  onPickWard?: (id: string) => void
}) {
  const navigate = useNavigate()
  const pick = useCallback((id: string) => navigate(`/admin/response?incident=${id}`), [navigate])
  const layers = useMemo(() => (zone ? zoneLayers(state, zone) : null), [state, zone])
  if (!zone || !layers) {
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
        onPickWard={onPickWard}
        key={region?.id ?? "all"}
        center={region?.center}
        zoom={region ? region.zoom + (big ? 0.6 : 0) : big ? 11.8 : 10.9}
      />
    )
  }
  return (
    <LiveMap
      key={`${zone.id}-${big ? "big" : "tile"}`}
      className={className}
      wards={layers.wards}
      incidents={layers.incidents}
      resources={layers.resources}
      facilities={layers.facilities}
      blocks={layers.blocks}
      needs={layers.needs}
      routes={layers.routes}
      onPickIncident={pick}
      onPickWard={onPickWard}
      center={zone.center}
      zoom={zoomFor(zone, big)}
    />
  )
}

function Screen({ state, zone, region, onExpand, main, fresh, size, onResize, selected, onSelect }: {
  state: DemoState; zone: Zone | null; region?: Region | null; onExpand: () => void; main?: boolean; fresh?: boolean
  size: Size; onResize: (s: Size) => void; selected: boolean; onSelect: () => void
}) {
  const [box, seen] = useSeenOnce<HTMLDivElement>()
  // A click selects the screen; a drag (panning the map, resizing the box)
  // does not. Only the icon expands.
  const down = useRef<{ x: number; y: number } | null>(null)
  const openCount = state.incidents.filter((i) => !/resolved|closed|cancel/i.test(i.status)).length

  // Remember a size the user dragged to (debounced; the observer fires per frame).
  useEffect(() => {
    const el = box.current
    if (!el) return
    let t: ReturnType<typeof setTimeout> | undefined
    const ro = new ResizeObserver(() => {
      clearTimeout(t)
      t = setTimeout(() => {
        const w = Math.round(el.offsetWidth)
        const h = Math.round(el.offsetHeight)
        if (Math.abs(w - size.w) > 4 || Math.abs(h - size.h) > 4) onResize({ w, h })
      }, 400)
    })
    ro.observe(el)
    return () => {
      clearTimeout(t)
      ro.disconnect()
    }
  }, [box, size.w, size.h, onResize])

  return (
    <div
      ref={box}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      title={zone ? `Show ${zone.name} in the analytics` : "Show the whole city in the analytics"}
      onPointerDown={(e) => {
        down.current = { x: e.clientX, y: e.clientY }
      }}
      onClick={(e) => {
        const d = down.current
        if (d && Math.hypot(e.clientX - d.x, e.clientY - d.y) > 6) return
        onSelect()
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault()
          onSelect()
        }
      }}
      style={{ width: size.w, height: size.h, resize: "both", minWidth: 220, minHeight: 170, maxWidth: 1400, maxHeight: 900 }}
      className={`group relative shrink-0 cursor-pointer snap-start overflow-hidden rounded-xl border bg-muted shadow-card transition-shadow hover:shadow-md ${
        selected ? "border-primary ring-2 ring-primary/30" : main ? "border-primary/30" : "border-border"
      } ${fresh && !selected ? "ring-2 ring-amber-400/70" : ""}`}
    >
      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-center gap-2 bg-gradient-to-b from-card via-card/80 to-card/0 px-3 py-2 text-foreground">
        {zone ? (
          <span className={`h-3 w-1.5 rounded-sm ${SEV_BAR[zone.severity] ?? "bg-zinc-400"}`} />
        ) : (
          <MonitorPlay className="size-3.5 text-primary" />
        )}
        <span className="truncate text-xs font-semibold tracking-wide uppercase">
          {zone ? zone.name : `All zones · ${region?.name ?? "every region"}`}
        </span>
        {fresh && <Badge className="h-4 bg-amber-400 px-1 text-[10px] text-black">NEW</Badge>}
        <span className="ml-auto flex items-center gap-2 text-[11px] tabular-nums text-muted-foreground">
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
      {seen ? (
        <WallMiniMap state={state} zone={zone} region={region} w={size.w} h={size.h} />
      ) : (
        <div className="h-full w-full bg-muted" />
      )}
      {selected && (
        <span className="pointer-events-none absolute bottom-2 left-2 z-10 rounded-md bg-primary px-1.5 py-0.5 text-[10px] font-semibold text-primary-foreground">
          ANALYTICS
        </span>
      )}
      <button
        onClick={(e) => {
          e.stopPropagation()
          onExpand()
        }}
        className="absolute right-6 bottom-2 z-10 rounded-lg border bg-card/95 p-1.5 text-foreground opacity-80 shadow-sm transition group-hover:opacity-100 hover:bg-card"
        aria-label={`Expand ${zone ? zone.name : "city"} screen`}
      >
        <Maximize2 className="size-4" />
      </button>
    </div>
  )
}

function Expanded({ state, zones, region, index, onClose, onStep, onPickWard }: {
  state: DemoState; zones: Zone[]; region: Region | null; index: number; onClose: () => void; onStep: (d: number) => void
  onPickWard: (id: string) => void
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
    <div className="fixed inset-0 z-50 flex flex-col bg-background text-foreground">
      <div className="flex items-center gap-2 border-b bg-card px-4 py-2.5">
        <Button size="icon" variant="ghost" className="hover:bg-muted" onClick={() => onStep(-1)} aria-label="Previous screen">
          <ChevronLeft className="size-5" />
        </Button>
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold uppercase tracking-wide">
            {zone ? zone.name : `All zones · ${region?.name ?? "every region"}`}
          </div>
          <div className="text-xs text-muted-foreground">
            Screen {index + 2} of {zones.length + 1} · ← → between screens · click a ward for its numbers · Esc to close
          </div>
        </div>
        <Button size="icon" variant="ghost" className="hover:bg-muted" onClick={() => onStep(1)} aria-label="Next screen">
          <ChevronRight className="size-5" />
        </Button>
        <Button size="icon" variant="ghost" className="ml-auto hover:bg-muted" onClick={onClose} aria-label="Close">
          <X className="size-5" />
        </Button>
      </div>
      <div className="grid min-h-0 flex-1 lg:grid-cols-[1fr_360px]">
        <ScreenMap state={state} zone={zone} region={region} big className="h-full min-h-[50vh] w-full"
                   onPickWard={onPickWard} />
        <aside className="min-h-0 overflow-y-auto border-l bg-card p-4">
          {zone && (
            <div className="mb-3 grid grid-cols-3 gap-2 text-center">
              <Kpi label="Incidents" value={zone.incidents.length} />
              <Kpi label="Units en route" value={zone.unitsEnRoute} />
              <Kpi label="Reports" value={zone.reports} />
            </div>
          )}
          {zone && (
            <Button size="sm" variant="secondary" className="mb-2 w-full" onClick={() => onPickWard(zone.id)}>
              Ward numbers and approvals
            </Button>
          )}
          <ul className="space-y-1.5">
            {list.map((i) => (
              <li key={i.id}>
                <button
                  onClick={() => navigate(`/admin/response?incident=${i.id}`)}
                  className="w-full rounded-lg border bg-card p-2.5 text-left text-sm hover:border-primary"
                >
                  <div className="flex items-start gap-2">
                    <span className={`mt-1 h-3 w-1.5 shrink-0 rounded-sm ${SEV_BAR[i.severity] ?? "bg-zinc-400"}`} />
                    <span className="flex-1 leading-tight">{i.title}</span>
                    <span className="text-xs text-muted-foreground">S{i.severity}</span>
                  </div>
                  <div className="mt-1 pl-3.5 text-xs text-muted-foreground">
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
    <div className="rounded-lg border bg-card p-2.5">
      <div className="text-lg font-semibold tabular-nums">{value}</div>
      <div className="text-[11px] text-muted-foreground">{label}</div>
    </div>
  )
}

export default function CommandWall() {
  // The world arrives already scoped to the console's region (header picker).
  const { state, region: regionPick, setRegion } = useDemo()
  const region = regionPick === "all" ? null : REGIONS.find((r) => r.id === regionPick) ?? null
  const pickRegion = (id: string) => setRegion(id as "pune" | "ncr" | "all")
  // Small screens redraw every 4 s; the analytics and the expanded view use the
  // live snapshot.
  const wallState = useThrottledState(state, 4000, region?.id ?? "all")
  const zones = useMemo(() => zonesOf(wallState), [wallState])
  const liveZones = useMemo(() => zonesOf(state), [state])
  const [open, setOpen] = useState(-2)
  const [ward, setWard] = useState<string | null>(null)
  // Which screen the analytics follow: null = the whole city.
  const [scopeId, setScopeId] = useState<string | null>(null)
  const scope = scopeId ? zones.find((z) => z.id === scopeId) ?? null : null
  // Analytics follow the throttled world too: re-rendering twelve charts every
  // second was what made clicks lag.
  const scoped = useMemo(() => scopeState(wallState, scope), [wallState, scope])
  const [now, setNow] = useState(() => Date.now())
  const [preset, setPreset] = useState<keyof typeof PRESETS>(() => load(PRESET_KEY, "M"))
  const [sizes, setSizes] = useState<Record<string, Size>>(() => load(SIZE_KEY, {}))

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 5000)
    return () => clearInterval(id)
  }, [])

  const sizeOf = (id: string, main: boolean): Size => {
    if (sizes[id]) return sizes[id]
    const p = PRESETS[preset]
    return main ? { w: Math.round(p.w * 1.5), h: p.h } : p
  }
  const resize = useCallback((id: string, s: Size) => {
    setSizes((old) => {
      const next = { ...old, [id]: s }
      save(SIZE_KEY, next)
      return next
    })
  }, [])
  const choosePreset = (p: keyof typeof PRESETS) => {
    setPreset(p)
    setSizes({})
    save(PRESET_KEY, p)
    save(SIZE_KEY, {})
  }

  const step = useCallback(
    (d: number) => setOpen((i) => {
      const n = liveZones.length + 1
      const pos = (((i + 1 + d) % n) + n) % n
      return pos - 1
    }),
    [liveZones.length],
  )
  const strip = useRef<HTMLDivElement | null>(null)
  const scroll = (d: number) => strip.current?.scrollBy({ left: d * 360, behavior: "smooth" })
  const unattended = liveZones.reduce((s, z) => s + z.unattended, 0)

  return (
    <div className="space-y-5 p-4 md:p-6">
      <section className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <MonitorPlay className="size-4" />
          <h2 className="text-base font-semibold tracking-tight">Live wall</h2>
          <span className="text-muted-foreground text-xs">
            {liveZones.length} active zone{liveZones.length === 1 ? "" : "s"}
            {unattended > 0 && <> · <b className="text-amber-600 dark:text-amber-400">{unattended} incident{unattended === 1 ? "" : "s"} with nobody assigned</b></>}
            {" "}· a screen appears for every ward with an open incident · click a screen to focus the analytics below · ⤢ to expand · drag a corner to resize
          </span>
          {state.cachedAt && (
            <Badge variant="outline" className="gap-1 text-[11px]">
              <Database className="size-3" /> cached view from {new Date(state.cachedAt).toLocaleTimeString(undefined, { hour12: false })}, connecting…
            </Badge>
          )}
          <div className="ml-auto flex items-center gap-1">
            <select
              value={regionPick}
              onChange={(e) => pickRegion(e.target.value)}
              className="border-input bg-card h-8 rounded-lg border px-2.5 text-xs shadow-xs"
              aria-label="Region"
              title="Which region the wall shows"
            >
              {REGIONS.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              <option value="all">All regions</option>
            </select>
            {(Object.keys(PRESETS) as (keyof typeof PRESETS)[]).map((p) => (
              <Button key={p} size="sm" variant={preset === p && !Object.keys(sizes).length ? "default" : "outline"}
                      className="h-8 w-8 px-0" onClick={() => choosePreset(p)} title={`All screens ${p}`}>
                {p}
              </Button>
            ))}
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
          className="flex snap-x items-start gap-3 overflow-x-auto rounded-xl border bg-card p-3 shadow-card [scrollbar-width:thin]"
        >
          <Screen state={wallState} zone={null} region={region} main onExpand={() => setOpen(-1)}
                  size={sizeOf("city", true)} onResize={(s) => resize("city", s)}
                  selected={!scope} onSelect={() => setScopeId(null)} />
          {zones.map((z) => (
            <Screen
              key={z.id}
              state={wallState}
              zone={z}
              fresh={now - z.since < 2 * 60_000}
              onExpand={() => setOpen(liveZones.findIndex((x) => x.id === z.id))}
              size={sizeOf(z.id, false)}
              onResize={(s) => resize(z.id, s)}
              selected={scope?.id === z.id}
              onSelect={() => setScopeId((cur) => (cur === z.id ? null : z.id))}
            />
          ))}
          {zones.length === 0 && (
            <div className="flex w-[340px] shrink-0 items-center justify-center self-stretch rounded-xl border-2 border-dashed border-border p-6 text-center text-sm text-muted-foreground">
              <Users className="mr-2 size-4" /> No open incidents. Zone screens appear here as soon as one opens.
            </div>
          )}
        </div>
      </section>

      <WallAnalytics
        zones={scope ? [scope] : zones}
        now={now}
        state={scoped}
        scope={scope}
        onClearScope={() => setScopeId(null)}
      />

      {open > -2 && (
        <Expanded
          state={state}
          zones={liveZones}
          region={region}
          index={Math.min(open, liveZones.length - 1)}
          onClose={() => setOpen(-2)}
          onStep={step}
          onPickWard={setWard}
        />
      )}
      <WardPanel wardId={ward} onClose={() => setWard(null)} />
    </div>
  )
}
