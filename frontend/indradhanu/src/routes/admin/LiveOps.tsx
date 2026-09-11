import { useCallback, useEffect, useState } from "react"
import {
  AlertTriangle, CheckCircle2, Copy, Layers, Loader2, Play, RefreshCw,
  ShieldAlert, Siren, Zap,
} from "lucide-react"
import {
  request, startRun, fetchEvents, fetchEventChain,
  type RunResult, type EventRow,
} from "@/api/httpClient"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Separator } from "@/components/ui/separator"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

/** The live console.
 *
 *  Every number on this page came out of the API a moment ago. Nothing here
 *  reads `src/api/mock`. It exists so the backend can be checked from a browser
 *  rather than from curl, and so the three things that are hard to believe from
 *  a JSON dump - deduplication, trust, and re-allocation with a reason - are
 *  each visible as a thing that happened rather than a claim.
 */

type Incident = {
  id: string; title: string; category: string; wardId: string
  severity: number; status: string; reportCount: number; confidence: number
}
type IncidentReport = {
  id: string; note: string; reporter_name: string; source: string
  trust_score: number | null; verification_status: string
  link_score: number | null; decided_by: string | null; rationale: string | null
  mesh_hops: number | null
}
type Duplicate = {
  kind: string; incidentIds: string[]; wardId: string | null
  agencies: string[]; resources: string[]; detail: string; wastedUnits: number
}
type Change = {
  kind: string; resourceId: string; resourceLabel: string
  incidentId: string | null; incidentTitle: string; wardId: string
  fromIncidentTitle: string; etaMinutes: number; reason: string
}
type PlanDiff = {
  planId: string | null; engine: string; runtimeMs: number; coverage: number
  headline: string; changed: number
  kept: Change[]; assigned: Change[]; reassigned: Change[]; released: Change[]
  uncovered: { wardId: string; capability: string; reason: string }[]
}
type SimResult = {
  reports: number; incidentsOpened: number; reportsMerged: number
  reportsHeld: number; injectionFlagged: number; headline: string
  duplicateEffort: Duplicate[]; plan: PlanDiff | null
  reportDetail: {
    reportId: string; incidentId: string | null; trust: number; status: string
    linkScore: number; decidedBy: string; injectionSuspected: boolean; summary: string
  }[]
}

const sevTone = (s: number) =>
  s >= 5 ? "destructive" : s >= 4 ? "default" : "secondary"

const trustTone = (status: string) =>
  status === "auto_confirmed" ? "default"
    : status === "quarantined" ? "destructive" : "secondary"

