import { useMemo, useState } from "react"
import { Activity, ArrowRight, ChevronRight, Link2 } from "lucide-react"
import { useDemo } from "@/routes/demo/DemoProvider"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table"
import type { DemoEvent } from "@/routes/demo/useDemo"

/** The audit log, as the agents wrote it.
 *
 *  Nothing on this screen is generated for the screen. `events` is append-only,
 *  a database trigger refuses updates to it, and every row carries the id of the
 *  event that caused it. That last field is what makes this a trace rather than
 *  a log: a dispatch can be followed back to the plan that ordered it, to the
 *  report that triggered the plan.
 */


/** Every event that joined one thing to another, as a sentence.
 *
 *  The log below is honest and unreadable: `assignment_changed`, a uuid, and a
 *  JSON payload. What an officer wants from it is one question — *what got
 *  attached to what* — and answering that meant knowing which `kind` strings
 *  are attachments and which id in the payload is the other end.
 *
 *  So it is decoded once, here, into left → right with the actor that did it.
 *  Nothing is invented: every row is one event, and the ids are resolved
 *  against the live world so a row says "Ambulance 4 → Water on Karve Road"
 *  rather than two uuids. An id that no longer resolves is shown as the id,
 *  because pretending it resolved would be worse.
 */
type Attachment = {
  id: number
  at: string
  verb: string
  left: string
  right: string
  actor: string
  why: string
  tone: string
}

/** `kind` → how to read it. Only attachments are listed; everything else stays
 *  in the raw log where it belongs. */
const ATTACHES: Record<string, { verb: string; tone: string }> = {
  report_received: { verb: "report filed into", tone: "text-sky-600 dark:text-sky-400" },
  reports_merged: { verb: "reports merged into", tone: "text-sky-600 dark:text-sky-400" },
  incident_opened: { verb: "incident opened in", tone: "text-orange-600 dark:text-orange-400" },
  assignment_created: { verb: "unit attached to", tone: "text-emerald-600 dark:text-emerald-400" },
  assignment_changed: { verb: "unit re-attached to", tone: "text-violet-600 dark:text-violet-400" },
  decision_proposed: { verb: "decision raised for", tone: "text-blue-600 dark:text-blue-400" },
  decision_acted: { verb: "decision settled for", tone: "text-violet-600 dark:text-violet-400" },
  alert_issued: { verb: "advisory issued to", tone: "text-fuchsia-600 dark:text-fuchsia-400" },
  incident_resolved: { verb: "incident closed in", tone: "text-emerald-600 dark:text-emerald-400" },
}

const TONE: Record<string, string> = {
  incident: "text-orange-600 dark:text-orange-400",
  report: "text-sky-600 dark:text-sky-400",
  assignment: "text-emerald-600 dark:text-emerald-400",
  plan: "text-blue-600 dark:text-blue-400",
  decision: "text-violet-600 dark:text-violet-400",
  demand: "text-red-600 dark:text-red-400",
  resource: "text-cyan-600 dark:text-cyan-400",
  risk: "text-amber-600 dark:text-amber-400",
  field: "text-cyan-600 dark:text-cyan-400",
  alert: "text-fuchsia-600 dark:text-fuchsia-400",
  road: "text-red-600 dark:text-red-400",
}
const toneFor = (kind: string) => TONE[kind.split(".")[0]] ?? "text-muted-foreground"

const time = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, {
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  })

