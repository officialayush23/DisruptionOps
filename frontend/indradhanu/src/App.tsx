import { Navigate, Route, Routes } from "react-router-dom"
import { AdminShell } from "@/components/layout/AdminShell"
import { useScenarioNavigation } from "@/scenario/useScenarioNavigation"
import { RequireRole } from "@/auth/RequireRole"

import Login from "@/routes/auth/Login"
import DemoConsole from "@/routes/demo/DemoConsole"
import LiveOps from "@/routes/admin/LiveOps"
import RiskBoard from "@/routes/admin/RiskBoard"
import IncidentQueue from "@/routes/admin/IncidentQueue"
import AllocationPlanner from "@/routes/admin/AllocationPlanner"
import DecisionGate from "@/routes/admin/DecisionGate"
import AgentTrace from "@/routes/admin/AgentTrace"
import ResourcesPage from "@/routes/admin/ResourcesPage"
import AlertsPage from "@/routes/admin/AlertsPage"
import AfterAction from "@/routes/admin/AfterAction"
import CitizenPortal from "@/routes/citizen/CitizenPortal"
import FieldPortal from "@/routes/field/FieldPortal"

export function App() {
  useScenarioNavigation()

  return (
    <Routes>
      <Route path="/login" element={<Login />} />

      {/* A resident is the default landing, because the largest audience for
          this system has no account and should not meet a login wall to find
          out whether their street is about to flood. */}
      <Route path="/" element={<Navigate to="/citizen" replace />} />
      <Route path="/citizen/*" element={<CitizenPortal />} />

      <Route
        path="/field/*"
        element={
          <RequireRole need="field">
            <FieldPortal />
          </RequireRole>
        }
      />

      <Route
        path="/admin/*"
        element={
          <RequireRole need="staff">
            <AdminShell>
              <Routes>
                {/* The only screen wired to the real API. Everything else
                    still reads src/api/mock until it is migrated. */}
                <Route path="demo" element={<DemoConsole />} />
                <Route path="live" element={<LiveOps />} />
                <Route path="risk" element={<RiskBoard />} />
                <Route path="incidents" element={<IncidentQueue />} />
                <Route path="allocation" element={<AllocationPlanner />} />
                <Route path="decisions" element={<DecisionGate />} />
                <Route path="agent" element={<AgentTrace />} />
                <Route path="resources" element={<ResourcesPage />} />
                <Route path="alerts" element={<AlertsPage />} />
                <Route path="after-action" element={<AfterAction />} />
                <Route path="*" element={<Navigate to="/admin/demo" replace />} />
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
