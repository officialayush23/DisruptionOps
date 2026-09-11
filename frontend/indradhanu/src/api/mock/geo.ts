import type { LngLat, Lifeline, Shelter, Ward } from "@/api/types"

/** Build a slightly irregular polygon around a centroid, so wards read as
 *  real administrative shapes rather than perfect circles. Deterministic:
 *  the same ward id always produces the same outline. */
function ring(center: LngLat, radiusKm: number, seed: number): LngLat[] {
  const pts: LngLat[] = []
  const n = 9
  const kmPerDegLat = 110.57
  const kmPerDegLng = 105.6 // at ~18.5N
  let s = seed
  const rand = () => {
    s = (s * 9301 + 49297) % 233280
    return s / 233280
  }
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2
    const r = radiusKm * (0.78 + rand() * 0.44)
    pts.push([
      center[0] + (Math.cos(a) * r) / kmPerDegLng,
      center[1] + (Math.sin(a) * r) / kmPerDegLat,
    ])
  }
  pts.push(pts[0])
  return pts
}

interface WardSeed {
  number: string
  name: string
  c: LngLat
  pop: number
  elderly: number
  elev: number
  area: number
}

/* Ward names and approximate centroids follow real Pune localities. Boundaries
   are simplified stand-ins for the PMC ward shapefile, which is loaded from
   PostGIS in the production build. */
const SEEDS: WardSeed[] = [
  {
    number: "12",
    name: "Kasba–Somwar Peth",
    c: [73.8567, 18.5196],
    pop: 62400,
    elderly: 0.16,
    elev: 553,
    area: 2.1,
  },
  {
    number: "15",
    name: "Vitthalwadi–Ekta Nagar",
    c: [73.8331, 18.4762],
    pop: 48900,
    elderly: 0.11,
    elev: 548,
    area: 2.6,
  },
  {
    number: "18",
    name: "Sinhagad Road",
    c: [73.8262, 18.4703],
    pop: 71200,
    elderly: 0.09,
    elev: 559,
    area: 4.2,
  },
  {
    number: "21",
    name: "Karve Nagar",
    c: [73.8155, 18.4921],
    pop: 58300,
    elderly: 0.12,
    elev: 567,
    area: 3.1,
  },
  {
    number: "23",
    name: "Kothrud",
    c: [73.8074, 18.5074],
    pop: 94100,
    elderly: 0.14,
    elev: 574,
    area: 5.0,
  },
  {
    number: "27",
    name: "Warje–Malwadi",
    c: [73.7998, 18.4783],
    pop: 52700,
    elderly: 0.1,
    elev: 588,
    area: 3.7,
  },
  {
    number: "31",
    name: "Shivajinagar",
    c: [73.8492, 18.5305],
    pop: 66800,
    elderly: 0.15,
    elev: 560,
    area: 2.8,
  },
  {
    number: "34",
    name: "Deccan Gymkhana",
    c: [73.8412, 18.5163],
    pop: 41200,
    elderly: 0.18,
    elev: 556,
    area: 1.9,
  },
  {
    number: "39",
    name: "Yerwada",
    c: [73.8843, 18.5524],
    pop: 88600,
    elderly: 0.08,
    elev: 545,
    area: 5.6,
  },
  {
    number: "42",
    name: "Kalyani Nagar",
    c: [73.9002, 18.5478],
    pop: 39400,
    elderly: 0.11,
    elev: 542,
    area: 2.4,
  },
  {
    number: "47",
    name: "Hadapsar",
    c: [73.9301, 18.4998],
    pop: 102300,
    elderly: 0.07,
    elev: 561,
    area: 7.1,
  },
  {
    number: "51",
    name: "Kondhwa Khurd",
    c: [73.8884, 18.4631],
    pop: 76500,
    elderly: 0.09,
    elev: 592,
    area: 4.8,
  },
  {
    number: "55",
    name: "Katraj",
    c: [73.8578, 18.4482],
    pop: 64900,
    elderly: 0.08,
    elev: 620,
    area: 5.3,
  },
  {
    number: "58",
    name: "Aundh",
    c: [73.8071, 18.5583],
    pop: 47800,
    elderly: 0.13,
    elev: 570,
    area: 3.3,
  },
]

export const WARDS: Ward[] = SEEDS.map((s, i) => ({
  id: `w-${s.number}`,
  number: s.number,
  name: s.name,
  centroid: s.c,
  boundary: ring(s.c, Math.sqrt(s.area) * 0.62, 1000 + i * 137),
  population: s.pop,
  elderlyShare: s.elderly,
  elevationM: s.elev,
  areaSqKm: s.area,
}))

export const wardById = (id: string) => WARDS.find((w) => w.id === id)
export const wardName = (id: string) => wardById(id)?.name ?? id

/** Offset a point by metres, for placing lifelines inside a ward. */
function near(c: LngLat, dxKm: number, dyKm: number): LngLat {
  return [c[0] + dxKm / 105.6, c[1] + dyKm / 110.57]
}

interface LifeSeed {
  kind: Lifeline["kind"]
  name: string
  ward: string
  dx: number
  dy: number
  capacity?: number
}

