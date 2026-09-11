import { useEffect } from "react"
import { useNavigate } from "react-router-dom"
import { useScenario } from "./store"

/** Navigates the app as the scenario advances, so the tour drives the UI
 *  rather than telling the judge where to click. */
export function useScenarioNavigation() {
  const nav = useNavigate()
  const pendingRoute = useScenario((s) => s.pendingRoute)
  const consumeRoute = useScenario((s) => s.consumeRoute)
  useEffect(() => {
    if (!pendingRoute) return
    nav(pendingRoute)
    consumeRoute()
  }, [pendingRoute, nav, consumeRoute])
}
