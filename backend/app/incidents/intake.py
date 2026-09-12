"""Report intake.

One door. Everything that claims something is happening comes through here: a
resident on the citizen portal, a field operator on a phone, an agency feed, a
sensor or gauge, and the simulator.
They differ in one field, `source`, which feeds the trust score. Nothing else
downstream can tell them apart, and that is the property the whole simulation
design rests on: a report a human types during a running simulation is processed
by this exact function and can therefore change the outcome.

The order matters and is not arbitrary:

    isolate text -> trust -> cluster -> incident -> needs -> events

Text is isolated before anything reads it, because report text is untrusted
input that later reaches a language model. Trust is scored before clustering so
a burst of fabricated reports cannot manufacture its own corroboration. Needs
are computed from the incident, not the report, because four reports of one
flooded road need one pump between them.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any

from app.core.logging import get_logger
from app.db import session as db
from app.incidents import clustering, trust
from app.taxonomy import cache as taxonomy
from app.world import events as ev
from app.world.clock import WALL, Clock

log = get_logger(__name__)


# --------------------------------------------------------- input isolation ---
#: Phrases that are trying to talk to the agent rather than describe the world.
#: This is not a content filter and does not reject the report; it flags it and
#: feeds the anomaly component. The real defence is structural: the agent is
#: handed a typed Evidence object and told the quoted text is data.
_INJECTION = re.compile(
    r"(ignore\s+(all\s+)?previous|disregard\s+(the\s+)?above|system\s*prompt|"
    r"you\s+are\s+now|act\s+as\s+|new\s+instructions?|send\s+(all|every)\s+"
    r"(ambulance|unit|boat|resource)|</?(system|assistant|user)>)",
    re.I,
)


@dataclass(slots=True)
class Evidence:
    """What an agent is allowed to see of a report.

    The free text survives as `quoted_text` and is never spliced into a prompt
    as though it were an instruction. Everything an agent acts on is a typed
    field beside it.
    """

    category: str
    ward_id: str
    location: tuple[float, float]
    quoted_text: str
    has_photo: bool
    source: str
    injection_suspected: bool


def isolate(note: str, *, category: str, ward_id: str, location: tuple[float, float],
            has_photo: bool, source: str) -> Evidence:
    suspicious = bool(_INJECTION.search(note or ""))
    if suspicious:
        log.warning("report_injection_suspected", ward_id=ward_id, source=source)
    return Evidence(
        category=category,
        ward_id=ward_id,
        location=location,
        quoted_text=(note or "")[:2000],
        has_photo=has_photo,
        source=source,
        injection_suspected=suspicious,
    )


# ------------------------------------------------------------------ result ---
@dataclass(slots=True)
class IntakeResult:
    report_id: str
    incident_id: str | None
    created_incident: bool
    linked: bool
    trust: trust.Trust
    link_score: float
    link_rationale: str
    decided_by: str
    injection_suspected: bool
    event_id: int

    @property
    def summary(self) -> str:
        if self.created_incident:
            return f"Opened a new incident. {trust.explain(self.trust)}"
        if self.linked:
            return (
                f"Merged into an existing incident at {self.link_score:.2f} "
                f"({self.decided_by}). {trust.explain(self.trust)}"
            )
        return f"Held without an incident. {trust.explain(self.trust)}"


# ----------------------------------------------------------------- helpers ---
async def _trust_inputs(
    *,
    conn: Any,
    source: str,
    reporter_id: str | None,
    device_id: str | None,
    ward_id: str,
    category: str,
    lng: float,
    lat: float,
    note: str,
    has_photo: bool,
    now: datetime,
    corroborations: int,
) -> trust.TrustInputs:
    reliability = None
    if reporter_id:
        reliability = await conn.fetchval(
            "select reliability from reporter_reliability where reporter_id = $1::uuid",
            reporter_id,
        )

    risk = await conn.fetchval(
        """
        select wr.score
          from ward_risks wr
          join hazard_runs hr on hr.id = wr.run_id
         where wr.ward_id = $1
         order by hr.started_at desc
         limit 1
        """,
        ward_id,
    )

    # Category plausibility: does this category belong to a hazard that anything
    # has actually scored recently? An unknown category is treated as plausible
    # rather than penalised, because a new category is a configuration change,
    # not a lie.
    ref = taxonomy.categories.get(category)
    plausible = True
    if ref and ref.hazard_id and risk is not None:
        active = await conn.fetchval(
            """
            select hazard from hazard_runs
             where started_at > $1::timestamptz - interval '12 hours'
             order by started_at desc limit 1
            """,
            now,
        )
        plausible = active is None or active == ref.hazard_id

    recent = 0
    near_dupe = 0
    speed = None
    if device_id or reporter_id:
        recent = await conn.fetchval(
            """
            select count(*) from citizen_reports
             where created_at > $1::timestamptz - interval '15 minutes'
               and (($2::text is not null and device_id = $2)
                 or ($3::uuid is not null and reporter_id = $3::uuid))
            """,
            now, device_id, reporter_id,
        ) or 0
        if note.strip():
            near_dupe = await conn.fetchval(
                """
                select count(*) from citizen_reports
                 where created_at > $1::timestamptz - interval '60 minutes'
                   and (($2::text is not null and device_id = $2)
                     or ($3::uuid is not null and reporter_id = $3::uuid))
                   and lower(btrim(note)) = lower(btrim($4))
                """,
                now, device_id, reporter_id, note,
            ) or 0
        prev = await conn.fetchrow(
            """
            select extensions.ST_Distance(
                     location,
                     extensions.ST_SetSRID(extensions.ST_MakePoint($4,$5),4326)::extensions.geography
                   ) / 1000.0 as km,
                   extract(epoch from ($1::timestamptz - created_at)) / 3600.0 as hours
              from citizen_reports
             where (($2::text is not null and device_id = $2)
                 or ($3::uuid is not null and reporter_id = $3::uuid))
               and created_at < $1::timestamptz
             order by created_at desc limit 1
            """,
            now, device_id, reporter_id, lng, lat,
        )
        if prev and prev["hours"] and float(prev["hours"]) > 0:
            hours = float(prev["hours"])
            if hours < 1.0:  # only meaningful over a short gap
                speed = float(prev["km"]) / hours

    return trust.TrustInputs(
        source=source,
        reporter_id=reporter_id,
        reporter_reliability=float(reliability) if reliability is not None else None,
        ward_risk=float(risk) if risk is not None else None,
        category_plausible=plausible,
        corroborations=corroborations,
        has_photo=has_photo,
        recent_from_source=int(recent),
        near_duplicate_text=int(near_dupe),
        implied_speed_kmh=speed,
    )


def _title(category: str, ward_name: str) -> str:
    ref = taxonomy.categories.get(category)
    label = ref.display_name if ref else category.replace("_", " ").capitalize()
    return f"{label} — {ward_name}"


async def _recompute_incident(conn: Any, incident_id: str, clock: Clock) -> dict:
    """Report count, confidence and severity, from the reports themselves.

    Confidence is the aggregate trust of the reports that support the incident,
    lifted by independent corroboration. Severity starts from the category's
    base and rises with corroboration and the worst individual report, capped at
    5. None of it comes from a model.
    """
    row = await conn.fetchrow(
        """
        select count(*)::int                         as n,
               count(distinct coalesce(r.reporter_id::text, r.device_id, r.id::text))::int as independent,
               avg(coalesce(r.trust_score, 0.5))     as avg_trust,
               max(coalesce(r.trust_score, 0.5))     as max_trust,
               min(r.created_at)                     as first_at
          from citizen_reports r
         where r.incident_id = $1::uuid
           and r.verification_status <> 'rejected'
        """,
        incident_id,
    )
    n = row["n"] or 0
    independent = row["independent"] or 0
    avg_trust = float(row["avg_trust"] or 0.5)

    corroboration_lift = 1.0 - 1.0 / (1.0 + 0.8 * max(0, independent - 1))
    confidence = min(0.99, avg_trust + (1.0 - avg_trust) * corroboration_lift)

    cat = await conn.fetchval("select category from incidents where id = $1::uuid", incident_id)
    ref = taxonomy.categories.get(cat)
    base = ref.base_severity if ref else 3
    severity = min(5, base + (1 if independent >= 3 else 0) + (1 if independent >= 6 else 0))

    await conn.execute(
        """
        update incidents
           set report_count = $2,
               confidence   = $3,
               severity     = $4,
               trust_score  = $5,
               first_reported_at = coalesce(first_reported_at, $6),
               updated_at   = $7
         where id = $1::uuid
        """,
        incident_id, n, round(confidence, 4), severity, round(avg_trust, 4),
        row["first_at"], clock.now(),
    )
    return {"report_count": n, "independent": independent,
            "confidence": round(confidence, 4), "severity": severity}


async def _write_needs(conn: Any, incident_id: str, category: str, clock: Clock) -> dict[str, int]:
    """What this incident requires, from the category's capability needs.

    Requirements are per incident, not per report. Four people reporting one
    flooded road need one pump between them, and that is the entire reason
    clustering has to happen before this does.
    """
    ref = taxonomy.categories.get(category)
    needs = dict(ref.needs) if ref else {}
    if not needs:
        return {}
    await conn.executemany(
        """
        insert into incident_needs (incident_id, capability_id, required, updated_at)
        values ($1::uuid, $2, $3, $4)
        on conflict (incident_id, capability_id)
        do update set required = excluded.required, updated_at = excluded.updated_at
        """,
        [(incident_id, cap, qty, clock.now()) for cap, qty in needs.items()],
    )
    return needs


# -------------------------------------------------------------- the intake ---
async def receive(
    *,
    ward_id: str,
    category: str,
    location: tuple[float, float],
    note: str = "",
    photo_url: str | None = None,
    source: str = "app",
    reporter_id: str | None = None,
    reporter_name: str = "Anonymous",
    device_id: str | None = None,
    occurred_at: datetime | None = None,
    city_id: str = "pune",
    clock: Clock = WALL,
) -> IntakeResult:
    """Take one report all the way to an incident, or decline to.

    Everything happens in one transaction, including the events, so a report
    that fails halfway leaves no incident claiming reports that were never
    written and no event describing something that did not happen.
    """
    lng, lat = location
    now = clock.now()
    occurred = occurred_at or now

    if category not in taxonomy.categories:
        from app.taxonomy import UnknownTaxonomyValue

        raise UnknownTaxonomyValue("incident category", category, list(taxonomy.categories))

    ev_obj = isolate(
        note, category=category, ward_id=ward_id, location=(lng, lat),
        has_photo=bool(photo_url), source=source,
    )

    async with db.transaction() as conn:
        ward_name = await conn.fetchval("select name from wards where id = $1", ward_id) or ward_id

        # Cluster first, so corroboration can be counted before trust is scored.
        candidates = await clustering.find_candidates(
            ward_id=ward_id, category=category, lng=lng, lat=lat, note=note,
            now=occurred, city_id=city_id, sim_run_id=clock.sim_run_id,
        )
        decision = clustering.decide(candidates)

        corroborations = 0
        if decision.candidate is not None:
            # Independent means a different person or device. Counting a
            # reporter's own repeated reports as corroboration is precisely the
            # hole a report flood walks through.
            corroborations = await conn.fetchval(
                """
                select count(distinct coalesce(reporter_id::text, device_id, id::text))
                  from citizen_reports
                 where incident_id = $1::uuid
                   and coalesce(reporter_id::text, '') is distinct from coalesce($2::text, '')
                   and coalesce(device_id, '') is distinct from coalesce($3::text, '')
                """,
                decision.candidate.incident_id, reporter_id, device_id,
            ) or 0

        t_inputs = await _trust_inputs(
            conn=conn, source=source, reporter_id=reporter_id, device_id=device_id,
            ward_id=ward_id, category=category, lng=lng, lat=lat, note=note,
            has_photo=bool(photo_url), now=occurred, corroborations=int(corroborations),
        )
        if ev_obj.injection_suspected:
            t_inputs.near_duplicate_text += 1  # feeds the anomaly component

        cat_ref = taxonomy.categories.get(category)
        t = trust.score(t_inputs, life_safety=bool(cat_ref and cat_ref.life_safety))
        if ev_obj.injection_suspected:
            t.reasons.append(
                "The report text contains instruction-like phrasing. It is "
                "treated as data and flagged, never executed."
            )

        report_row = await conn.fetchrow(
            """
            insert into citizen_reports
              (ward_id, city_id, category, location, note, photo_path, classified_as,
               reporter_id, reporter_name, source, device_id, occurred_at,
               trust_score, trust_breakdown, verification_status, classification_confidence,
               sim_run_id, created_at)
            values ($1,$2,$3,
                    extensions.ST_SetSRID(extensions.ST_MakePoint($4,$5),4326)::extensions.geography,
                    $6,$7,$3,$8::uuid,$9,$10,$11,$12,$13,$14,$15,$16,$17::uuid,$18)
            returning id::text, created_at
            """,
            ward_id, city_id, category, lng, lat, note, photo_url,
            reporter_id, reporter_name, source, device_id, occurred,
            t.score, {"components": t.components, "reasons": t.reasons},
            t.status, t.score, clock.sim_run_id, now,
        )
        report_id = report_row["id"]

        received = await ev.append(
            clock=clock, kind=ev.Kind.REPORT_RECEIVED, actor=ev.citizen(reporter_id),
            subject_type="report", subject_id=report_id, city_id=city_id, ward_id=ward_id,
            payload={
                "source": source, "category": category, "trust": t.score,
                "verification": t.status,
                "injection_suspected": ev_obj.injection_suspected,
                "occurred_at": occurred.isoformat(),
            },
            conn=conn,
        )

        # A quarantined report is recorded and visible, but does not get to open
        # an incident or join one. It has not been called false; it has been
        # stopped from spending a vehicle.
        if t.status == "quarantined":
            await ev.append(
                clock=clock, kind=ev.Kind.REPORT_REJECTED, actor=ev.agent("triage"),
                subject_type="report", subject_id=report_id, city_id=city_id, ward_id=ward_id,
                payload={"trust": t.score, "reasons": t.reasons},
                caused_by=received.id, conn=conn,
            )
            return IntakeResult(
                report_id=report_id, incident_id=None, created_incident=False, linked=False,
                trust=t, link_score=0.0, link_rationale="Held before clustering.",
                decided_by="auto", injection_suspected=ev_obj.injection_suspected,
                event_id=received.id,
            )

        decided_by = "auto"
        rationale = decision.rationale
        target: str | None = None
        link_score = decision.candidate.score if decision.candidate else 0.0

        if decision.action == "adjudicate" and decision.candidate is not None:
            same, answer = await clustering.adjudicate(note, category, decision.candidate)
            decided_by = "llm"
            rationale = f"{decision.rationale} Model: {answer}"
            target = decision.candidate.incident_id if same else None
        elif decision.action == "link" and decision.candidate is not None:
            target = decision.candidate.incident_id

        created = False
        if target is None:
            hazard = (cat_ref.hazard_id if cat_ref and cat_ref.hazard_id else "flood")
            inc = await conn.fetchrow(
                """
                insert into incidents
                  (title, category, hazard, ward_id, city_id, location, severity,
                   status, report_count, confidence, trust_score, first_reported_at,
                   sim_run_id, created_at, updated_at)
                values ($1,$2,$3,$4,$5,
                        extensions.ST_SetSRID(extensions.ST_MakePoint($6,$7),4326)::extensions.geography,
                        $8,'reported',1,$9,$9,$10,$11::uuid,$12,$12)
                returning id::text
                """,
                _title(category, ward_name), category, hazard, ward_id, city_id,
                lng, lat, (cat_ref.base_severity if cat_ref else 3), t.score,
                occurred, clock.sim_run_id, now,
            )
            target = inc["id"]
            created = True

        await conn.execute(
            "update citizen_reports set incident_id = $2::uuid where id = $1::uuid",
            report_id, target,
        )
        await conn.execute(
            """
            insert into report_links
              (report_id, incident_id, link_score, components, decided_by, rationale, created_at)
            values ($1::uuid,$2::uuid,$3,$4,$5,$6,$7)
            on conflict (report_id, incident_id) do nothing
            """,
            report_id, target, link_score,
            decision.candidate.components if decision.candidate else {},
            decided_by, rationale, now,
        )

        stats = await _recompute_incident(conn, target, clock)
        needs = await _write_needs(conn, target, category, clock)

        if created:
            await ev.append(
                clock=clock, kind=ev.Kind.INCIDENT_OPENED, actor=ev.agent("triage"),
                subject_type="incident", subject_id=target, city_id=city_id, ward_id=ward_id,
                payload={"category": category, "severity": stats["severity"],
                         "needs": needs, "rationale": rationale},
                caused_by=received.id, conn=conn,
            )
        else:
            await ev.append(
                clock=clock, kind=ev.Kind.REPORT_LINKED, actor=ev.agent("triage"),
                subject_type="incident", subject_id=target, city_id=city_id, ward_id=ward_id,
                payload={
                    "report_id": report_id, "link_score": link_score,
                    "decided_by": decided_by, "rationale": rationale,
                    "report_count": stats["report_count"],
                    "independent_reporters": stats["independent"],
                    "confidence": stats["confidence"],
                    # This is the number the console shows as "merged, not
                    # dispatched twice".
                    "duplicates_absorbed": stats["report_count"] - 1,
                },
                caused_by=received.id, conn=conn,
            )

        return IntakeResult(
            report_id=report_id, incident_id=target, created_incident=created,
            linked=not created, trust=t, link_score=link_score, link_rationale=rationale,
            decided_by=decided_by, injection_suspected=ev_obj.injection_suspected,
            event_id=received.id,
        )
