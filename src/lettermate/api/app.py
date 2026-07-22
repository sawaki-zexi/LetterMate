"""FastAPI application factory."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from datetime import datetime
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from sqlalchemy.orm import Session, sessionmaker

from lettermate.api.routes import build_router
from lettermate.config import Settings, get_settings
from lettermate.dashboard.routes import build_dashboard_router
from lettermate.db.session import create_session_factory


def create_app(
    settings: Settings | None = None,
    *,
    session_factory: sessionmaker[Session] | None = None,
    stage_triggers: Mapping[str, Callable[[], None]] | None = None,
    next_scheduled_run: Callable[[], datetime | None] | None = None,
) -> FastAPI:
    app = FastAPI(title="LetterMate", version="0.1.0")
    resolved_settings = settings or get_settings()
    resolved_session_factory = session_factory or create_session_factory(resolved_settings)
    app.include_router(
        build_router(
            session_factory=resolved_session_factory,
            settings=resolved_settings,
            stage_triggers=stage_triggers,
        )
    )
    app.include_router(
        build_dashboard_router(
            session_factory=resolved_session_factory,
            settings=resolved_settings,
            next_scheduled_run=next_scheduled_run,
        )
    )
    app.mount(
        "/static",
        StaticFiles(directory=Path(__file__).parents[1] / "web" / "static"),
        name="static",
    )

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    return app
