from dataclasses import dataclass
from datetime import datetime


@dataclass(frozen=True)
class RankingCandidate:
    item_id: int
    source_id: int
    published_at: datetime | None
    semantic_score: float
    tags: list[str]


@dataclass(frozen=True)
class RankingDecision:
    item_id: int
    source_id: int
    semantic_score: float
    preference_boost: float
    freshness_bonus: float
    repetition_penalty: float
    source_diversity_adjustment: float
    final_score: float
    included: bool


class RankingPolicy:
    def __init__(
        self,
        *,
        item_limit: int,
        minimum_score: float,
        freshness_max_bonus: float = 0.5,
        repetition_penalty: float = 0.5,
        source_diversity_adjustment: float = 0.25,
    ) -> None:
        self._item_limit = item_limit
        self._minimum_score = minimum_score
        self._freshness_max_bonus = freshness_max_bonus
        self._repetition_penalty = repetition_penalty
        self._source_diversity_adjustment = source_diversity_adjustment

    def rank(
        self,
        candidates: list[RankingCandidate],
        *,
        tag_weights: dict[str, float],
        source_weights: dict[int, float],
        recent_tags: set[str],
        now: datetime,
    ) -> list[RankingDecision]:
        provisional: list[tuple[RankingCandidate, RankingDecision]] = []
        for candidate in candidates:
            preference_boost = sum(tag_weights.get(tag, 0.0) for tag in candidate.tags)
            preference_boost += source_weights.get(candidate.source_id, 0.0)
            freshness_bonus = self._freshness(candidate, now)
            repetition = (
                -self._repetition_penalty
                if any(tag in recent_tags for tag in candidate.tags)
                else 0.0
            )
            provisional.append(
                (
                    candidate,
                    RankingDecision(
                        item_id=candidate.item_id,
                        source_id=candidate.source_id,
                        semantic_score=candidate.semantic_score,
                        preference_boost=preference_boost,
                        freshness_bonus=freshness_bonus,
                        repetition_penalty=repetition,
                        source_diversity_adjustment=0.0,
                        final_score=(
                            candidate.semantic_score
                            + preference_boost
                            + freshness_bonus
                            + repetition
                        ),
                        included=False,
                    ),
                )
            )
        provisional.sort(
            key=lambda pair: (
                -pair[1].final_score,
                -(pair[0].published_at.timestamp() if pair[0].published_at else 0.0),
                pair[0].source_id,
                pair[0].item_id,
            )
        )
        selected_sources: set[int] = set()
        decisions: list[RankingDecision] = []
        selected_count = 0
        for candidate, decision in provisional:
            diversity = (
                self._source_diversity_adjustment
                if candidate.source_id not in selected_sources
                else 0.0
            )
            score = decision.final_score + diversity
            included = score >= self._minimum_score and selected_count < self._item_limit
            updated = RankingDecision(
                **{
                    **decision.__dict__,
                    "source_diversity_adjustment": diversity,
                    "final_score": score,
                    "included": included,
                }
            )
            if included:
                selected_count += 1
                selected_sources.add(candidate.source_id)
            decisions.append(updated)
        return decisions

    def _freshness(self, candidate: RankingCandidate, now: datetime) -> float:
        if candidate.published_at is None:
            return 0.0
        age_hours = max(0.0, (now - candidate.published_at).total_seconds() / 3600)
        return max(0.0, self._freshness_max_bonus * (1 - min(age_hours, 24.0) / 24.0))
