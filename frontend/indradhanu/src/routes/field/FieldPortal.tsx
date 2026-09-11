import { useState } from "react"
import { toast } from "sonner"
import {
  CheckCircle2,
  ClipboardList,
  MapPin,
  Navigation,
  Truck,
} from "lucide-react"
import type { FieldTask } from "@/api/types"
import { PortalShell } from "@/components/layout/PortalShell"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Textarea } from "@/components/ui/textarea"
import { Separator } from "@/components/ui/separator"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { MapView } from "@/components/map/MapView"
import { SeverityBadge } from "@/components/common/indicators"
import { timeOf } from "@/lib/format"
import {
  useFieldTasks,
  useIncidents,
  useResources,
  useWardRisks,
  useWards,
} from "@/hooks/useApi"
import { api } from "@/api/client"
import { wardName } from "@/api/mock/geo"
import { cn } from "@/lib/utils"

const STATUS_CLASS: Record<FieldTask["status"], string> = {
  queued: "bg-status-pending text-black",
  accepted: "bg-status-active text-white",
  on_site: "bg-status-active text-white",
  complete: "bg-status-resolved text-white",
}

const NEXT: Record<FieldTask["status"], FieldTask["status"] | null> = {
  queued: "accepted",
  accepted: "on_site",
  on_site: "complete",
  complete: null,
}

const NEXT_LABEL: Record<string, string> = {
  accepted: "Accept task",
  on_site: "Mark on site",
  complete: "Close with proof",
}

export default function FieldPortal() {
  const { data: allTasks = [] } = useFieldTasks()
  const { data: wards = [] } = useWards()
  const { data: risks = [] } = useWardRisks("flood")
  const { data: resources = [] } = useResources()
  const { data: incidents = [] } = useIncidents()

  const operators = Array.from(new Set(allTasks.map((t) => t.operator)))
  const [operator, setOperator] = useState<string>("all")
  const [proof, setProof] = useState<Record<string, string>>({})

  const tasks =
    operator === "all"
      ? allTasks
      : allTasks.filter((t) => t.operator === operator)
  const open = tasks.filter((t) => t.status !== "complete")
  const done = tasks.filter((t) => t.status === "complete")

  async function advance(t: FieldTask) {
    const next = NEXT[t.status]
    if (!next) return
    await api.updateFieldTask(
      t.id,
      next,
      next === "complete" ? proof[t.id] : undefined
    )
    toast.success(
      next === "complete"
        ? "Task closed with proof"
        : `Task ${next.replace("_", " ")}`,
      { description: t.title }
    )
  }

  return (
    <PortalShell
      title="Field & service operator"
      subtitle="Accept, work, close — with proof"
    >
      <div className="mx-auto w-full max-w-3xl space-y-4 p-4">
        <div className="flex items-center gap-2">
          <Truck className="size-4 shrink-0 text-muted-foreground" />
          <Select value={operator} onValueChange={setOperator}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder="All operators" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All operators</SelectItem>
              {operators.map((o) => (
                <SelectItem key={o} value={o}>
                  {o}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {!tasks.length ? (
          <Card>
            <CardContent className="flex flex-col items-center gap-2 py-10 text-center">
              <ClipboardList className="size-8 text-muted-foreground" />
              <p className="font-medium">No tasks assigned</p>
              <p className="max-w-sm text-sm text-muted-foreground">
                Tasks appear here the moment the planner dispatches a unit. Each
                one carries the approach instruction the solver worked out, not
                just a pin on a map.
              </p>
            </CardContent>
          </Card>
        ) : (
          <>
            <Card className="overflow-hidden py-0">
              <MapView
                className="h-[260px] w-full"
                expandable
                wards={wards}
                risks={risks}
                resources={resources}
                incidents={incidents}
                zoom={11.6}
              />
            </Card>

            {open.map((t) => (
              <Card key={t.id} className="border-2">
                <CardHeader className="pb-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <CardTitle className="text-base">{t.title}</CardTitle>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {t.operator} · {wardName(t.wardId)}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <SeverityBadge severity={t.priority} showLabel={false} />
                      <Badge className={STATUS_CLASS[t.status]}>
                        {t.status.replace("_", " ")}
                      </Badge>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="rounded-md bg-muted p-3">
                    <p className="mb-1 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
                      Approach instruction
                    </p>
                    <p className="text-sm">{t.instruction}</p>
                  </div>

                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    <span className="inline-flex items-center gap-1.5">
                      <MapPin className="size-3" />
                      {t.location[1].toFixed(4)}, {t.location[0].toFixed(4)}
                    </span>
                    {t.acceptedAt && (
                      <span className="tabular">
                        accepted {timeOf(t.acceptedAt)}
                      </span>
                    )}
                  </div>

                  {t.status === "on_site" && (
                    <Textarea
                      rows={2}
                      placeholder="What did you find and what did you do? This closes the task."
                      value={proof[t.id] ?? ""}
                      onChange={(e) =>
                        setProof((p) => ({ ...p, [t.id]: e.target.value }))
                      }
                    />
                  )}

                  <Button
                    className="w-full"
                    onClick={() => advance(t)}
                    disabled={
                      t.status === "on_site" && !(proof[t.id] ?? "").trim()
                    }
                  >
                    <Navigation className="size-4" />
                    {NEXT_LABEL[NEXT[t.status] ?? ""]}
                  </Button>
                </CardContent>
              </Card>
            ))}

            {done.length > 0 && (
              <>
                <Separator />
                <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                  Closed ({done.length})
                </p>
                {done.map((t) => (
                  <Card key={t.id} className={cn("opacity-90")}>
                    <CardContent className="space-y-2 py-4">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="inline-flex items-center gap-2 text-sm font-medium">
                          <CheckCircle2 className="size-4 text-status-resolved" />
                          {t.title}
                        </span>
                        <span className="tabular text-xs text-muted-foreground">
                          {timeOf(t.completedAt)} IST
                        </span>
                      </div>
                      {t.proofNote && (
                        <p className="text-sm text-muted-foreground">
                          “{t.proofNote}”
                        </p>
                      )}
                    </CardContent>
                  </Card>
                ))}
              </>
            )}
          </>
        )}
      </div>
    </PortalShell>
  )
}
