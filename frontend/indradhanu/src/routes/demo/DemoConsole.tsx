import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  AlertTriangle, Copy, Gavel, Loader2, Play, Square, Zap,
} from "lucide-react"
import { useDemo } from "./useDemo"
import { LiveMap } from "@/components/map/LiveMap"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Alert, AlertDescription } from "@/components/ui/alert"

/** The live console.
 *
 *  Everything on this page came out of the API within the last second. The
 *  world advances on the server, one tick per second, and the map animates
 *  between polls. Nothing is scripted in the browser.
 */


const BEAT_STYLE: Record<string, string> = {
  incident: "text-orange-600 dark:text-orange-400",
  merge: "text-sky-600 dark:text-sky-400",
  held: "text-amber-600 dark:text-amber-400",
  attack: "text-red-600 dark:text-red-400",
  dispatch: "text-emerald-600 dark:text-emerald-400",
  reassign: "text-violet-600 dark:text-violet-400",
  release: "text-muted-foreground",
  resolved: "text-emerald-600 dark:text-emerald-400",
  shortfall: "text-red-600 dark:text-red-400",
  decision: "text-blue-600 dark:text-blue-400",
  you: "text-violet-600 dark:text-violet-400 font-medium",
  error: "text-red-600 dark:text-red-400",
}

