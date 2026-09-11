import { useMemo, useState } from "react"
import { Activity, ChevronRight } from "lucide-react"
import { useDemo } from "@/routes/demo/DemoProvider"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import type { DemoEvent } from "@/routes/demo/useDemo"

/** The audit log, as the agents wrote it.
 *
 *  Nothing on this screen is generated for the screen. `events` is append-only,
 *  a database trigger refuses updates to it, and every row carries the id of the
 *  event that caused it. That last field is what makes this a trace rather than
 *  a log: a dispatch can be followed back to the plan that ordered it, to the
 *  report that triggered the plan.
 */

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
