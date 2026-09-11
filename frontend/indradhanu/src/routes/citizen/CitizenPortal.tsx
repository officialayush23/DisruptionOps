import { useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import {
  Camera,
  Clock,
  MapPin,
  Navigation,
  Send,
  ShieldCheck,
  Sparkles,
  TriangleAlert,
} from "lucide-react"
import type { IncidentCategory } from "@/api/types"
import { PortalShell } from "@/components/layout/PortalShell"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Separator } from "@/components/ui/separator"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
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
  useCitizenSituation,
  useShelters,
  useWardRisks,
  useWards,
} from "@/hooks/useApi"
import { api } from "@/api/client"
import { useScenario } from "@/scenario/store"
import { severityLabel } from "@/lib/tokens"
import { cn } from "@/lib/utils"

const CATEGORIES: { value: IncidentCategory; label: string }[] = [
  { value: "flooded_road", label: "Flooded road" },
  { value: "waterlogging", label: "Waterlogging" },
  { value: "blocked_drain", label: "Blocked drain" },
  { value: "fallen_tree", label: "Fallen tree" },
  { value: "person_stranded", label: "Someone is stranded" },
  { value: "power_line", label: "Damaged power line" },
  { value: "structural_damage", label: "Structural damage" },
]

interface Msg {
  role: "user" | "agent"
  text: string
}

