import { AlertOctagon, Cpu, Route as RouteIcon, Timer } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Separator } from "@/components/ui/separator"
import { StatTile } from "@/components/common/indicators"
import { timeOf } from "@/lib/format"
import { useAllocationPlan, useResources } from "@/hooks/useApi"
import { wardById, wardName } from "@/api/mock/geo"
import { RESOURCE_LABEL } from "@/api/mock/world"
import { Empty } from "./DecisionGate"
import { cn } from "@/lib/utils"

const STATUS_CLASS: Record<string, string> = {
  proposed: "bg-status-pending text-black",
  approved: "bg-status-resolved text-white",
  en_route: "bg-status-active text-white",
  on_site: "bg-status-active text-white",
  complete: "bg-muted text-muted-foreground",
}

export default function AllocationPlanner() {
  const { data: plan } = useAllocationPlan()
  const { data: resources = [] } = useResources()

  if (!plan) {
    return (
      <Empty
        icon={<RouteIcon className="size-8 text-muted-foreground" />}
        title="No allocation plan yet"
        body="Once wards are ranked, the solver assigns units against them under capacity and live travel-time constraints. The plan, and anything it could not cover, appears here."
      />
    )
  }

  const resById = new Map(resources.map((r) => [r.id, r]))
  const avgEta =
    plan.assignments.reduce((a, x) => a + x.etaMinutes, 0) /
    (plan.assignments.length || 1)

  return (
    <div className="space-y-4 p-4">
      <div>
        <h1 className="text-lg font-semibold">Allocation planner</h1>
        <p className="text-sm text-muted-foreground">
          The model proposes and explains. The solver decides the numbers.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label="Units assigned"
          value={String(plan.assignments.length)}
          sub={`of ${resources.length} in fleet`}
        />
        <StatTile
          label="Mean ETA"
          value={`${avgEta.toFixed(0)} min`}
          sub="over the flood-adjusted road graph"
        />
        <StatTile
          label="Demand covered"
          value={`${Math.round(plan.solver.coverage * 100)}%`}
          sub={`${plan.uncovered.length} demand unmet`}
        />
        <StatTile
          label="Solve time"
          value={`${plan.solver.runtimeMs} ms`}
          sub={
            plan.solver.engine === "cp-sat"
              ? "OR-Tools CP-SAT, optimal"
              : "greedy fallback"
          }
        />
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Cpu className="size-4" />
            Objective
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm">{plan.objective}</p>
          <Separator />
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground">
            <span className="tabular">{plan.solver.variables} variables</span>
            <span className="tabular">
              {plan.solver.constraints} constraints
            </span>
            <span>engine {plan.solver.engine}</span>
            <span className="tabular">
              generated {timeOf(plan.generatedAt)} IST
            </span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Assignments</CardTitle>
        </CardHeader>
        <CardContent className="px-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Unit</TableHead>
                <TableHead>Operator</TableHead>
                <TableHead>Ward</TableHead>
                <TableHead>Purpose</TableHead>
                <TableHead className="text-right">Distance</TableHead>
                <TableHead className="text-right">ETA</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {plan.assignments.map((a) => {
                const r = resById.get(a.resourceId)
                const w = wardById(a.wardId)
                return (
                  <TableRow key={a.id}>
                    <TableCell>
                      <div className="font-medium">
                        {r?.label ?? a.resourceId}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {r ? RESOURCE_LABEL[r.kind] : ""}
                      </div>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {r?.operator}
                    </TableCell>
                    <TableCell className="text-sm">
                      {w ? `${w.number} · ${w.name}` : a.wardId}
                    </TableCell>
                    <TableCell className="max-w-[22rem] text-sm">
                      {a.purpose}
                    </TableCell>
                    <TableCell className="tabular text-right">
                      {a.distanceKm} km
                    </TableCell>
                    <TableCell className="tabular text-right">
                      <span className="inline-flex items-center gap-1">
                        <Timer className="size-3 text-muted-foreground" />
                        {a.etaMinutes} min
                      </span>
                    </TableCell>
                    <TableCell>
                      <Badge className={cn(STATUS_CLASS[a.status])}>
                        {a.status.replace("_", " ")}
                      </Badge>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {plan.uncovered.length > 0 && (
        <Card className="border-sev-4">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm">
              <AlertOctagon className="size-4 text-sev-4" />
              Demand the plan could not cover
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Shown deliberately. A planner that only reports what it solved is
              hiding the part an officer most needs to act on.
            </p>
            {plan.uncovered.map((u, i) => (
              <div key={i} className="rounded-md border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">{wardName(u.wardId)}</span>
                  <Badge variant="outline">Short by {u.shortfall}</Badge>
                </div>
                <p className="mt-1 text-sm">{u.need}</p>
                <p className="mt-1 text-xs text-muted-foreground">{u.reason}</p>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
