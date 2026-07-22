"""Thin, protected HTTP routes. Domain work remains in services and repositories."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Cookie, Depends, Header, HTTPException, status
from fastapi.responses import HTMLResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session, sessionmaker

from lettermate.api.auth import OWNER_SESSION_COOKIE, require_owner, require_scheduler
from lettermate.config import Settings
from lettermate.db.repository import Repository
from lettermate.preferences.service import AppliedFeedback, PreferenceService
from lettermate.preferences.signing import FeedbackSigner


class FeedbackRequest(BaseModel):
    token: str


def build_router(
    settings: Settings,
    session_factory: sessionmaker[Session],
    stage_triggers: Mapping[str, Callable[[], None]] | None = None,
) -> APIRouter:
    router = APIRouter()
    available_stage_triggers = stage_triggers or {}

    def owner(
        authorization: Annotated[str | None, Header()] = None,
        owner_session: Annotated[str | None, Cookie(alias=OWNER_SESSION_COOKIE)] = None,
    ) -> None:
        require_owner(authorization, owner_session, token=settings.owner_api_token)

    def scheduler(
        scheduler_token: Annotated[
            str | None, Header(alias="X-Scheduler-Token")
        ] = None,
    ) -> None:
        require_scheduler(scheduler_token, token=settings.scheduler_token)

    def apply_feedback(token: str) -> AppliedFeedback:
        try:
            with session_factory() as session:
                return PreferenceService(
                    Repository(session),
                    signer=FeedbackSigner(settings.feedback_signing_secret),
                    action_weights=settings.feedback_action_weights,
                ).apply_signed_feedback(
                    token,
                    now=datetime.now(UTC),
                    action_source="email",
                )
        except (LookupError, RuntimeError, ValueError) as error:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="invalid feedback token",
            ) from error

    @router.get("/api/sources")
    def list_sources(_: None = Depends(owner)) -> list[dict[str, object]]:
        with session_factory() as session:
            return [
                {
                    "id": source.id,
                    "name": source.name,
                    "platform": source.platform,
                    "source_type": source.source_type,
                    "url": source.url,
                    "tags": source.tags,
                    "enabled": source.enabled,
                    "status": source.status,
                    "last_fetched_at": (
                        source.last_fetched_at.isoformat()
                        if source.last_fetched_at is not None
                        else None
                    ),
                }
                for source in Repository(session).list_sources()
            ]

    @router.post("/api/stages/{stage_name}", status_code=status.HTTP_202_ACCEPTED)
    def trigger_stage(stage_name: str, _: None = Depends(scheduler)) -> dict[str, str]:
        if stage_name not in {"sync", "collect", "analyze", "build", "send"}:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="unknown stage")
        trigger = available_stage_triggers.get(stage_name)
        if trigger is None:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="stage trigger unavailable",
            )
        try:
            trigger()
        except Exception as error:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="stage trigger failed",
            ) from error
        return {"stage": stage_name, "status": "accepted"}

    @router.get("/api/items")
    def list_items(_: None = Depends(owner)) -> list[dict[str, object]]:
        with session_factory() as session:
            return [_item_summary(item) for item in Repository(session).list_content_items()]

    @router.get("/api/items/{item_id}")
    def item_detail(item_id: int, _: None = Depends(owner)) -> dict[str, object]:
        with session_factory() as session:
            repository = Repository(session)
            item = repository.get_content_item_by_id(item_id)
            if item is None:
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="item not found")
            return _item_detail(item, repository)

    @router.get("/api/newsletters")
    def list_newsletters(_: None = Depends(owner)) -> list[dict[str, object]]:
        with session_factory() as session:
            return [
                {
                    "id": newsletter.id,
                    "issue_date": newsletter.issue_date.isoformat(),
                    "title": newsletter.title,
                    "status": newsletter.status,
                    "sent_at": newsletter.sent_at.isoformat() if newsletter.sent_at else None,
                    "item_count": len(newsletter.items),
                }
                for newsletter in Repository(session).list_newsletters()
            ]

    @router.get("/api/jobs")
    def list_jobs(_: None = Depends(owner)) -> list[dict[str, object]]:
        with session_factory() as session:
            return [
                {
                    "id": run.id,
                    "job_type": run.job_type,
                    "status": run.status,
                    "started_at": run.started_at.isoformat(),
                    "finished_at": run.finished_at.isoformat() if run.finished_at else None,
                }
                for run in Repository(session).list_job_runs()
            ]

    @router.get("/api/preferences")
    def list_preferences(_: None = Depends(owner)) -> list[dict[str, object]]:
        with session_factory() as session:
            return [
                {
                    "id": snapshot.id,
                    "version": snapshot.version,
                    "interests": snapshot.explicit_interests,
                    "exclusions": snapshot.exclusions,
                    "tag_weights": snapshot.tag_weights,
                    "source_weights": snapshot.source_weights,
                    "derivation_type": snapshot.derivation_type,
                    "created_at": snapshot.created_at.isoformat(),
                }
                for snapshot in Repository(session).list_preference_snapshots()
            ]

    @router.post("/api/preferences/reset")
    def reset_preferences(
        _: None = Depends(owner),
    ) -> dict[str, str | int | list[str] | dict[str, int]]:
        with session_factory() as session:
            snapshot = Repository(session).reset_preference_weights()
            return {
                "id": snapshot.id,
                "version": snapshot.version,
                "interests": snapshot.explicit_interests,
                "exclusions": snapshot.exclusions,
                "tag_weights": snapshot.tag_weights,
                "source_weights": snapshot.source_weights,
                "derivation_type": snapshot.derivation_type,
            }

    @router.post("/feedback")
    def feedback(payload: FeedbackRequest) -> dict[str, str | int | bool]:
        result = apply_feedback(payload.token)
        return {
            "status": "accepted",
            "created": result.created,
            "snapshot_id": result.snapshot_id,
        }

    @router.get("/feedback", response_class=HTMLResponse)
    def signed_email_feedback(token: str) -> HTMLResponse:
        result = apply_feedback(token)
        message = "Feedback recorded" if result.created else "Feedback already recorded"
        return HTMLResponse(f"<!doctype html><title>LetterMate</title><p>{message}</p>")

    return router


def _item_summary(item: object) -> dict[str, object]:
    from lettermate.db.models import ContentItem

    assert isinstance(item, ContentItem)
    return {
        "id": item.id,
        "title": item.title,
        "url": item.url,
        "status": item.status,
        "published_at": item.published_at.isoformat() if item.published_at else None,
        "decision": item.analysis.decision if item.analysis else None,
        "final_score": item.analysis.final_score if item.analysis else None,
    }


def _item_detail(item: object, repository: Repository) -> dict[str, object]:
    from lettermate.db.models import ContentItem

    assert isinstance(item, ContentItem)
    analysis = item.analysis
    if analysis is None:
        return _item_summary(item)
    run = analysis.agent_run
    return {
        **_item_summary(item),
        "summary": analysis.summary,
        "tags": analysis.tags,
        "reason": analysis.reason,
        "confidence": (
            (run.semantic_output or {}).get("confidence") if run.semantic_output else None
        ),
        "evidence_references": (run.semantic_output or {}).get("evidence_references", []),
        "score_components": {
            "semantic_score": analysis.semantic_score,
            "preference_boost": analysis.preference_boost,
            "freshness_bonus": analysis.freshness_bonus,
            "repetition_penalty": analysis.repetition_penalty,
            "source_diversity_adjustment": analysis.source_diversity_adjustment,
            "final_score": analysis.final_score,
        },
        "preference_snapshot_version": run.preference_snapshot.version,
        "tool_traces": [
            {
                "tool_name": trace.tool_name,
                "status": trace.status,
                "latency_ms": trace.latency_ms,
                "result_summary": trace.result_summary,
                "error_category": trace.error_category,
            }
            for trace in repository.list_tool_call_traces(run.id)
        ],
    }
