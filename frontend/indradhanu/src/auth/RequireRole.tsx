import type { ReactNode } from "react"
import { Navigate, useLocation } from "react-router-dom"
import { useAuth } from "@/auth/AuthProvider"

/** Route guard.
 *
 *  This decides what to RENDER, never what is permitted. Every endpoint behind
 *  these screens checks the same role server-side and the database checks it
 *  again in row level security, so a user who edits their way past this guard
 *  reaches an interface that returns 403 to everything. Hiding a screen is a
 *  courtesy; the refusal is enforced twice, elsewhere.
 */
export function RequireRole({
  children,
  need,
}: {
  children: ReactNode
  need: "staff" | "field" | "citizen" | "commissioner"
}) {
  const { me, loading } = useAuth()
  const loc = useLocation()

  if (loading) {
    return (
      <div className="text-muted-foreground flex min-h-svh items-center justify-center text-sm">
        Checking your access…
      </div>
    )
  }

  const ok =
    need === "citizen" ||
    (need === "staff" && me.isStaff) ||
    (need === "commissioner" && me.canEscalate) ||
    (need === "field" && (me.isStaff || me.role === "field_operator"))

  if (!ok) {
    if (!me.authenticated) {
      return <Navigate to="/login" state={{ from: loc.pathname }} replace />
    }
    return (
      <div className="flex min-h-svh flex-col items-center justify-center gap-2 p-6 text-center">
        <p className="font-medium">This view is not part of your delegation.</p>
        <p className="text-muted-foreground max-w-md text-sm">
          You are signed in as {me.fullName || "an unnamed user"} (
          {me.role.replace(/_/g, " ")}). The operations console is restricted to
          municipal staff.
        </p>
      </div>
    )
  }
  return <>{children}</>
}