const LIFE_SEEDS: LifeSeed[] = [
  {
    kind: "hospital",
    name: "Sassoon General Hospital",
    ward: "w-12",
    dx: 0.3,
    dy: 0.4,
  },
  {
    kind: "hospital",
    name: "Deenanath Mangeshkar Hospital",
    ward: "w-21",
    dx: -0.4,
    dy: 0.2,
  },
  {
    kind: "hospital",
    name: "Ruby Hall Clinic",
    ward: "w-31",
    dx: 0.5,
    dy: -0.3,
  },
  { kind: "hospital", name: "Noble Hospital", ward: "w-47", dx: -0.6, dy: 0.5 },
  {
    kind: "school",
    name: "Vitthalwadi Municipal School",
    ward: "w-15",
    dx: 0.2,
    dy: -0.3,
  },
  {
    kind: "school",
    name: "Sinhagad Road Primary School",
    ward: "w-18",
    dx: -0.5,
    dy: 0.6,
  },
  { kind: "school", name: "Kothrud Vidyalaya", ward: "w-23", dx: 0.7, dy: 0.1 },
  {
    kind: "school",
    name: "Yerwada Zilla Parishad School",
    ward: "w-39",
    dx: -0.3,
    dy: -0.6,
  },
  {
    kind: "school",
    name: "Hadapsar English Medium School",
    ward: "w-47",
    dx: 0.9,
    dy: -0.4,
  },
  {
    kind: "pump_station",
    name: "Vitthalwadi Storm Pump",
    ward: "w-15",
    dx: -0.3,
    dy: 0.2,
  },
  {
    kind: "pump_station",
    name: "Mutha Right Bank Pump",
    ward: "w-18",
    dx: 0.4,
    dy: -0.5,
  },
  {
    kind: "substation",
    name: "Kalyani Nagar 33kV",
    ward: "w-42",
    dx: 0.2,
    dy: 0.3,
  },
  { kind: "substation", name: "Warje 22kV", ward: "w-27", dx: -0.4, dy: -0.2 },
  {
    kind: "shelter",
    name: "Kothrud Community Hall",
    ward: "w-23",
    dx: -0.6,
    dy: -0.4,
    capacity: 450,
  },
  {
    kind: "shelter",
    name: "Karve Nagar Samaj Mandir",
    ward: "w-21",
    dx: 0.5,
    dy: -0.5,
    capacity: 300,
  },
  {
    kind: "shelter",
    name: "Sinhagad Road Municipal Hall",
    ward: "w-18",
    dx: 0.8,
    dy: 0.3,
    capacity: 520,
  },
  {
    kind: "shelter",
    name: "Shivajinagar Ward Office Hall",
    ward: "w-31",
    dx: -0.4,
    dy: 0.5,
    capacity: 280,
  },
  {
    kind: "shelter",
    name: "Hadapsar Sports Complex",
    ward: "w-47",
    dx: 0.3,
    dy: 0.8,
    capacity: 700,
  },
  {
    kind: "shelter",
    name: "Yerwada Municipal School Hall",
    ward: "w-39",
    dx: 0.6,
    dy: 0.4,
    capacity: 380,
  },
  {
    kind: "shelter",
    name: "Katraj Zilla Parishad Hall",
    ward: "w-55",
    dx: -0.2,
    dy: 0.6,
    capacity: 260,
  },
]

export const LIFELINES: Lifeline[] = LIFE_SEEDS.map((l, i) => {
  const w = wardById(l.ward)!
  return {
    id: `lf-${i + 1}`,
    kind: l.kind,
    name: l.name,
    wardId: l.ward,
    location: near(w.centroid, l.dx, l.dy),
    capacity: l.capacity,
  }
})

export const SHELTERS: Shelter[] = LIFELINES.filter(
  (l): l is Lifeline & { capacity: number } =>
    l.kind === "shelter" && l.capacity != null
).map((l, i) => ({
  ...l,
  kind: "shelter" as const,
  capacity: l.capacity,
  occupancy: [0, 0, 34, 0, 12, 0, 0][i] ?? 0,
}))

export function distanceKm(a: LngLat, b: LngLat): number {
  const dx = (a[0] - b[0]) * 105.6
  const dy = (a[1] - b[1]) * 110.57
  return Math.sqrt(dx * dx + dy * dy)
}

/** Nearest shelter with spare capacity. */
export function nearestShelter(from: LngLat): Shelter {
  return [...SHELTERS]
    .filter((s) => s.occupancy < s.capacity)
    .sort(
      (a, b) => distanceKm(from, a.location) - distanceKm(from, b.location)
    )[0]
}

/** A plausible walking line to a shelter: a few intermediate points so the
 *  route renders as a path rather than a straight ruler. */
export function routeTo(from: LngLat, to: LngLat): LngLat[] {
  const mid1: LngLat = [
    from[0] + (to[0] - from[0]) * 0.35,
    from[1] + (to[1] - from[1]) * 0.1,
  ]
  const mid2: LngLat = [
    from[0] + (to[0] - from[0]) * 0.55,
    from[1] + (to[1] - from[1]) * 0.62,
  ]
  const mid3: LngLat = [
    from[0] + (to[0] - from[0]) * 0.86,
    from[1] + (to[1] - from[1]) * 0.74,
  ]
  return [from, mid1, mid2, mid3, to]
}
