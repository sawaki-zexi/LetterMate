from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from types import MappingProxyType
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError

from lettermate.db.models import (
    Feedback,
    Newsletter,
    NewsletterItem,
    PreferenceSnapshot,
)
from lettermate.db.repository import Repository, make_preference_hash
from lettermate.preferences.signing import ALLOWED_ACTIONS, FeedbackSigner

ALLOWED_ACTION_SOURCES = frozenset({"dashboard", "email"})


@dataclass(frozen=True)
class FeedbackSignal:
    feedback_id: int
    action: str
    source_id: int
    tags: Sequence[str]
    created_at: datetime | None = None


@dataclass(frozen=True)
class PreferenceWeights:
    tag_weights: Mapping[str, int]
    source_weights: Mapping[int, int]
    feedback_ids: tuple[int, ...]


@dataclass(frozen=True)
class AppliedFeedback:
    feedback_id: int
    snapshot_id: int
    created: bool


@dataclass(frozen=True)
class _ReplayState:
    tag_weights: dict[str, int]
    source_weights: dict[str, int]
    feedback_cutoff: datetime | None
    feedback_cutoff_id: int | None


def derive_preference_weights(
    signals: Iterable[FeedbackSignal],
    *,
    action_weights: Mapping[str, int],
) -> PreferenceWeights:
    materialized_signals = list(signals)
    feedback_ids = [signal.feedback_id for signal in materialized_signals]
    if len(feedback_ids) != len(set(feedback_ids)):
        raise ValueError("duplicate feedback ID")
    ordered_signals = sorted(
        materialized_signals,
        key=lambda signal: (
            _as_utc(signal.created_at)
            if signal.created_at is not None
            else datetime.min.replace(tzinfo=UTC),
            signal.feedback_id,
        ),
    )
    tag_weights: dict[str, int] = {}
    source_weights: dict[int, int] = {}

    for signal in ordered_signals:
        if signal.action not in action_weights:
            raise ValueError(f"unknown feedback action: {signal.action}")
        weight = action_weights[signal.action]
        source_weights[signal.source_id] = source_weights.get(signal.source_id, 0) + weight
        for tag in sorted(set(signal.tags)):
            tag_weights[tag] = tag_weights.get(tag, 0) + weight

    return PreferenceWeights(
        tag_weights=MappingProxyType(dict(sorted(tag_weights.items()))),
        source_weights=MappingProxyType(dict(sorted(source_weights.items()))),
        feedback_ids=tuple(signal.feedback_id for signal in ordered_signals),
    )


def _as_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value.astimezone(UTC)


def build_feedback_urls(
    *,
    signer: FeedbackSigner,
    base_url: str,
    issue_id: int,
    item_id: int,
    expires_at: datetime,
) -> Mapping[str, str]:
    parts = urlsplit(base_url)
    if parts.scheme not in {"http", "https"} or not parts.netloc:
        raise ValueError("feedback base URL must be an absolute HTTP(S) URL")
    existing_query = parse_qsl(parts.query, keep_blank_values=True)
    urls = {
        action: urlunsplit(
            parts._replace(
                query=urlencode(
                    [
                        *existing_query,
                        (
                            "token",
                            signer.sign(
                                issue_id=issue_id,
                                item_id=item_id,
                                action=action,
                                expires_at=expires_at,
                            ),
                        ),
                    ]
                )
            )
        )
        for action in sorted(ALLOWED_ACTIONS)
    }
    return MappingProxyType(urls)


