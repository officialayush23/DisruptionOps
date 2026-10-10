"""The one district the final round is scoped to.

Pimpri-Chinchwad (PCMC) zone round PCCOE, Pune district. The envelope is the
same one migration 029 clips its wards to, so the road graph, the wards and the
simulator all describe exactly the same area.
"""
from __future__ import annotations

from pathlib import Path

NAME = "PCMC · Pawana corridor (Pune district)"
HAZARD = "flood"
#: west, south, east, north (WGS84)
BBOX = (73.715, 18.585, 73.845, 18.712)

#: River sample points for GloFAS discharge (lon, lat). GloFAS is ~5 km, so
#: these are a handful of cells along the Pawana and the Indrayani, not gauges.
RIVER_POINTS = {
    "pawana_ravet": (73.745, 18.645),
    "pawana_chinchwad": (73.778, 18.626),
    "pawana_kasarwadi": (73.818, 18.607),
    "indrayani_talawade": (73.790, 18.705),
}
#: ERA5 is 0.25° (~25 km): one point covers the district; two give a check.
WEATHER_POINTS = {
    "district": (73.78, 18.645),
    "maval_upstream": (73.60, 18.70),   # rain upstream on the Pawana catchment
}

REPO = Path(__file__).resolve().parents[2]
RAW = REPO / "data" / "raw"
PROCESSED = REPO / "data" / "processed"
SIM = REPO / "data" / "sim"
