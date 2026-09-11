import { useEffect, useLayoutEffect, useState } from "react"
import { X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { TOUR_STEPS, hasSeenTour, useTour } from "./tourStore"

interface Rect {
  top: number
  left: number
  width: number
  height: number
}

const CARD_W = 340
const GAP = 12

/** Coach marks. Deliberately no dimming scrim — the design rule here is solid
 *  surfaces only, so the current element is marked with a ring rather than by
 *  fading everything else out. */
export function TourGuide() {
  const { open, index } = useTour()
  const next = useTour((s) => s.next)
  const prev = useTour((s) => s.prev)
  const close = useTour((s) => s.close)
  const start = useTour((s) => s.start)
  const [rect, setRect] = useState<Rect | null>(null)

  // First visit: offer the walkthrough once the shell has painted.
  useEffect(() => {
    if (hasSeenTour()) return
    const t = setTimeout(() => start(), 600)
    return () => clearTimeout(t)
  }, [start])

  const step = TOUR_STEPS[index]

  useLayoutEffect(() => {
    if (!open || !step) return

    const measure = () => {
      const el = document.querySelector(step.target)
      if (!el) {
        setRect(null)
        return
      }
      const r = el.getBoundingClientRect()
      setRect({ top: r.top, left: r.left, width: r.width, height: r.height })
    }

    measure()
    const id = window.setInterval(measure, 300)
    window.addEventListener("resize", measure)
    window.addEventListener("scroll", measure, true)
    return () => {
      window.clearInterval(id)
      window.removeEventListener("resize", measure)
      window.removeEventListener("scroll", measure, true)
    }
  }, [open, step, index])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close()
      if (e.key === "ArrowRight") next()
      if (e.key === "ArrowLeft") prev()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open, close, next, prev])

  if (!open || !step) return null

  // Place the card beside the target, clamped into the viewport.
  const vw = window.innerWidth
  const vh = window.innerHeight
  let top = vh / 2 - 90
  let left = vw / 2 - CARD_W / 2

  if (rect) {
    const preferBottom = (step.side ?? "bottom") === "bottom"
    const roomBelow = vh - (rect.top + rect.height)
    const below = preferBottom ? roomBelow > 200 : roomBelow > 320
    top = below
      ? rect.top + rect.height + GAP
      : Math.max(GAP, rect.top - 200 - GAP)
    left = Math.min(
      Math.max(GAP, rect.left + rect.width / 2 - CARD_W / 2),
      vw - CARD_W - GAP
    )
    top = Math.min(Math.max(GAP, top), vh - 220)
  }

  return (
    <>
      {rect && (
        <div
          aria-hidden
          className="pointer-events-none fixed z-[70] rounded-md border-2 border-primary"
          style={{
            top: rect.top - 3,
            left: rect.left - 3,
            width: rect.width + 6,
            height: rect.height + 6,
          }}
        />
      )}

      <div
        role="dialog"
        aria-label="Guided walkthrough"
        className="fixed z-[71] rounded-lg border-2 bg-card shadow-lg"
        style={{ top, left, width: CARD_W }}
      >
        <div className="flex items-start gap-2 border-b px-4 py-2.5">
          <div className="min-w-0 flex-1">
            <p className="tabular text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
              Walkthrough · {index + 1} of {TOUR_STEPS.length}
            </p>
            <p className="text-sm font-semibold">{step.title}</p>
          </div>
          <Button
            size="icon"
            variant="ghost"
            className="-mt-1 -mr-2 size-7 shrink-0"
            onClick={close}
            aria-label="Skip walkthrough"
          >
            <X className="size-4" />
          </Button>
        </div>

        <div className="px-4 py-3">
          <p className="text-sm">{step.body}</p>
        </div>

        <div className="flex items-center gap-2 border-t px-4 py-2.5">
          <div className="flex gap-1">
            {TOUR_STEPS.map((_, i) => (
              <span
                key={i}
                className={
                  i === index
                    ? "size-1.5 rounded-full bg-primary"
                    : "size-1.5 rounded-full bg-muted"
                }
              />
            ))}
          </div>
          <div className="ml-auto flex gap-1.5">
            <Button size="sm" variant="ghost" onClick={close}>
              Skip
            </Button>
            {index > 0 && (
              <Button size="sm" variant="outline" onClick={prev}>
                Back
              </Button>
            )}
            <Button size="sm" onClick={next}>
              {index === TOUR_STEPS.length - 1 ? "Done" : "Next"}
            </Button>
          </div>
        </div>
      </div>
    </>
  )
}
