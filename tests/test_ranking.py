from datetime import UTC, datetime, timedelta

from lettermate.ranking.policy import RankingCandidate, RankingPolicy


def candidate(
    item_id: int, *, source_id: int = 1, tags: list[str] | None = None
) -> RankingCandidate:
    return RankingCandidate(
        item_id=item_id,
        source_id=source_id,
        published_at=datetime.now(UTC) - timedelta(hours=1),
        semantic_score=4,
        tags=tags or ["agents"],
    )


def test_ranking_records_components_and_applies_deterministic_tie_order():
    policy = RankingPolicy(item_limit=2, minimum_score=3.0)

    ranked = policy.rank(
        [candidate(2, source_id=2), candidate(1, source_id=1)],
        tag_weights={"agents": 1.0},
        source_weights={},
        recent_tags=set(),
        now=datetime.now(UTC),
    )

    assert [entry.item_id for entry in ranked] == [1, 2]
    assert ranked[0].semantic_score == 4
    assert ranked[0].preference_boost == 1.0
    assert ranked[0].freshness_bonus > 0
    assert ranked[0].included is True


def test_ranking_excludes_repeated_and_low_scoring_candidates():
    policy = RankingPolicy(item_limit=5, minimum_score=4.5, repetition_penalty=2.0)

    ranked = policy.rank(
        [candidate(1, tags=["repeated"])],
        tag_weights={},
        source_weights={},
        recent_tags={"repeated"},
        now=datetime.now(UTC),
    )

    assert ranked[0].repetition_penalty == -2.0
    assert ranked[0].included is False
