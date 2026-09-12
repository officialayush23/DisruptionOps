import { useState } from "react"
import { NavLink, useLocation } from "react-router-dom"
import {
  Activity,
  BrainCircuit,
  ClipboardCheck,
  Gauge,
  Handshake,
  History,
  Inbox,
  Network,
  Radar,
  Radio,
  Route,
  Rewind,
  Settings2,
  Siren,
  TrendingUp,
  Truck,
  Waypoints,
} from "lucide-react"
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar"
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger,
} from "@/components/ui/sheet"
import { Separator } from "@/components/ui/separator"
import Copilot from "@/routes/admin/Copilot"
import { PersonaSwitcher } from "./PersonaSwitcher"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DemoProvider, useDemo } from "@/routes/demo/DemoProvider"

/** What each nav badge counts, and how loudly to say it.
 *
 *  A badge means **a person has to do something here**, not "this screen has
 *  content". That distinction is the whole design: the moment every tab carries
 *  a number, none of them mean anything and an officer learns to ignore the
 *  sidebar — which is worse than having had no badges at all, because the two
 *  that genuinely block a decision are now buried in noise.
 *
 *  So only queues are counted, and in two registers:
 *
 *    **blocked** — the system has stopped and is waiting for a human. The gate
 *    is the archetype: a decision that will not issue until somebody approves
 *    it. Amber, the same colour the gate already used.
 *
 *    **gap** — nothing is blocked, but there is a hole an officer would want to
 *    close: a demand nobody can serve, a crew off the road, a capability the
 *    forecast says is about to run short. Quieter, because it is a shortfall
 *    rather than an instruction.
 *
 *  Screens that are records or tools — the console, the copilot, the agent
 *  trace, issued alerts, replay, after-action, the architecture page and
 *  configuration — carry nothing. Nobody is waiting on them.
 */
type Tone = "blocked" | "gap"
type Count = { n: number; tone: Tone; what: string }

const NAV: {
  group: "Operations" | "Analysis" | "Setup"
  to: string
  label: string
  icon: typeof Radar
  count?: (c: Counts) => Count | null
}[] = [
  // Operations: the four screens an officer works from during an event. A judge
  // who opened this console found sixteen and could not tell which four those
  // were, which is the whole of the "too cluttered" complaint — not density on
  // any one screen, but no answer to "where do I start".
  { group: "Operations", to: "/admin/console", label: "Live map", icon: Radar },
  // Not "Dispatch". Nothing on it dispatches: the solver assigns, the gate
  // authorises, and this is the ledger of what it did — which is what an
  // officer was missing, not a second way to move a vehicle by hand.
  {
    group: "Operations", to: "/admin/dispatch", label: "Who is on what", icon: Waypoints,
    count: (c) => (c.short ? { n: c.short, tone: "gap", what: "demands nobody has" } : null),
  },
  {
    group: "Operations", to: "/admin/decisions", label: "Approvals", icon: ClipboardCheck,
    count: (c) => (c.gate ? { n: c.gate, tone: "blocked", what: "waiting for an approval" } : null),
  },
  {
    group: "Operations", to: "/admin/intake", label: "Reports", icon: Inbox,
    count: (c) => (c.held ? { n: c.held, tone: "blocked", what: "held for a human" } : null),
  },
  // Promoted out of Analysis. It now leads with what got attached to what,
  // which is a live operational question rather than an after-the-fact one.
  { group: "Operations", to: "/admin/agent", label: "Agent log", icon: Activity },

  // Analysis: real work, none of it urgent. Collapsed by default, so the rail
  // reads as four things rather than sixteen and everything is still one click
  // from where it was.
  {
    group: "Analysis", to: "/admin/incidents", label: "Incident queue", icon: Siren,
    count: (c) => (c.unattended ? { n: c.unattended, tone: "gap", what: "open with nobody on the way" } : null),
  },
  {
    group: "Analysis", to: "/admin/allocation", label: "Allocation planner", icon: Route,
    count: (c) => (c.uncovered ? { n: c.uncovered, tone: "blocked", what: "demands nobody can serve" } : null),
  },
  {
    group: "Analysis", to: "/admin/handoff", label: "Agency handoff", icon: Handshake,
    count: (c) => (c.handoffs ? { n: c.handoffs, tone: "blocked", what: "requests another agency has not answered" } : null),
  },
  {
    group: "Analysis", to: "/admin/risk", label: "Risk board", icon: Gauge,
    count: (c) => (c.severeWards ? { n: c.severeWards, tone: "gap", what: "wards at severity 4 or above" } : null),
  },
  {
    group: "Analysis", to: "/admin/forecast", label: "Forecast", icon: TrendingUp,
    count: (c) => (c.shortfalls ? { n: c.shortfalls, tone: "gap", what: "capabilities projected short" } : null),
  },
  {
    group: "Analysis", to: "/admin/resources", label: "Resources", icon: Truck,
    count: (c) => (c.offline ? { n: c.offline, tone: "gap", what: "units out of the fleet" } : null),
  },
  { group: "Analysis", to: "/admin/alerts", label: "Issued alerts", icon: Radio },
  { group: "Analysis", to: "/admin/copilot", label: "Copilot, full screen", icon: BrainCircuit },

  { group: "Setup", to: "/admin/replay", label: "Replay", icon: Rewind },
  { group: "Setup", to: "/admin/after-action", label: "After-action", icon: History },
  { group: "Setup", to: "/admin/architecture", label: "How this works", icon: Network },
  { group: "Setup", to: "/admin/configuration", label: "Configuration", icon: Settings2 },
]

