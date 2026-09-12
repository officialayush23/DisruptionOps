import { Navigate, Route, Routes } from "react-router-dom"
import { AdminShell } from "@/components/layout/AdminShell"
import { RequireRole } from "@/auth/RequireRole"

import Login from "@/routes/auth/Login"
import DemoConsole from "@/routes/demo/DemoConsole"
import Copilot from "@/routes/admin/Copilot"
import Dispatch from "@/routes/admin/Dispatch"
import CitizenApp from "@/routes/citizen/CitizenApp"
import FieldApp from "@/routes/field/FieldApp"
import IntakeInbox from "@/routes/admin/IntakeInbox"
import RiskBoard from "@/routes/admin/RiskBoard"
import Forecast from "@/routes/admin/Forecast"
import AgencyHandoff from "@/routes/admin/AgencyHandoff"
import Configuration from "@/routes/admin/Configuration"
import IncidentQueue from "@/routes/admin/IncidentQueue"
import AllocationPlanner from "@/routes/admin/AllocationPlanner"
import DecisionGate from "@/routes/admin/DecisionGate"
import AgentTrace from "@/routes/admin/AgentTrace"
import ResourcesPage from "@/routes/admin/ResourcesPage"
import AlertsPage from "@/routes/admin/AlertsPage"
import AfterAction from "@/routes/admin/AfterAction"
import Replay from "@/routes/admin/Replay"
import Architecture from "@/routes/admin/Architecture"

/** Three interfaces, three URLs.
 *
 *  They are separate routes rather than tabs because they are separate jobs. A
 *  resident opens /citizen on a phone with no account; a crew opens /field
 *  scoped to their agency; an officer opens /admin. Putting a walkable marker
 *  on the operations console was simply the wrong screen for it.
 */
export function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />

      {/* The public face. No account required: the largest audience for this
          has none, and should not meet a login wall to find out whether their
          street is about to flood. */}
      <Route path="/" element={<Navigate to="/citizen" replace />} />
      <Route path="/citizen/*" element={<CitizenApp />} />

      <Route
        path="/field/*"
        element={
          <RequireRole need="field">
            <FieldApp />
          </RequireRole>
        }
      />

      <Route
        path="/admin/*"
        element={
          <RequireRole need="staff">
            <AdminShell>
              <Routes>
                <Route path="console" element={<DemoConsole />} />
                <Route path="copilot" element={<Copilot />} />
                {/* Who is going where. It was only on the map, which answers
                    "where" and not "why that unit". */}
                <Route path="dispatch" element={<Dispatch />} />
                <Route path="intake" element={<IntakeInbox />} />
                <Route path="risk" element={<RiskBoard />} />
                <Route path="forecast" element={<Forecast />} />
                <Route path="incidents" element={<IncidentQueue />} />
                <Route path="allocation" element={<AllocationPlanner />} />
                <Route path="handoff" element={<AgencyHandoff />} />
                <Route path="decisions" element={<DecisionGate />} />
                <Route path="agent" element={<AgentTrace />} />
                <Route path="resources" element={<ResourcesPage />} />
                <Route path="alerts" element={<AlertsPage />} />
                <Route path="after-action" element={<AfterAction />} />
                <Route path="replay" element={<Replay />} />
                <Route path="architecture" element={<Architecture />} />
                <Route path="configuration" element={<Configuration />} />
                {/* `live` and `demo` were two names for overlapping things.
                    One console now; both old paths land on it. */}
                <Route path="live" element={<Navigate to="/admin/console" replace />} />
                <Route path="demo" element={<Navigate to="/admin/console" replace />} />
                <Route path="*" element={<Navigate to="/admin/console" replace />} />
              </Routes>
            </AdminShell>
          </RequireRole>
        }
      />

      <Route path="*" element={<Navigate to="/citizen" replace />} />
    </Routes>
  )
}

export default App
