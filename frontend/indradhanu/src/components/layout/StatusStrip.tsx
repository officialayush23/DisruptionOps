import { useSystemStatus } from "@/hooks/useApi"
import { cn } from "@/lib/utils"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"

const STATE_COLOR: Record<string, string> = {
  live: "bg-sev-1",
  cached: "bg-sev-2",
  down: "bg-sev-5",
}

export function StatusStrip() {
  const { data } = useSystemStatus()
  if (!data) return null

  return (
    <div className="space-y-1 px-2 py-1">
      {data.feeds.map((f) => (
        <Tooltip key={f.id}>
          <TooltipTrigger asChild>
            <div className="flex items-center gap-2 text-xs">
              <span
                className={cn(
                  "size-1.5 shrink-0 rounded-full",
                  STATE_COLOR[f.state]
                )}
              />
              <span className="truncate text-muted-foreground">{f.label}</span>
              <span className="ml-auto shrink-0 text-[10px] text-muted-foreground/70 uppercase">
                {f.state}
              </span>
            </div>
          </TooltipTrigger>
          <TooltipContent side="right" className="max-w-56">
            <p className="font-medium">{f.label}</p>
            <p className="text-xs">{f.detail}</p>
          </TooltipContent>
        </Tooltip>
      ))}
    </div>
  )
}
