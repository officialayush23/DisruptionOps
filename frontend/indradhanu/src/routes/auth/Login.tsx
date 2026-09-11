import { useState } from "react"
import { Link, useLocation, useNavigate } from "react-router-dom"
import {
  AlertTriangle, ArrowRight, CheckCircle2, Loader2, LogIn, UserPlus,
} from "lucide-react"
import { useAuth } from "@/auth/AuthProvider"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"

/** Three ways in, because there are three kinds of person.
 *
 *  A resident needs no account and must not meet a wall: the largest audience
 *  for a flood map has never signed in to anything the corporation runs and
 *  should not have to in order to find out whether their street is under water.
 *  A resident who *wants* an account can make one, and it is a citizen account
 *  whatever they type — the role lives in `profiles` and signup cannot set it.
 *  Staff sign in with credentials somebody issued them.
 *
 *  The demo identities are one click each, signing straight in rather than
 *  filling the form and waiting to be told to press another button. They exist
 *  so the delegation matrix can be *shown*: the same screen looks different to a
 *  ward officer and to a commissioner, and that difference is the product.
 */

/** Seeded by migration `pune_demo_accounts`. Throwaway, and documented as such:
 *  these are deleted before anything resembling production. */
const DEMO = [
  {
    email: "commissioner@pune.indradhanu.local",
    label: "Commissioner", who: "Meera Deshpande",
    can: "Authorises evacuations and NDRF requests. Can create logins.",
    tone: "border-violet-500/40",
  },
  {
    email: "officer@pune.indradhanu.local",
    label: "Ward officer", who: "Rahul Kulkarni",
    can: "The whole console. Approves what the gate holds back.",
    tone: "border-sky-500/40",
  },
  {
    email: "fire@pune.indradhanu.local",
    label: "Field — Fire Brigade", who: "Sana Shaikh",
    can: "Only Fire Brigade units and tasks.",
    tone: "border-orange-500/40",
  },
  {
    email: "pmc@pune.indradhanu.local",
    label: "Field — PMC Drainage", who: "Vikram Jadhav",
    can: "Only PMC Drainage units and tasks.",
    tone: "border-teal-500/40",
  },
  {
    email: "citizen@pune.indradhanu.local",
    label: "Resident", who: "Anita Joshi",
    can: "The public view, with a signed-in reporting history.",
    tone: "border-slate-500/40",
  },
]

const DEMO_PASSWORD = "Indradhanu#2026"

const LANDING: Record<string, string> = {
  commissioner: "/admin/console",
  ward_officer: "/admin/console",
  admin: "/admin/console",
  field_operator: "/field",
  citizen: "/citizen",
}

