from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Protocol

from lettermate.evals.schemas import BaselineResult, EvalItem, RankedItem


class StructuredRankingProvider(Protocol):
    def rank(
        self,
        *,
        items: Sequence[EvalItem],
        preferences: Mapping[str, object],
        limit: int,
    ) -> Sequence[RankedItem]: ...


def _validate_limit(limit: int) -> int:
    if type(limit) is not int or not 1 <= limit <= 5:
        raise ValueError("limit must be an integer from 1 to 5")
    return limit


def _dataset_version(items: Sequence[EvalItem]) -> str:
    if not items:
        raise ValueError("baseline requires at least one candidate")
    versions = {item.dataset_version for item in items}
    if len(versions) != 1:
        raise ValueError("baseline candidates must share one dataset version")
    return next(iter(versions))


def _candidate_ids(items: Sequence[EvalItem]) -> list[str]:
    candidate_ids: list[str] = []
    seen_ids: set[str] = set()
    for item in items:
        if item.item_id in seen_ids:
            raise ValueError(f"duplicate candidate item ID: {item.item_id}")
        seen_ids.add(item.item_id)
        candidate_ids.append(item.item_id)
    return candidate_ids


def latest_first(items: Sequence[EvalItem], *, limit: int = 5) -> BaselineResult:
    limit = _validate_limit(limit)
    ranked = sorted(items, key=lambda item: (-item.published_at.timestamp(), item.item_id))
    return BaselineResult(
        baseline="latest-first",
        dataset_version=_dataset_version(items),
        candidate_ids=_candidate_ids(items),
        ranked_items=[
            RankedItem(
                item_id=item.item_id,
                score=item.published_at.timestamp(),
                source=item.source,
            )
            for item in ranked[:limit]
        ],
    )


def static_one_shot(
    items: Sequence[EvalItem],
    *,
    preferences: Mapping[str, object],
    provider: StructuredRankingProvider,
    limit: int = 5,
) -> BaselineResult:
    limit = _validate_limit(limit)
    dataset_version = _dataset_version(items)
    candidate_ids = _candidate_ids(items)
    candidate_sources = {item.item_id: item.source for item in items}
    provider_items = provider.rank(items=items, preferences=preferences, limit=limit)
    ranked: list[RankedItem] = []
    seen_ids: set[str] = set()
    for entry in provider_items:
        if entry.item_id not in candidate_sources:
            raise ValueError(f"provider returned unknown candidate ID: {entry.item_id}")
        if entry.item_id in seen_ids:
            raise ValueError(f"duplicate ranked item ID: {entry.item_id}")
        seen_ids.add(entry.item_id)
        ranked.append(
            RankedItem(
                item_id=entry.item_id,
                score=entry.score,
                source=candidate_sources[entry.item_id],
            )
        )
    ranked = sorted(ranked, key=lambda entry: (-entry.score, entry.item_id))[:limit]
    return BaselineResult(
        baseline="static-one-shot",
        dataset_version=dataset_version,
        candidate_ids=candidate_ids,
        ranked_items=ranked,
    )


def write_result(result: BaselineResult, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(result.model_dump_json(indent=2), encoding="utf-8")
