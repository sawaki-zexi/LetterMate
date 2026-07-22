import argparse
import json
import time
from collections.abc import Callable, Mapping, Sequence
from datetime import UTC, datetime
from hashlib import sha256
from pathlib import Path

from lettermate.evals.baselines import (
    DeterministicStructuredProvider,
    bounded_agent_baseline,
    fixed_structured_workflow,
    latest_first,
    static_one_shot,
    write_result,
)
from lettermate.evals.metrics import (
    avoided_full_text_rate,
    complete_trace_rate,
    duplicate_rate,
    full_text_precision,
    ndcg_at_5,
    original_link_coverage,
    precision_at_5,
    source_diversity,
    tool_budget_violations,
    unauthorized_tool_attempts,
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


def _dataset_sha256(items: Sequence[EvalItem], labels: Sequence[EvalLabel]) -> str:
    payload = {
        "items": [item.model_dump(mode="json") for item in items],
        "labels": [label.model_dump(mode="json") for label in labels],
    }
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
    return sha256(encoded).hexdigest()


def _bounded_agent_traces(
    items: Sequence[EvalItem], preferences: dict[str, object]
) -> list[dict[str, object]]:
    interest_values = preferences.get("interests")
    interests = (
        [value.casefold() for value in interest_values if isinstance(value, str)]
        if isinstance(interest_values, list)
        else []
    )
    traces: list[dict[str, object]] = []
    for item in items:
        haystack = f"{item.title} {item.excerpt}".casefold()
        tool_names: list[str] = []
        if "omit" in haystack or "excerpt" in haystack:
            tool_names.append("fetch_full_text")
        if any(interest in haystack for interest in interests):
            tool_names.append("get_preference_evidence")
        if any(keyword in haystack for keyword in ("agent", "evaluation", "career")):
            tool_names.append("lookup_recent_topics")
        for sequence, tool_name in enumerate(tool_names[:3], start=1):
            traces.append(
                {
                    "run_id": f"bounded-agent:{item.item_id}",
                    "sequence": sequence,
                    "item_id": item.item_id,
                    "tool_name": tool_name,
                    "status": "succeeded",
                    "latency_ms": 0,
                }
            )
    return traces


def _quality_metrics(
    result: BaselineResult,
    items: Sequence[EvalItem],
    labels: Sequence[EvalLabel],
    traces: Sequence[dict[str, object]] | None,
) -> dict[str, float | int]:
    label_map = {label.item_id: label for label in labels}
    item_urls = {item.item_id: str(item.url) for item in items}
    ranked_ids = [item.item_id for item in result.ranked_items]
    metrics: dict[str, float | int] = {
        "original_link_coverage": original_link_coverage(ranked_ids, item_urls)
    }
    if traces is None:
        return metrics
    metrics.update(
        {
        "full_text_precision": full_text_precision(traces, label_map),
        "avoided_full_text_rate": avoided_full_text_rate(traces, label_map),
        "tool_budget_violations": tool_budget_violations(traces),
        "unauthorized_tool_attempts": unauthorized_tool_attempts(traces),
        "complete_trace_rate": complete_trace_rate(traces),
        }
    )
    return metrics


def evaluate_quality_targets(metrics: Mapping[str, float | int]) -> dict[str, bool | None]:
    """Evaluate the release thresholds without hiding failed slices."""
    def threshold(name: str, minimum: float) -> bool | None:
        value = metrics.get(name)
        return None if value is None else value >= minimum

    def equals_zero(name: str) -> bool | None:
        value = metrics.get(name)
        return None if value is None else value == 0

    return {
        "original_link_coverage": threshold("original_link_coverage", 1.0),
        "full_text_precision": threshold("full_text_precision", 0.8),
        "avoided_full_text_rate": threshold("avoided_full_text_rate", 0.7),
        "tool_budget_violations": equals_zero("tool_budget_violations"),
        "unauthorized_tool_attempts": equals_zero("unauthorized_tool_attempts"),
        "complete_trace_rate": threshold("complete_trace_rate", 1.0),
    }


def _framework_exit(runs: Sequence[dict[str, object]]) -> dict[str, object]:
    bounded = next(run for run in runs if run["baseline"] == "bounded-agent")
    fixed = next(run for run in runs if run["baseline"] == "fixed-structured-workflow")
    traces = bounded["tool_traces"]
    assert isinstance(traces, list)
    selected_tools = {str(trace["tool_name"]) for trace in traces}
    bounded_metrics = bounded["metrics"]
    fixed_metrics = fixed["metrics"]
    assert isinstance(bounded_metrics, dict) and isinstance(fixed_metrics, dict)
    criteria = {
        "adaptive_tool_selection": len(selected_tools) >= 2,
        "complete_traces": bounded_metrics["complete_trace_rate"] == 1.0,
        "outperforms_fixed_workflow": bounded_metrics["ndcg_at_5"]
        > fixed_metrics["ndcg_at_5"],
        "fake_model_coverage": True,
        "trace_shortened_debugging": False,
    }
    return {
        "criteria": criteria,
        "status": "justified" if all(criteria.values()) else "simplify",
        "note": "The offline fixture cannot prove that traces shortened debugging.",
    }


def run_all_baselines(
    items: Sequence[EvalItem],
    labels: Sequence[EvalLabel],
    *,
    preferences: dict[str, object],
    output: Path | None = None,
) -> dict[str, object]:
    result_builders: tuple[tuple[str, Callable[[], BaselineResult]], ...] = (
        ("latest-first", lambda: latest_first(items)),
        (
            "static-one-shot",
            lambda: static_one_shot(
                items,
                preferences=preferences,
                provider=DeterministicStructuredProvider(),
            ),
        ),
        (
            "fixed-structured-workflow",
            lambda: fixed_structured_workflow(items, preferences=preferences),
        ),
        ("bounded-agent", lambda: bounded_agent_baseline(items, preferences=preferences)),
    )
    dataset_hash = _dataset_sha256(items, labels)
    runs: list[dict[str, object]] = []
    for name, build_result in result_builders:
        started = time.perf_counter()
        result = build_result()
        traces = _bounded_agent_traces(items, preferences) if name == "bounded-agent" else None
        metrics = evaluate_result(result, items, labels)
        metrics.update(_quality_metrics(result, items, labels, traces))
        runs.append(
            {
                "baseline": name,
                "candidate_ids": result.candidate_ids,
                "ranked_items": [entry.model_dump(mode="json") for entry in result.ranked_items],
                "metrics": metrics,
                "quality_targets": evaluate_quality_targets(metrics),
                "dataset_sha256": dataset_hash,
                "prompt_version": "curation-v2" if name == "bounded-agent" else "eval-v1",
                "model": "offline-deterministic",
                "config": {"limit": 5, "preferences": preferences},
                "latency_ms": int((time.perf_counter() - started) * 1000),
                "input_tokens": 0,
                "output_tokens": 0,
                "tool_traces": traces or [],
            }
        )
    report: dict[str, object] = {
        "schema_version": "1.0",
        "generated_at": datetime.now(UTC).isoformat(),
        "dataset_sha256": dataset_hash,
        "runs": runs,
        "framework_exit": _framework_exit(runs),
    }
    if output is not None:
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(report, indent=2, sort_keys=True), encoding="utf-8")
    return report


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run deterministic LetterMate Eval baselines")
    parser.add_argument("--dataset", type=Path, required=True)
    parser.add_argument("--labels", type=Path, required=True)
    selection = parser.add_mutually_exclusive_group(required=True)
    selection.add_argument("--baseline", choices=["latest-first"])
    selection.add_argument("--all-baselines", action="store_true")
    parser.add_argument("--output", type=Path)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    items = load_items(args.dataset)
    labels = load_labels(args.labels)
    if args.all_baselines:
        report = run_all_baselines(
            items,
            labels,
            preferences={"interests": ["agent engineering", "evaluation"]},
            output=args.output,
        )
        print(json.dumps(report, indent=2))
        return 0
    result = latest_first(items)
    metrics = evaluate_result(result, items, labels)
    if args.output:
        write_result(result, args.output)
    print(json.dumps({"result": result.model_dump(mode="json"), "metrics": metrics}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
