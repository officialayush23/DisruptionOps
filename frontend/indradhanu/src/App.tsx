import { Navigate, Route, Routes } from "react-router-dom"
import { AdminShell } from "@/components/layout/AdminShell"
import { useScenarioNavigation } from "@/scenario/useScenarioNavigation"

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
      <Route path="/" element={<Navigate to="/admin/risk" replace />} />
      <Route
        path="/admin/*"
        element={
          <AdminShell>
            <Routes>
              <Route path="risk" element={<RiskBoard />} />
              <Route path="incidents" element={<IncidentQueue />} />
              <Route path="allocation" element={<AllocationPlanner />} />
              <Route path="decisions" element={<DecisionGate />} />
              <Route path="agent" element={<AgentTrace />} />
              <Route path="resources" element={<ResourcesPage />} />
              <Route path="alerts" element={<AlertsPage />} />
              <Route path="after-action" element={<AfterAction />} />
              <Route path="*" element={<Navigate to="/admin/risk" replace />} />
            </Routes>
          </AdminShell>
        }
      />
      <Route path="/citizen/*" element={<CitizenPortal />} />
      <Route path="/field/*" element={<FieldPortal />} />
      <Route path="*" element={<Navigate to="/admin/risk" replace />} />
    </Routes>
  )
}

export default App
