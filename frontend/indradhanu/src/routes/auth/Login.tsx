import { useState } from "react"
import { useLocation, useNavigate } from "react-router-dom"
import { ShieldCheck } from "lucide-react"
import { useAuth } from "@/auth/AuthProvider"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Alert, AlertDescription } from "@/components/ui/alert"

/** The demo accounts, seeded by migration `pune_demo_accounts`.
 *
 *  Listed in the interface on purpose: this is a hackathon build against a
 *  throwaway project, and a judge should be able to switch roles without being
 *  handed a slip of paper. Delete this block before the credentials mean
 *  anything.
 */
const DEMO = [
  { email: "commissioner@pune.indradhanu.local", label: "Commissioner", who: "Meera Deshpande", can: "Can authorise evacuations" },
  { email: "officer@pune.indradhanu.local", label: "Ward officer", who: "Rahul Kulkarni", can: "Delegated within one ward" },
  { email: "fire@pune.indradhanu.local", label: "Field, fire", who: "Sana Shaikh", can: "Sees only Fire Brigade tasks" },
  { email: "pmc@pune.indradhanu.local", label: "Field, drainage", who: "Vikram Jadhav", can: "Sees only PMC Drainage tasks" },
  { email: "citizen@pune.indradhanu.local", label: "Citizen", who: "Anita Joshi", can: "Risk map and reporting only" },
]
const DEMO_PASSWORD = "Indradhanu#2026"

export default function Login() {
  const { signIn, signUp, configured } = useAuth()
  const [mode, setMode] = useState<"signin" | "signup">("signin")
  const [fullName, setFullName] = useState("")
  const [notice, setNotice] = useState<string | null>(null)
  const nav = useNavigate()
  const loc = useLocation()
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const from = (loc.state as { from?: string } | null)?.from ?? "/"

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    setNotice(null)

    if (mode === "signup") {
      const { error, needsConfirmation } = await signUp(
        email.trim(),
        password,
        fullName.trim()
      )
      setBusy(false)
      if (error) {
        setError(error)
        return
      }
      if (needsConfirmation) {
        setNotice(
          "Account created. Check your email for the confirmation link, then sign in."
        )
        setMode("signin")
        return
      }
      // Confirmation is off, so the account is live and already signed in.
      nav("/citizen", { replace: true })
      return
    }

    const { error } = await signIn(email.trim(), password)
    setBusy(false)
    if (error) {
      setError(error)
      return
    }
    nav(from, { replace: true })
  }

  function useDemo(demoEmail: string) {
    setEmail(demoEmail)
    setPassword(DEMO_PASSWORD)
    setError(null)
  }

  return (
    <div className="flex min-h-svh items-center justify-center bg-muted/30 p-4">
      <div className="grid w-full max-w-4xl gap-4 md:grid-cols-[1fr_1fr]">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ShieldCheck className="size-5" />
              Indradhanu OS
            </CardTitle>
            <CardDescription>
              {mode === "signin"
                ? "Pune and Alandi disaster coordination. Sign in, or read the risk map without an account."
                : "Create a resident account to get alerts for your area and report what you can see."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {!configured && (
              <Alert className="mb-4">
                <AlertDescription>
                  Supabase is not configured in this build. Set
                  <code className="mx-1">VITE_SUPABASE_URL</code> and
                  <code className="mx-1">VITE_SUPABASE_ANON_KEY</code> in
                  <code className="mx-1">.env.local</code>.
                </AlertDescription>
              </Alert>
            )}
            <form onSubmit={submit} className="space-y-4">
              {mode === "signup" && (
                <div className="space-y-2">
                  <Label htmlFor="fullName">Your name</Label>
                  <Input
                    id="fullName"
                    autoComplete="name"
                    value={fullName}
                    onChange={(e) => setFullName(e.target.value)}
                    required
                  />
                </div>
              )}
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  autoComplete="username"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  type="password"
                  autoComplete={mode === "signup" ? "new-password" : "current-password"}
                  minLength={mode === "signup" ? 8 : undefined}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </div>
              {error && (
                <Alert variant="destructive">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
              {notice && (
                <Alert>
                  <AlertDescription>{notice}</AlertDescription>
                </Alert>
              )}
              <Button type="submit" className="w-full" disabled={busy || !configured}>
                {busy
                  ? mode === "signup"
                    ? "Creating account…"
                    : "Signing in…"
                  : mode === "signup"
                    ? "Create account"
                    : "Sign in"}
              </Button>

              <div className="text-muted-foreground space-y-2 text-center text-xs">
                <button
                  type="button"
                  className="underline underline-offset-2"
                  onClick={() => {
                    setMode(mode === "signin" ? "signup" : "signin")
                    setError(null)
                    setNotice(null)
                  }}
                >
                  {mode === "signin"
                    ? "New here? Create a resident account"
                    : "Already have an account? Sign in"}
                </button>
                <p>
                  Or{" "}
                  <button
                    type="button"
                    className="underline underline-offset-2"
                    onClick={() => nav("/citizen")}
                  >
                    continue without an account
                  </button>
                  . The risk map and reporting work either way.
                </p>
              </div>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Staff demo identities</CardTitle>
            <CardDescription>
              The same event looks different from each seat. Authority is what
              changes, not the data.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {DEMO.map((d) => (
              <button
                key={d.email}
                type="button"
                onClick={() => useDemo(d.email)}
                className="w-full rounded-md border p-3 text-left transition hover:bg-accent"
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-sm font-medium">{d.label}</span>
                  <span className="text-muted-foreground text-xs">{d.who}</span>
                </div>
                <p className="text-muted-foreground mt-0.5 text-xs">{d.can}</p>
              </button>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