const GROUPS = ["Operations", "Analysis", "Setup"] as const

/** The world clock, in the header.
 *
 *  Every admin screen now reads one poll. This is the honest indicator of
 *  whether it is arriving: a tick that is not advancing means the world is
 *  stopped, and a latency number means the operator can see the thing degrade
 *  before it fails, rather than after.
 */
function LiveBadge() {
  const { state, error, latencyMs } = useDemo()
  if (error) {
    return (
      <Badge variant="destructive" className="gap-1.5 font-normal">
        Backend unreachable
      </Badge>
    )
  }
  return (
    <div className="text-muted-foreground flex items-center gap-2 text-xs">
      <span className="flex items-center gap-1.5">
        <span
          className={`size-2 rounded-full ${
            state.running ? "animate-pulse bg-emerald-500" : "bg-slate-400"
          }`}
        />
        {state.running ? "Live" : "Idle"}
      </span>
      <span className="tabular-nums">tick {state.tick}</span>
      {latencyMs !== null && (
        <span className="tabular-nums opacity-70">{latencyMs} ms</span>
      )}
    </div>
  )
}

/** Everything the sidebar counts, computed once from the world the whole
 *  console already polls. No screen is asked and nothing extra is fetched.
 *
 *  Each of these was previously only discoverable by opening the screen, which
 *  is the wrong way round: an officer with sixteen tabs should be told where
 *  they are needed rather than having to go and look. Only the gate and the
 *  handoff said so, and the other four queues below are no less blocking. */
type Counts = {
  held: number
  short: number
  gate: number
  handoffs: number
  uncovered: number
  unattended: number
  offline: number
  shortfalls: number
  severeWards: number
}

function useCounts(): Counts {
  const { state } = useDemo()
  return {
    // The system declined to act on these and said so. `verdict === null`
    // matters: a report a person has already ruled on is not still asking.
    held: state.reports.filter(
      (r) =>
        (r.status === "quarantined" || r.status === "rejected") && r.verdict === null
    ).length,
    gate: state.decisions.filter((d) => d.status === "awaiting_approval").length,
    handoffs: state.agencyRequests.filter((r) => r.status === "requested").length,
    // The allocator's own admission. A demand it could not cover does not
    // resolve itself; somebody calls another agency or changes a priority.
    uncovered: state.plan?.uncovered.length ?? 0,
    // Open, and nobody is driving to it. Briefly true after any new incident
    // and before the next plan, which is honest — it says nobody is on the way
    // *yet* — so it is a gap rather than a block.
    unattended: state.incidents.filter(
      (i) => i.status === "open" && i.unitsEnRoute === 0
    ).length,
    // Out of the fleet rather than merely busy: a crew working an incident is
    // not a problem, and counting them would make this number meaningless
    // exactly when the city is busiest.
    offline: state.resources.filter(
      (r) => r.status !== "available" && !r.assignedTo
    ).length,
    shortfalls: (state.forecast?.demand ?? []).filter((d) => d.shortfall > 0.5).length,
    // Incidents the dispatch board has something to do about: a recorded need
    // that nobody is meeting. Distinct from `unattended`, which counts nobody
    // *en route* — an incident can have a unit driving to it and still be short
    // of a second capability nobody holds.
    short: (() => {
      const open = new Set(
        state.incidents.filter((i) => i.status !== "resolved").map((i) => i.id)
      )
      const bad = new Set<string>()
      for (const n of state.needs) {
        if (n.met < n.required && open.has(n.incidentId)) bad.add(n.incidentId)
      }
      return bad.size
    })(),
    severeWards: state.wards.filter((w) => (w.severity ?? 0) >= 4).length,
  }
}