export default function AgentTrace() {
  const { state } = useDemo()
  const [actor, setActor] = useState<string | null>(null)
  const [open, setOpen] = useState<number | null>(null)

  const actors = useMemo(() => {
    const counts = new Map<string, number>()
    for (const e of state.events) counts.set(e.actor, (counts.get(e.actor) ?? 0) + 1)
    return [...counts].sort((a, b) => b[1] - a[1])
  }, [state.events])

  const byId = useMemo(
    () => new Map(state.events.map((e) => [e.id, e])),
    [state.events]
  )

  const chainOf = (e: DemoEvent) => {
    const chain: DemoEvent[] = []
    let cursor: DemoEvent | undefined = e
    const seen = new Set<number>()
    while (cursor && !seen.has(cursor.id)) {
      seen.add(cursor.id)
      chain.push(cursor)
      cursor = cursor.causationId ? byId.get(cursor.causationId) : undefined
    }
    return chain.reverse()
  }

  const rows = actor ? state.events.filter((e) => e.actor === actor) : state.events

  const unitLabel = useMemo(
    () => new Map(state.resources.map((r) => [r.id, r.label] as const)),
    [state.resources]
  )
  const incidentTitle = useMemo(
    () => new Map(state.incidents.map((i) => [i.id, i.title] as const)),
    [state.incidents]
  )
  const wardLabel = useMemo(
    () => new Map(state.wards.map((w) => [w.id, w.name] as const)),
    [state.wards]
  )

  const attachments = useMemo<Attachment[]>(() => {
    const out: Attachment[] = []
    const name = (id: unknown): string | null => {
      if (typeof id !== "string" || !id) return null
      return unitLabel.get(id) ?? incidentTitle.get(id) ?? wardLabel.get(id) ?? id
    }
    for (const e of rows) {
      const spec = ATTACHES[e.kind]
      if (!spec) continue
      const p = (e.payload ?? {}) as Record<string, unknown>
      // Left is whatever the event is about; right is the thing it was joined
      // to. Both come out of the payload the agent stored, in the order the
      // verb reads, so no row needs its own sentence.
      const left =
        name(p.resource_id) ??
        name(e.subjectId) ??
        (e.subjectType ? e.subjectType : "something")
      const right =
        name(p.to_incident) ??
        name(p.incident_id) ??
        name(e.wardId) ??
        name(p.ward_id) ??
        "—"
      out.push({
        id: e.id,
        at: e.occurredAt,
        verb: spec.verb,
        tone: spec.tone,
        left: String(left),
        right: String(right),
        actor: e.actor.replace(/^agent:/, "").replace(/[:_]/g, " "),
        why: e.text,
      })
    }
    return out
  }, [rows, unitLabel, incidentTitle, wardLabel])

  return (
    <div className="space-y-3 p-4">
      <div className="flex flex-wrap items-center gap-1">
        <Button
          size="sm"
          variant={actor === null ? "secondary" : "ghost"}
          className="h-7 text-xs"
          onClick={() => setActor(null)}
        >
          Everything <span className="text-muted-foreground ml-1">{state.events.length}</span>
        </Button>
        {actors.map(([a, n]) => (
          <Button
            key={a}
            size="sm"
            variant={actor === a ? "secondary" : "ghost"}
            className="h-7 text-xs"
            onClick={() => setActor(a)}
          >
            {a.replace(/^agent:/, "").replace(/_/g, " ")}
            <span className="text-muted-foreground ml-1">{n}</span>
          </Button>
        ))}
      </div>

      {/* What got joined to what, before the raw log. This is the question the
          log was always answering and never in one place. */}
      {attachments.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Link2 className="size-4" /> What is attached to what
            </CardTitle>
            <CardDescription className="text-xs">
              Every event that joined two things, newest first, with the actor
              that did it. Decoded from the same append-only rows shown below —
              the ids resolved against the live world, and nothing added.
            </CardDescription>
          </CardHeader>
          <CardContent className="px-0">
            <div className="max-h-[24rem] overflow-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-20">Time</TableHead>
                    <TableHead>What</TableHead>
                    <TableHead>Joined to</TableHead>
                    <TableHead>By</TableHead>
                    <TableHead>In its own words</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {attachments.map((a) => (
                    <TableRow key={a.id}>
                      <TableCell className="text-muted-foreground text-xs tabular-nums">
                        {time(a.at)}
                      </TableCell>
                      <TableCell className="max-w-[14rem]">
                        <div className="truncate text-sm font-medium">{a.left}</div>
                        <div className={`text-xs ${a.tone}`}>{a.verb}</div>
                      </TableCell>
                      <TableCell className="max-w-[16rem]">
                        <div className="flex items-center gap-1.5">
                          <ArrowRight className="text-muted-foreground size-3 shrink-0" />
                          <span className="truncate text-sm">{a.right}</span>
                        </div>
                      </TableCell>
                      <TableCell className="text-xs">
                        <Badge variant="outline" className="font-normal">{a.actor}</Badge>
                      </TableCell>
                      <TableCell className="text-muted-foreground max-w-[22rem] truncate text-xs">
                        {a.why}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}

      {rows.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <Activity className="size-4" /> Nothing written yet
            </CardTitle>
            <CardDescription className="text-xs">
              Every agent action appends here as it happens. Start live ingest on
              the command console and the first rows will arrive within a second.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Append-only event log</CardTitle>
            <CardDescription className="text-xs">
              Newest first. Click a row to follow it back to what caused it.
            </CardDescription>
          </CardHeader>
          <CardContent className="max-h-[640px] space-y-0.5 overflow-y-auto">
            {rows.map((e) => {
              const expanded = open === e.id
              const chain = expanded ? chainOf(e) : []
              return (
                <div key={e.id}>
                  <button
                    type="button"
                    onClick={() => setOpen(expanded ? null : e.id)}
                    className="hover:bg-muted/50 flex w-full items-start gap-2 rounded px-1.5 py-1 text-left text-xs"
                  >
                    <ChevronRight
                      className={`mt-0.5 size-3 shrink-0 transition-transform ${
                        expanded ? "rotate-90" : ""
                      }`}
                    />
                    <span className="text-muted-foreground shrink-0 tabular-nums">
                      {time(e.occurredAt)}
                    </span>
                    <Badge variant="outline" className="shrink-0 font-normal">
                      {e.actor.replace(/^agent:/, "").replace(/_/g, " ")}
                    </Badge>
                    <span className={`shrink-0 ${toneFor(e.kind)}`}>{e.kind}</span>
                    <span className="min-w-0 flex-1 truncate">{e.text}</span>
                  </button>

                  {expanded && (
                    <div className="bg-muted/30 ml-6 mb-1 space-y-2 rounded border p-2 text-xs">
                      <div>
                        <div className="text-muted-foreground font-medium uppercase tracking-wide">
                          Caused by
                        </div>
                        {chain.length <= 1 ? (
                          <p className="text-muted-foreground mt-1">
                            Nothing. This is the head of its chain.
                          </p>
                        ) : (
                          <ol className="mt-1 space-y-1">
                            {chain.map((c) => (
                              <li key={c.id} className="flex gap-2">
                                <span className="text-muted-foreground tabular-nums">
                                  {time(c.occurredAt)}
                                </span>
                                <span className={toneFor(c.kind)}>{c.kind}</span>
                                <span className="min-w-0 flex-1">{c.text}</span>
                              </li>
                            ))}
                          </ol>
                        )}
                      </div>
                      <div>
                        <div className="text-muted-foreground font-medium uppercase tracking-wide">
                          Subject
                        </div>
                        <div className="mt-1">
                          {e.subjectType ?? "—"}
                          {e.subjectId ? ` · ${e.subjectId}` : ""}
                          {e.wardId ? ` · ward ${e.wardId}` : ""}
                        </div>
                      </div>
                      <div>
                        <div className="text-muted-foreground font-medium uppercase tracking-wide">
                          Payload as stored
                        </div>
                        <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words text-[11px] leading-relaxed">
                          {JSON.stringify(e.payload ?? {}, null, 2)}
                        </pre>
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
