import { Truck } from "lucide-react"
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
import { Progress } from "@/components/ui/progress"
import { StatTile } from "@/components/common/indicators"
import { useResources, useShelters } from "@/hooks/useApi"
import { RESOURCE_LABEL } from "@/api/mock/world"
import { wardName } from "@/api/mock/geo"
import { cn } from "@/lib/utils"

const STATUS_CLASS: Record<string, string> = {
  available: "bg-status-resolved text-white",
  assigned: "bg-status-pending text-black",
  en_route: "bg-status-active text-white",
  on_site: "bg-status-active text-white",
  offline: "bg-muted text-muted-foreground",
}

export default function ResourcesPage() {
  const { data: resources = [] } = useResources()
  const { data: shelters = [] } = useShelters()

  const available = resources.filter((r) => r.status === "available").length
  const committed = resources.length - available
  const occupancy = shelters.reduce((a, s) => a + s.occupancy, 0)
  const capacity = shelters.reduce((a, s) => a + s.capacity, 0)

  return (
    <div className="space-y-4 p-4">
      <div>
        <h1 className="text-lg font-semibold">Resources</h1>
        <p className="text-sm text-muted-foreground">
          No city publishes live unit availability, so the platform is the
          system of record. The corporation enters its inventory once; dispatch
          and closure keep it current.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label="Units in fleet"
          value={String(resources.length)}
          sub="across 6 operators"
        />
        <StatTile
          label="Available"
          value={String(available)}
          sub="ready to assign"
        />
        <StatTile
          label="Committed"
          value={String(committed)}
          sub="assigned or en route"
        />
        <StatTile
          label="Shelter occupancy"
          value={`${occupancy}/${capacity}`}
          sub={`${shelters.length} shelters activated`}
        />
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Truck className="size-4" />
            Fleet
          </CardTitle>
        </CardHeader>
        <CardContent className="px-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Unit</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Operator</TableHead>
                <TableHead className="text-right">Capacity</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {resources.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-medium">{r.label}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {RESOURCE_LABEL[r.kind]}
                  </TableCell>
                  <TableCell className="text-sm">{r.operator}</TableCell>
                  <TableCell className="tabular text-right">
                    {r.capacity}
                  </TableCell>
                  <TableCell>
                    <Badge className={cn(STATUS_CLASS[r.status])}>
                      {r.status.replace("_", " ")}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Shelters</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {shelters.map((s) => (
            <div key={s.id} className="space-y-1.5">
              <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span className="font-medium">{s.name}</span>
                <span className="tabular text-xs text-muted-foreground">
                  {wardName(s.wardId)} · {s.occupancy}/{s.capacity}
                </span>
              </div>
              <Progress
                value={(s.occupancy / s.capacity) * 100}
                className="h-1.5"
              />
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  )
}
