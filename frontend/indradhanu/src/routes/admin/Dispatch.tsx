import { useMemo } from "react"
import { Inbox, Siren, Truck } from "lucide-react"
import { useDemo } from "@/routes/demo/DemoProvider"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table"

/** The allocation ledger. Who is on what, what is spare, what nobody has.
 *
 *  The system assigns — CP-SAT solves it, the gate authorises it, the replanner
 *  revisits it. This screen does not. Its whole job is to make what the system
 *  decided legible, which until now was possible only by hovering coloured
 *  lines on a map: the map answers "where", and the question is "what is this
 *  unit attached to, and why that one".
 *
 *  Three tables, because the question has three halves and an officer asks them
 *  in this order:
 *
 *    **Assigned** — every committed unit, the incident it is attached to, the
 *    hazard behind that incident, how many reports built it, how far out it is,
 *    and which actor made the attachment. One row per unit, so "where is
 *    Ambulance 4" is a scan rather than a search.
 *
 *    **Spare** — what is left. The other half of every coverage question, and
 *    the one a map cannot show, because an idle unit looks exactly like a busy
 *    one from above.
 *
 *    **Nobody has it** — demand with no unit against it. Not a failure to
 *    display: the solver records these deliberately rather than quietly
 *    under-serving them, and this is where they surface.
 *
 *  Everything is derived from the one poll the console already runs. No new
 *  request, and no number on this screen that another screen could disagree
 *  with.
 */

const pretty = (s: string) => s.replace(/_/g, " ")

const time = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, {
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  })

const since = (iso: string) => {
  const s = (Date.now() - new Date(iso).getTime()) / 1000
  if (!Number.isFinite(s) || s < 0) return ""
  if (s < 90) return `${Math.round(s)}s`
  if (s < 5400) return `${Math.round(s / 60)}m`
  return `${Math.round(s / 3600)}h`
}

/** How far along the drive, as a bar rather than a percentage. A number needs
 *  reading; a bar is read from the doorway. */
function Progress({ value }: { value: number }) {
  return (
    <div className="bg-muted h-1.5 w-16 overflow-hidden rounded-full">
      <div
        className="h-1.5 rounded-full bg-emerald-500"
        style={{ width: `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%` }}
      />
    </div>
  )
}

