import {
  createContext, useCallback, useContext, useMemo, useState, type ReactNode,
} from "react"
import { useActivityIndex, useDemoPoll } from "./useDemo"

/** One world, shared by every screen that looks at it.
 *
 *  This used to be a hook called inside the console. React unmounts a route when
 *  you navigate away from it, so switching to the risk board tore the poll down,
 *  threw the snapshot away, and coming back showed the pre-start empty state for
 *  a second before the first response landed. Worse, it meant the other screens
 *  had no access to the live world at all and were still reading fixtures, which
 *  is why they looked empty while reports were visibly arriving next door.
 *
 *  Mounted once, above the admin routes: the poll survives navigation, every
 *  screen reads the same tick, and no screen can disagree with the map about
 *  what is happening.
 */

type Ctx = ReturnType<typeof useDemoPoll> & {
  activity: Map<string, { at: string; text: string; kind: string }[]>
  /** The incident the operator last picked, shared across screens. */
  selected: string | null
  setSelected: (id: string | null) => void
  busy: string | null
  run: (key: string, path: string, body?: unknown) => Promise<unknown>
}

const DemoContext = createContext<Ctx | null>(null)

export function DemoProvider({ children }: { children: ReactNode }) {
  const poll = useDemoPoll(1000)
  const activity = useActivityIndex(poll.state)
  const [selected, setSelected] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const { act } = poll
  const run = useCallback(
    async (key: string, path: string, body?: unknown) => {
      setBusy(key)
      try {
        return await act(path, body)
      } finally {
        setBusy(null)
      }
    },
    [act]
  )

  const value = useMemo<Ctx>(
    () => ({ ...poll, activity, selected, setSelected, busy, run }),
    [poll, activity, selected, busy, run]
  )

  return <DemoContext.Provider value={value}>{children}</DemoContext.Provider>
}

/** Reading the world outside the provider is a bug, not a fallback, so this
 *  says so rather than quietly rendering an empty console. */
export function useDemo(): Ctx {
  const ctx = useContext(DemoContext)
  if (!ctx) throw new Error("useDemo must be used inside <DemoProvider>")
  return ctx
}
