"""Authentication.

Supabase issues the JWT; this service verifies it and resolves the caller's
role from `profiles`. The role is what the API authorises against, and it is
the same role the database policies check — so a bug in the API layer cannot
grant access the database would refuse.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from typing import Annotated

import jwt
from fastapi import Depends, Header

from app.core.config import settings
from app.core.errors import Forbidden, Unauthorised
from app.core.logging import get_logger
from app.db import session as db

log = get_logger(__name__)


class Role(StrEnum):
    CITIZEN = "citizen"
    FIELD_OPERATOR = "field_operator"
    WARD_OFFICER = "ward_officer"
    COMMISSIONER = "commissioner"
    ADMIN = "admin"


STAFF = {Role.WARD_OFFICER, Role.COMMISSIONER, Role.ADMIN}
ESCALATION = {Role.COMMISSIONER, Role.ADMIN}


@dataclass(frozen=True, slots=True)
class Principal:
    user_id: str | None
    role: Role
    ward_id: str | None = None
    operator: str | None = None
    full_name: str = ""

    @property
    def is_staff(self) -> bool:
        return self.role in STAFF

    @property
    def can_escalate(self) -> bool:
        return self.role in ESCALATION


ANONYMOUS = Principal(user_id=None, role=Role.CITIZEN)


def _decode(token: str) -> dict:
    try:
        return jwt.decode(
            token,
            settings.supabase_jwt_key,
            algorithms=["HS256"],
            audience="authenticated",
            options={"verify_exp": True},
        )
    except jwt.ExpiredSignatureError as exc:
        raise Unauthorised("Your session has expired. Sign in again.") from exc
    except jwt.InvalidTokenError as exc:
        raise Unauthorised("That token could not be verified.") from exc


async def _principal_from_token(token: str) -> Principal:
    claims = _decode(token)
    user_id = claims.get("sub")
    if not user_id:
        raise Unauthorised("Token carries no subject.")

    row = await db.fetchrow(
        "select role, ward_id, operator, full_name from profiles where id = $1",
        user_id,
    )
    if row is None:
        # Signed in, but the profile trigger has not caught up yet.
        return Principal(user_id=user_id, role=Role.CITIZEN)
    return Principal(
        user_id=user_id,
        role=Role(row["role"]),
        ward_id=row["ward_id"],
        operator=row["operator"],
        full_name=row["full_name"] or "",
    )


async def current_principal(
    authorization: Annotated[str | None, Header()] = None,
) -> Principal:
    """Resolves the caller. Anonymous is a valid outcome: a resident can read
    the risk map and file a report without an account."""
    if not authorization:
        return ANONYMOUS
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not token:
        raise Unauthorised("Expected an `Authorization: Bearer <token>` header.")
    return await _principal_from_token(token)


CurrentPrincipal = Annotated[Principal, Depends(current_principal)]


async def require_staff(principal: CurrentPrincipal) -> Principal:
    if not principal.is_staff:
        raise Forbidden("This view is restricted to municipal staff.")
    return principal


async def require_commissioner(principal: CurrentPrincipal) -> Principal:
    if not principal.can_escalate:
        raise Forbidden(
            "This action is reserved to the Municipal Commissioner or an officer "
            "authorised in writing for the event."
        )
    return principal


StaffPrincipal = Annotated[Principal, Depends(require_staff)]
CommissionerPrincipal = Annotated[Principal, Depends(require_commissioner)]
