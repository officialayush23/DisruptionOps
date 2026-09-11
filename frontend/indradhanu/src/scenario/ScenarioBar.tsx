import {
  ChevronLeft,
  ChevronRight,
  Clock,
  ExternalLink,
  Gauge,
  HardHat,
  Pause,
  Play,
  RotateCcw,
  Sparkles,
  User,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"
import { STEPS, useScenario } from "./store"

/** Opens the other two interfaces in their own windows, so a judge can watch
 *  the same moment from all three sides at once. The scenario clock lives in
 *  each tab's own store, so each window is driven independently — the point is
 *  to see the citizen and field views, not to keep three clocks in lockstep. */
function InterfaceLaunchers({ compact = false }: { compact?: boolean }) {
  const open = (path: string) =>
    window.open(path, "_blank", "noopener,noreferrer,width=520,height=900")

  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <Button
        size="sm"
        variant="outline"
        onClick={() => open("/citizen")}
        title="Open the citizen portal in a new window"
      >
        <User className="size-3.5" />
        {!compact && <span>Citizen view</span>}
        <ExternalLink className="size-3 opacity-60" />
      </Button>
      <Button
        size="sm"
        variant="outline"
        onClick={() => open("/field")}
        title="Open the field operator portal in a new window"
      >
        <HardHat className="size-3.5" />
        {!compact && <span>Field view</span>}
        <ExternalLink className="size-3 opacity-60" />
      </Button>
    </div>
  )
}

export function ScenarioBar() {
  const { index, playing, speedMs } = useScenario()
  const start = useScenario((s) => s.start)
  const play = useScenario((s) => s.play)
  const pause = useScenario((s) => s.pause)
  const next = useScenario((s) => s.next)
  const prev = useScenario((s) => s.prev)
  const reset = useScenario((s) => s.reset)
  const setSpeed = useScenario((s) => s.setSpeed)
  const world = useScenario((s) => s.world)

  const step = index >= 0 ? STEPS[index] : null
  const pendingApproval =
    !!step?.interactive &&
    world.decisions.some((d) => d.status === "awaiting_approval")

  if (index < 0) {
    return (
      <div className="flex flex-wrap items-center gap-3 border-b bg-card px-4 py-2.5">
        <Sparkles className="size-4 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">Guided demo — Replay Mode</p>
          <p className="truncate text-xs text-muted-foreground">
            Replays the Pune flood of 25 July 2024 through the live pipeline.
            Ten steps, about a minute.
          </p>
        </div>
        <InterfaceLaunchers />
        <Button size="sm" onClick={start} className="shrink-0">
          <Play className="size-3.5" />
          Start guided demo
        </Button>
      </div>
    )
  }

  const simClock = world.status.simulatedTime
    ? new Date(world.status.simulatedTime).toLocaleTimeString("en-IN", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: "Asia/Kolkata",
      })
    : "--:--"

  return (
    <div className="border-b bg-card">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5">
        <div className="flex shrink-0 items-center gap-1">
          <Button
            size="icon"
            variant="outline"
            className="size-8"
            onClick={prev}
            disabled={index === 0}
          >
            <ChevronLeft className="size-4" />
          </Button>
          <Button
            size="icon"
            variant={playing ? "outline" : "default"}
            className="size-8"
            onClick={playing ? pause : play}
          >
            {playing ? (
              <Pause className="size-4" />
            ) : (
              <Play className="size-4" />
            )}
          </Button>
          <Button
            size="icon"
            variant="outline"
            className="size-8"
            onClick={next}
            disabled={index >= STEPS.length - 1}
          >
            <ChevronRight className="size-4" />
          </Button>
        </div>

        <Badge variant="outline" className="tabular shrink-0 gap-1.5 font-mono">
          <Clock className="size-3" />
          {simClock} IST · 25 Jul 2024
        </Badge>

        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">
            <span className="tabular mr-2 text-muted-foreground">
              {index + 1}/{STEPS.length}
            </span>
            {step!.title}
          </p>
          <p className="truncate text-xs text-muted-foreground">
            {step!.narration}
          </p>
        </div>

        {pendingApproval && (
          <Badge className="shrink-0 animate-pulse bg-sev-4 text-sev-4-foreground">
            Waiting for your decision
          </Badge>
        )}

        <div className="flex shrink-0 items-center gap-2">
          <Select
            value={String(speedMs)}
            onValueChange={(v) => setSpeed(Number(v))}
          >
            <SelectTrigger size="sm" className="w-[104px]">
              <Gauge className="size-3.5" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="9000">Slow</SelectItem>
              <SelectItem value="5200">Normal</SelectItem>
              <SelectItem value="2600">Fast</SelectItem>
            </SelectContent>
          </Select>
          <Button
            size="icon"
            variant="ghost"
            className="size-8"
            onClick={reset}
            title="Reset demo"
          >
            <RotateCcw className="size-4" />
          </Button>
        </div>
      </div>

      {/* step ticks */}
      <div className="flex gap-[3px] px-4 pb-2">
        {STEPS.map((s, i) => (
          <button
            key={s.id}
            title={`${i + 1}. ${s.title}`}
            onClick={() => useScenario.getState().goto(i)}
            className={cn(
              "h-1 flex-1 rounded-full transition-colors",
              i < index ? "bg-primary" : i === index ? "bg-primary" : "bg-muted"
            )}
          />
        ))}
      </div>
    </div>
  )
}