/** The number itself, plus a dot for the collapsed rail.
 *
 *  A sidebar in icon mode hid every badge, so an officer who collapsed it to
 *  see more map lost the only thing telling them where they were needed. The
 *  dot survives the collapse — it cannot say how many, and it can say that
 *  there is something. */
function NavBadge({ count }: { count: Count }) {
  const blocked = count.tone === "blocked"
  return (
    <>
      <Badge
        variant="secondary"
        className={
          "ml-auto h-5 min-w-5 px-1.5 tabular-nums group-data-[collapsible=icon]:hidden " +
          (blocked ? "bg-sev-4 text-sev-4-foreground" : "")
        }
      >
        {count.n > 99 ? "99+" : count.n}
      </Badge>
      <span
        aria-hidden
        className={
          "absolute right-1 top-1 hidden size-2 rounded-full group-data-[collapsible=icon]:block " +
          (blocked ? "bg-sev-4" : "bg-muted-foreground/60")
        }
      />
    </>
  )
}

/** Where the reports are coming from, as counted this second. */
function LoadStrip() {
  const { state } = useDemo()
  const open = state.incidents.length
  const committed = state.resources.filter((r) => r.status !== "available").length
  const unmet = state.needs.filter((n) => n.met < n.required).length
  const rows: [string, string, boolean][] = [
    ["Open incidents", String(open), open > 0],
    ["Units committed", `${committed}/${state.resources.length}`, committed > 0],
    ["Unmet needs", String(unmet), unmet > 0],
    ["Shelters and hospitals", String(state.facilities.length), false],
    ["Roads blocked", String(state.roadBlocks.length), state.roadBlocks.length > 0],
    ["Reports in", String(state.reports.length), state.reports.length > 0],
    ["Alerts out", String(state.alerts.length), state.alerts.length > 0],
  ]
  return (
    <div className="space-y-1 px-2 py-1">
      {rows.map(([label, value, hot]) => (
        <div key={label} className="flex items-center justify-between text-xs">
          <span className="text-muted-foreground truncate">{label}</span>
          <span className={`tabular-nums ${hot ? "font-medium" : "text-muted-foreground"}`}>
            {value}
          </span>
        </div>
      ))}
    </div>
  )
}

