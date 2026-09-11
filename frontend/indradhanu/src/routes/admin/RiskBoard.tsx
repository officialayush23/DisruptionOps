import { useMemo, useState } from "react"
import { AlertTriangle, Building2, Droplets, Users } from "lucide-react"
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { MapView } from "@/components/map/MapView"
import {
  ScoreBar,
  SeverityBadge,
  Sparkline,
  StatTile,
} from "@/components/common/indicators"
import {
  useLifelines,
  useShelters,
  useWardRisks,
  useWards,
} from "@/hooks/useApi"
import { useScenario } from "@/scenario/store"
import { cn } from "@/lib/utils"

export default function RiskBoard() {
  const { data: wards = [] } = useWards()
  const { data: risks = [] } = useWardRisks("flood")
  const { data: shelters = [] } = useShelters()
  const { data: lifelines = [] } = useLifelines()
  const focusWardId = useScenario((s) => s.focusWardId)
  const [selected, setSelected] = useState<string | null>(null)

  const activeWardId = selected ?? focusWardId ?? risks[0]?.wardId ?? null
  const ward = wards.find((w) => w.id === activeWardId)
  const risk = risks.find((r) => r.wardId === activeWardId)

  const stats = useMemo(() => {
    const high = risks.filter((r) => r.severity >= 4)
    const atRisk = high.reduce((a, r) => a + r.populationAtRisk, 0)
    const lifelinesAtRisk = lifelines.filter((l) =>
      high.some((h) => h.wardId === l.wardId)
    )
    const lead = high.length
      ? Math.min(...high.map((r) => r.leadTimeHours))
      : null
    return { high: high.length, atRisk, lifelinesAtRisk, lead }
  }, [risks, lifelines])

  if (!risks.length) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-10 text-center">
        <Droplets className="size-8 text-muted-foreground" />
        <div>
          <p className="font-medium">No active hazard run</p>
          <p className="max-w-sm text-sm text-muted-foreground">
            Feeds are live and being polled. Start the guided demo above to
            replay the Pune flood of 25 July 2024 through the pipeline.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <div className="grid grid-cols-2 gap-3 p-4 lg:grid-cols-4">
        <StatTile
          label="Wards at severity 4+"
          value={String(stats.high)}
          sub={`of ${risks.length} scored`}
        />
        <StatTile
          label="Residents in footprint"
          value={stats.atRisk.toLocaleString("en-IN")}
          sub="population-weighted exposure"
        />
        <StatTile
          label="Lifelines exposed"
          value={String(stats.lifelinesAtRisk.length)}
          sub={
            stats.lifelinesAtRisk
              .slice(0, 3)
              .map((l) => l.kind.replace("_", " "))
              .join(", ") || "none"
          }
        />
        <StatTile
          label="Shortest lead time"
          value={stats.lead != null ? `${stats.lead} h` : "—"}
          sub="until expected impact"
        />
      </div>

      <ResizablePanelGroup
        orientation="horizontal"
        className="min-h-0 flex-1 border-t"
      >
        <ResizablePanel defaultSize={54} minSize={30} data-tour="map">
          <MapView
            className="h-full w-full"
            expandable
            wards={wards}
            risks={risks}
            shelters={shelters}
            selectedWardId={activeWardId}
            focusWardId={focusWardId}
            onSelectWard={setSelected}
          />
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel defaultSize={46} minSize={28}>
          <ResizablePanelGroup orientation="vertical">
            <ResizablePanel defaultSize={55} minSize={25} data-tour="wardtable">
              <ScrollArea className="h-full">
                <Table>
                  <TableHeader className="sticky top-0 z-10 bg-card">
                    <TableRow>
                      <TableHead className="w-[46px]">#</TableHead>
                      <TableHead>Ward</TableHead>
                      <TableHead>Risk</TableHead>
                      <TableHead>Severity</TableHead>
                      <TableHead className="text-right">At risk</TableHead>
                      <TableHead className="text-right">Lead</TableHead>
                      <TableHead className="w-[70px]">12 h</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {risks.map((r) => {
                      const w = wards.find((x) => x.id === r.wardId)
                      return (
                        <TableRow
                          key={r.wardId}
                          onClick={() => setSelected(r.wardId)}
                          className={cn(
                            "cursor-pointer",
                            r.wardId === activeWardId && "bg-accent"
                          )}
                        >
                          <TableCell className="tabular text-muted-foreground">
                            {w?.number}
                          </TableCell>
                          <TableCell className="font-medium">
                            {w?.name}
                          </TableCell>
                          <TableCell>
                            <ScoreBar score={r.score} severity={r.severity} />
                          </TableCell>
                          <TableCell>
                            <SeverityBadge
                              severity={r.severity}
                              showLabel={false}
                            />
                          </TableCell>
                          <TableCell className="tabular text-right">
                            {r.populationAtRisk.toLocaleString("en-IN")}
                          </TableCell>
                          <TableCell className="tabular text-right text-muted-foreground">
                            {r.leadTimeHours} h
                          </TableCell>
                          <TableCell>
                            <Sparkline
                              values={r.projection}
                              severity={r.severity}
                            />
                          </TableCell>
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              </ScrollArea>
            </ResizablePanel>
            <ResizableHandle withHandle />
            <ResizablePanel defaultSize={45} minSize={20}>
              <ScrollArea className="h-full">
                {ward && risk ? (
                  <div className="space-y-4 p-4">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <h2 className="text-lg font-semibold">
                          Ward {ward.number} — {ward.name}
                        </h2>
                        <p className="text-sm text-muted-foreground">
                          {ward.population.toLocaleString("en-IN")} residents ·{" "}
                          {ward.areaSqKm} km² · mean elevation {ward.elevationM}{" "}
                          m
                        </p>
                      </div>
                      <SeverityBadge severity={risk.severity} />
                    </div>

                    <Card>
                      <CardHeader className="pb-3">
                        <CardTitle className="flex items-center gap-2 text-sm">
                          <AlertTriangle className="size-4" />
                          Why is this ward being warned?
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="space-y-3">
                        <div className="flex items-baseline gap-2">
                          <span className="tabular text-3xl font-semibold">
                            {Math.round(risk.score * 100)}
                          </span>
                          <span className="text-sm text-muted-foreground">
                            / 100 · model confidence{" "}
                            {Math.round(risk.confidence * 100)}%
                          </span>
                        </div>
                        <Separator />
                        <div className="space-y-2.5">
                          {risk.drivers.map((d) => (
                            <div key={d.label} className="space-y-1">
                              <div className="flex items-center justify-between gap-3 text-sm">
                                <span className="font-medium">{d.label}</span>
                                <span className="tabular text-muted-foreground">
                                  {Math.round(d.contribution * 100)}%
                                </span>
                              </div>
                              <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
                                <div
                                  className="h-full rounded-full bg-foreground"
                                  style={{ width: `${d.contribution * 100}%` }}
                                />
                              </div>
                              <p className="text-xs text-muted-foreground">
                                {d.detail}
                              </p>
                            </div>
                          ))}
                        </div>
                      </CardContent>
                    </Card>

                    <div className="grid gap-3 sm:grid-cols-2">
                      <Card>
                        <CardHeader className="pb-2">
                          <CardTitle className="flex items-center gap-2 text-sm">
                            <Users className="size-4" />
                            Exposure
                          </CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-1 text-sm">
                          <Row
                            k="Residents at risk"
                            v={risk.populationAtRisk.toLocaleString("en-IN")}
                          />
                          <Row
                            k="Over 60"
                            v={`${Math.round(ward.elderlyShare * 100)}%`}
                          />
                          <Row k="Lead time" v={`${risk.leadTimeHours} h`} />
                        </CardContent>
                      </Card>
                      <Card>
                        <CardHeader className="pb-2">
                          <CardTitle className="flex items-center gap-2 text-sm">
                            <Building2 className="size-4" />
                            Lifelines in ward
                          </CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-1.5">
                          {lifelines
                            .filter((l) => l.wardId === ward.id)
                            .map((l) => (
                              <div
                                key={l.id}
                                className="flex items-center gap-2 text-sm"
                              >
                                <Badge
                                  variant="outline"
                                  className="text-[10px] uppercase"
                                >
                                  {l.kind.replace("_", " ")}
                                </Badge>
                                <span className="truncate">{l.name}</span>
                              </div>
                            ))}
                          {!lifelines.some((l) => l.wardId === ward.id) && (
                            <p className="text-sm text-muted-foreground">
                              No mapped lifelines in this ward.
                            </p>
                          )}
                        </CardContent>
                      </Card>
                    </div>
                  </div>
                ) : (
                  <p className="p-4 text-sm text-muted-foreground">
                    Select a ward to see the reasoning behind its score.
                  </p>
                )}
              </ScrollArea>
            </ResizablePanel>
          </ResizablePanelGroup>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  )
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-muted-foreground">{k}</span>
      <span className="tabular font-medium">{v}</span>
    </div>
  )
}
