import { NavLink, useLocation } from "react-router-dom"
import {
  Activity,
  ClipboardCheck,
  Gauge,
  History,
  Radio,
  Route,
  Siren,
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
import { StatusStrip } from "./StatusStrip"
import { ScenarioBar } from "@/scenario/ScenarioBar"
import { useDecisions } from "@/hooks/useApi"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { HelpCircle } from "lucide-react"
import { TourGuide } from "@/components/tour/TourGuide"
import { useTour } from "@/components/tour/tourStore"

const NAV = [
  { to: "/admin/risk", label: "Risk board", icon: Gauge },
  { to: "/admin/incidents", label: "Incident queue", icon: Siren },
  { to: "/admin/allocation", label: "Allocation planner", icon: Route },
  { to: "/admin/decisions", label: "Decision gate", icon: ClipboardCheck },
  { to: "/admin/agent", label: "Agent trace", icon: Activity },
  { to: "/admin/resources", label: "Resources", icon: Truck },
  { to: "/admin/alerts", label: "Issued alerts", icon: Radio },
  { to: "/admin/after-action", label: "After-action", icon: History },
]

export function AdminShell({ children }: { children: React.ReactNode }) {
  const location = useLocation()
  const startTour = useTour((t) => t.start)
  const { data: decisions } = useDecisions()
  const pending =
    decisions?.filter((d) => d.status === "awaiting_approval").length ?? 0
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
            <SidebarGroupLabel>Command console</SidebarGroupLabel>
            <SidebarGroupContent data-tour="nav">
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
                        {item.to === "/admin/decisions" && pending > 0 && (
                          <Badge
                            variant="secondary"
                            className="ml-auto h-5 min-w-5 bg-sev-4 px-1.5 text-sev-4-foreground group-data-[collapsible=icon]:hidden"
                          >
                            {pending}
                          </Badge>
                        )}
                      </NavLink>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>

          <SidebarGroup className="mt-auto group-data-[collapsible=icon]:hidden">
            <SidebarGroupLabel>Feeds</SidebarGroupLabel>
            <SidebarGroupContent data-tour="feeds">
              <StatusStrip />
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
          <div className="ml-auto flex items-center gap-2">
            <Button
              size="icon"
              variant="ghost"
              className="size-8"
              onClick={startTour}
              title="Replay the walkthrough"
              aria-label="Replay the walkthrough"
            >
              <HelpCircle className="size-4" />
            </Button>
            <div data-tour="personas">
              <PersonaSwitcher />
            </div>
          </div>
        </header>

        <div data-tour="scenario">
          <ScenarioBar />
        </div>

        <main className="min-w-0 flex-1 overflow-auto">{children}</main>
        <TourGuide />
      </SidebarInset>
    </SidebarProvider>
  )
}
