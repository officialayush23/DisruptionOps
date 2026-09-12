"""Travel over the road graph, and the roads themselves.

Three jobs, in one place because they all need the same router:

  * **A matrix** of durations, for the allocator. Mapbox first, then OSRM, then
    great-circle distance at an urban event speed. Every fallback is *slower*
    than reality, so a degraded plan never promises an ETA it cannot meet.
  * **A route**, as the geometry of actual streets plus the turn instructions
    that name them. This is what a person can follow and what a unit drives
    along; a straight line between two dots is neither.
  * **Snapping a point to a road**, which is what makes a hazard a hazard. A
    flooded road has to be *on* a road, or nothing routes around it and the
    whole avoidance story is decoration.

The blockage handling is the part worth arguing about. No public router knows
which streets are under water tonight, so we cannot ask it to avoid them.
What we can do is ask for alternatives and choose the one that passes nearest to
none of the hazards people have reported, and when every alternative is exposed,
return the least exposed one *with a count* rather than a false promise.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Sequence

from app.core.config import settings
from app.core.logging import get_logger
from app.ingest.client import get_json

log = get_logger(__name__)

EARTH_RADIUS_KM = 6371.0
#: Effective speed during an active urban flood event.
EVENT_SPEED_KMH = 18.0
#: Extra minutes added when a route passes near a blocked point.
BLOCKED_DETOUR_MINUTES = 11.0
#: A route within this distance of a blockage is treated as affected.
BLOCK_RADIUS_KM = 0.35
#: Mapbox Matrix allows 25 coordinates per request on the standard profile.
MATRIX_LIMIT = 25


def haversine_km(a: tuple[float, float], b: tuple[float, float]) -> float:
    lon1, lat1 = math.radians(a[0]), math.radians(a[1])
    lon2, lat2 = math.radians(b[0]), math.radians(b[1])
    dlon, dlat = lon2 - lon1, lat2 - lat1
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 2 * EARTH_RADIUS_KM * math.asin(math.sqrt(h))


def _coords(pairs: Sequence[tuple[float, float]]) -> str:
    return ";".join(f"{lng:.5f},{lat:.5f}" for lng, lat in pairs)


def _data(result: Any) -> dict | None:
    """Unwrap `get_json`, which returns a FeedResult and not the payload.

    This was the bug behind "the navigation is a straight line": the route code
    treated the wrapper as the JSON, `.get("routes")` raised, the except arm
    caught it, and every route in the system quietly became the fallback. It had
    never once called a router successfully.
    """
    payload = getattr(result, "data", result)
    return payload if isinstance(payload, dict) else None


@dataclass(slots=True)
class TravelMatrix:
    """durations[i][j] = minutes from source i to destination j."""

    durations: list[list[float]]
    distances: list[list[float]]
    engine: str

    def eta(self, i: int, j: int) -> int:
        return max(4, round(self.durations[i][j]))


def _segment_is_blocked(
    a: tuple[float, float],
    b: tuple[float, float],
    blocked: Sequence[tuple[float, float]],
) -> bool:
    """Cheap proximity test: does the straight line a→b pass near a blockage?

    Sampling the segment is enough at city scale and avoids pulling in a full
    geometry engine on the hot path.
    """
    if not blocked:
        return False
    for t in (0.25, 0.5, 0.75):
        point = (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)
        for block in blocked:
            if haversine_km(point, block) <= BLOCK_RADIUS_KM:
                return True
    return False


def _fallback_matrix(
    sources: Sequence[tuple[float, float]],
    destinations: Sequence[tuple[float, float]],
    blocked: Sequence[tuple[float, float]],
) -> TravelMatrix:
    durations: list[list[float]] = []
    distances: list[list[float]] = []
    for s in sources:
        row_d: list[float] = []
        row_km: list[float] = []
        for d in destinations:
            km = haversine_km(s, d)
            # Straight-line distance understates road distance; 1.35 is the
            # usual detour factor for a dense Indian city grid.
            road_km = km * 1.35
            minutes = (road_km / EVENT_SPEED_KMH) * 60.0
            if _segment_is_blocked(s, d, blocked):
                minutes += BLOCKED_DETOUR_MINUTES
            row_d.append(minutes)
            row_km.append(round(road_km, 2))
        durations.append(row_d)
        distances.append(row_km)
    return TravelMatrix(durations, distances, engine="haversine-fallback")


def _apply_blocks(
    durations: list[list[float]],
    sources: Sequence[tuple[float, float]],
    destinations: Sequence[tuple[float, float]],
    blocked: Sequence[tuple[float, float]],
) -> None:
    for i, s in enumerate(sources):
        for j, d in enumerate(destinations):
            if _segment_is_blocked(s, d, blocked):
                durations[i][j] += BLOCKED_DETOUR_MINUTES


async def _mapbox_matrix(
    sources: Sequence[tuple[float, float]],
    destinations: Sequence[tuple[float, float]],
) -> TravelMatrix | None:
    if not settings.mapbox_token:
        return None
    if len(sources) + len(destinations) > MATRIX_LIMIT:
        return None
    n = len(sources)
    payload = _data(
        await get_json(
            f"{settings.mapbox_matrix_url}/driving/"
            f"{_coords(list(sources) + list(destinations))}",
            {
                "access_token": settings.mapbox_token,
                "sources": ";".join(str(i) for i in range(n)),
                "destinations": ";".join(str(n + j) for j in range(len(destinations))),
                "annotations": "duration,distance",
            },
            cache_key=f"mbx:matrix:{hash(_coords(list(sources) + list(destinations)))}",
        )
    )
    if not payload or payload.get("code") != "Ok":
        return None
    try:
        durations = [[(d or 0.0) / 60.0 for d in row] for row in payload["durations"]]
        distances = [
            [round((d or 0.0) / 1000.0, 2) for d in row]
            for row in payload.get("distances") or [[0.0] * len(destinations)] * n
        ]
    except (KeyError, TypeError):
        return None
    return TravelMatrix(durations, distances, engine="mapbox")


async def _osrm_matrix(
    sources: Sequence[tuple[float, float]],
    destinations: Sequence[tuple[float, float]],
) -> TravelMatrix | None:
    coord_str = _coords(list(sources) + list(destinations))
    n = len(sources)
    payload = _data(
        await get_json(
            f"{settings.osrm_url}/table/v1/driving/{coord_str}",
            {
                "sources": ";".join(str(i) for i in range(n)),
                "destinations": ";".join(str(n + j) for j in range(len(destinations))),
                "annotations": "duration,distance",
            },
            cache_key=f"osrm:table:{hash(coord_str)}",
        )
    )
    if not payload or payload.get("code") != "Ok":
        return None
    try:
        durations = [[(d or 0.0) / 60.0 for d in row] for row in payload["durations"]]
        distances = [
            [round((d or 0.0) / 1000.0, 2) for d in row]
            for row in payload.get("distances") or [[0.0] * len(destinations)] * n
        ]
    except (KeyError, TypeError):
        return None
    return TravelMatrix(durations, distances, engine="osrm")


async def travel_matrix(
    sources: Sequence[tuple[float, float]],
    destinations: Sequence[tuple[float, float]],
    blocked: Sequence[tuple[float, float]] = (),
) -> TravelMatrix:
    if not sources or not destinations:
        return TravelMatrix([], [], engine="empty")

    matrix = await _mapbox_matrix(sources, destinations)
    if matrix is None:
        matrix = await _osrm_matrix(sources, destinations)
    if matrix is None:
        return _fallback_matrix(sources, destinations, blocked)

    _apply_blocks(matrix.durations, sources, destinations, blocked)
    return matrix


# --------------------------------------------------------------- one route ---
@dataclass(slots=True)
class Step:
    """One turn, with the street it happens on."""

    instruction: str
    street: str
    distance_m: int


@dataclass(slots=True)
class RouteLine:
    """A path a person can actually follow, not a line between two dots."""

    coordinates: list[list[float]]
    km: float
    minutes: int
    engine: str
    #: Blocked points the returned path still passes close to. Zero is the goal;
    #: a non-zero number is reported rather than hidden, because the honest
    #: answer during a flood is sometimes "this is the least bad way".
    passes_near_blocks: int = 0
    #: Turn instructions naming real streets. Empty when the router was not
    #: reachable and the geometry is the fallback line.
    steps: list[Step] = field(default_factory=list)
    #: How many alternatives were compared to pick this one.
    considered: int = 1

    @property
    def is_real_road(self) -> bool:
        return self.engine in ("mapbox", "osrm")


def _exposure(coords: list[list[float]], blocked: Sequence[tuple[float, float]]) -> int:
    if not blocked:
        return 0
    return sum(
        1
        for c in coords[::3]  # every third vertex is enough to judge a route
        for b in blocked
        if haversine_km((float(c[0]), float(c[1])), b) < BLOCK_RADIUS_KM
    )


def _mapbox_steps(route: dict) -> list[Step]:
    out: list[Step] = []
    for leg in route.get("legs") or []:
        for s in leg.get("steps") or []:
            man = s.get("maneuver") or {}
            text = man.get("instruction") or ""
            name = s.get("name") or ""
            if not text:
                continue
            out.append(
                Step(
                    instruction=text,
                    street=name,
                    distance_m=int(round(float(s.get("distance") or 0.0))),
                )
            )
    return out[:12]


#: OSRM answers with a maneuver type and a modifier and leaves the sentence to
#: the client. Mapbox writes the sentence for you, which is why this did not
#: exist until now — and why, with no Mapbox token set, `route_steps` came back
#: empty on every guidance call, the phone found no steps to follow, and
#: turn-by-turn simply never appeared. The line was drawn on the map and nobody
#: was ever told to turn anywhere.
_TURNS = {
    "left": "Turn left", "right": "Turn right",
    "sharp left": "Take a sharp left", "sharp right": "Take a sharp right",
    "slight left": "Bear left", "slight right": "Bear right",
    "straight": "Carry straight on",
    "uturn": "Turn around",
}


def _osrm_steps(route: dict) -> list[Step]:
    """Turn OSRM's maneuvers into sentences somebody can follow while walking."""
    out: list[Step] = []
    for leg in route.get("legs") or []:
        for s in leg.get("steps") or []:
            man = s.get("maneuver") or {}
            kind = str(man.get("type") or "")
            modifier = str(man.get("modifier") or "")
            name = str(s.get("name") or "")
            distance = int(round(float(s.get("distance") or 0.0)))

            if kind == "depart":
                text = "Set off" + (f" along {name}" if name else "")
            elif kind == "arrive":
                text = "You have arrived"
            elif kind == "roundabout" or kind == "rotary":
                exit_no = man.get("exit")
                text = (
                    f"At the roundabout, take exit {exit_no}"
                    if exit_no else "Go around the roundabout"
                )
            elif kind in ("merge", "on ramp", "off ramp", "fork"):
                text = _TURNS.get(modifier, "Keep going")
                if kind == "fork":
                    text = text.replace("Turn", "Fork")
            else:
                text = _TURNS.get(modifier, "Continue")
            if name and kind not in ("depart", "arrive"):
                text = f"{text} onto {name}"

            out.append(Step(instruction=text, street=name, distance_m=distance))
    return out[:12]


