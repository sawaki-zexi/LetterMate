from datetime import UTC, date, datetime, timedelta
from urllib.parse import parse_qs, urlparse

import pytest

from lettermate.db.models import Feedback, PreferenceSnapshot
from lettermate.db.repository import ContentInput, NewsletterItemInput, Repository
from lettermate.preferences.service import (
    FeedbackSignal,
    PreferenceService,
    build_feedback_urls,
    derive_preference_weights,
)
from lettermate.preferences.signing import FeedbackSigner
from lettermate.ranking.policy import RankingCandidate, RankingPolicy


def test_feedback_token_binds_payload_and_rejects_tampering():
    signer = FeedbackSigner("test-secret")
    now = datetime(2026, 7, 20, 3, tzinfo=UTC)
    token = signer.sign(
        issue_id=10,
        item_id=20,
        action="useful",
        expires_at=now + timedelta(hours=1),
    )

    payload = signer.verify(token, now=now)

    assert payload.issue_id == 10
    assert payload.item_id == 20
    assert payload.action == "useful"
    with pytest.raises(ValueError, match="signature"):
        signer.verify(token[:-1] + ("A" if token[-1] != "A" else "B"), now=now)


def test_feedback_token_rejects_expired_and_unknown_actions():
    signer = FeedbackSigner("test-secret")
    now = datetime(2026, 7, 20, 3, tzinfo=UTC)
    expired = signer.sign(
        issue_id=1,
        item_id=2,
        action="saved",
        expires_at=now - timedelta(seconds=1),
    )

    with pytest.raises(ValueError, match="expired"):
        signer.verify(expired, now=now)
    with pytest.raises(ValueError, match="unknown feedback action"):
        signer.sign(issue_id=1, item_id=2, action="delete", expires_at=now)


def test_preference_derivation_is_configurable_explainable_and_replay_stable():
    signals = [
        FeedbackSignal(feedback_id=2, action="not_interested", source_id=9, tags=["ads"]),
        FeedbackSignal(feedback_id=1, action="saved", source_id=7, tags=["agents"]),
        FeedbackSignal(feedback_id=3, action="useful", source_id=7, tags=["agents"]),
    ]
    weights = {"useful": 1, "saved": 2, "not_interested": -2}

    first = derive_preference_weights(signals, action_weights=weights)
    replay = derive_preference_weights(list(reversed(signals)), action_weights=weights)

    assert first == replay
    assert first.tag_weights == {"ads": -2, "agents": 3}
    assert first.source_weights == {7: 3, 9: -2}
    assert first.feedback_ids == (1, 2, 3)


def test_preference_derivation_rejects_unknown_action():
    with pytest.raises(ValueError, match="unknown feedback action"):
        derive_preference_weights(
            [FeedbackSignal(feedback_id=1, action="delete", source_id=1, tags=[])],
            action_weights={"useful": 1},
        )


def test_feedback_urls_are_action_specific_and_share_the_configured_expiry():
    signer = FeedbackSigner("test-secret")
    expires_at = datetime(2026, 7, 27, 3, tzinfo=UTC)

    urls = build_feedback_urls(
        signer=signer,
        base_url="https://letters.example/feedback",
        issue_id=5,
        item_id=8,
        expires_at=expires_at,
    )

    assert set(urls) == {"useful", "not_interested", "saved"}
    for action, url in urls.items():
        token = parse_qs(urlparse(url).query)["token"][0]
        payload = signer.verify(token, now=expires_at - timedelta(seconds=1))
        assert (payload.issue_id, payload.item_id, payload.action) == (5, 8, action)
        assert payload.expires_at == expires_at


