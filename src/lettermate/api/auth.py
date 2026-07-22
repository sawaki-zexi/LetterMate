"""Authentication dependencies with constant-time token checks."""

from __future__ import annotations

import hmac
from typing import Annotated

from fastapi import Cookie, Header, HTTPException, status

OWNER_SESSION_COOKIE = "lettermate_owner_session"


def require_owner(
    authorization: Annotated[str | None, Header()] = None,
    owner_session: Annotated[str | None, Cookie(alias=OWNER_SESSION_COOKIE)] = None,
    *,
    token: str,
) -> None:
    presented_token = owner_session
    if authorization is not None:
        scheme, _, bearer_token = authorization.partition(" ")
        if scheme.casefold() != "bearer" or not bearer_token:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="owner authentication required",
            )
        presented_token = bearer_token
    if presented_token is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="owner authentication required",
        )
    if not hmac.compare_digest(presented_token, token):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="invalid owner token")


def require_scheduler(
    scheduler_token: Annotated[str | None, Header(alias="X-Scheduler-Token")] = None,
    *,
    token: str,
) -> None:
    if scheduler_token is None or not hmac.compare_digest(scheduler_token, token):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="invalid scheduler token")
