import { useState } from "react"
import { Camera, Layers, Siren } from "lucide-react"
import type { Incident } from "@/api/types"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable"
import { MapView } from "@/components/map/MapView"
import { SeverityBadge, StatTile } from "@/components/common/indicators"
import { timeOf } from "@/lib/format"
import {
  useIncidents,
  useReports,
  useResources,
  useWardRisks,
  useWards,
} from "@/hooks/useApi"
import { wardName } from "@/api/mock/geo"
import { useScenario } from "@/scenario/store"
import { Empty } from "./DecisionGate"
import { cn } from "@/lib/utils"

const STATUS_CLASS: Record<Incident["status"], string> = {
  reported: "bg-status-pending text-black",
  confirmed: "bg-status-open text-white",
  dispatched: "bg-status-active text-white",
  in_progress: "bg-status-active text-white",
  resolved: "bg-status-resolved text-white",
}

const CATEGORY_LABEL: Record<string, string> = {
  flooded_road: "Flooded road",
  waterlogging: "Waterlogging",
  fallen_tree: "Fallen tree",
  blocked_drain: "Blocked drain",
  structural_damage: "Structural damage",
  person_stranded: "Person stranded",
  power_line: "Power line",
  heat_casualty: "Heat casualty",
}

export default function IncidentQueue() {
  const { data: incidents = [] } = useIncidents()
  const { data: wards = [] } = useWards()
  const { data: risks = [] } = useWardRisks("flood")
  const { data: resources = [] } = useResources()
  const { data: reports = [] } = useReports()
  const focusWardId = useScenario((s) => s.focusWardId)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const selected =
    incidents.find((i) => i.id === selectedId) ?? incidents[0] ?? null
  const clustered = reports.filter((r) => r.incidentId === selected?.id)
  const unclustered = reports.filter((r) => !r.incidentId)

  if (!reports.length && !incidents.length) {
    return (
      <Empty
        icon={<Siren className="size-8 text-muted-foreground" />}
        title="No incidents reported"
        body="Citizen photo reports are classified, geotagged and clustered here — so the console shows confirmed incidents rather than a raw report feed."
      />
    )
  }

  return (
    <div className="flex h-full flex-col">
      <div className="grid grid-cols-2 gap-3 p-4 lg:grid-cols-4">
        <StatTile
          label="Reports received"
          value={String(reports.length)}
          sub="from residents"
        />
        <StatTile
          label="Confirmed incidents"
          value={String(incidents.length)}
          sub={
            incidents.length
              ? `${reports.length - unclustered.length} reports clustered`
              : "awaiting clustering"
          }
        />
        <StatTile
          label="Duplicates collapsed"
          value={String(
            Math.max(0, reports.length - unclustered.length - incidents.length)
          )}
          sub="reports merged into existing incidents"
        />
        <StatTile
          label="Resolved"
          value={String(
            incidents.filter((i) => i.status === "resolved").length
          )}
          sub="closed with field proof"
        />
      </div>

      <ResizablePanelGroup
        orientation="horizontal"
        className="min-h-0 flex-1 border-t"
      >
        <ResizablePanel defaultSize={48} minSize={28}>
          <MapView
            className="h-full w-full"
            expandable
            wards={wards}
            risks={risks}
            incidents={incidents}
            resources={resources}
            focusWardId={focusWardId}
          />
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel defaultSize={52} minSize={30}>
          <ScrollArea className="h-full">
            <div className="space-y-3 p-4">
              {incidents.map((inc) => (
                <Card
                  key={inc.id}
                  onClick={() => setSelectedId(inc.id)}
                  className={cn(
                    "cursor-pointer transition-colors",
                    selected?.id === inc.id && "border-foreground"
                  )}
                >
                  <CardHeader className="pb-2">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <CardTitle className="text-sm">{inc.title}</CardTitle>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {wardName(inc.wardId)} ·{" "}
                          {CATEGORY_LABEL[inc.category]} ·{" "}
                          {timeOf(inc.createdAt)} IST
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
                        <SeverityBadge
                          severity={inc.severity}
                          showLabel={false}
                        />
                        <Badge className={STATUS_CLASS[inc.status]}>
                          {inc.status.replace("_", " ")}
                        </Badge>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                      <span className="inline-flex items-center gap-1.5 font-medium">
                        <Layers className="size-3.5" />
                        {inc.reportCount} report
                        {inc.reportCount === 1 ? "" : "s"} clustered
                      </span>
                      <span className="tabular text-muted-foreground">
                        cluster confidence {Math.round(inc.confidence * 100)}%
                      </span>
                    </div>

                    {selected?.id === inc.id && clustered.length > 0 && (
                      <>
                        <Separator className="my-3" />
                        <p className="mb-2 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
                          Reports in this cluster
                        </p>
                        <div className="space-y-2">
                          {clustered.map((r) => (
                            <div
                              key={r.id}
                              className="flex items-start gap-2 text-xs"
                            >
                              <Camera className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                              <div className="min-w-0 flex-1">
                                <p className="truncate">{r.note}</p>
                                <p className="text-muted-foreground">
                                  {r.reporterName} · {timeOf(r.createdAt)} ·
                                  classified {CATEGORY_LABEL[r.classifiedAs]}{" "}
                                  <span className="tabular">
                                    (
                                    {Math.round(
                                      r.classificationConfidence * 100
                                    )}
                                    %)
                                  </span>
                                </p>
                              </div>
                            </div>
                          ))}
                        </div>
                      </>
                    )}
                  </CardContent>
                </Card>
              ))}

              {unclustered.length > 0 && (
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm">
                      Awaiting clustering ({unclustered.length})
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    {unclustered.map((r) => (
                      <div
                        key={r.id}
                        className="flex items-start gap-2 text-xs"
                      >
                        <Camera className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                        <div className="min-w-0 flex-1">
                          <p className="truncate">{r.note}</p>
                          <p className="text-muted-foreground">
                            {wardName(r.wardId)} · {r.reporterName} ·{" "}
                            {timeOf(r.createdAt)}
                          </p>
                        </div>
                      </div>
                    ))}
                  </CardContent>
                </Card>
              )}
            </div>
          </ScrollArea>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  )
}