def test_signed_feedback_is_idempotent_traceable_and_reset_keeps_raw_history(
    temp_db_session,
):
    repo = Repository(temp_db_session)
    source = repo.create_source(
        "Example", "blog", "rss", "https://example.com/feed.xml", ["source-tag"]
    )
    item = repo.upsert_content_item(
        ContentInput(
            source_id=source.id,
            external_id="item-1",
            title="Agent update",
            url="https://example.com/item-1",
            author="Author",
            published_at=datetime(2026, 7, 20, tzinfo=UTC),
            raw_content="Details",
        )
    )
    initial = repo.create_preference_snapshot(
        explicit_interests=["agents"],
        exclusions=["ads"],
        tag_weights={},
        source_weights={},
        feedback_cutoff=None,
    )
    run = repo.start_agent_run(
        content_item_id=item.id,
        preference_snapshot_id=initial.id,
        prompt_version="curator-v1",
        model="fake-local",
        input_hash="feedback-input",
    )
    decision = repo.save_analysis(
        item,
        summary="Summary",
        tags=["agents", "python"],
        score=5,
        reason="Relevant",
        actionable_insight="Read it",
        should_include=True,
        model="fake-local",
        agent_run_id=run.id,
        semantic_score=5.0,
        final_score=5.0,
        decision="include",
    )
    issue = repo.save_newsletter(
        issue_date=date(2026, 7, 22),
        title="Daily",
        markdown_body="# Daily",
        html_body="<h1>Daily</h1>",
        status="draft",
        items=[NewsletterItemInput(item.id, decision.id, 1, "Top", 5.0)],
    )
    later_snapshot = repo.create_preference_snapshot(
        explicit_interests=["agents"],
        exclusions=["ads"],
        tag_weights={},
        source_weights={},
        feedback_cutoff=None,
    )
    later_run = repo.start_agent_run(
        content_item_id=item.id,
        preference_snapshot_id=later_snapshot.id,
        prompt_version="curator-v2",
        model="fake-local",
        input_hash="later-analysis",
    )
    repo.save_analysis(
        item,
        summary="Later summary",
        tags=["later-tag"],
        score=3,
        reason="Changed",
        actionable_insight="Re-read it",
        should_include=True,
        model="fake-local",
        agent_run_id=later_run.id,
        semantic_score=3.0,
        final_score=3.0,
        decision="include",
    )
    signer = FeedbackSigner("test-secret")
    now = datetime(2026, 7, 22, 3, tzinfo=UTC)
    token = signer.sign(
        issue_id=issue.id,
        item_id=item.id,
        action="saved",
        expires_at=now + timedelta(days=7),
    )
    service = PreferenceService(
        repo,
        signer=signer,
        action_weights={"useful": 1, "saved": 2, "not_interested": -2},
    )

    first = service.apply_signed_feedback(token, now=now, action_source="email")
    repeated = service.apply_signed_feedback(token, now=now, action_source="email")

    assert first.created is True
    assert repeated.created is False
    assert repeated.feedback_id == first.feedback_id
    assert repeated.snapshot_id == first.snapshot_id
    assert temp_db_session.query(Feedback).count() == 1
    assert temp_db_session.query(PreferenceSnapshot).count() == 3
    feedback = temp_db_session.get(Feedback, first.feedback_id)
    assert feedback is not None
    assert feedback.newsletter_item_id == issue.items[0].id
    assert feedback.decision_id == decision.id
    assert feedback.preference_snapshot_id == initial.id
    assert feedback.source_id == source.id
    assert feedback.tags == ["agents", "python"]
    assert feedback.action_source == "email"
    snapshot = temp_db_session.get(PreferenceSnapshot, first.snapshot_id)
    assert snapshot is not None
    assert snapshot.explicit_interests == ["agents"]
    assert snapshot.exclusions == ["ads"]
    assert snapshot.tag_weights == {"agents": 2, "python": 2}
    assert snapshot.source_weights == {str(source.id): 2}
    assert snapshot.feedback_cutoff.replace(tzinfo=UTC) == now

    replayed = service.replay_preferences()

    assert replayed.version == 4
    assert replayed.content_hash == snapshot.content_hash
    assert replayed.tag_weights == snapshot.tag_weights
    assert replayed.source_weights == snapshot.source_weights
    assert temp_db_session.query(Feedback).count() == 1

    reset = repo.reset_preference_weights()

    assert reset.version == 5
    assert reset.tag_weights == {}
    assert reset.source_weights == {}
    assert temp_db_session.query(Feedback).count() == 1

    later_now = now + timedelta(minutes=1)
    useful_token = signer.sign(
        issue_id=issue.id,
        item_id=item.id,
        action="useful",
        expires_at=later_now + timedelta(days=7),
    )
    after_reset = service.apply_signed_feedback(
        useful_token,
        now=later_now,
        action_source="email",
    )
    replayed_after_reset = service.replay_preferences()

    assert after_reset.created is True
    assert temp_db_session.get(PreferenceSnapshot, after_reset.snapshot_id).tag_weights == {
        "agents": 1,
        "python": 1,
    }
    assert temp_db_session.get(PreferenceSnapshot, after_reset.snapshot_id).source_weights == {
        str(source.id): 1
    }
    assert replayed_after_reset.content_hash == temp_db_session.get(
        PreferenceSnapshot, after_reset.snapshot_id
    ).content_hash


def test_feedback_snapshot_changes_a_later_ranking_fixture():
    policy = RankingPolicy(item_limit=1, minimum_score=0, source_diversity_adjustment=0)
    candidates = [
        RankingCandidate(
            item_id=1,
            source_id=7,
            published_at=None,
            semantic_score=3.0,
            tags=["agents"],
        ),
        RankingCandidate(
            item_id=2,
            source_id=9,
            published_at=None,
            semantic_score=4.0,
            tags=[],
        ),
    ]

    baseline = policy.rank(
        candidates,
        tag_weights={},
        source_weights={},
        recent_tags=set(),
        now=datetime(2026, 7, 22, tzinfo=UTC),
    )
    personalized = policy.rank(
        candidates,
        tag_weights={"agents": 1},
        source_weights={7: 1},
        recent_tags=set(),
        now=datetime(2026, 7, 22, tzinfo=UTC),
    )

    assert [decision.item_id for decision in baseline if decision.included] == [2]
    assert [decision.item_id for decision in personalized if decision.included] == [1]