export default function Login() {
  const { signIn, signUp, configured, me } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const from = (location.state as { from?: string } | null)?.from

  const [mode, setMode] = useState<"in" | "up">("in")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [fullName, setFullName] = useState("")
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  /** Where somebody lands after signing in.
   *
   *  Their role, not the page they were bounced from: sending a field operator
   *  to the console they cannot see, because that is where they clicked, is a
   *  worse welcome than sending them to their own screen.
   */
  function landing(role: string) {
    if (from && (role === "ward_officer" || role === "commissioner" || role === "admin")) {
      return from
    }
    return LANDING[role] ?? "/citizen"
  }

  async function submit(e?: React.FormEvent) {
    e?.preventDefault()
    setError(null); setNotice(null); setBusy("form")
    try {
      if (mode === "up") {
        const r = await signUp(email.trim(), password, fullName.trim())
        if (r.error) { setError(r.error); return }
        if (r.needsConfirmation) {
          setNotice(
            "Account created. Check your email for the confirmation link, then " +
            "sign in. You can use the map and report without waiting."
          )
          setMode("in")
          return
        }
        navigate("/citizen", { replace: true })
        return
      }
      const r = await signIn(email.trim(), password)
      if (r.error) { setError(r.error); return }
      // The provider reads the profile on the auth event; give it the tick it
      // needs before deciding where this person belongs.
      setTimeout(() => navigate(landing(me.role), { replace: true }), 120)
    } finally { setBusy(null) }
  }

  /** One click: fill the form and sign in. Filling it and stopping is a step
   *  that exists only to be clicked through. */
  async function useIdentity(demoEmail: string) {
    setError(null); setNotice(null)
    setEmail(demoEmail); setPassword(DEMO_PASSWORD)
    setBusy(demoEmail)
    try {
      const r = await signIn(demoEmail, DEMO_PASSWORD)
      if (r.error) {
        setError(
          `${r.error} The credentials are filled in above, so you can try again ` +
          "or sign in manually."
        )
        return
      }
      const role =
        demoEmail.startsWith("commissioner") ? "commissioner"
        : demoEmail.startsWith("officer") ? "ward_officer"
        : demoEmail.startsWith("citizen") ? "citizen"
        : "field_operator"
      setTimeout(() => navigate(landing(role), { replace: true }), 120)
    } finally { setBusy(null) }
  }

  return (
    <div className="mx-auto flex min-h-svh max-w-5xl flex-col justify-center gap-4 p-4">
      <div>
        <h1 className="text-xl font-semibold">Indradhanu</h1>
        <p className="text-muted-foreground text-sm">
          Agentic disaster relief coordination for Pune Municipal Corporation.
        </p>
      </div>

      {!configured && (
        <Alert variant="destructive">
          <AlertTriangle className="size-4" />
          <AlertDescription className="text-xs">
            Supabase is not configured in this build, so signing in will not
            work. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in
            <code className="mx-1">frontend/indradhanu/.env.local</code>. The
            public view below works regardless.
          </AlertDescription>
        </Alert>
      )}

      {/* The public door, first and unmissable. A resident meeting a login wall
          on a flood map is the product failing at its largest audience. */}
      <Card className="border-primary/40">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">No account needed</CardTitle>
          <CardDescription className="text-xs">
            See what is happening where you are, get told where to go and why,
            and report what you can see — by voice or by typing, in English,
            Hindi or Marathi. Nothing below is required for any of it.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild className="w-full sm:w-auto">
            <Link to="/citizen">
              Open the public view <ArrowRight className="size-4" />
            </Link>
          </Button>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-3">
            <div className="flex gap-1">
              <Button
                size="sm" variant={mode === "in" ? "secondary" : "ghost"}
                className="h-8 gap-1.5 text-xs" onClick={() => setMode("in")}
              >
                <LogIn className="size-3.5" /> Sign in
              </Button>
              <Button
                size="sm" variant={mode === "up" ? "secondary" : "ghost"}
                className="h-8 gap-1.5 text-xs" onClick={() => setMode("up")}
              >
                <UserPlus className="size-3.5" /> Register
              </Button>
            </div>
            <CardDescription className="pt-1 text-xs">
              {mode === "in"
                ? "Staff credentials, or an account you registered."
                : "Anyone can register. New accounts are residents — a role is " +
                  "something an officer grants afterwards, never something a " +
                  "signup form can ask for."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form className="space-y-3" onSubmit={submit}>
              {mode === "up" && (
                <div className="space-y-1">
                  <Label htmlFor="name" className="text-xs">Your name</Label>
                  <Input
                    id="name" value={fullName} autoComplete="name"
                    onChange={(e) => setFullName(e.target.value)}
                    placeholder="Anita Joshi"
                  />
                </div>
              )}
              <div className="space-y-1">
                <Label htmlFor="email" className="text-xs">Email</Label>
                <Input
                  id="email" type="email" value={email} autoComplete="email"
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="password" className="text-xs">Password</Label>
                <Input
                  id="password" type="password" value={password}
                  autoComplete={mode === "in" ? "current-password" : "new-password"}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={mode === "up" ? "At least eight characters" : "••••••••"}
                />
              </div>

              {error && (
                <Alert variant="destructive">
                  <AlertTriangle className="size-4" />
                  <AlertDescription className="text-xs">{error}</AlertDescription>
                </Alert>
              )}
              {notice && (
                <Alert>
                  <CheckCircle2 className="size-4" />
                  <AlertDescription className="text-xs">{notice}</AlertDescription>
                </Alert>
              )}

              <Button type="submit" className="w-full" disabled={busy !== null}>
                {busy === "form" ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : mode === "in" ? (
                  <LogIn className="size-4" />
                ) : (
                  <UserPlus className="size-4" />
                )}
                {mode === "in" ? "Sign in" : "Create account"}
              </Button>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Try an identity</CardTitle>
            <CardDescription className="text-xs">
              One click signs you straight in. Worth trying more than one: the
              same system looks different to each of them, and that difference —
              what a ward officer may authorise and a crew may not — is the point
              rather than a login demo.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-1.5">
            {DEMO.map((d) => (
              <button
                key={d.email}
                type="button"
                disabled={busy !== null}
                onClick={() => void useIdentity(d.email)}
                className={`hover:bg-muted/50 flex w-full items-start gap-2 rounded-md border p-2 text-left transition-colors disabled:opacity-60 ${d.tone}`}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-sm font-medium">{d.who}</span>
                    <Badge variant="outline" className="font-normal">{d.label}</Badge>
                  </div>
                  <p className="text-muted-foreground mt-0.5 text-xs">{d.can}</p>
                </div>
                {busy === d.email ? (
                  <Loader2 className="mt-1 size-4 shrink-0 animate-spin" />
                ) : (
                  <ArrowRight className="text-muted-foreground mt-1 size-4 shrink-0" />
                )}
              </button>
            ))}
            <p className="text-muted-foreground pt-1 text-[11px]">
              Shared password <code>{DEMO_PASSWORD}</code>. These are throwaway
              accounts for the demo and are deleted before any real deployment.
            </p>
          </CardContent>
        </Card>
      </div>

      <p className="text-muted-foreground text-center text-xs">
        Crews open <Link to="/field" className="underline">/field</Link>.
        Residents open <Link to="/citizen" className="underline">/citizen</Link>.
      </p>
    </div>
  )
}
