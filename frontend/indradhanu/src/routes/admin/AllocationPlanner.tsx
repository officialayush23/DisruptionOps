import { useMemo } from "react"
import { ArrowRight, Loader2, Route, Zap } from "lucide-react"
import { useDemo } from "@/routes/demo/DemoProvider"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import type { RawChange } from "@/routes/demo/useDemo"

/** What the last solve decided, and what it cost to decide it.
 *
 *  The useful artefact of a re-plan is not the plan, it is the diff. An officer
 *  cannot check a fresh assignment of twenty-three units against their own
 *  judgement, but they can check four changes and the sentence attached to each
 *  one. Kept units are shown too, because "nothing moved" is a result and a
 *  screen that only lists changes cannot tell you it happened.
 */

const LABELS = {
  reassigned: "Re-tasked",
  assigned: "Newly tasked",
  released: "Stood down",
  kept: "Left alone",
} as const

const GROUPS: { key: keyof typeof LABELS; tone: string }[] = [
  { key: "reassigned", tone: "border-violet-500/40 bg-violet-500/5" },
  { key: "assigned", tone: "border-emerald-500/40 bg-emerald-500/5" },
  { key: "released", tone: "border-slate-500/40 bg-slate-500/5" },
  { key: "kept", tone: "border-sky-500/40 bg-sky-500/5" },
]

function ChangeRow({ c }: { c: RawChange }) {
  return (
    <div className="rounded border p-2 text-xs">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant="outline">{c.resource_label}</Badge>
        {c.from_incident_title && (
          <>
            <span className="text-muted-foreground truncate">{c.from_incident_title}</span>
            <ArrowRight className="text-muted-foreground size-3 shrink-0" />
          </>
        )}
        <span className="truncate font-medium">
          {c.incident_title || "no task"}
        </span>
        {c.eta_minutes > 0 && (
          <span className="text-muted-foreground tabular-nums">
            {c.eta_minutes} min
          </span>
        )}
      </div>
      {c.reason && <div className="text-muted-foreground mt-1">{c.reason}</div>}
    </div>
  )
}

export default function AllocationPlanner() {
  const { state, busy, run } = useDemo()
  const plan = state.plan

  const fleet = useMemo(() => {
    const byStatus = new Map<string, number>()
    for (const r of state.resources) {
      byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1)
    }
    return byStatus
  }, [state.resources])

  const unmet = state.needs.filter((n) => n.met < n.required)
  const shortBy = unmet.reduce((n, x) => n + (x.required - x.met), 0)

  return (
    <div className="space-y-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          onClick={() => run("replan", "/demo/replan")}
          disabled={busy !== null}
        >
          {busy === "replan" ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Zap className="size-4" />
          )}
          Re-plan now
        </Button>
        <div className="text-muted-foreground flex flex-wrap items-center gap-3 text-xs">
          {[...fleet].map(([status, n]) => (
            <span key={status}>
              {n} {status.replace(/_/g, " ")}
            </span>
          ))}
          {shortBy > 0 && (
            <Badge variant="destructive">
              {shortBy} unit(s) short across {unmet.length} need(s)
            </Badge>
          )}
        </div>
      </div>

      {!plan ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <Route className="size-4" /> No plan yet
            </CardTitle>
            <CardDescription className="text-xs">
              The planner runs when new reports have changed the picture, at most
              once every six ticks, and on demand from the button above. Until it
              has run there is nothing to check, so nothing is shown.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">{plan.headline}</CardTitle>
              <CardDescription className="text-xs">
                Solved by {plan.engine}. Coverage {(plan.coverage * 100).toFixed(0)}%.
                A unit already on its way costs something to move, and more the
                closer it is, which is why most of them stay put.
              </CardDescription>
            </CardHeader>
            {plan.uncovered.length > 0 && (
              <CardContent className="space-y-1">
                <div className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
                  Could not be covered
                </div>
                {plan.uncovered.map((u, i) => (
                  <div key={i} className="text-destructive text-xs">
                    {u.ward_id ? `${u.ward_id}: ` : ""}
                    {u.reason}
                  </div>
                ))}
              </CardContent>
            )}
          </Card>

          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            {GROUPS.map(({ key, tone }) => {
              const list = plan[key] ?? []
              return (
                <Card key={key} className={list.length ? tone : undefined}>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm">
                      {LABELS[key]}{" "}
                      <span className="text-muted-foreground tabular-nums font-normal">
                        {list.length}
                      </span>
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="max-h-[420px] space-y-1.5 overflow-y-auto">
                    {list.map((c, i) => (
                      <ChangeRow key={`${c.resource_id}-${i}`} c={c} />
                    ))}
                    {list.length === 0 && (
                      <p className="text-muted-foreground text-xs">None.</p>
                    )}
                  </CardContent>
                </Card>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}
