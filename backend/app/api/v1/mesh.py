"""Mesh gateway API.

Three endpoints for a gateway (a phone with signal running the bitchat fork's
forwarder, or `scripts/mesh_bridge.py` on a laptop next to one), authenticated
by `X-Mesh-Gateway-Key` rather than a staff login because a gateway is a
device, not a person:

    POST /mesh/inbound       packets heard on the mesh
    GET  /mesh/outbox        what to broadcast next
    POST /mesh/outbox/ack    what was broadcast
    POST /mesh/civ-sync      a bitchat phone's whole "back online" bundle
    POST /mesh/gateway/heartbeat   "this phone is linked", every ~10 s

Plus `POST /ingest/sensor` for a camera node that has internet and can skip the
mesh, and `GET /mesh/status` for the console.

With `MESH_GATEWAY_KEY` unset every gateway endpoint answers 403. An open
endpoint that files reports into the trust pipeline is a side door, and 014
closed the last one of those.
"""

from __future__ import annotations

import hmac
import time

from fastapi import APIRouter, Header
from pydantic import Field

from app.core.config import settings
from app.core.errors import Forbidden
from app.core.security import StaffPrincipal
from app.mesh import envelope, service
from app.schemas.domain import Camel

router = APIRouter(tags=["mesh"])


def _gateway(key: str | None) -> None:
    if not settings.mesh_gateway_key:
        raise Forbidden("Mesh gateway is disabled: MESH_GATEWAY_KEY is not set.")
    if not key or not hmac.compare_digest(key, settings.mesh_gateway_key):
        raise Forbidden("Wrong or missing X-Mesh-Gateway-Key.")


class InboundIn(Camel):
    gateway_id: str = Field(min_length=1, max_length=80)
    packets: list[str] = Field(default_factory=list, max_length=100)
    city_id: str = "pune"


class AckIn(Camel):
    gateway_id: str = Field(min_length=1, max_length=80)
    ids: list[str] = Field(default_factory=list, max_length=200)


class SensorIn(Camel):
    """A camera node's detection, sent straight over HTTPS when it can."""

    node_id: str = Field(min_length=1, max_length=60)
    event_id: str = Field(min_length=1, max_length=60)
    kind: str
    confidence: float = Field(ge=0, le=1)
    lat: float
    lon: float
    frames: str | None = None
    vlm_agreed: bool = False
    caption: str | None = Field(default=None, max_length=300)
    occurred_at: int | None = None
    city_id: str = "pune"


@router.post("/mesh/inbound")
async def inbound(body: InboundIn,
                  x_mesh_gateway_key: str | None = Header(default=None)) -> dict:
    _gateway(x_mesh_gateway_key)
    results = await service.receive(body.packets, gateway_id=body.gateway_id,
                                    city_id=body.city_id)
    return {"results": results}


@router.get("/mesh/outbox")
async def outbox(gateway_id: str, limit: int = 20, city_id: str = "pune",
                 x_mesh_gateway_key: str | None = Header(default=None)) -> dict:
    _gateway(x_mesh_gateway_key)
    return {"messages": await service.pull(gateway_id=gateway_id,
                                           limit=max(1, min(limit, 50)),
                                           city_id=city_id)}


@router.post("/mesh/outbox/ack")
async def outbox_ack(body: AckIn,
                     x_mesh_gateway_key: str | None = Header(default=None)) -> dict:
    _gateway(x_mesh_gateway_key)
    return {"acked": await service.ack(body.ids)}


class CivBundleIn(Camel):
    """`bitchat.civ.sync/v1`, as the bitchat fork's SyncBundleBuilder writes it."""

    bundle_schema: str = "bitchat.civ.sync/v1"
    produced_at: int | None = None
    gateway_id: str = Field(default="bitchat", min_length=1, max_length=80)
    city_id: str = "pune"
    incidents: list[dict] = Field(default_factory=list, max_length=500)
    shelters: list[dict] = Field(default_factory=list, max_length=500)


@router.post("/mesh/civ-sync")
async def civ_sync(body: CivBundleIn,
                   x_mesh_gateway_key: str | None = Header(default=None)) -> dict:
    """A phone that carried mesh traffic into signal posts it all here. Each
    incident is turned into an R packet (or an S packet for a VLM camera brief
    with a known hazard class) and handled exactly like one heard on the mesh,
    so a report that arrives both ways is still one report."""
    _gateway(x_mesh_gateway_key)
    return await service.receive_civ_bundle(body.model_dump(), gateway_id=body.gateway_id,
                                            city_id=body.city_id)


class HeartbeatIn(Camel):
    """A gateway phone saying it is alive and linked, with what it can see."""

    gateway_id: str = Field(min_length=1, max_length=80)
    city_id: str = "pune"
    label: str | None = Field(default=None, max_length=80)
    lat: float | None = Field(default=None, ge=-90, le=90)
    lon: float | None = Field(default=None, ge=-180, le=180)
    peers: int | None = Field(default=None, ge=0, le=10_000)
    queued: int | None = Field(default=None, ge=0, le=100_000)
    battery: int | None = Field(default=None, ge=0, le=100)
    app_version: str | None = Field(default=None, max_length=40)
    listen: bool | None = None


@router.post("/mesh/gateway/heartbeat")
async def gateway_heartbeat(body: HeartbeatIn,
                            x_mesh_gateway_key: str | None = Header(default=None)) -> dict:
    """Marks the phone as a live gateway so the console's Mesh screen shows it
    even before it has carried a single packet. Also the phone's "Sync now"
    check: a 200 here proves the URL and the key are right."""
    _gateway(x_mesh_gateway_key)
    return await service.gateway_heartbeat(body.model_dump())


@router.post("/ingest/sensor")
async def ingest_sensor(body: SensorIn,
                        x_mesh_gateway_key: str | None = Header(default=None)) -> dict:
    """Same handling as an S packet off the mesh, so the two paths cannot
    disagree, and deduplicated with it by event id: a detection that arrives
    both over HTTPS and over the mesh is one report."""
    _gateway(x_mesh_gateway_key)
    text = envelope.encode(
        "S",
        {"id": body.event_id, "n": body.node_id, "k": body.kind,
         "c": round(body.confidence, 3), "la": body.lat, "lo": body.lon,
         "f": body.frames, "v": 1 if body.vlm_agreed else None,
         "x": body.caption, "t": body.occurred_at or int(time.time())},
        key=settings.mesh_hmac_key,
    )
    results = await service.receive([text], gateway_id=f"https:{body.node_id}",
                                    city_id=body.city_id)
    return results[0]


@router.get("/mesh/status")
async def mesh_status(_: StaffPrincipal, city_id: str = "pune") -> dict:
    return await service.status(city_id)
