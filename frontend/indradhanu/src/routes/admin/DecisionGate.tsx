import { useState } from "react"
import { toast } from "sonner"
import {
  CheckCircle2,
  FileText,
  ShieldAlert,
  ShieldCheck,
  XCircle,
} from "lucide-react"
import type { Decision } from "@/api/types"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { Textarea } from "@/components/ui/textarea"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card"
import { useDecisions } from "@/hooks/useApi"
import { api } from "@/api/client"
import { timeOf } from "@/lib/format"
import { wardName } from "@/api/mock/geo"
import { POLICY } from "@/api/mock/policy"
import { cn } from "@/lib/utils"

const STATUS_META: Record<
  Decision["status"],
  { label: string; className: string }
> = {
  auto_issued: {
    label: "Auto-issued",
    className: "bg-status-resolved text-white",
  },
  awaiting_approval: {
    label: "Awaiting approval",
    className: "bg-sev-4 text-sev-4-foreground",
  },
  approved: { label: "Approved", className: "bg-status-resolved text-white" },
  overridden: {
    label: "Overridden",
    className: "bg-status-pending text-black",
  },
  rejected: { label: "Rejected", className: "bg-sev-5 text-sev-5-foreground" },
}

export default function DecisionGate() {
  const { data: decisions = [], refetch } = useDecisions()
  const [filter, setFilter] = useState<"pending" | "all">("pending")
  const [dialog, setDialog] = useState<{
    d: Decision
    action: "approve" | "reject" | "override"
  } | null>(null)
  const [note, setNote] = useState("")

  const pending = decisions.filter((d) => d.status === "awaiting_approval")
  const shown =
    filter === "pending" ? (pending.length ? pending : decisions) : decisions

  async function act() {
    if (!dialog) return
    const { d, action } = dialog
    await api.actOnDecision(d.id, action, note || undefined)
    setDialog(null)
    setNote("")
    await refetch()
    toast.success(
      action === "approve"
        ? "Action approved and issued"
        : action === "reject"
          ? "Action rejected"
          : "Action overridden",
      { description: `${d.action} — ${d.target}` }
    )
  }

  if (!decisions.length) {
    return (
      <Empty
        icon={<ShieldCheck className="size-8 text-muted-foreground" />}
        title="No decisions yet"
        body="Once a hazard run produces candidate actions, each one is checked against the policy corpus and lands here."
      />
    )
  }

  return (
    <div className="space-y-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">Decision gate</h1>
          <p className="text-sm text-muted-foreground">
            Every action is checked against the retrieved clause before it can
            issue.
            {pending.length > 0 && (
              <>
                {" "}
                <span className="font-medium text-sev-4">
                  {pending.length} need{pending.length === 1 ? "s" : ""} your
                  approval.
                </span>
              </>
            )}
          </p>
        </div>
        <Tabs
          value={filter}
          onValueChange={(v) => setFilter(v as typeof filter)}
        >
          <TabsList>
            <TabsTrigger value="pending">Needs approval</TabsTrigger>
            <TabsTrigger value="all">All ({decisions.length})</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      <div className="grid gap-3 xl:grid-cols-2">
        {shown.map((d) => {
          const meta = STATUS_META[d.status]
          const needsAction = d.status === "awaiting_approval"
          const clause = POLICY.find((p) => p.clause === d.authority.clause)
          return (
            <Card
              key={d.id}
              className={cn(needsAction && "border-2 border-sev-4")}
            >
              <CardHeader className="pb-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <CardTitle className="text-base">{d.action}</CardTitle>
                    <p className="mt-0.5 text-sm text-muted-foreground">
                      {d.target}
                    </p>
                  </div>
                  <Badge className={cn("shrink-0", meta.className)}>
                    {meta.label}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="text-sm">{d.rationale}</p>

                <Separator />

                <div className="space-y-2">
                  <div className="flex items-center gap-2 text-xs">
                    {d.authority.withinDelegation ? (
                      <ShieldCheck className="size-4 shrink-0 text-status-resolved" />
                    ) : (
                      <ShieldAlert className="size-4 shrink-0 text-sev-4" />
                    )}
                    <span className="font-medium">
                      {d.authority.withinDelegation
                        ? "Within delegated authority"
                        : "Outside delegated authority"}
                    </span>
                  </div>
                  <HoverCard>
                    <HoverCardTrigger asChild>
                      <button className="flex w-full items-start gap-2 rounded-md border p-2 text-left hover:bg-accent">
                        <FileText className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 text-xs">
                          <span className="font-medium">
                            {d.authority.clause}
                          </span>
                          <span className="block truncate text-muted-foreground">
                            {d.authority.source} · delegated to{" "}
                            {d.authority.delegatedTo}
                          </span>
                        </span>
                      </button>
                    </HoverCardTrigger>
                    <HoverCardContent className="w-96" align="start">
                      <p className="text-xs font-semibold">
                        {d.authority.clause}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {clause?.text ?? "Clause text unavailable."}
                      </p>
                    </HoverCardContent>
                  </HoverCard>
                </div>

                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  <span className="tabular">
                    Confidence {Math.round(d.confidence * 100)}%
                  </span>
                  <span className="tabular">{timeOf(d.createdAt)} IST</span>
                  {d.wardId && <span>{wardName(d.wardId)}</span>}
                </div>

                {d.decidedBy && (
                  <div className="rounded-md bg-muted p-2 text-xs">
                    <span className="font-medium">{meta.label}</span> by{" "}
                    {d.decidedBy} at {timeOf(d.decidedAt)}
                    {d.overrideNote && (
                      <p className="mt-1 text-muted-foreground">
                        “{d.overrideNote}”
                      </p>
                    )}
                  </div>
                )}

                {needsAction && (
                  <div className="flex flex-wrap gap-2 pt-1">
                    <Button
                      size="sm"
                      onClick={() => setDialog({ d, action: "approve" })}
                    >
                      <CheckCircle2 className="size-3.5" />
                      Approve and issue
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setDialog({ d, action: "override" })}
                    >
                      Override
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setDialog({ d, action: "reject" })}
                    >
                      <XCircle className="size-3.5" />
                      Reject
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          )
        })}
      </div>

      <AlertDialog open={!!dialog} onOpenChange={(o) => !o && setDialog(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {dialog?.action === "approve" && "Approve and issue this action?"}
              {dialog?.action === "override" && "Override the recommendation?"}
              {dialog?.action === "reject" && "Reject this action?"}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>
                  <span className="font-medium text-foreground">
                    {dialog?.d.action}
                  </span>{" "}
                  — {dialog?.d.target}
                </p>
                <p className="text-xs">
                  This will be recorded against {dialog?.d.authority.clause} and
                  attributed to you in the after-action record.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Textarea
            placeholder={
              dialog?.action === "approve"
                ? "Optional note for the record"
                : "Why are you departing from the recommendation?"
            }
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
          />
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={act}>
              {dialog?.action === "approve" ? "Approve and issue" : "Confirm"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

export function Empty({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode
  title: string
  body: string
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-10 text-center">
      {icon}
      <div>
        <p className="font-medium">{title}</p>
        <p className="max-w-sm text-sm text-muted-foreground">{body}</p>
      </div>
    </div>
  )
}
