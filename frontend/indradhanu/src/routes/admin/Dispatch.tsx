import { useMemo, useState } from "react"
import { CheckCircle2, Inbox, Loader2, Send, Siren, Truck } from "lucide-react"
import { useDemo } from "@/routes/demo/DemoProvider"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"

/** Who is going where, and why — as one screen.
 *
 *  This existed only on the map, which is the wrong instrument for it. A map
 *  answers "where", and the question an officer actually has is a chain:
 *
 *      four reports  →  one incident  →  two units  →  eleven minutes out
 *
 *  Every link of that chain was on a different screen, joined by ids nothing
 *  showed, so the only way to follow it was to hover coloured lines and guess.
 *  A judge watching that concluded, correctly, that they could not see what the
 *  system was doing.
 *
 *  Three columns, left to right in the order the work flows, and the middle one
 *  is the selection that drives the other two. Pick an incident: the left shows
 *  the reports that built it, the right shows the units that could serve what it
 *  still needs, nearest first, with a button. That button is the other thing
 *  that was missing — an officer could re-plan the whole city or approve
 *  something the Copilot had thought of, and could not send the boat two streets
 *  away that they could see was idle.
 *
 *  Nothing here writes an assignment. `POST /dispatch/assign` proposes through
 *  the same policy gate every agent uses; inside a ward officer's delegation it
 *  issues and is carried out in the same request, and outside it, it waits on
 *  the gate with the clause that held it. A dispatch board with its own path to
 *  the fleet would be the second source of truth this system exists to not have.
 */

const M_PER_DEG_LAT = 110_574

function km(a: [number, number], b: [number, number]) {
  const dx = (a[0] - b[0]) * 111_320 * Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180)
  const dy = (a[1] - b[1]) * M_PER_DEG_LAT
  return Math.sqrt(dx * dx + dy * dy) / 1000
}

const pretty = (s: string) => s.replace(/_/g, " ")

const since = (iso: string) => {
  const s = (Date.now() - new Date(iso).getTime()) / 1000
  if (!Number.isFinite(s) || s < 0) return ""
  if (s < 90) return `${Math.round(s)}s`
  if (s < 5400) return `${Math.round(s / 60)}m`
  return `${Math.round(s / 3600)}h`
}