export default function DemoConsole() {
  const { state, error, refresh, act } = useDemo(1000)
  const [busy, setBusy] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const feedRef = useRef<HTMLDivElement>(null)

  const run = useCallback(
    async (key: string, path: string, body?: unknown) => {
      setBusy(key)
      try {
        return await act(path, body)
      } finally {
        setBusy(null)
      }
    },
    [act]
  )

  useEffect(() => {
    feedRef.current?.scrollTo({ top: 0, behavior: "smooth" })
  }, [state.beats.length])

  const pending = useMemo(
    () => state.decisions.filter((d) => d.status === "awaiting_approval"),
    [state.decisions]
  )
  const autoIssued = state.decisions.filter((d) => d.status === "auto_issued").length
  const selectedIncident = state.incidents.find((i) => i.id === selected)
  const selectedNeeds = state.needs.filter((n) => n.incidentId === selected)

  const committed = state.resources.filter((r) => r.status !== "available").length
  const merged = state.incidents.reduce((n, i) => n + Math.max(0, i.reportCount - 1), 0)

  return (
    <div className="space-y-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        {!state.running ? (
          <Button onClick={() => run("start", "/demo/start", { cityId: "pune", reportEveryTicks: 4 })}
                  disabled={busy !== null}>
            {busy === "start" ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
            Start demo
          </Button>
        ) : (
          <Button variant="destructive" onClick={() => run("stop", "/demo/stop")} disabled={busy !== null}>
            <Square className="size-4" /> Stop
          </Button>
        )}
        <Button variant="outline" onClick={() => run("replan", "/demo/replan")} disabled={busy !== null}>
          <Zap className="size-4" /> Re-plan now
        </Button>

        <div className="text-muted-foreground ml-2 flex items-center gap-3 text-xs">
          <span>tick <span className="tabular-nums font-medium">{state.tick}</span></span>
          <span>{state.incidents.length} open incidents</span>
          <span>{committed}/{state.resources.length} units committed</span>
          {merged > 0 && (
            <Badge variant="outline" className="gap-1">
              <Copy className="size-3" />{merged} duplicate dispatch{merged === 1 ? "" : "es"} avoided
            </Badge>
          )}
          <Badge variant="secondary">{autoIssued} auto-issued</Badge>
          {pending.length > 0 && <Badge variant="destructive">{pending.length} awaiting officer</Badge>}
        </div>
      </div>

      {(error || state.error) && (
        <Alert variant="destructive">
          <AlertTriangle className="size-4" />
          <AlertDescription>{error ?? state.error}</AlertDescription>
        </Alert>
      )}

      <div className="grid gap-3 lg:grid-cols-[1fr_380px]">
        <div className="space-y-3">
          <LiveMap
            className="h-[520px] w-full rounded-lg border"
            wards={state.wards}
            incidents={state.incidents}
            resources={state.resources}
            facilities={state.facilities ?? []}
            blocks={state.roadBlocks ?? []}
            onPickIncident={setSelected}
          />
          <p className="text-muted-foreground text-xs">
            Dashed amber lines are units en route to what they were tasked with.
            A number inside an incident is how many reports collapsed into it.
            Hover anything for detail.
          </p>

          {selectedIncident && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">{selectedIncident.title}</CardTitle>
                <CardDescription>
                  Severity {selectedIncident.severity} · {selectedIncident.reportCount} report
                  {selectedIncident.reportCount === 1 ? "" : "s"} ·
                  confidence {(selectedIncident.confidence * 100).toFixed(0)}%
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-1">
                {selectedNeeds.map((n) => (
                  <div key={n.capability} className="flex items-center gap-2 text-xs">
                    <Badge variant={n.met >= n.required ? "secondary" : "destructive"}>
                      {n.met}/{n.required}
                    </Badge>
                    <span>{n.capability.replace(/_/g, " ")}</span>
                    {n.met < n.required && (
                      <span className="text-muted-foreground">shortfall</span>
                    )}
                  </div>
                ))}
                {selectedNeeds.length === 0 && (
                  <p className="text-muted-foreground text-xs">No capability needs recorded.</p>
                )}
              </CardContent>
            </Card>
          )}
        </div>

        <div className="space-y-3">
          {pending.length > 0 && (
            <Card className="border-destructive/50">
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-sm">
                  <Gavel className="size-4" /> Awaiting an officer
                </CardTitle>
                <CardDescription>
                  These did not issue automatically. The clause is why.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                {pending.slice(0, 4).map((d) => (
                  <div key={d.id} className="rounded border p-2 text-xs">
                    <div className="font-medium">{d.action}</div>
                    <div className="text-muted-foreground">{d.target}</div>
                    <div className="text-muted-foreground mt-1 italic">{d.rationale}</div>
                    {d.clause && (
                      <div className="mt-1">
                        <Badge variant="outline">{d.clause}</Badge>{" "}
                        <span className="text-muted-foreground">
                          reserved to {d.delegatedTo}
                        </span>
                      </div>
                    )}
                    <div className="mt-2 flex gap-2">
                      <Button size="sm" className="h-7 text-xs"
                              onClick={() => run(`ok-${d.id}`, `/demo/decisions/${d.id}/approve`)}>
                        Approve
                      </Button>
                      <Button size="sm" variant="outline" className="h-7 text-xs"
                              onClick={() => run(`no-${d.id}`, `/demo/decisions/${d.id}/reject`)}>
                        Reject
                      </Button>
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          {state.duplicates.length > 0 && (
            <Alert variant="destructive">
              <Copy className="size-4" />
              <AlertDescription className="text-xs">
                <div className="font-medium">Work being done twice</div>
                {state.duplicates.slice(0, 2).map((d, i) => <div key={i}>{d.detail}</div>)}
              </AlertDescription>
            </Alert>
          )}

          {state.plan && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Last re-plan</CardTitle>
                <CardDescription className="text-xs">{state.plan.headline}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-1">
                {[...state.plan.reassigned, ...state.plan.assigned, ...state.plan.released]
                  .slice(0, 6)
                  .map((c, i) => (
                    <div key={i} className="text-xs">
                      <Badge variant={c.kind === "reassigned" ? "default" : "outline"}
                             className="mr-1">{c.resource_label}</Badge>
                      <span className="text-muted-foreground">{c.reason}</span>
                    </div>
                  ))}
                {state.plan.uncovered.slice(0, 3).map((u, i) => (
                  <div key={`u${i}`} className="text-destructive text-xs">{u.reason}</div>
                ))}
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">What is happening</CardTitle>
            </CardHeader>
            <CardContent>
              <div ref={feedRef} className="max-h-[420px] space-y-1.5 overflow-y-auto">
                {[...state.beats].reverse().map((b, i) => (
                  <div key={`${b.tick}-${i}`} className="flex gap-2 text-xs">
                    <span className="text-muted-foreground shrink-0 tabular-nums">
                      {String(b.tick).padStart(3, "0")}
                    </span>
                    <span className={BEAT_STYLE[b.kind] ?? ""}>{b.text}</span>
                  </div>
                ))}
                {state.beats.length === 0 && (
                  <p className="text-muted-foreground text-xs">
                    Press Start. Reports arrive a few seconds apart.
                  </p>
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
