import {
  CheckCircle2,
  FileText,
  History,
  ShieldAlert,
  ShieldCheck,
  XCircle,
} from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { StatTile } from "@/components/common/indicators"
import { timeOf } from "@/lib/format"
import {
  useAgentRuns,
  useAlerts,
  useDecisions,
  useFieldTasks,
  useIncidents,
  useAllocationPlan,
} from "@/hooks/useApi"
import { wardName } from "@/api/mock/geo"
import { Empty } from "./DecisionGate"
import { cn } from "@/lib/utils"

export default function AfterAction() {
  const { data: decisions = [] } = useDecisions()
  const { data: incidents = [] } = useIncidents()
  const { data: alerts = [] } = useAlerts()
  const { data: tasks = [] } = useFieldTasks()
  const { data: runs = [] } = useAgentRuns()
  const { data: plan } = useAllocationPlan()
  const run = runs[0]

  if (!decisions.length) {
    return (
      <Empty
        icon={<History className="size-8 text-muted-foreground" />}
        title="Nothing to review yet"
        body="After an event, every recommendation, cited clause, approval, override and closure is replayed here as one auditable record."
      />
    )
  }

  const auto = decisions.filter((d) => d.status === "auto_issued").length
  const human = decisions.filter((d) =>
    ["approved", "overridden", "rejected"].includes(d.status)
  ).length
  const overrides = decisions.filter(
    (d) => d.status === "overridden" || d.status === "rejected"
  )

  const timeline = [
    ...decisions.map((d) => ({
      at: d.createdAt,
      kind: "decision" as const,
      title: d.action,
      detail: `${d.target} — ${d.authority.clause}`,
      status: d.status,
    })),
    ...alerts.map((a) => ({
      at: a.issuedAt,
      kind: "alert" as const,
      title: "Advisory issued",
      detail: `${wardName(a.wardId)} — reach ${a.reach.toLocaleString("en-IN")}`,
      status: "auto_issued" as const,
    })),
    ...incidents.map((i) => ({
      at: i.createdAt,
      kind: "incident" as const,
      title: i.title,
      detail: `${wardName(i.wardId)} — ${i.reportCount} reports clustered`,
      status: "auto_issued" as const,
    })),
    ...tasks
      .filter((t) => t.completedAt)
      .map((t) => ({
        at: t.completedAt!,
        kind: "task" as const,
        title: `Closed — ${t.title}`,
        detail: t.proofNote ?? "",
        status: "approved" as const,
      })),
  ].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime())

  return (
    <div className="space-y-4 p-4">
      <div>
        <h1 className="text-lg font-semibold">After-action record</h1>
        <p className="text-sm text-muted-foreground">
          What was recommended, what a human changed, and what actually happened
          — the record that makes the next event better, and the one an auditor
          asks for.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label="Decisions"
          value={String(decisions.length)}
          sub={`${auto} auto-issued, ${human} by officer`}
        />
        <StatTile
          label="Advisories"
          value={String(alerts.length)}
          sub={`${alerts.reduce((a, x) => a + x.reach, 0).toLocaleString("en-IN")} residents reached`}
        />
        <StatTile
          label="Incidents"
          value={String(incidents.length)}
          sub={`${incidents.filter((i) => i.status === "resolved").length} resolved`}
        />
        <StatTile
          label="Unmet demand"
          value={String(plan?.uncovered.length ?? 0)}
          sub="logged, not hidden"
        />
      </div>

      {run?.summary && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Run summary</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm">{run.summary}</p>
          </CardContent>
        </Card>
      )}

      {overrides.length > 0 && (
        <Card className="border-status-pending">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm">
              <ShieldAlert className="size-4" />
              Where a human departed from the recommendation
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              These are the most valuable rows in the system. Each one is a
              labelled example of the model being wrong in a way an officer
              could name.
            </p>
            {overrides.map((d) => (
              <div key={d.id} className="rounded-md border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">{d.action}</span>
                  <Badge variant="outline">{d.status}</Badge>
                </div>
                <p className="mt-1 text-sm text-muted-foreground">{d.target}</p>
                {d.overrideNote && (
                  <p className="mt-2 text-sm">“{d.overrideNote}”</p>
                )}
                <p className="mt-1 text-xs text-muted-foreground">
                  {d.decidedBy} · {timeOf(d.decidedAt)} IST
                </p>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Event timeline</CardTitle>
        </CardHeader>
        <CardContent className="space-y-0">
          {timeline.map((e, i) => (
            <div key={i} className="flex gap-3 py-2.5">
              <div className="flex flex-col items-center">
                <span
                  className={cn(
                    "flex size-6 shrink-0 items-center justify-center rounded-full",
                    e.status === "auto_issued" || e.status === "approved"
                      ? "bg-status-resolved text-white"
                      : e.status === "awaiting_approval"
                        ? "bg-sev-4 text-sev-4-foreground"
                        : "bg-status-pending text-black"
                  )}
                >
                  {e.status === "rejected" ? (
                    <XCircle className="size-3.5" />
                  ) : e.kind === "decision" ? (
                    <FileText className="size-3.5" />
                  ) : (
                    <CheckCircle2 className="size-3.5" />
                  )}
                </span>
                {i < timeline.length - 1 && (
                  <span className="mt-1 w-px flex-1 bg-border" />
                )}
              </div>
              <div className="min-w-0 flex-1 pb-1">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="text-sm font-medium">{e.title}</span>
                  <span className="tabular text-xs text-muted-foreground">
                    {timeOf(e.at)} IST
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">{e.detail}</p>
              </div>
            </div>
          ))}
          <Separator className="my-2" />
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <ShieldCheck className="size-3.5" />
            Every row above carries the clause it was issued under and the
            person who authorised it.
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
