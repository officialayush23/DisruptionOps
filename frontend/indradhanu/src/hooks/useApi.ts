import { useQuery } from "@tanstack/react-query"
import { api } from "@/api/client"
import type { HazardType } from "@/api/types"
import { useScenario } from "@/scenario/store"

/** Every query is keyed on the scenario position, so advancing the replay
 *  refetches automatically. Against the real backend the key becomes a
 *  polling interval or a Supabase realtime invalidation instead. */
function useTick() {
  return useScenario(
    (s) =>
      `${s.index}:${Object.keys(s.decisionOverrides).length}:${Object.keys(s.taskOverrides).length}`
  )
}

export function useSystemStatus() {
  const t = useTick()
  return useQuery({
    queryKey: ["status", t],
    queryFn: () => api.getSystemStatus(),
  })
}
export function useWards() {
  return useQuery({
    queryKey: ["wards"],
    queryFn: () => api.getWards(),
    staleTime: Infinity,
  })
}
export function useLifelines() {
  return useQuery({
    queryKey: ["lifelines"],
    queryFn: () => api.getLifelines(),
    staleTime: Infinity,
  })
}
export function useShelters() {
  const t = useTick()
  return useQuery({
    queryKey: ["shelters", t],
    queryFn: () => api.getShelters(),
  })
}
export function useWardRisks(hazard: HazardType = "flood") {
  const t = useTick()
  return useQuery({
    queryKey: ["risks", hazard, t],
    queryFn: () => api.getWardRisks(hazard),
  })
}
export function useActiveRun(hazard: HazardType = "flood") {
  const t = useTick()
  return useQuery({
    queryKey: ["run", hazard, t],
    queryFn: () => api.getActiveRun(hazard),
  })
}
export function useIncidents() {
  const t = useTick()
  return useQuery({
    queryKey: ["incidents", t],
    queryFn: () => api.getIncidents(),
  })
}
export function useReports(incidentId?: string) {
  const t = useTick()
  return useQuery({
    queryKey: ["reports", incidentId ?? "all", t],
    queryFn: () => api.getReports(incidentId),
  })
}
export function useResources() {
  const t = useTick()
  return useQuery({
    queryKey: ["resources", t],
    queryFn: () => api.getResources(),
  })
}
export function useAllocationPlan() {
  const t = useTick()
  return useQuery({
    queryKey: ["plan", t],
    queryFn: () => api.getAllocationPlan(),
  })
}
export function useDecisions() {
  const t = useTick()
  return useQuery({
    queryKey: ["decisions", t],
    queryFn: () => api.getDecisions(),
  })
}
export function useAgentRuns() {
  const t = useTick()
  return useQuery({
    queryKey: ["agentruns", t],
    queryFn: () => api.getAgentRuns(),
  })
}
export function useAlerts() {
  const t = useTick()
  return useQuery({ queryKey: ["alerts", t], queryFn: () => api.getAlerts() })
}
export function useCitizenSituation(wardId: string) {
  const t = useTick()
  return useQuery({
    queryKey: ["situation", wardId, t],
    queryFn: () => api.getCitizenSituation(wardId),
  })
}
export function useFieldTasks(operator?: string) {
  const t = useTick()
  return useQuery({
    queryKey: ["tasks", operator ?? "all", t],
    queryFn: () => api.getFieldTasks(operator),
  })
}
