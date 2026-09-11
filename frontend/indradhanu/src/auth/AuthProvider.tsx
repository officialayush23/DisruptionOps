import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react"
import type { Session } from "@supabase/supabase-js"
import { supabase, supabaseConfigured } from "@/lib/supabase"
import { fetchMe, type Me } from "@/api/httpClient"

/** Session plus entitlement.
 *
 *  Supabase tells us who is signed in. It does not tell us what they are
 *  allowed to do: role, ward delegation and agency live in `profiles` and are
 *  resolved by the backend at `/auth/me`, through the same code path that
 *  authorises every other call. So the client asks rather than infers, and
 *  nothing here is trusted for access control - it only decides what to render.
 *  The server refuses anything the role does not permit regardless of what this
 *  object says.
 */

const ANONYMOUS: Me = {
  authenticated: false,
  userId: null,
  role: "citizen",
  fullName: "",
  wardId: null,
  operator: null,
  isStaff: false,
  canEscalate: false,
  interfaces: ["citizen"],
  developmentIdentity: false,
}

type AuthState = {
  session: Session | null
  me: Me
  loading: boolean
  configured: boolean
  /** Supabase says this person is signed in, but `/auth/me` could not be
   *  reached, so we do not know what they may do. Distinct from being signed
   *  out, and the guard must not treat the two the same: bouncing somebody
   *  back to a login screen they just used correctly reads as "wrong
   *  password", and they will type it again. */
  entitlementUnavailable: boolean
  signIn: (email: string, password: string) => Promise<{ error: string | null }>
  signUp: (
    email: string,
    password: string,
    fullName: string
  ) => Promise<{ error: string | null; needsConfirmation: boolean }>
  signOut: () => Promise<void>
  refresh: () => Promise<void>
}

const AuthContext = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [me, setMe] = useState<Me>(ANONYMOUS)
  const [loading, setLoading] = useState(true)
  const [entitlementUnavailable, setEntitlementUnavailable] = useState(false)

  const refresh = useCallback(async () => {
    try {
      setMe(await fetchMe())
      setEntitlementUnavailable(false)
    } catch (err) {
      setEntitlementUnavailable(true)
      // The backend being unreachable is not the same as being signed out. Stay
      // anonymous for rendering, but do not throw the user back to a login
      // screen for what is probably a stopped uvicorn.
      console.warn("[indradhanu] /auth/me unavailable", err)
      setMe(ANONYMOUS)
    }
  }, [])

  useEffect(() => {
    let alive = true
    if (!supabaseConfigured) {
      // No Supabase configured: the backend may still hand us a development
      // identity via DEV_AUTH_ROLE, so ask anyway.
      void refresh().finally(() => alive && setLoading(false))
      return () => {
        alive = false
      }
    }

    supabase.auth.getSession().then(async ({ data }) => {
      if (!alive) return
      setSession(data.session)
      await refresh()
      if (alive) setLoading(false)
    })

    const { data: sub } = supabase.auth.onAuthStateChange(async (_event, next) => {
      if (!alive) return
      setSession(next)
      await refresh()
    })
    return () => {
      alive = false
      sub.subscription.unsubscribe()
    }
  }, [refresh])

  const signIn = useCallback(async (email: string, password: string) => {
    if (!supabaseConfigured) {
      return { error: "Supabase is not configured in this build." }
    }
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    return { error: error?.message ?? null }
  }, [])

  const signUp = useCallback(
    async (email: string, password: string, fullName: string) => {
      if (!supabaseConfigured) {
        return { error: "Supabase is not configured in this build.", needsConfirmation: false }
      }
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        // Only the display name. A role passed here would be ignored anyway:
        // `app.handle_new_user` gives every new account the citizen role and
        // deliberately does not read a role out of signup metadata, because a
        // role you can ask for at signup is not a role, it is a door.
        options: { data: { full_name: fullName } },
      })
      if (error) return { error: error.message, needsConfirmation: false }
      // No session back means the project requires email confirmation.
      return { error: null, needsConfirmation: data.session === null }
    },
    []
  )

  const signOut = useCallback(async () => {
    if (supabaseConfigured) await supabase.auth.signOut()
    setSession(null)
    setMe(ANONYMOUS)
    setEntitlementUnavailable(false)
  }, [])

  const value = useMemo<AuthState>(
    () => ({
      session,
      me,
      loading,
      configured: supabaseConfigured,
      entitlementUnavailable,
      signIn,
      signUp,
      signOut,
      refresh,
    }),
    [session, me, loading, entitlementUnavailable, signIn, signUp, signOut, refresh]
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>")
  return ctx
}