class PreferenceService:
    def __init__(
        self,
        repository: Repository,
        *,
        signer: FeedbackSigner,
        action_weights: Mapping[str, int],
    ) -> None:
        missing_actions = ALLOWED_ACTIONS - action_weights.keys()
        if missing_actions:
            missing = ", ".join(sorted(missing_actions))
            raise ValueError(f"missing feedback action weights: {missing}")
        self._repository = repository
        self._signer = signer
        self._action_weights = dict(action_weights)

    def apply_signed_feedback(
        self,
        token: str,
        *,
        now: datetime,
        action_source: str,
    ) -> AppliedFeedback:
        if action_source not in ALLOWED_ACTION_SOURCES:
            raise ValueError(f"unknown feedback action source: {action_source}")
        if now.tzinfo is None:
            raise ValueError("feedback time must be timezone-aware")
        payload = self._signer.verify(token, now=now)
        session = self._repository.session
        membership = session.scalar(
            select(NewsletterItem)
            .join(Newsletter, Newsletter.id == NewsletterItem.newsletter_id)
            .where(
                Newsletter.id == payload.issue_id,
                NewsletterItem.content_item_id == payload.item_id,
            )
        )
        if membership is None:
            raise LookupError("newsletter item not found")
        membership_id = membership.id
        existing = session.scalar(
            select(Feedback).where(
                Feedback.newsletter_item_id == membership_id,
                Feedback.feedback_type == payload.action,
            )
        )
        if existing is not None:
            if existing.resulting_preference_snapshot_id is None:
                raise RuntimeError("feedback exists without a resulting preference snapshot")
            return AppliedFeedback(
                feedback_id=existing.id,
                snapshot_id=existing.resulting_preference_snapshot_id,
                created=False,
            )

        if (
            membership.preference_snapshot_id is None
            or membership.source_id is None
        ):
            raise RuntimeError("newsletter item is missing frozen recommendation provenance")
        latest = self._repository.get_latest_preference_snapshot()
        if latest is None:
            raise RuntimeError("feedback requires an existing preference snapshot")

        normalized_now = now.astimezone(UTC)
        source_id = membership.source_id
        feedback = Feedback(
            content_item_id=membership.content_item_id,
            newsletter_item_id=membership_id,
            decision_id=membership.decision_id,
            preference_snapshot_id=membership.preference_snapshot_id,
            source_id=source_id,
            feedback_type=payload.action,
            action_source=action_source,
            tags=sorted(set(membership.decision_tags)),
            note="",
            created_at=normalized_now,
        )
        try:
            session.add(feedback)
            session.flush()
            replay = self._derive_replay_state()
            current_version = session.scalar(select(func.max(PreferenceSnapshot.version))) or 0
            snapshot = PreferenceSnapshot(
                version=current_version + 1,
                explicit_interests=sorted(set(latest.explicit_interests)),
                exclusions=sorted(set(latest.exclusions)),
                tag_weights=replay.tag_weights,
                source_weights=replay.source_weights,
                feedback_cutoff=replay.feedback_cutoff,
                feedback_cutoff_id=replay.feedback_cutoff_id,
                derivation_type="feedback",
                content_hash=make_preference_hash(
                    explicit_interests=latest.explicit_interests,
                    exclusions=latest.exclusions,
                    tag_weights=replay.tag_weights,
                    source_weights=replay.source_weights,
                    feedback_cutoff=replay.feedback_cutoff,
                    feedback_cutoff_id=replay.feedback_cutoff_id,
                ),
            )
            session.add(snapshot)
            session.flush()
            feedback.resulting_preference_snapshot_id = snapshot.id
            session.commit()
        except IntegrityError:
            session.rollback()
            existing = session.scalar(
                select(Feedback).where(
                    Feedback.newsletter_item_id == membership_id,
                    Feedback.feedback_type == payload.action,
                )
            )
            if existing is None or existing.resulting_preference_snapshot_id is None:
                raise
            return AppliedFeedback(
                feedback_id=existing.id,
                snapshot_id=existing.resulting_preference_snapshot_id,
                created=False,
            )
        return AppliedFeedback(feedback_id=feedback.id, snapshot_id=snapshot.id, created=True)

    def replay_preferences(self) -> PreferenceSnapshot:
        latest = self._repository.get_latest_preference_snapshot()
        if latest is None:
            raise RuntimeError("preference replay requires an existing snapshot")
        replay = self._derive_replay_state()
        return self._repository.create_preference_snapshot(
            explicit_interests=latest.explicit_interests,
            exclusions=latest.exclusions,
            tag_weights=replay.tag_weights,
            source_weights=replay.source_weights,
            feedback_cutoff=replay.feedback_cutoff,
            feedback_cutoff_id=replay.feedback_cutoff_id,
            derivation_type="replay",
        )

    def _derive_replay_state(self) -> _ReplayState:
        session = self._repository.session
        snapshots = list(
            session.scalars(select(PreferenceSnapshot).order_by(PreferenceSnapshot.version))
        )
        if not snapshots:
            raise RuntimeError("preference replay requires an existing snapshot")
        reset_snapshots = [
            snapshot for snapshot in snapshots if snapshot.derivation_type == "reset"
        ]
        baseline = reset_snapshots[-1] if reset_snapshots else snapshots[0]
        cutoff_time = (
            _as_utc(baseline.feedback_cutoff)
            if baseline.feedback_cutoff is not None
            else None
        )
        cutoff_id = baseline.feedback_cutoff_id or 0
        feedback_rows = list(
            session.scalars(select(Feedback).order_by(Feedback.created_at, Feedback.id))
        )
        signals: list[FeedbackSignal] = []
        for row in feedback_rows:
            created_at = _as_utc(row.created_at)
            after_cutoff = cutoff_time is None or (created_at, row.id) > (
                cutoff_time,
                cutoff_id,
            )
            if not after_cutoff:
                continue
            if row.source_id is None:
                raise RuntimeError(f"feedback {row.id} is missing replay provenance")
            signals.append(
                FeedbackSignal(
                    feedback_id=row.id,
                    action=row.feedback_type,
                    source_id=row.source_id,
                    tags=row.tags,
                    created_at=created_at,
                )
            )
        derived = derive_preference_weights(signals, action_weights=self._action_weights)
        tag_weights = dict(baseline.tag_weights)
        for tag, weight in derived.tag_weights.items():
            tag_weights[tag] = tag_weights.get(tag, 0) + weight
        source_weights = dict(baseline.source_weights)
        for source_id, weight in derived.source_weights.items():
            key = str(source_id)
            source_weights[key] = source_weights.get(key, 0) + weight
        feedback_cutoff: datetime | None
        feedback_cutoff_id: int | None
        if signals:
            feedback_cutoff = _as_utc(signals[-1].created_at) if signals[-1].created_at else None
            feedback_cutoff_id = signals[-1].feedback_id
        else:
            feedback_cutoff = cutoff_time
            feedback_cutoff_id = baseline.feedback_cutoff_id
        return _ReplayState(
            tag_weights=dict(sorted(tag_weights.items())),
            source_weights=dict(sorted(source_weights.items())),
            feedback_cutoff=feedback_cutoff,
            feedback_cutoff_id=feedback_cutoff_id,
        )
