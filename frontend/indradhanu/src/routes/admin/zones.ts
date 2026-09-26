import type { DemoState, Incident } from "@/routes/demo/useDemo"

/** A "zone" is a ward with at least one open incident: one screen on the wall.
 *
 *  Grouping by ward rather than by distance clustering is deliberate. A ward is
 *  a unit someone is responsible for, it has a name an officer recognises, and
 *  it does not reshuffle when one more report lands 200 m away, so the wall is
 *  stable: screens are added when a new ward is hit and removed when its last
 *  incident closes, and never jump between positions otherwise.
 */
export type Zone = {
  id: string
  name: string
  incidents: Incident[]
  severity: number
  reports: number
  unitsEnRoute: number
  unattended: number
  center: [number, number]
  radiusKm: number
  since: number
}

export const isOpen = (status: string) => !/resolved|closed|cancel/i.test(status)

export function km(a: [number, number], b: [number, number]): number {
  const R = 6371
  const dLat = ((b[1] - a[1]) * Math.PI) / 180
  const dLng = ((b[0] - a[0]) * Math.PI) / 180
  const la = (a[1] * Math.PI) / 180
  const lb = (b[1] * Math.PI) / 180
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la) * Math.cos(lb) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

export function zonesOf(state: DemoState): Zone[] {
  const wardName = new Map(state.wards.map((w) => [w.id, w.name]))
  const wardCentre = new Map(state.wards.map((w) => [w.id, w.centroid]))
  const byWard = new Map<string, Incident[]>()
  for (const i of state.incidents) {
    if (!isOpen(i.status)) continue
    const list = byWard.get(i.wardId) ?? []
    list.push(i)
    byWard.set(i.wardId, list)
  }
  const zones: Zone[] = []
  for (const [id, incidents] of byWard) {
    const n = incidents.length
    const lng = incidents.reduce((s, i) => s + i.location[0], 0) / n
    const lat = incidents.reduce((s, i) => s + i.location[1], 0) / n
    const center: [number, number] =
      Number.isFinite(lng) && Number.isFinite(lat) ? [lng, lat] : (wardCentre.get(id) ?? [73.86, 18.52])
    const radiusKm = Math.max(0.6, ...incidents.map((i) => km(center, i.location)))
    zones.push({
      id,
      name: wardName.get(id) ?? id,
      incidents: [...incidents].sort((a, b) => b.severity - a.severity),
      severity: Math.max(...incidents.map((i) => i.severity)),
      reports: incidents.reduce((s, i) => s + (i.reportCount || 0), 0),
      unitsEnRoute: incidents.reduce((s, i) => s + (i.unitsEnRoute || 0), 0),
      unattended: incidents.filter((i) => !i.unitsEnRoute).length,
      center,
      radiusKm,
      since: Math.min(...incidents.map((i) => Date.parse(i.createdAt) || Date.now())),
    })
  }
  // Worst first; ties by how long it has been going on, so positions are stable.
  return zones.sort(
    (a, b) => b.severity - a.severity || b.incidents.length - a.incidents.length || a.since - b.since,
  )
}

/** What a zone screen draws: the zone's incidents and whatever is working them
 *  or is near enough to matter, not the whole city. */
export function zoneLayers(state: DemoState, z: Zone) {
  const ids = new Set(z.incidents.map((i) => i.id))
  const near = (loc: [number, number]) => km(z.center, loc) <= Math.max(2.5, z.radiusKm * 2)
  return {
    incidents: z.incidents,
    resources: state.resources.filter(
      (r) => (r.incidentId && ids.has(r.incidentId)) || near(r.location),
    ),
    facilities: state.facilities.filter((f) => near(f.location)),
    blocks: state.roadBlocks.filter((b) => near(b.location)),
    needs: state.needs.filter((n) => ids.has(n.incidentId)),
    routes: state.routes.filter((r) => ids.has(r.incidentId)),
    wards: state.wards.filter((w) => w.id === z.id),
  }
}

/** Zoom that fits a zone's spread on a ~400 px screen. */
export function zoomFor(z: Zone, big = false): number {
  const base = z.radiusKm < 0.8 ? 14.6 : z.radiusKm < 1.6 ? 13.8 : z.radiusKm < 3 ? 13 : 12.2
  return big ? base + 0.6 : base
}
