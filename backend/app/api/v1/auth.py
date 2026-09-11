"""Who am I?

One endpoint, and it earns its place. The frontend gets a Supabase session from
`supabase-js`, but the session only carries what Supabase knows: a user id and
an email. It does not know whether this person is a ward officer, which ward
they hold delegation for, or which agency's field tasks they may see. That
lives in `profiles` and is resolved here, by the same code path that authorises
every other call.

So the client asks once after sign-in and renders the interface it is entitled
to, rather than guessing from the email address or trusting a claim the token
never made.
"""

from __future__ import annotations

from pydantic import Field

from fastapi import APIRouter

from app.core.security import STAFF, CurrentPrincipal, Role
from app.schemas.domain import Camel

router = APIRouter(tags=["auth"])


class Me(Camel):
    authenticated: bool
    user_id: str | None = None
    role: Role
    full_name: str = ""
    ward_id: str | None = None
    operator: str | None = None
    is_staff: bool = False
    can_escalate: bool = False
    #: Which of the three interfaces this person may open. The client uses it to
    #: decide what to route to; the server enforces it regardless.
    interfaces: list[str] = Field(default_factory=list)
    #: True when DEV_AUTH_ROLE granted this identity rather than a real token.
    development_identity: bool = False


def _interfaces(role: Role) -> list[str]:
    if role in STAFF:
        return ["admin", "field", "citizen"]
    if role is Role.FIELD_OPERATOR:
        return ["field", "citizen"]
    return ["citizen"]


@router.get("/auth/me", response_model=Me)
async def me(principal: CurrentPrincipal) -> Me:
    """Resolve the caller. Anonymous is a valid answer, not an error.

    A resident who has not signed in can still read the risk map and file a
    report, so this returns an anonymous citizen rather than a 401.
    """
    return Me(
        authenticated=principal.user_id is not None,
        user_id=principal.user_id,
        role=principal.role,
        full_name=principal.full_name,
        ward_id=principal.ward_id,
        operator=principal.operator,
        is_staff=principal.is_staff,
        can_escalate=principal.can_escalate,
        interfaces=_interfaces(principal.role),
        development_identity=principal.user_id is None and principal.role is not Role.CITIZEN,
    )
