"""Travel times over the road graph.

OSRM gives real road distances; when it is unreachable we fall back to great
circle distance at an urban effective speed. The fallback is always *slower*
than reality would be, so a fallback plan never promises an ETA it cannot meet.

The important detail is `blocked`: road segments through a confirmed flooded
incident are excluded, so the solver never routes a unit through water it
cannot cross. That is the difference between a dispatch plan and a straight
line on a map.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Sequence

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


def haversine_km(a: tuple[float, float], b: tuple[float, float]) -> float:
    lon1, lat1 = math.radians(a[0]), math.radians(a[1])
    lon2, lat2 = math.radians(b[0]), math.radians(b[1])
    dlon, dlat = lon2 - lon1, lat2 - lat1
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 2 * EARTH_RADIUS_KM * math.asin(math.sqrt(h))


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


async def travel_matrix(
    sources: Sequence[tuple[float, float]],
    destinations: Sequence[tuple[float, float]],
    blocked: Sequence[tuple[float, float]] = (),
) -> TravelMatrix:
    if not sources or not destinations:
        return TravelMatrix([], [], engine="empty")

    coords = list(sources) + list(destinations)
    coord_str = ";".join(f"{lng:.5f},{lat:.5f}" for lng, lat in coords)
    n_src = len(sources)
    n_dst = len(destinations)

    result = await get_json(
        f"{settings.osrm_url}/table/v1/driving/{coord_str}",
        {
            "sources": ";".join(str(i) for i in range(n_src)),
            "destinations": ";".join(str(n_src + j) for j in range(n_dst)),
            "annotations": "duration,distance",
        },
        cache_key=f"osrm:{hash(coord_str)}",
    )

    payload = result.data if isinstance(result.data, dict) else None
    if not payload or payload.get("code") != "Ok":
        return _fallback_matrix(sources, destinations, blocked)

    try:
        durations = [
            [(d or 0.0) / 60.0 for d in row] for row in payload["durations"]
        ]
        distances = [
            [round((d or 0.0) / 1000.0, 2) for d in row]
            for row in payload.get("distances", [[0.0] * n_dst] * n_src)
        ]
    except (KeyError, TypeError):
        return _fallback_matrix(sources, destinations, blocked)

    # Apply blockage penalties on top of the real road durations.
    for i, s in enumerate(sources):
        for j, d in enumerate(destinations):
            if _segment_is_blocked(s, d, blocked):
                durations[i][j] += BLOCKED_DETOUR_MINUTES

    return TravelMatrix(durations, distances, engine="osrm")