export default function LiveOps() {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [run, setRun] = useState<RunResult | null>(null)
  const [sim, setSim] = useState<SimResult | null>(null)
  const [plan, setPlan] = useState<PlanDiff | null>(null)
  const [incidents, setIncidents] = useState<Incident[]>([])
  const [dupes, setDupes] = useState<Duplicate[]>([])
  const [events, setEvents] = useState<EventRow[]>([])
  const [chain, setChain] = useState<EventRow[] | null>(null)
  const [openIncident, setOpenIncident] = useState<string | null>(null)
  const [incidentReports, setIncidentReports] = useState<IncidentReport[]>([])

  const guard = useCallback(async (key: string, fn: () => Promise<void>) => {
    setBusy(key); setError(null)
    try { await fn() } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally { setBusy(null) }
  }, [])

  const refresh = useCallback(async () => {
    const [inc, dup, evs] = await Promise.all([
      request<Incident[]>("/incidents"),
      request<Duplicate[]>("/duplicates"),
      fetchEvents({ limit: 60 }),
    ])
    setIncidents(inc); setDupes(dup); setEvents(evs)
  }, [])

  useEffect(() => { void guard("load", refresh) }, [guard, refresh])

  const doRun = () => guard("run", async () => {
    setRun(await startRun("flood", "pune")); await refresh()
  })

  const doSimulate = (count: number, dup: number, adv: number) =>
    guard("sim", async () => {
      const r = await request<SimResult>("/simulate/reports", {
        method: "POST",
        body: { count, duplicateRatio: dup, adversarialRatio: adv, cityId: "pune", replan: true },
      })
      setSim(r); if (r.plan) setPlan(r.plan); await refresh()
    })

  const doReplan = () => guard("replan", async () => {
    setPlan(await request<PlanDiff>("/replan?trigger=manual", { method: "POST" }))
    await refresh()
  })

  const showIncident = (id: string) => guard("incident", async () => {
    setOpenIncident(id)
    setIncidentReports(await request<IncidentReport[]>(`/incidents/${id}/reports`))
  })

  const showChain = (id: number) => guard("chain", async () => {
    setChain(await fetchEventChain(id))
  })

  return (
    <div className="space-y-4 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={doRun} disabled={busy !== null}>
          {busy === "run" ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
          Run flood hazard
        </Button>
        <Button variant="secondary" onClick={() => doSimulate(12, 0.5, 0.2)} disabled={busy !== null}>
          {busy === "sim" ? <Loader2 className="size-4 animate-spin" /> : <Siren className="size-4" />}
          Simulate 12 reports
        </Button>
        <Button variant="secondary" onClick={() => doSimulate(6, 0.8, 0)} disabled={busy !== null}>
          <Copy className="size-4" /> 6 duplicates
        </Button>
        <Button variant="secondary" onClick={() => doSimulate(6, 0, 0.6)} disabled={busy !== null}>
          <ShieldAlert className="size-4" /> Fake report burst
        </Button>
        <Button variant="outline" onClick={doReplan} disabled={busy !== null}>
          <Zap className="size-4" /> Re-plan
        </Button>
        <Button variant="ghost" size="sm" onClick={() => guard("load", refresh)} disabled={busy !== null}>
          <RefreshCw className="size-3.5" /> Refresh
        </Button>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertTriangle className="size-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {run && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Hazard run</CardTitle>
            <CardDescription>
              {run.wardsScored} wards scored in {run.durationMs} ms, feeds {run.mode},
              solver {run.engine}
            </CardDescription>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
            {[
              ["Wards", run.wardsScored], ["Decisions", run.decisions],
              ["Auto-issued", run.autoIssued], ["Awaiting officer", run.awaitingApproval],
              ["Assignments", run.assignments], ["Uncovered", run.uncovered],
              ["Events", run.events],
            ].map(([k, v]) => (
              <div key={String(k)}>
                <div className="text-2xl font-semibold tabular-nums">{String(v)}</div>
                <div className="text-muted-foreground text-xs">{k}</div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {sim && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Deduplication and trust</CardTitle>
            <CardDescription>{sim.headline}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
              {[
                ["Reports in", sim.reports], ["Incidents opened", sim.incidentsOpened],
                ["Merged as duplicates", sim.reportsMerged], ["Held below trust floor", sim.reportsHeld],
                ["Injection flagged", sim.injectionFlagged],
              ].map(([k, v]) => (
                <div key={String(k)}>
                  <div className="text-2xl font-semibold tabular-nums">{String(v)}</div>
                  <div className="text-muted-foreground text-xs">{k}</div>
                </div>
              ))}
            </div>
            <Separator />
            <div className="max-h-56 space-y-1 overflow-y-auto">
              {sim.reportDetail.map((r) => (
                <div key={r.reportId} className="flex items-start gap-2 text-xs">
                  <Badge variant={trustTone(r.status)} className="shrink-0">
                    {(r.trust * 100).toFixed(0)}%
                  </Badge>
                  {r.injectionSuspected && (
                    <Badge variant="destructive" className="shrink-0">injection</Badge>
                  )}
                  <span className="text-muted-foreground">{r.summary}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <Tabs defaultValue="incidents">
        <TabsList>
          <TabsTrigger value="incidents">Incidents ({incidents.length})</TabsTrigger>
          <TabsTrigger value="plan">Allocation diff</TabsTrigger>
          <TabsTrigger value="duplicates">Duplicate effort ({dupes.length})</TabsTrigger>
          <TabsTrigger value="events">Audit log ({events.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="incidents" className="space-y-2">
          {incidents.length === 0 && (
            <p className="text-muted-foreground p-4 text-sm">
              No incidents yet. Simulate some reports.
            </p>
          )}
          {incidents.map((i) => (
            <Card key={i.id} className="cursor-pointer" onClick={() => showIncident(i.id)}>
              <CardContent className="flex flex-wrap items-center gap-2 py-3">
                <Badge variant={sevTone(i.severity)}>S{i.severity}</Badge>
                <span className="text-sm font-medium">{i.title}</span>
                {i.reportCount > 1 && (
                  <Badge variant="outline" className="gap-1">
                    <Layers className="size-3" />
                    {i.reportCount} reports merged, {i.reportCount - 1} dispatch
                    {i.reportCount - 1 === 1 ? "" : "es"} avoided
                  </Badge>
                )}
                <span className="text-muted-foreground ml-auto text-xs">
                  confidence {(i.confidence * 100).toFixed(0)}% · {i.status}
                </span>
              </CardContent>
            </Card>
          ))}

          {openIncident && incidentReports.length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">
                  The {incidentReports.length} reports behind this one incident
                </CardTitle>
                <CardDescription>
                  Each row is somebody who reported it, what the matcher scored, and why.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                {incidentReports.map((r) => (
                  <div key={r.id} className="rounded border p-2 text-xs">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant={trustTone(r.verification_status)}>
                        trust {((r.trust_score ?? 0) * 100).toFixed(0)}%
                      </Badge>
                      {r.link_score !== null && (
                        <Badge variant="outline">match {(r.link_score * 100).toFixed(0)}%</Badge>
                      )}
                      <Badge variant="outline">{r.source}</Badge>
                      {r.mesh_hops ? <Badge variant="outline">{r.mesh_hops} hops</Badge> : null}
                      <span className="text-muted-foreground">
                        {r.decided_by === "llm" ? "adjudicated by model" : r.decided_by}
                      </span>
                    </div>
                    <p className="mt-1">{r.note || <em>no text</em>}</p>
                    {r.rationale && (
                      <p className="text-muted-foreground mt-1 italic">{r.rationale}</p>
                    )}
                  </div>
                ))}
              </CardContent>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="plan">
          {!plan && <p className="text-muted-foreground p-4 text-sm">Run a re-plan.</p>}
          {plan && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">{plan.headline}</CardTitle>
                <CardDescription>
                  {plan.engine}, {plan.runtimeMs} ms, coverage {(plan.coverage * 100).toFixed(0)}%
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {([
                  ["Re-tasked", plan.reassigned, "default"],
                  ["Newly assigned", plan.assigned, "secondary"],
                  ["Released", plan.released, "outline"],
                  ["Unchanged", plan.kept, "outline"],
                ] as const).map(([label, list, tone]) =>
                  list.length ? (
                    <div key={label}>
                      <div className="mb-1 text-xs font-medium">{label} ({list.length})</div>
                      {list.map((c) => (
                        <div key={c.resourceId + label} className="mb-1 rounded border p-2 text-xs">
                          <div className="flex items-center gap-2">
                            <Badge variant={tone}>{c.resourceLabel}</Badge>
                            {c.fromIncidentTitle && (
                              <span className="text-muted-foreground">
                                {c.fromIncidentTitle} →
                              </span>
                            )}
                            <span className="font-medium">{c.incidentTitle || "stood down"}</span>
                            {c.etaMinutes > 0 && (
                              <span className="text-muted-foreground ml-auto">
                                ETA {c.etaMinutes} min
                              </span>
                            )}
                          </div>
                          <p className="text-muted-foreground mt-1">{c.reason}</p>
                        </div>
                      ))}
                    </div>
                  ) : null
                )}
                {plan.uncovered.length > 0 && (
                  <Alert>
                    <AlertTriangle className="size-4" />
                    <AlertDescription>
                      <div className="font-medium">
                        {plan.uncovered.length} need(s) could not be met
                      </div>
                      {plan.uncovered.slice(0, 5).map((u, i) => (
                        <div key={i} className="text-xs">
                          {u.wardId} · {u.capability}: {u.reason}
                        </div>
                      ))}
                    </AlertDescription>
                  </Alert>
                )}
              </CardContent>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="duplicates" className="space-y-2">
          {dupes.length === 0 && (
            <div className="text-muted-foreground flex items-center gap-2 p-4 text-sm">
              <CheckCircle2 className="size-4" /> Nothing is being worked twice.
            </div>
          )}
          {dupes.map((d, i) => (
            <Alert key={i} variant={d.kind === "same_incident" ? "destructive" : "default"}>
              <Copy className="size-4" />
              <AlertDescription>
                <div className="font-medium">
                  {d.kind === "same_incident"
                    ? "Same incident, more than one agency"
                    : "Two incidents that may be one event"}
                  {d.wastedUnits > 0 && ` · ${d.wastedUnits} unit(s) possibly redundant`}
                </div>
                <div className="text-xs">{d.detail}</div>
                {d.agencies.length > 0 && (
                  <div className="mt-1 flex gap-1">
                    {d.agencies.map((a) => <Badge key={a} variant="outline">{a}</Badge>)}
                  </div>
                )}
              </AlertDescription>
            </Alert>
          ))}
        </TabsContent>

        <TabsContent value="events" className="space-y-1">
          {events.map((e) => (
            <div
              key={e.id}
              className="hover:bg-accent flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs"
              onClick={() => showChain(e.id)}
            >
              <span className="text-muted-foreground tabular-nums">#{e.id}</span>
              <Badge variant="outline">{e.kind}</Badge>
              <span className="text-muted-foreground">{e.actor}</span>
              {e.wardId && <span className="text-muted-foreground">{e.wardId}</span>}
              <span className="text-muted-foreground ml-auto">
                {new Date(e.occurredAt).toLocaleTimeString()}
              </span>
            </div>
          ))}
          {chain && (
            <Card className="mt-3">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Why this happened</CardTitle>
                <CardDescription>
                  The recorded causal chain, oldest cause first. Not inferred from
                  timestamps: each event stored the id of the one that caused it.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-1">
                {chain.map((e, i) => (
                  <div key={e.id} className="flex items-center gap-2 text-xs">
                    <span className="text-muted-foreground">{"→".repeat(i) || "•"}</span>
                    <Badge variant="outline">{e.kind}</Badge>
                    <span className="text-muted-foreground">{e.actor}</span>
                    <span className="text-muted-foreground truncate">
                      {JSON.stringify(e.payload).slice(0, 90)}
                    </span>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}
        </TabsContent>
      </Tabs>
    </div>
  )
}