export default function Dispatch() {
  const { state, selected, setSelected, busy, run } = useDemo()
  const [sent, setSent] = useState<string | null>(null)

  const wardName = useMemo(
    () => new Map(state.wards.map((w) => [w.id, w.name] as const)),
    [state.wards]
  )

  /** Open incidents, worst first, each carrying what it needs and who is on it.
   *
   *  Assembled here rather than asked for, because every part of it is already
   *  in the one poll the console runs — the joining is what was missing, not
   *  the data. */
  const rows = useMemo(() => {
    const needsBy = new Map<string, { capability: string; met: number; required: number }[]>()
    for (const n of state.needs) {
      const list = needsBy.get(n.incidentId)
      if (list) list.push(n)
      else needsBy.set(n.incidentId, [n])
    }
    const unitsBy = new Map<string, typeof state.resources>()
    for (const r of state.resources) {
      if (!r.incidentId) continue
      const list = unitsBy.get(r.incidentId)
      if (list) list.push(r)
      else unitsBy.set(r.incidentId, [r])
    }
    const reportsBy = new Map<string, typeof state.reports>()
    for (const rep of state.reports) {
      if (!rep.incidentId) continue
      const list = reportsBy.get(rep.incidentId)
      if (list) list.push(rep)
      else reportsBy.set(rep.incidentId, [rep])
    }

    return state.incidents
      .filter((i) => i.status !== "resolved")
      .map((i) => {
        const needs = needsBy.get(i.id) ?? []
        return {
          incident: i,
          needs,
          short: needs.filter((n) => n.met < n.required),
          units: unitsBy.get(i.id) ?? [],
          reports: (reportsBy.get(i.id) ?? []).sort((a, b) =>
            a.createdAt < b.createdAt ? 1 : -1
          ),
        }
      })
      .sort(
        (a, b) =>
          b.short.length - a.short.length ||
          b.incident.severity - a.incident.severity ||
          b.reports.length - a.reports.length
      )
  }, [state.incidents, state.needs, state.resources, state.reports])

  const current = rows.find((r) => r.incident.id === selected) ?? rows[0] ?? null

  /** Units that could serve what the selected incident is still short of.
   *
   *  Capability first, then distance. An idle unit that cannot do the job is
   *  not an option, and showing it as one is how a board like this starts
   *  lying — so a unit appears here only if it holds a capability the incident
   *  is actually short of, and the badge says which. */
  const candidates = useMemo(() => {
    if (!current || !current.short.length) return []
    const wanted = new Set(current.short.map((n) => n.capability))
    return state.resources
      .filter((r) => r.status === "available" && !r.assignedTo)
      .map((r) => ({
        unit: r,
        serves: r.capabilities.filter((c) => wanted.has(c)),
        away: km(r.location, current.incident.location),
      }))
      .filter((c) => c.serves.length > 0)
      .sort((a, b) => a.away - b.away)
      .slice(0, 12)
  }, [current, state.resources])

  /** Reports that have not landed on an incident yet — the left edge of the
   *  pipeline, and the only column that is not about the selection. Held or
   *  still clustering, so it is small by design and alarming when it is not. */
  const loose = useMemo(
    () =>
      state.reports
        .filter((r) => !r.incidentId)
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
        .slice(0, 8),
    [state.reports]
  )

  async function send(resourceId: string, label: string) {
    const r = (await run(`send-${resourceId}`, "/dispatch/assign", {
      resourceId,
      incidentId: current!.incident.id,
    })) as { note?: string } | undefined
    setSent(r?.note ?? `${label} dispatched.`)
    setTimeout(() => setSent(null), 8000)
  }

  if (!rows.length) {
    return (
      <div className="p-4">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <Siren className="size-4" /> Nothing open
            </CardTitle>
            <CardDescription className="text-xs">
              {state.running
                ? "Reports are arriving. The first incident and everything routed to it will appear here."
                : "Start the world on the command console and this fills."}
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    )
  }

  return (
    <div className="grid h-[calc(100svh-3.5rem)] grid-cols-1 gap-3 p-3 lg:grid-cols-[1fr_1.3fr_1fr]">
      {/* ------------------------------------------------------- reports -- */}
      <Panel
        icon={<Inbox className="size-4" />}
        title="Reports"
        note={
          current
            ? `${current.reports.length} merged into the selected incident`
            : "what came in"
        }
      >
        {current?.reports.map((rep) => (
          <div key={rep.id} className="rounded-md border p-2">
            <p className="line-clamp-2 text-xs">{rep.text}</p>
            <div className="text-muted-foreground mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
              <Badge variant="outline" className="font-normal">
                {pretty(rep.classifiedAs ?? rep.category)}
              </Badge>
              <span>{rep.source}</span>
              {rep.trust !== null && (
                <span className="tabular-nums">trust {rep.trust.toFixed(2)}</span>
              )}
              <span>{since(rep.createdAt)}</span>
              {rep.opened ? (
                <span className="text-orange-600 dark:text-orange-400">
                  opened this incident
                </span>
              ) : (
                <span className="text-sky-600 dark:text-sky-400">merged</span>
              )}
            </div>
            {/* The join nobody could see: why this report was put with the
                others rather than opening a second incident for the same
                flooded road. */}
            {rep.linkReason && !rep.opened && (
              <p className="text-muted-foreground mt-1 text-[11px]">
                {rep.linkReason}
                {rep.linkScore !== null ? ` · ${rep.linkScore.toFixed(2)}` : ""}
              </p>
            )}
          </div>
        ))}
        {loose.length > 0 && (
          <>
            <div className="text-muted-foreground pt-1 text-[11px] font-medium uppercase tracking-wide">
              Not on an incident yet
            </div>
            {loose.map((rep) => (
              <div key={rep.id} className="rounded-md border border-dashed p-2">
                <p className="line-clamp-2 text-xs">{rep.text}</p>
                <p className="text-muted-foreground mt-1 text-[11px]">
                  {pretty(rep.status)} · {since(rep.createdAt)}
                </p>
              </div>
            ))}
          </>
        )}
      </Panel>

      {/* ----------------------------------------------------- incidents -- */}
      <Panel
        icon={<Siren className="size-4" />}
        title="Incidents"
        note={`${rows.length} open, ${rows.filter((r) => r.short.length).length} short of something`}
      >
        {rows.map((r) => {
          const open = current?.incident.id === r.incident.id
          return (
            <button
              key={r.incident.id}
              type="button"
              onClick={() => setSelected(r.incident.id)}
              className={`w-full rounded-md border p-2 text-left transition-colors ${
                open ? "border-primary bg-primary/5" : "hover:border-muted-foreground/40"
              }`}
            >
              <div className="flex items-center gap-2">
                <Badge
                  variant={r.incident.severity >= 4 ? "destructive" : "secondary"}
                  className="tabular-nums"
                >
                  {r.incident.severity}
                </Badge>
                <span className="truncate text-sm font-medium">{r.incident.title}</span>
              </div>
              <div className="text-muted-foreground mt-1 flex flex-wrap gap-x-2 text-[11px]">
                <span>{wardName.get(r.incident.wardId) ?? r.incident.wardId}</span>
                <span>{r.reports.length} report(s)</span>
                <span>{since(r.incident.createdAt)} old</span>
              </div>

              {/* What it needs, and what is actually on the way. This pair is
                  the whole screen: a need with nobody against it is the thing
                  an officer is looking for. */}
              <div className="mt-1.5 flex flex-wrap gap-1">
                {r.needs.map((n) => (
                  <Badge
                    key={n.capability}
                    variant={n.met >= n.required ? "secondary" : "destructive"}
                    className="font-normal"
                  >
                    {pretty(n.capability)} {n.met}/{n.required}
                  </Badge>
                ))}
                {r.needs.length === 0 && (
                  <span className="text-muted-foreground text-[11px]">
                    no needs recorded
                  </span>
                )}
              </div>

              {r.units.length > 0 && (
                <div className="mt-1.5 space-y-0.5 border-t pt-1.5">
                  {r.units.map((u) => (
                    <div
                      key={u.id}
                      className="flex flex-wrap items-center gap-1.5 text-[11px]"
                    >
                      <Truck className="size-3 shrink-0" />
                      <span className="font-medium">{u.label}</span>
                      <span className="text-muted-foreground">
                        {pretty(u.assignmentStatus ?? u.status)}
                      </span>
                      {u.etaMinutes != null && (
                        <span className="tabular-nums text-emerald-600 dark:text-emerald-400">
                          {u.etaMinutes} min out
                        </span>
                      )}
                      {u.distanceKm != null && (
                        <span className="text-muted-foreground tabular-nums">
                          {u.distanceKm.toFixed(1)} km
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </button>
          )
        })}
      </Panel>

      {/* --------------------------------------------------------- units -- */}
      <Panel
        icon={<Truck className="size-4" />}
        title="Send a unit"
        note={
          current
            ? current.short.length
              ? `${current.incident.title} is short of ${current.short
                  .map((n) => pretty(n.capability))
                  .join(", ")}`
              : "Everything this incident needs is on the way"
            : "pick an incident"
        }
      >
        {sent && (
          <div className="flex items-start gap-1.5 rounded-md border border-emerald-500/40 bg-emerald-500/5 p-2 text-xs">
            <CheckCircle2 className="mt-0.5 size-3.5 shrink-0" />
            <span>{sent}</span>
          </div>
        )}

        {current && !current.short.length && (
          <p className="text-muted-foreground text-xs">
            Nothing is outstanding here. Units are only offered against a
            capability an incident is actually short of — a board that let you
            pile a second boat onto a covered incident would be helping you make
            the mistake it exists to prevent.
          </p>
        )}

        {candidates.map(({ unit, serves, away }) => (
          <div key={unit.id} className="rounded-md border p-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-1.5 text-sm">
                  <span className="font-medium">{unit.label}</span>
                  <span className="text-muted-foreground text-xs">
                    {unit.operator}
                  </span>
                </div>
                <div className="text-muted-foreground mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px]">
                  <span className="tabular-nums">{away.toFixed(1)} km away</span>
                  {serves.map((c) => (
                    <Badge key={c} variant="outline" className="font-normal">
                      {pretty(c)}
                    </Badge>
                  ))}
                </div>
              </div>
              <Button
                size="sm"
                className="h-7 shrink-0 text-xs"
                disabled={busy !== null}
                onClick={() => void send(unit.id, unit.label)}
              >
                {busy === `send-${unit.id}` ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <Send className="size-3" />
                )}
                Send
              </Button>
            </div>
          </div>
        ))}

        {current && current.short.length > 0 && candidates.length === 0 && (
          <p className="text-destructive text-xs">
            Nothing free in the municipal fleet holds{" "}
            {current.short.map((n) => pretty(n.capability)).join(" or ")}. This is
            the case for asking another agency, on the handoff screen.
          </p>
        )}

        <p className="text-muted-foreground border-t pt-2 text-[11px]">
          Sending proposes through the policy gate, the same one every agent
          uses. Inside a ward officer&rsquo;s delegation it issues and the unit
          starts moving; beyond it, it waits on the decision gate with the
          clause that held it.
        </p>
      </Panel>
    </div>
  )
}

/** One column. Header pinned, body scrolls — three independently scrolling
 *  lists rather than one long page, so the selection never moves out from under
 *  the person reading it. */
function Panel({
  icon, title, note, children,
}: {
  icon: React.ReactNode
  title: string
  note: string
  children: React.ReactNode
}) {
  return (
    <Card className="flex min-h-0 flex-col gap-0 py-0">
      <CardHeader className="shrink-0 border-b py-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          {icon} {title}
        </CardTitle>
        <CardDescription className="text-xs">{note}</CardDescription>
      </CardHeader>
      <CardContent className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
        {children}
      </CardContent>
    </Card>
  )
}