export default function CitizenPortal() {
  const { data: wards = [] } = useWards()
  const { data: risks = [] } = useWardRisks("flood")
  const { data: shelters = [] } = useShelters()
  const focusWardId = useScenario((s) => s.focusWardId)
  // The scenario can move the resident's location; an explicit pick wins.
  const [picked, setPicked] = useState<string | null>(null)
  const wardId = picked ?? focusWardId ?? "w-15"
  const setWardId = (id: string) => setPicked(id)
  const { data: situation } = useCitizenSituation(wardId)

  const ward = wards.find((w) => w.id === wardId)
  const alert = situation?.alert
  const risk = situation?.risk

  return (
    <PortalShell
      title="Indradhanu"
      subtitle={ward ? `${ward.name}, Pune` : "Pune"}
    >
      <div className="mx-auto w-full max-w-2xl space-y-4 p-4">
        <div className="flex items-center gap-2">
          <MapPin className="size-4 shrink-0 text-muted-foreground" />
          <Select value={wardId} onValueChange={setWardId}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {wards.map((w) => (
                <SelectItem key={w.id} value={w.id}>
                  {w.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* the one question a resident actually asks */}
        <Card
          className={cn(
            "border-2",
            alert
              ? "border-sev-5"
              : risk && risk.severity >= 3
                ? "border-sev-3"
                : "border-sev-1"
          )}
        >
          <CardHeader className="pb-3">
            <div className="flex items-start justify-between gap-3">
              <CardTitle className="text-lg">
                {alert
                  ? "You need to act now"
                  : risk && risk.severity >= 3
                    ? "Stay alert, but do not move yet"
                    : "You are safe right now"}
              </CardTitle>
              {risk ? (
                <SeverityBadge severity={risk.severity} />
              ) : (
                <Badge variant="secondary">No hazard</Badge>
              )}
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {alert ? (
              <>
                <p className="text-base font-medium">{alert.headline}</p>
                <p>{alert.action}</p>
                <div className="grid gap-2 sm:grid-cols-2">
                  <div className="flex items-center gap-2 rounded-md bg-muted p-3">
                    <Clock className="size-4 shrink-0" />
                    <div className="min-w-0">
                      <p className="text-xs text-muted-foreground">Leave by</p>
                      <p className="tabular font-semibold">
                        {timeOf(alert.byTime)}
                      </p>
                    </div>
                  </div>
                  {alert.safeLocation && (
                    <div className="flex items-center gap-2 rounded-md bg-muted p-3">
                      <Navigation className="size-4 shrink-0" />
                      <div className="min-w-0">
                        <p className="text-xs text-muted-foreground">Go to</p>
                        <p className="truncate font-semibold">
                          {alert.safeLocation.name}
                        </p>
                        <p className="tabular text-xs text-muted-foreground">
                          {alert.safeLocation.distanceKm} km away
                        </p>
                      </div>
                    </div>
                  )}
                </div>
                <Badge variant="outline" className="text-xs">
                  {alert.language}
                </Badge>
              </>
            ) : risk ? (
              <p>
                {ward?.name} is at {severityLabel[risk.severity].toLowerCase()}{" "}
                flood risk with about {risk.leadTimeHours} hours of lead time.
                Avoid low-lying roads. We will send you an instruction if that
                changes — you do not need to keep checking.
              </p>
            ) : (
              <p className="text-muted-foreground">
                No active hazard for your area. Feeds are being polled
                continuously.
              </p>
            )}
          </CardContent>
        </Card>

        <Tabs defaultValue="map">
          <TabsList className="w-full">
            <TabsTrigger value="map" className="flex-1">
              Route
            </TabsTrigger>
            <TabsTrigger value="why" className="flex-1">
              Why
            </TabsTrigger>
            <TabsTrigger value="ask" className="flex-1">
              Ask
            </TabsTrigger>
            <TabsTrigger value="report" className="flex-1">
              Report
            </TabsTrigger>
          </TabsList>

          <TabsContent value="map" className="mt-3">
            <Card className="overflow-hidden py-0">
              <MapView
                className="h-[380px] w-full"
                expandable
                wards={wards}
                risks={risks}
                shelters={shelters}
                route={situation?.route ?? null}
                focusWardId={wardId}
                selectedWardId={wardId}
                zoom={12.4}
              />
            </Card>
            {situation?.shelter && (
              <p className="mt-2 text-xs text-muted-foreground">
                The dashed line is your walking route to{" "}
                {situation.shelter.name}. It avoids the underpass, which is
                under water.
              </p>
            )}
          </TabsContent>

          <TabsContent value="why" className="mt-3">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-sm">
                  <TriangleAlert className="size-4" />
                  Why am I being warned?
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {risk ? (
                  <>
                    <div className="flex items-baseline gap-2">
                      <span className="tabular text-3xl font-semibold">
                        {Math.round(risk.score * 100)}
                      </span>
                      <span className="text-sm text-muted-foreground">
                        out of 100
                      </span>
                    </div>
                    <Separator />
                    {risk.drivers.map((d) => (
                      <div key={d.label} className="space-y-1">
                        <div className="flex items-center justify-between gap-3 text-sm">
                          <span className="font-medium">{d.label}</span>
                          <span className="tabular text-muted-foreground">
                            {Math.round(d.contribution * 100)}%
                          </span>
                        </div>
                        <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
                          <div
                            className="h-full rounded-full bg-foreground"
                            style={{ width: `${d.contribution * 100}%` }}
                          />
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {d.detail}
                        </p>
                      </div>
                    ))}
                  </>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    No score has been computed for your area yet.
                  </p>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="ask" className="mt-3">
            <AskAgent wardId={wardId} />
          </TabsContent>

          <TabsContent value="report" className="mt-3">
            <ReportForm wardId={wardId} />
          </TabsContent>
        </Tabs>
      </div>
    </PortalShell>
  )
}

const SUGGESTIONS = [
  "Should I leave now?",
  "Why am I at risk?",
  "Where is the nearest shelter?",
  "Which roads should I avoid?",
]

function AskAgent({ wardId }: { wardId: string }) {
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [input, setInput] = useState("")
  const [busy, setBusy] = useState(false)
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [msgs, busy])

  async function send(text: string) {
    if (!text.trim() || busy) return
    setMsgs((m) => [...m, { role: "user", text }])
    setInput("")
    setBusy(true)
    const res = await api.askAgent(text, wardId)
    setMsgs((m) => [...m, { role: "agent", text: res.answer }])
    setBusy(false)
  }

  return (
    <Card className="flex h-[420px] flex-col">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Sparkles className="size-4" />
          Ask the guidance agent
        </CardTitle>
      </CardHeader>
      <CardContent className="flex min-h-0 flex-1 flex-col gap-3">
        <ScrollArea className="min-h-0 flex-1 pr-3">
          <div className="space-y-3">
            {!msgs.length && (
              <p className="text-sm text-muted-foreground">
                Ask anything about your area. The agent answers from the live
                risk score for your ward, not from general advice.
              </p>
            )}
            {msgs.map((m, i) => (
              <div
                key={i}
                className={cn(
                  "max-w-[85%] rounded-lg px-3 py-2 text-sm",
                  m.role === "user"
                    ? "ml-auto bg-primary text-primary-foreground"
                    : "bg-muted"
                )}
              >
                {m.text}
              </div>
            ))}
            {busy && (
              <div className="max-w-[85%] rounded-lg bg-muted px-3 py-2 text-sm">
                <span className="animate-pulse">Thinking…</span>
              </div>
            )}
            <div ref={endRef} />
          </div>
        </ScrollArea>

        {!msgs.length && (
          <div className="flex flex-wrap gap-1.5">
            {SUGGESTIONS.map((s) => (
              <Button
                key={s}
                size="sm"
                variant="outline"
                onClick={() => send(s)}
              >
                {s}
              </Button>
            ))}
          </div>
        )}

        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            send(input)
          }}
        >
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask about your area…"
          />
          <Button type="submit" size="icon" disabled={busy || !input.trim()}>
            <Send className="size-4" />
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}

function ReportForm({ wardId }: { wardId: string }) {
  const { data: wards = [] } = useWards()
  const [category, setCategory] = useState<IncidentCategory>("flooded_road")
  const [note, setNote] = useState("")
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<{ confidence: number } | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    const ward = wards.find((w) => w.id === wardId)
    if (!ward || busy) return
    setBusy(true)
    const rec = await api.submitReport({
      wardId,
      category,
      location: [ward.centroid[0] + 0.0009, ward.centroid[1] + 0.0007],
      note: note || CATEGORIES.find((c) => c.value === category)!.label,
    })
    setBusy(false)
    setDone({ confidence: rec.classificationConfidence })
    setNote("")
    toast.success("Report received", {
      description: "Classified and sent to the ward control room.",
    })
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Camera className="size-4" />
          Report what you can see
        </CardTitle>
      </CardHeader>
      <CardContent>
        {done ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <ShieldCheck className="size-5 shrink-0 text-status-resolved" />
              <p className="text-sm font-medium">
                Report received and classified
              </p>
            </div>
            <p className="text-sm text-muted-foreground">
              The vision model classified your photo with{" "}
              <span className="tabular font-medium">
                {Math.round(done.confidence * 100)}%
              </span>{" "}
              confidence. If others report the same thing nearby, they collapse
              into one incident so the control room sees a single confirmed
              problem rather than a stream of tickets.
            </p>
            <Button variant="outline" size="sm" onClick={() => setDone(null)}>
              Report something else
            </Button>
          </div>
        ) : (
          <form className="space-y-3" onSubmit={submit}>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">
                What are you seeing?
              </label>
              <Select
                value={category}
                onValueChange={(v) => setCategory(v as IncidentCategory)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CATEGORIES.map((c) => (
                    <SelectItem key={c.value} value={c.value}>
                      {c.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">
                Anything else? (optional)
              </label>
              <Textarea
                rows={3}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Water is above knee level near the bridge"
              />
            </div>
            <Button type="submit" disabled={busy} className="w-full">
              {busy ? "Sending…" : "Send report"}
            </Button>
            <p className="text-xs text-muted-foreground">
              Your location is taken from your selected ward. Photos are
              classified on the server and never shown publicly.
            </p>
          </form>
        )}
      </CardContent>
    </Card>
  )
}
