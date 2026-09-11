import type { Authority } from "@/api/types"

/** The policy corpus the agent retrieves against. In production this is a
 *  vector index over the actual NDMA guidelines and the PMC Disaster
 *  Management Plan; here it is the same clauses, inlined, so the retrieval
 *  step returns identical citations with or without network. */
export interface PolicyClause {
  id: string
  clause: string
  source: string
  delegatedTo: string
  text: string
  /** Actions this clause authorises. */
  authorises: string[]
  /** Above this severity the action leaves delegated authority. */
  maxSeverityWithoutEscalation: number
}

export const POLICY: PolicyClause[] = [
  {
    id: "pol-1",
    clause: "PMC DMP 2023, cl. 4.2",
    source: "Pune Municipal Corporation Disaster Management Plan",
    delegatedTo: "Ward Officer",
    text: "The Ward Officer may issue public advisories and precautionary warnings within the ward without prior approval where a competent forecast indicates likely impact within 24 hours.",
    authorises: ["issue_advisory", "issue_warning"],
    maxSeverityWithoutEscalation: 5,
  },
  {
    id: "pol-2",
    clause: "PMC DMP 2023, cl. 6.1",
    source: "Pune Municipal Corporation Disaster Management Plan",
    delegatedTo: "Ward Officer",
    text: "Pre-positioning of municipal equipment, including pumps and dewatering sets, within the ward is delegated to the Ward Officer during an active alert.",
    authorises: ["preposition_equipment", "inspect_drainage"],
    maxSeverityWithoutEscalation: 5,
  },
  {
    id: "pol-3",
    clause: "PMC DMP 2023, cl. 6.4",
    source: "Pune Municipal Corporation Disaster Management Plan",
    delegatedTo: "Ward Officer",
    text: "Temporary closure of a municipal road may be ordered by the Ward Officer where standing water exceeds 0.3 m or where a structural hazard is confirmed.",
    authorises: ["close_road", "divert_traffic"],
    maxSeverityWithoutEscalation: 4,
  },
  {
    id: "pol-4",
    clause: "NDMA UF Guidelines 2010, §7.3",
    source: "NDMA Guidelines on Management of Urban Flooding",
    delegatedTo: "Municipal Commissioner",
    text: "Evacuation of an educational institution or healthcare facility shall be ordered only by the Municipal Commissioner or an officer specifically authorised in writing for the event.",
    authorises: ["evacuate_school", "evacuate_hospital"],
    maxSeverityWithoutEscalation: 0,
  },
  {
    id: "pol-5",
    clause: "NDMA UF Guidelines 2010, §9.1",
    source: "NDMA Guidelines on Management of Urban Flooding",
    delegatedTo: "District Disaster Management Authority",
    text: "Requisition of State Disaster Response Force or armed forces assistance requires a request routed through the District Disaster Management Authority.",
    authorises: ["requisition_ndrf", "requisition_army"],
    maxSeverityWithoutEscalation: 0,
  },
  {
    id: "pol-6",
    clause: "PMC DMP 2023, cl. 8.2",
    source: "Pune Municipal Corporation Disaster Management Plan",
    delegatedTo: "Ward Officer",
    text: "Activation of a designated shelter and deployment of transport to it is delegated to the Ward Officer once a red-level advisory is in force for the ward.",
    authorises: ["activate_shelter", "deploy_transport"],
    maxSeverityWithoutEscalation: 5,
  },
  {
    id: "pol-7",
    clause: "MahaWRD Circular 2019/07",
    source: "Maharashtra Water Resources Department",
    delegatedTo: "Executive Engineer, Khadakwasla Division",
    text: "Downstream local bodies shall be notified not less than three hours before any reservoir discharge exceeding 20,000 cusecs.",
    authorises: ["notify_downstream"],
    maxSeverityWithoutEscalation: 5,
  },
]

export function clauseFor(action: string): PolicyClause | null {
  return POLICY.find((p) => p.authorises.includes(action)) ?? null
}

export function authorityFor(action: string, severity: number): Authority {
  const c = clauseFor(action)
  if (!c) {
    return {
      clause: "No matching clause",
      source: "—",
      delegatedTo: "Municipal Commissioner",
      withinDelegation: false,
    }
  }
  return {
    clause: c.clause,
    source: c.source,
    delegatedTo: c.delegatedTo,
    withinDelegation: severity <= c.maxSeverityWithoutEscalation,
  }
}