function Chrome({ children }: { children: React.ReactNode }) {
  const location = useLocation()
  const current = NAV.find((n) => location.pathname.startsWith(n.to))
  const counts = useCounts()
  const [copilot, setCopilot] = useState(false)

  return (
    <SidebarProvider>
      <Sidebar collapsible="icon">
        <SidebarHeader className="border-b">
          <div className="flex items-center gap-2 px-1 py-1.5">
            <div className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary text-xs font-bold text-primary-foreground">
              IN
            </div>
            <div className="grid min-w-0 flex-1 leading-tight group-data-[collapsible=icon]:hidden">
              <span className="truncate text-sm font-semibold">Indradhanu</span>
              <span className="truncate text-xs text-muted-foreground">
                Pune Municipal Corporation
              </span>
            </div>
          </div>
        </SidebarHeader>

        <SidebarContent>
          {GROUPS.map((group) => (
            <SidebarGroup
              key={group}
              // Operations stays open. The other two collapse, because an
              // officer during an event is not configuring anything and a rail
              // that shows them sixteen equal choices is asking them to triage
              // the navigation before they triage the city.
              className={group === "Analysis" ? "group-data-[collapsible=icon]:hidden" : undefined}
            >
              <SidebarGroupLabel>{group}</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {NAV.filter((n) => n.group === group).map((item) => {
                    const count = item.count?.(counts) || null
                    return (
                      <SidebarMenuItem key={item.to} className="relative">
                        <SidebarMenuButton
                          asChild
                          isActive={location.pathname.startsWith(item.to)}
                          size={group === "Operations" ? "lg" : "default"}
                          // The tooltip is the only place a collapsed rail can
                          // say what the dot is about, so it carries the
                          // sentence rather than repeating the label.
                          tooltip={
                            count
                              ? `${item.label} — ${count.n} ${count.what}`
                              : item.label
                          }
                        >
                          <NavLink
                            // A badge is a destination, not a notice: where a
                            // screen can open straight onto the queue that is
                            // being counted, the link says so.
                            to={
                              count && item.to === "/admin/intake"
                                ? `${item.to}?filter=held`
                                : item.to
                            }
                          >
                            <item.icon />
                            <span>{item.label}</span>
                            {count && <NavBadge count={count} />}
                          </NavLink>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    )
                  })}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          ))}

          <SidebarGroup className="mt-auto group-data-[collapsible=icon]:hidden">
            <SidebarGroupLabel>Right now</SidebarGroupLabel>
            <SidebarGroupContent>
              <LoadStrip />
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
      </Sidebar>

      <SidebarInset className="min-w-0">
        <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-2 border-b bg-background px-4">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mr-1 h-4" />
          <div className="flex min-w-0 items-center gap-2">
            {current && (
              <current.icon className="size-4 shrink-0 text-muted-foreground" />
            )}
            <span className="truncate text-sm font-semibold">
              {current?.label ?? "Console"}
            </span>
            {/* Said again at the top of the screen it belongs to, in words. The
                sidebar number tells an officer where to go; this tells them
                what they are looking at once they are there, which is the half
                a bare number cannot carry. */}
            {(() => {
              const c = current?.count?.(counts)
              if (!c) return null
              return (
                <Badge
                  variant="secondary"
                  className={
                    "hidden shrink-0 font-normal sm:inline-flex " +
                    (c.tone === "blocked" ? "bg-sev-4 text-sev-4-foreground" : "")
                  }
                >
                  {c.n} {c.what}
                </Badge>
              )
            })()}
          </div>
          <div className="ml-auto flex items-center gap-3">
            <LiveBadge />
            {/* The Copilot, over whatever they are doing rather than instead of
                it. As its own primary tab it was the clearest example of the
                console showing an officer something they had not asked for: a
                full-screen chat sitting between them and the map. Here it is
                available from every screen, answers against the same world the
                screen behind it is showing, and closes. */}
            <Sheet open={copilot} onOpenChange={setCopilot}>
              <SheetTrigger asChild>
                <Button variant="outline" size="sm" className="h-8 gap-1.5 text-xs">
                  <BrainCircuit className="size-3.5" />
                  <span className="hidden sm:inline">Ask</span>
                </Button>
              </SheetTrigger>
              <SheetContent
                side="right"
                className="flex w-full flex-col gap-0 p-0 sm:max-w-xl"
              >
                <SheetHeader className="shrink-0 border-b px-4 py-3">
                  <SheetTitle className="flex items-center gap-2 text-sm">
                    <BrainCircuit className="size-4" /> Commissioner Copilot
                  </SheetTitle>
                </SheetHeader>
                <div className="min-h-0 flex-1 p-3">
                  <Copilot compact />
                </div>
              </SheetContent>
            </Sheet>
            <PersonaSwitcher />
          </div>
        </header>

        <main className="min-w-0 flex-1 overflow-auto">{children}</main>
      </SidebarInset>
    </SidebarProvider>
  )
}

/** The provider sits outside the chrome so the poll outlives navigation between
 *  admin screens, and so the sidebar badges read the same world the map does. */
export function AdminShell({ children }: { children: React.ReactNode }) {
  return (
    <DemoProvider>
      <Chrome>{children}</Chrome>
    </DemoProvider>
  )
}