export default function Dispatch() {
  const { state, selected, setSelected } = useDemo()

  const wardName = useMemo(
    () => new Map(state.wards.map((w) => [w.id, w.name] as const)),
    [state.wards]
  )
  const byIncident = useMemo(
    () => new Map(state.incidents.map((i) => [i.id, i] as const)),
    [state.incidents]
  )

  /** Who attached this unit, and when.
   *
   *  Taken from the append-only log rather than from the assignment row,
   *  because the assignment knows *that* it exists and the log knows who caused
   *  it — the solver, the replanner, an officer's approval. "Assigned by" is
   *  the column that turns a status board into an account of a decision. */
  const attachedBy = useMemo(() => {
    const m = new Map<string, { actor: string; at: string; text: string }>()
    for (const e of state.events) {
      if (!e.kind.startsWith("assignment")) continue
      const rid = (e.payload as Record<string, unknown>)?.resource_id
      if (typeof rid !== "string") continue
      const prev = m.get(rid)
      if (!prev || prev.at < e.occurredAt) {
        m.set(rid, { actor: e.actor, at: e.occurredAt, text: e.text })
      }
    }
    return m
  }, [state.events])

  const reportsPerIncident = useMemo(() => {
    const m = new Map<string, number>()
    for (const r of state.reports) {
      if (!r.incidentId) continue
      m.set(r.incidentId, (m.get(r.incidentId) ?? 0) + 1)
    }
    return m
  }, [state.reports])

  const progressOf = useMemo(
    () => new Map(state.routes.map((r) => [r.resourceId, r.progress] as const)),
    [state.routes]
  )

  const assigned = useMemo(
    () =>
      state.resources
        .filter((r) => r.incidentId)
        .map((r) => ({
          unit: r,
          incident: r.incidentId ? byIncident.get(r.incidentId) : undefined,
          by: attachedBy.get(r.id),
          // Only `UnitRoute` carries progress — a resource row does not know
          // how far along its drive it is, and the fallback to `r.progress`
          // was reaching for a field that has never existed on it. No route
          // yet means not moving yet, which is what 0 says.
          progress: progressOf.get(r.id) ?? 0,
        }))
        .sort(
          (a, b) =>
            (b.incident?.severity ?? 0) - (a.incident?.severity ?? 0) ||
            (a.unit.etaMinutes ?? 999) - (b.unit.etaMinutes ?? 999)
        ),
    [state.resources, byIncident, attachedBy, progressOf]
  )

  const spare = useMemo(
    () =>
      state.resources
        .filter((r) => !r.incidentId)
        .sort(
          (a, b) =>
            Number(b.status === "available") - Number(a.status === "available") ||
            a.kind.localeCompare(b.kind)
        ),
    [state.resources]
  )

  /** Demand with nothing against it, joined to the incident and the hazard it
   *  came from, so the row says what is missing *and* what it is missing for. */
  const unmet = useMemo(
    () =>
      state.needs
        .filter((n) => n.met < n.required)
        .map((n) => ({ ...n, incident: byIncident.get(n.incidentId) }))
        .filter((n) => n.incident && n.incident.status !== "resolved")
        .sort(
          (a, b) =>
            (b.incident?.severity ?? 0) - (a.incident?.severity ?? 0) ||
            b.required - b.met - (a.required - a.met)
        ),
    [state.needs, byIncident]
  )

  const free = spare.filter((r) => r.status === "available").length

  return (
    <div className="space-y-3 p-4">
      {/* Four numbers, and the only two that change a decision are the last
          two. Red is reserved for the one that means somebody is not coming. */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Units committed" value={`${assigned.length}/${state.resources.length}`} />
        <Stat label="Spare and ready" value={free} />
        <Stat
          label="Open incidents"
          value={state.incidents.filter((i) => i.status !== "resolved").length}
        />
        <Stat label="Demands nobody has" value={unmet.length} tone={unmet.length ? "bad" : undefined} />
      </div>

      {/* ------------------------------------------------------- assigned -- */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Truck className="size-4" /> Assigned right now
          </CardTitle>
          <CardDescription className="text-xs">
            One row per committed unit, live. The solver decided every one of
            these; the last column says which actor wrote it and when, so a
            re-tasking is visible as a re-tasking rather than as a line moving on
            a map.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0">
          <div className="max-h-[26rem] overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Unit</TableHead>
                  <TableHead>Attached to</TableHead>
                  <TableHead>Hazard</TableHead>
                  <TableHead>Ward</TableHead>
                  <TableHead className="text-right">Reports</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead className="text-right">ETA</TableHead>
                  <TableHead>On the way</TableHead>
                  <TableHead>Attached by</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {assigned.map(({ unit, incident, by, progress }) => (
                  <TableRow
                    key={unit.id}
                    className={`cursor-pointer ${
                      selected === incident?.id ? "bg-primary/5" : ""
                    }`}
                    onClick={() => setSelected(incident?.id ?? null)}
                  >
                    <TableCell className="font-medium">
                      {unit.label}
                      <span className="text-muted-foreground ml-1.5 text-xs font-normal">
                        {pretty(unit.kind)}
                      </span>
                    </TableCell>
                    <TableCell className="max-w-[16rem]">
                      <div className="flex items-center gap-1.5">
                        {incident && (
                          <Badge
                            variant={incident.severity >= 4 ? "destructive" : "secondary"}
                            className="tabular-nums"
                          >
                            {incident.severity}
                          </Badge>
                        )}
                        <span className="truncate text-sm">
                          {incident?.title ?? unit.assignedTo ?? "—"}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      {incident ? pretty(incident.category) : "—"}
                    </TableCell>
                    <TableCell className="text-xs">
                      {incident ? wardName.get(incident.wardId) ?? incident.wardId : "—"}
                    </TableCell>
                    <TableCell className="text-right text-xs tabular-nums">
                      {incident ? reportsPerIncident.get(incident.id) ?? 0 : "—"}
                    </TableCell>
                    <TableCell className="text-xs">
                      {pretty(unit.assignmentStatus ?? unit.status)}
                    </TableCell>
                    <TableCell className="text-right text-xs tabular-nums">
                      {unit.etaMinutes != null ? `${unit.etaMinutes} min` : "—"}
                      {unit.distanceKm != null && (
                        <span className="text-muted-foreground ml-1">
                          {unit.distanceKm.toFixed(1)} km
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Progress value={progress} />
                    </TableCell>
                    <TableCell className="text-muted-foreground max-w-[13rem] text-xs">
                      {by ? (
                        <span className="block truncate" title={by.text}>
                          {by.actor.replace(/^agent:/, "").replace(/[:_]/g, " ")} ·{" "}
                          {time(by.at)}
                        </span>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                  </TableRow>
                ))}
                {assigned.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={9} className="text-muted-foreground text-xs">
                      Nothing committed. Either nothing is open, or the planner
                      has not run since it opened.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-3 lg:grid-cols-2">
        {/* --------------------------------------------------------- left -- */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Inbox className="size-4" /> What is left
            </CardTitle>
            <CardDescription className="text-xs">
              Not committed to anything. A map cannot show this — an idle unit
              looks exactly like a busy one from above — and it is half of every
              question about whether the city is covered.
            </CardDescription>
          </CardHeader>
          <CardContent className="px-0">
            <div className="max-h-[22rem] overflow-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Unit</TableHead>
                    <TableHead>Can do</TableHead>
                    <TableHead>State</TableHead>
                    <TableHead>Why not available</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {spare.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="font-medium">
                        {r.label}
                        <span className="text-muted-foreground ml-1.5 text-xs font-normal">
                          {pretty(r.kind)}
                        </span>
                      </TableCell>
                      <TableCell className="max-w-[12rem]">
                        <div className="flex flex-wrap gap-1">
                          {r.capabilities.slice(0, 2).map((c) => (
                            <Badge key={c} variant="outline" className="font-normal">
                              {pretty(c)}
                            </Badge>
                          ))}
                          {r.capabilities.length > 2 && (
                            <span className="text-muted-foreground text-xs">
                              +{r.capabilities.length - 2}
                            </span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-xs">
                        <Badge
                          variant={r.status === "available" ? "secondary" : "outline"}
                          className="font-normal"
                        >
                          {pretty(r.status)}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-muted-foreground max-w-[12rem] truncate text-xs">
                        {r.status === "available"
                          ? "—"
                          : r.unavailableReason ?? r.statusNote ?? pretty(r.status)}
                      </TableCell>
                    </TableRow>
                  ))}
                  {spare.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={4} className="text-muted-foreground text-xs">
                        Every unit in the fleet is committed.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>

        {/* -------------------------------------------------------- unmet -- */}
        <Card className={unmet.length ? "border-destructive/40" : undefined}>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Siren className="size-4" /> Demand nobody has
            </CardTitle>
            <CardDescription className="text-xs">
              Recorded rather than quietly under-served. Each row is a capability
              an open incident needs and no unit is meeting — the case for asking
              another agency, on the handoff screen.
            </CardDescription>
          </CardHeader>
          <CardContent className="px-0">
            <div className="max-h-[22rem] overflow-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Needs</TableHead>
                    <TableHead>For</TableHead>
                    <TableHead>Ward</TableHead>
                    <TableHead className="text-right">Short by</TableHead>
                    <TableHead className="text-right">Waiting</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {unmet.map((n) => (
                    <TableRow
                      key={`${n.incidentId}-${n.capability}`}
                      className={`cursor-pointer ${
                        selected === n.incidentId ? "bg-primary/5" : ""
                      }`}
                      onClick={() => setSelected(n.incidentId)}
                    >
                      <TableCell className="font-medium">
                        {pretty(n.capability)}
                      </TableCell>
                      <TableCell className="max-w-[12rem]">
                        <div className="flex items-center gap-1.5">
                          <Badge
                            variant={
                              (n.incident?.severity ?? 0) >= 4 ? "destructive" : "secondary"
                            }
                            className="tabular-nums"
                          >
                            {n.incident?.severity}
                          </Badge>
                          <span className="truncate text-sm">{n.incident?.title}</span>
                        </div>
                      </TableCell>
                      <TableCell className="text-xs">
                        {n.incident
                          ? wardName.get(n.incident.wardId) ?? n.incident.wardId
                          : "—"}
                      </TableCell>
                      <TableCell className="text-right text-xs tabular-nums">
                        {n.required - n.met} of {n.required}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-right text-xs tabular-nums">
                        {n.incident ? since(n.incident.createdAt) : ""}
                      </TableCell>
                    </TableRow>
                  ))}
                  {unmet.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={5} className="text-muted-foreground text-xs">
                        Everything every open incident needs has a unit against
                        it.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

function Stat({
  label, value, tone,
}: {
  label: string
  value: string | number
  tone?: "bad"
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardDescription>{label}</CardDescription>
        <CardTitle
          className={`text-2xl tabular-nums ${
            tone === "bad" ? "text-red-600 dark:text-red-400" : ""
          }`}
        >
          {value}
        </CardTitle>
      </CardHeader>
    </Card>
  )
}
