"""The citizen portal: what one resident needs, and nothing else."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends

from app.agents import llm
from app.core.errors import NotFound
from app.core.security import CurrentPrincipal
from app.db import session as db
from app.db.repositories import queries as q
from app.schemas.domain import (
    AskRequest,
    AskResponse,
    CitizenReport,
    CitizenSituation,
    HazardType,
    ReportCreate,
)

router = APIRouter(tags=["citizen"])

_SYSTEM = (
    "You are the guidance agent for Indradhanu, a municipal disaster response "
    "platform in Pune. Answer a resident in plain language, in at most three "
    "sentences. Use only the facts given to you. Never invent a shelter, a road, "
    "a time or a number. If the facts do not answer the question, say what you do "
    "know and stop."
)


def _fallback_answer(question: str, facts: dict) -> str:
    """Deterministic rules over the same facts the model would get.

    This runs whenever the provider is unavailable, and it is written to be a
    correct answer rather than an apology.
    """
    ward = facts.get("ward_name", "your area")
    risk = facts.get("score")
    shelter = facts.get("shelter_name")
    distance = facts.get("shelter_km")
    action = facts.get("action")
    by_time = facts.get("by_time")
    q_lower = question.lower()

    if risk is None:
        return (
            f"There is no active hazard for {ward} right now. You will be told the "
            "moment that changes; you do not need to keep checking."
        )
    if any(w in q_lower for w in ("safe", "should i", "leave", "evacuat", "go")):
        if action and shelter:
            return (
                f"{ward} is at {facts['severity_label']} risk. {action} The nearest open "
                f"shelter is {shelter}, {distance} km away. Leave before {by_time}."
            )
        return (
            f"{ward} is at {facts['severity_label']} risk with about "
            f"{facts['lead_time']} hours of lead time. You do not need to move yet — "
            "avoid low-lying roads and keep your phone charged."
        )
    if any(w in q_lower for w in ("why", "reason", "how bad")):
        drivers = ", ".join(
            f"{d['label']} ({round(d['contribution'] * 100)}%)"
            for d in facts.get("drivers", [])[:3]
        )
        return (
            f"Your risk score is {round(risk * 100)} out of 100. The main reasons are "
            f"{drivers}."
        )
    if "shelter" in q_lower or "where" in q_lower:
        if shelter:
            return f"Go to {shelter}. It is {distance} km away and currently has room."
        return "No shelter has been activated for your ward yet."
    return (
        f"{ward} is at {round(risk * 100)} out of 100 for flood risk with about "
        f"{facts['lead_time']} hours of lead time. "
        f"{action or 'No action is needed from you yet.'} "
        "Ask me why if you want the reasoning behind that score."
    )


@router.get("/situation/{ward_id}", response_model=CitizenSituation)
async def situation(ward_id: str) -> CitizenSituation:
    wards = {w.id: w for w in await q.list_wards()}
    ward = wards.get(ward_id)
    if ward is None:
        raise NotFound("No such ward.")

    run = await q.latest_run(HazardType.FLOOD)
    risk = None
    if run:
        risk = next(
            (r for r in await q.ward_risks(run["id"]) if r.ward_id == ward_id), None
        )

    alerts = await q.list_alerts(ward_id)
    alert = alerts[0] if alerts else None

    shelter = None
    route = None
    if alert:
        found = await q.nearest_shelter(ward.centroid[0], ward.centroid[1])
        if found:
            shelter, _km = found
            # A few intermediate points so the client draws a path rather than
            # a ruler. Replaced by an OSRM walking route in the next pass.
            a, b = ward.centroid, shelter.location
            route = [
                a,
                [a[0] + (b[0] - a[0]) * 0.35, a[1] + (b[1] - a[1]) * 0.10],
                [a[0] + (b[0] - a[0]) * 0.55, a[1] + (b[1] - a[1]) * 0.62],
                [a[0] + (b[0] - a[0]) * 0.86, a[1] + (b[1] - a[1]) * 0.74],
                b,
            ]

    return CitizenSituation(
        ward_id=ward_id,
        at_risk=bool(risk and risk.severity >= 3),
        risk=risk,
        alert=alert,
        route=route,
        shelter=shelter,
    )


@router.post("/reports", response_model=CitizenReport, status_code=201)
async def submit_report(
    body: ReportCreate, principal: CurrentPrincipal
) -> CitizenReport:
    """Anyone may file a report, signed in or not.

    Classification confidence is recorded as unset here; the vision model fills
    it in asynchronously. We do not fabricate a score at insert time.
    """
    row = await db.fetchrow(
        """
        insert into citizen_reports
          (ward_id, category, location, note, photo_path, classified_as,
           reporter_id, reporter_name)
        values ($1, $2,
                extensions.ST_SetSRID(extensions.ST_MakePoint($3, $4), 4326)::extensions.geography,
                $5, $6, $2, $7, $8)
        returning id::text, created_at
        """,
        body.ward_id,
        body.category.value,
        body.location[0],
        body.location[1],
        body.note,
        body.photo_url,
        principal.user_id,
        principal.full_name or "Anonymous",
    )
    return CitizenReport(
        id=row["id"],
        incident_id=None,
        ward_id=body.ward_id,
        category=body.category,
        location=body.location,
        note=body.note,
        photo_url=body.photo_url,
        created_at=row["created_at"],
        classified_as=body.category,
        classification_confidence=0.0,
        reporter_name=principal.full_name or "Anonymous",
    )


@router.post("/ask", response_model=AskResponse)
async def ask(body: AskRequest) -> AskResponse:
    state = await situation(body.ward_id)
    wards = {w.id: w for w in await q.list_wards()}
    ward = wards.get(body.ward_id)

    severity_labels = {1: "minimal", 2: "low", 3: "moderate", 4: "high", 5: "critical"}
    facts: dict = {
        "ward_name": ward.name if ward else "your area",
        "score": state.risk.score if state.risk else None,
        "severity_label": severity_labels.get(state.risk.severity, "unknown")
        if state.risk
        else None,
        "lead_time": state.risk.lead_time_hours if state.risk else None,
        "drivers": [d.model_dump() for d in state.risk.drivers] if state.risk else [],
        "action": state.alert.action if state.alert else None,
        "by_time": state.alert.by_time.astimezone().strftime("%H:%M")
        if state.alert
        else None,
        "shelter_name": state.shelter.name if state.shelter else None,
        "shelter_km": state.alert.safe_location.distance_km
        if state.alert and state.alert.safe_location
        else None,
    }

    completion = await llm.complete(
        _SYSTEM,
        f"Resident question: {body.question}\n\nFacts you may use:\n{facts}",
        fallback=_fallback_answer(body.question, facts),
    )
    return AskResponse(answer=completion.text, engine=completion.engine)
