import { useState } from "react"
import {
  Activity,
  Brain,
  ChevronRight,
  FileText,
  Map,
  Radio,
  Route as RouteIcon,
  Wrench,
} from "lucide-react"
import type { AgentName, AgentStep } from "@/api/types"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { useAgentRuns } from "@/hooks/useApi"
import { timeOf } from "@/lib/format"
import { Empty } from "./DecisionGate"
import { cn } from "@/lib/utils"

const AGENT_META: Record<
  AgentName,
  { label: string; icon: typeof Brain; className: string }
> = {
  hazard_analyst: {
    label: "Hazard Analyst",
    icon: Activity,
    className: "bg-hazard-flood",
  },
  impact_exposure: {
    label: "Impact & Exposure",
    icon: Map,
    className: "bg-hazard-air",
  },
  allocation_planner: {
    label: "Allocation Planner",
    icon: RouteIcon,
    className: "bg-hazard-fire",
  },
  guidance_agent: {
    label: "Guidance Agent",
    icon: Radio,
    className: "bg-hazard-heat",
  },
  policy_retriever: {
    label: "Policy Retriever",
    icon: FileText,
    className: "bg-hazard-seismic",
  },
}

export default function AgentTrace() {
  const { data: runs = [] } = useAgentRuns()
  const run = runs[0]

  if (!run) {
    return (
      <Empty
        icon={<Brain className="size-8 text-muted-foreground" />}
        title="No agent run in progress"
        body="Every reasoning step, tool call and retrieved clause is recorded here while a hazard run is active — so a decision can be inspected rather than trusted."
      />
    )
  }

  const byAgent = run.steps.reduce<Record<string, number>>((a, s) => {
    a[s.agent] = (a[s.agent] ?? 0) + 1
    return a
  }, {})
  const totalMs = run.steps.reduce((a, s) => a + s.durationMs, 0)

  return (
    <div className="space-y-4 p-4">
      <div>
        <h1 className="text-lg font-semibold">Agent trace</h1>
        <p className="text-sm text-muted-foreground">
          What each agent did, which tool it called, and what came back. This is
          the record a judge — or an auditor — reads instead of taking the
          output on faith.
        </p>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <CardTitle className="text-sm">Run {run.id}</CardTitle>
              <p className="mt-1 text-sm text-muted-foreground">
                {run.trigger}
              </p>
            </div>
            <Badge
              variant={run.engine === "gemini" ? "default" : "secondary"}
              className="shrink-0"
            >
              {run.engine === "gemini"
                ? "Gemini 2.0 Flash"
                : "Deterministic fallback"}
            </Badge>
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
            <Stat k="Steps" v={String(run.steps.length)} />
            <Stat k="Agent time" v={`${(totalMs / 1000).toFixed(1)} s`} />
            <Stat k="Started" v={`${timeOf(run.startedAt)} IST`} />
            <Stat
              k="Finished"
              v={run.finishedAt ? `${timeOf(run.finishedAt)} IST` : "running"}
            />
            <Stat k="Agents involved" v={String(Object.keys(byAgent).length)} />
          </div>
          {run.summary && (
            <>
              <Separator className="my-3" />
              <p className="text-sm">{run.summary}</p>
            </>
          )}
        </CardContent>
      </Card>

      <ScrollArea className="max-h-[calc(100vh-24rem)]">
        <div className="space-y-2 pr-3">
          {run.steps.map((s, i) => (
            <StepRow key={s.id} step={s} index={i + 1} />
          ))}
        </div>
      </ScrollArea>
    </div>
  )
}

function StepRow({ step, index }: { step: AgentStep; index: number }) {
  const [open, setOpen] = useState(false)
  const meta = AGENT_META[step.agent]
  const Icon = meta.icon
  const hasDetail = !!step.tool

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="rounded-lg border bg-card">
        <CollapsibleTrigger asChild disabled={!hasDetail}>
          <button
            className={cn(
              "flex w-full items-start gap-3 p-3 text-left",
              hasDetail && "rounded-lg hover:bg-accent"
            )}
          >
            <span className="tabular w-5 shrink-0 pt-0.5 text-xs text-muted-foreground">
              {index}
            </span>
            <span
              className={cn(
                "flex size-7 shrink-0 items-center justify-center rounded-md text-white",
                meta.className
              )}
            >
              <Icon className="size-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-sm font-medium">{meta.label}</span>
                <span className="tabular text-xs text-muted-foreground">
                  {step.durationMs} ms
                </span>
                {step.status === "fallback" && (
                  <Badge variant="secondary" className="h-4 px-1.5 text-[10px]">
                    fallback
                  </Badge>
                )}
                {step.citedClause && (
                  <Badge
                    variant="outline"
                    className="h-4 gap-1 px-1.5 text-[10px]"
                  >
                    <FileText className="size-2.5" />
                    {step.citedClause}
                  </Badge>
                )}
              </span>
              <span className="mt-1 block text-sm">{step.thought}</span>
            </span>
            {hasDetail && (
              <ChevronRight
                className={cn(
                  "mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform",
                  open && "rotate-90"
                )}
              />
            )}
          </button>
        </CollapsibleTrigger>
        {hasDetail && (
          <CollapsibleContent>
            <div className="space-y-2 border-t px-3 py-2.5 pl-[4.25rem]">
              <div className="flex items-center gap-2">
                <Wrench className="size-3.5 text-muted-foreground" />
                <code className="text-xs font-medium">{step.tool}</code>
              </div>
              {step.toolInput && <Field label="Input" value={step.toolInput} />}
              {step.toolOutput && (
                <Field label="Output" value={step.toolOutput} />
              )}
            </div>
          </CollapsibleContent>
        )}
      </div>
    </Collapsible>
  )
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
        {label}
      </p>
      <pre className="mt-0.5 overflow-x-auto rounded-md bg-muted p-2 font-mono text-xs whitespace-pre-wrap">
        {value}
      </pre>
    </div>
  )
}

function Stat({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{k}</p>
      <p className="tabular font-medium">{v}</p>
    </div>
  )
}