def _pick(routes: list[dict], blocked: Sequence[tuple[float, float]]) -> tuple[dict, int]:
    """Least exposed first, then fastest. Exposure outranks speed on purpose."""
    scored: list[tuple[int, float, int, dict]] = []
    for n, r in enumerate(routes):
        coords = (r.get("geometry") or {}).get("coordinates") or []
        scored.append((_exposure(coords, blocked), float(r.get("duration") or 0.0), n, r))
    scored.sort(key=lambda t: (t[0], t[1], t[2]))
    return scored[0][3], scored[0][0]


async def route_line(
    origin: tuple[float, float],
    destination: tuple[float, float],
    blocked: Sequence[tuple[float, float]] = (),
) -> RouteLine:
    """Street geometry from A to B, chosen against the hazards people reported."""
    o = f"{origin[0]:.5f},{origin[1]:.5f}"
    d = f"{destination[0]:.5f},{destination[1]:.5f}"

    if settings.mapbox_token:
        payload = _data(
            await get_json(
                f"{settings.mapbox_directions_url}/driving/{o};{d}",
                {
                    "access_token": settings.mapbox_token,
                    "geometries": "geojson",
                    "overview": "full",
                    "alternatives": "true",
                    "steps": "true",
                    "language": "en",
                },
                cache_key=f"mbx:route:{o}:{d}",
            )
        )
        routes = (payload or {}).get("routes") or []
        if routes:
            best, exposure = _pick(routes, blocked)
            coords = (best.get("geometry") or {}).get("coordinates") or []
            return RouteLine(
                coordinates=[[float(c[0]), float(c[1])] for c in coords],
                km=round(float(best.get("distance") or 0.0) / 1000.0, 2),
                minutes=max(1, round(float(best.get("duration") or 0.0) / 60.0))
                + (BLOCKED_DETOUR_MINUTES if exposure else 0),
                engine="mapbox",
                passes_near_blocks=exposure,
                steps=_mapbox_steps(best),
                considered=len(routes),
            )

    payload = _data(
        await get_json(
            f"{settings.osrm_url}/route/v1/driving/{o};{d}",
            {"overview": "full", "geometries": "geojson", "alternatives": "true",
             # Asked for now. Without it OSRM returns geometry and no
             # instructions, and the citizen app has nothing to say after
             # "here is a line".
             "steps": "true"},
            cache_key=f"osrm:route:{o}:{d}",
        )
    )
    routes = (payload or {}).get("routes") or []
    if routes:
        best, exposure = _pick(routes, blocked)
        coords = (best.get("geometry") or {}).get("coordinates") or []
        return RouteLine(
            coordinates=[[float(c[0]), float(c[1])] for c in coords],
            km=round(float(best.get("distance") or 0.0) / 1000.0, 2),
            minutes=max(1, round(float(best.get("duration") or 0.0) / 60.0))
            + (BLOCKED_DETOUR_MINUTES if exposure else 0),
            engine="osrm",
            passes_near_blocks=exposure,
            steps=_osrm_steps(best),
            considered=len(routes),
        )

    km = haversine_km(origin, destination)
    detour = BLOCKED_DETOUR_MINUTES if _segment_is_blocked(origin, destination, blocked) else 0.0
    log.warning("route_fallback", origin=o, destination=d)
    return RouteLine(
        coordinates=[[origin[0], origin[1]], [destination[0], destination[1]]],
        km=round(km * 1.35, 2),
        minutes=max(1, round(km * 1.35 / EVENT_SPEED_KMH * 60 + detour)),
        engine="straight-line-fallback",
        passes_near_blocks=1 if detour else 0,
        # One honest step rather than none. With no steps at all the phone shows
        # no navigation whatsoever, which is a worse answer than a bearing and a
        # distance — and the instruction says plainly that no street was
        # consulted, so nobody mistakes it for a route.
        steps=[
            Step(
                instruction=(
                    f"Head {_bearing_word(origin, destination)} towards the "
                    "destination. No street router was reachable, so this is a "
                    "direction and a distance, not a route."
                ),
                street="",
                distance_m=int(round(km * 1.35 * 1000)),
            )
        ],
    )


