"""Protected, explanation-first dashboard routes."""

from __future__ import annotations

from collections.abc import Callable
from datetime import datetime
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Cookie, Depends, Form, Header, HTTPException, Request, status
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.templating import Jinja2Templates
from sqlalchemy.orm import Session, sessionmaker

from lettermate.api.auth import OWNER_SESSION_COOKIE, require_owner
from lettermate.config import Settings
from lettermate.db.repository import Repository

_templates = Jinja2Templates(directory=Path(__file__).parent / "templates")


def build_dashboard_router(
    settings: Settings,
    session_factory: sessionmaker[Session],
    next_scheduled_run: Callable[[], datetime | None] | None = None,
) -> APIRouter:
    router = APIRouter(default_response_class=HTMLResponse)

    def owner(
        authorization: Annotated[str | None, Header()] = None,
        owner_session: Annotated[str | None, Cookie(alias=OWNER_SESSION_COOKIE)] = None,
    ) -> None:
        require_owner(authorization, owner_session, token=settings.owner_api_token)

    def context(request: Request, template: str, **values: object) -> HTMLResponse:
        return _templates.TemplateResponse(request, template, {"settings": settings, **values})

    @router.get("/login")
    def login_page(request: Request) -> HTMLResponse:
        return context(request, "login.html")

    @router.post("/login")
    def login(token: Annotated[str, Form()]) -> RedirectResponse:
        require_owner(f"Bearer {token}", token=settings.owner_api_token)
        response = RedirectResponse(url="/", status_code=status.HTTP_303_SEE_OTHER)
        response.set_cookie(
            key=OWNER_SESSION_COOKIE,
            value=token,
            httponly=True,
            secure=settings.app_env.lower() not in {"development", "local", "test"},
            samesite="lax",
        )
        return response

    @router.get("/")
    def index(request: Request, _: None = Depends(owner)) -> HTMLResponse:
        with session_factory() as session:
            repository = Repository(session)
            return context(
                request,
                "index.html",
                sources=repository.list_sources(),
                recent_decisions=repository.list_recent_analyses(limit=5),
                newsletters=repository.list_newsletters()[:1],
                jobs=repository.list_job_runs(limit=5),
                latest_snapshot=repository.get_latest_preference_snapshot(),
                next_scheduled_run=(next_scheduled_run() if next_scheduled_run else None),
            )

    @router.get("/dashboard/sources")
    def sources(request: Request, _: None = Depends(owner)) -> HTMLResponse:
        with session_factory() as session:
            return context(request, "sources.html", sources=Repository(session).list_sources())

    @router.get("/dashboard/items/{item_id}")
    def item(request: Request, item_id: int, _: None = Depends(owner)) -> HTMLResponse:
        with session_factory() as session:
            repository = Repository(session)
            record = repository.get_content_item_by_id(item_id)
            if record is None:
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="item not found")
            traces = (
                repository.list_tool_call_traces(record.analysis.agent_run_id)
                if record.analysis
                else []
            )
            agent_run = record.analysis.agent_run if record.analysis else None
            return context(
                request,
                "item.html",
                item=record,
                analysis=record.analysis,
                agent_run=agent_run,
                preference_snapshot=agent_run.preference_snapshot if agent_run else None,
                traces=traces,
            )

    @router.get("/dashboard/jobs")
    def jobs(request: Request, _: None = Depends(owner)) -> HTMLResponse:
        with session_factory() as session:
            return context(request, "jobs.html", jobs=Repository(session).list_job_runs())

    @router.get("/dashboard/newsletters")
    def newsletters(request: Request, _: None = Depends(owner)) -> HTMLResponse:
        with session_factory() as session:
            return context(
                request,
                "newsletters.html",
                newsletters=Repository(session).list_newsletters(),
            )

    @router.get("/dashboard/preferences")
    def preferences(request: Request, _: None = Depends(owner)) -> HTMLResponse:
        with session_factory() as session:
            return context(
                request,
                "preferences.html",
                snapshots=Repository(session).list_preference_snapshots(),
            )

    @router.post("/dashboard/preferences/reset")
    def reset_preferences(_: None = Depends(owner)) -> RedirectResponse:
        with session_factory() as session:
            Repository(session).reset_preference_weights()
        return RedirectResponse(
            url="/dashboard/preferences",
            status_code=status.HTTP_303_SEE_OTHER,
        )

    return router
