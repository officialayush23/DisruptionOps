import { NavLink, useLocation } from "react-router-dom"
import {
  Activity,
  BrainCircuit,
  ClipboardCheck,
  Gauge,
  Handshake,
  History,
  Inbox,
  Radar,
  Radio,
  Route,
  Settings2,
  Siren,
  TrendingUp,
  Truck,
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
import { Separator } from "@/components/ui/separator"
import { PersonaSwitcher } from "./PersonaSwitcher"
import { Badge } from "@/components/ui/badge"
import { DemoProvider, useDemo } from "@/routes/demo/DemoProvider"

const NAV = [
  { to: "/admin/console", label: "Command console", icon: Radar },
  { to: "/admin/copilot", label: "Copilot", icon: BrainCircuit },
  { to: "/admin/intake", label: "Intake inbox", icon: Inbox },
  { to: "/admin/risk", label: "Risk board", icon: Gauge },
  { to: "/admin/forecast", label: "Forecast", icon: TrendingUp },
  { to: "/admin/incidents", label: "Incident queue", icon: Siren },
  { to: "/admin/allocation", label: "Allocation planner", icon: Route },
  { to: "/admin/handoff", label: "Agency handoff", icon: Handshake },
  { to: "/admin/decisions", label: "Decision gate", icon: ClipboardCheck },
  { to: "/admin/agent", label: "Agent trace", icon: Activity },
  { to: "/admin/resources", label: "Resources", icon: Truck },
  { to: "/admin/alerts", label: "Issued alerts", icon: Radio },
  { to: "/admin/after-action", label: "After-action", icon: History },
  { to: "/admin/configuration", label: "Configuration", icon: Settings2 },
]

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

/** Requests another agency has not answered yet. Coordination that has stalled
 *  is the thing this screen exists to make impossible to miss. */
function HandoffCount() {
  const { state } = useDemo()
  const open = state.agencyRequests.filter((r) => r.status === "requested").length
  if (!open) return null
  return (
    <Badge
      variant="secondary"
      className="ml-auto h-5 min-w-5 px-1.5 group-data-[collapsible=icon]:hidden"
    >
      {open}
    </Badge>
  )
}

/** A count of what is waiting for a person, read from the live world rather
 *  than from a fixture. It was showing zero during a run that had three
 *  decisions sitting on the gate. */
function GateCount() {
  const { state } = useDemo()
  const pending = state.decisions.filter(
    (d) => d.status === "awaiting_approval"
  ).length
  if (!pending) return null
  return (
    <Badge
      variant="secondary"
      className="ml-auto h-5 min-w-5 bg-sev-4 px-1.5 text-sev-4-foreground group-data-[collapsible=icon]:hidden"
    >
      {pending}
    </Badge>
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
          <SidebarGroup>
            <SidebarGroupLabel>Operations</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {NAV.map((item) => (
                  <SidebarMenuItem key={item.to}>
                    <SidebarMenuButton
                      asChild
                      isActive={location.pathname.startsWith(item.to)}
                      tooltip={item.label}
                    >
                      <NavLink to={item.to}>
                        <item.icon />
                        <span>{item.label}</span>
                        {item.to === "/admin/decisions" && <GateCount />}
                        {item.to === "/admin/handoff" && <HandoffCount />}
                      </NavLink>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>

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
          </div>
          <div className="ml-auto flex items-center gap-3">
            <LiveBadge />
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
