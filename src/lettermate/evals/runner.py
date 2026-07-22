import argparse
import json
from collections.abc import Sequence
from pathlib import Path

from lettermate.evals.baselines import latest_first, write_result
from lettermate.evals.metrics import (
    duplicate_rate,
    ndcg_at_5,
    precision_at_5,
    source_diversity,
    useful_rate,
)
from lettermate.evals.schemas import BaselineResult, EvalItem, EvalLabel, load_items, load_labels


def evaluate_result(
    result: BaselineResult,
    items: Sequence[EvalItem],
    labels: Sequence[EvalLabel],
) -> dict[str, float]:
    if len(set(result.candidate_ids)) != len(result.candidate_ids):
        raise ValueError("result candidate IDs must be unique")
    candidate_ids = set(result.candidate_ids)

    item_ids: set[str] = set()
    for item in items:
        if item.item_id in item_ids:
            raise ValueError(f"duplicate evaluation item ID: {item.item_id}")
        item_ids.add(item.item_id)
    if item_ids != candidate_ids:
        raise ValueError("evaluation item IDs must match candidate IDs")
    if {item.dataset_version for item in items} != {result.dataset_version}:
        raise ValueError("item and result dataset versions must match")

    label_ids: set[str] = set()
    for label in labels:
        if label.item_id in label_ids:
            raise ValueError(f"duplicate evaluation label ID: {label.item_id}")
        label_ids.add(label.item_id)
    if label_ids != candidate_ids:
        raise ValueError("label item IDs must match candidate IDs")
    if {label.dataset_version for label in labels} != {result.dataset_version}:
        raise ValueError("label and result dataset versions must match")

    ranked_ids = [ranked.item_id for ranked in result.ranked_items]
    if len(set(ranked_ids)) != len(ranked_ids):
        raise ValueError("ranked item IDs must be unique")
    if not set(ranked_ids) <= candidate_ids:
        raise ValueError("ranked item IDs must be candidates")

    item_sources = {item.item_id: item.source for item in items}
    grades = {label.item_id: label.relevance_grade for label in labels}
    ranked_sources = [item_sources[item_id] for item_id in ranked_ids]
    return {
        "precision_at_5": precision_at_5(ranked_ids, grades),
        "useful_rate": useful_rate(ranked_ids, grades),
        "ndcg_at_5": ndcg_at_5(ranked_ids, grades),
        "duplicate_rate": duplicate_rate(ranked_ids),
        "source_diversity": source_diversity(ranked_sources),
    }


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run deterministic LetterMate Eval baselines")
    parser.add_argument("--dataset", type=Path, required=True)
    parser.add_argument("--labels", type=Path, required=True)
    parser.add_argument("--baseline", choices=["latest-first"], required=True)
    parser.add_argument("--output", type=Path)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    items = load_items(args.dataset)
    labels = load_labels(args.labels)
    result = latest_first(items)
    metrics = evaluate_result(result, items, labels)
    if args.output:
        write_result(result, args.output)
    print(json.dumps({"result": result.model_dump(mode="json"), "metrics": metrics}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