def _bearing_word(a: tuple[float, float], b: tuple[float, float]) -> str:
    """Eight-point compass. Enough to start walking the right way."""
    import math

    dx = (b[0] - a[0]) * math.cos(math.radians((a[1] + b[1]) / 2))
    dy = b[1] - a[1]
    deg = (math.degrees(math.atan2(dx, dy)) + 360) % 360
    return ["north", "north-east", "east", "south-east",
            "south", "south-west", "west", "north-west"][int((deg + 22.5) % 360 // 45)]


# ---------------------------------------------------------------- snapping ---
@dataclass(slots=True)
class Snapped:
    lng: float
    lat: float
    street: str
    #: How far the original point had to move to reach a road, in metres.
    moved_m: int
    engine: str

    @property
    def on_road(self) -> bool:
        return self.engine != "none"


#: Snapping is a network call and a flood report lands roughly where the last
#: one did. Cached on a ~40 m grid, which is finer than the accuracy of a phone
#: GPS in a built-up street.
_snap_cache: dict[tuple[int, int], Snapped] = {}


def _grid(lng: float, lat: float) -> tuple[int, int]:
    return (round(lng * 2800), round(lat * 2800))


async def snap_to_road(lng: float, lat: float) -> Snapped:
    """Move a point onto the nearest routable road, and name that road.

    A hazard that sits in the middle of a block is not on anybody's way
    anywhere: no route passes near it, so no route is ever diverted by it, and
    the avoidance logic has nothing to bite on. Snapping first is what makes
    "flooded road" mean a road.

    Mapbox returns the snapped coordinate and the street name as
    `waypoints[0]`; a route is requested to a point a few hundred metres away
    because the Directions API needs two coordinates to answer at all.
    """
    key = _grid(lng, lat)
    hit = _snap_cache.get(key)
    if hit is not None:
        return hit

    result = Snapped(lng=lng, lat=lat, street="", moved_m=0, engine="none")
    if settings.mapbox_token:
        near = (lng + 0.0030, lat + 0.0030)
        payload = _data(
            await get_json(
                f"{settings.mapbox_directions_url}/driving/"
                f"{lng:.5f},{lat:.5f};{near[0]:.5f},{near[1]:.5f}",
                {
                    "access_token": settings.mapbox_token,
                    "geometries": "geojson",
                    "overview": "simplified",
                    "steps": "false",
                },
                cache_key=f"mbx:snap:{lng:.4f},{lat:.4f}",
            )
        )
        points = (payload or {}).get("waypoints") or []
        if points:
            loc = points[0].get("location") or []
            if len(loc) == 2:
                snapped = (float(loc[0]), float(loc[1]))
                result = Snapped(
                    lng=snapped[0],
                    lat=snapped[1],
                    street=(points[0].get("name") or "").strip(),
                    moved_m=int(round(haversine_km((lng, lat), snapped) * 1000)),
                    engine="mapbox",
                )

    _snap_cache[key] = result
    return result
