import { CloudOff, Download, Loader2, Smartphone, UploadCloud } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useInstall, useManifest, useOutbox } from "@/lib/pwa"

/** What the app says when there is no signal.
 *
 *  The honest thing and the useful thing are the same here: say that the report
 *  is on the phone and will go when it can. A spinner that never resolves
 *  teaches people the app is broken, and a success message for something that
 *  has not been sent teaches them something worse.
 *
 *  The install prompt sits beside it because installing is what makes the app
 *  work at all on a dead network next time, and the moment somebody sees "no
 *  signal" is the moment that argument lands.
 */
export function OfflineBar({ manifest }: { manifest: string }) {
  useManifest(manifest)
  const { queued, online } = useOutbox()
  const { available, installed, install } = useInstall()

  if (online && queued === 0 && (installed || !available)) return null

  return (
    <div className="space-y-2">
      {!online && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs">
          <CloudOff className="size-4 shrink-0 text-amber-600 dark:text-amber-400" />
          <span className="font-medium">No signal.</span>
          <span className="text-muted-foreground">
            You can still report and read the last map we had. Anything you send
            is kept on this phone and goes the moment you are back online.
          </span>
        </div>
      )}

      {queued > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-xs">
          {online ? (
            <Loader2 className="size-4 shrink-0 animate-spin" />
          ) : (
            <UploadCloud className="size-4 shrink-0" />
          )}
          <span className="font-medium tabular-nums">
            {queued} report{queued === 1 ? "" : "s"} waiting
          </span>
          <span className="text-muted-foreground">
            {online
              ? "Sending now."
              : "Saved on this phone. Nothing is lost; it sends itself later."}
          </span>
        </div>
      )}

      {available && !installed && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-xs">
          <Smartphone className="size-4 shrink-0" />
          <span className="text-muted-foreground">
            Install this and it opens with no network at all.
          </span>
          <Button size="sm" variant="secondary" className="ml-auto h-7 text-xs"
                  onClick={() => void install()}>
            <Download className="size-3" /> Add to home screen
          </Button>
        </div>
      )}
    </div>
  )
}
