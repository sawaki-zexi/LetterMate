import json
import math
from datetime import UTC, datetime, timedelta, timezone
from pathlib import Path

import pytest
from pydantic import ValidationError

from lettermate.evals.baselines import latest_first, static_one_shot, write_result
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
from lettermate.evals.runner import (
    evaluate_quality_targets,
    evaluate_result,
    main,
    run_all_baselines,
)
from lettermate.evals.schemas import (
    BaselineResult,
    EvalItem,
    EvalLabel,
    RankedItem,
    load_items,
    load_labels,
)

ROOT = Path(__file__).resolve().parents[1]


def item(
    item_id: str,
    *,
    hour: int = 0,
    source: str = "source-a",
    published_at: datetime | None = None,
    dataset_version: str = "sample-v1",
) -> EvalItem:
    return EvalItem(
        item_id=item_id,
        source=source,
        title=f"Title {item_id}",
        url=f"https://example.com/{item_id}",
        excerpt="A public, synthetic excerpt with enough context.",
        published_at=published_at or datetime(2026, 7, 20, hour, tzinfo=UTC),
        dataset_version=dataset_version,
    )


def label(
    item_id: str, *, grade: int = 2, dataset_version: str = "sample-v1"
) -> EvalLabel:
    return EvalLabel(
        item_id=item_id,
        relevance_grade=grade,
        needs_full_text=False,
        expected_tags=[],
        redaction_status="public",
        dataset_version=dataset_version,
    )


def test_eval_schemas_reject_invalid_versions_grades_and_private_notes():
    with pytest.raises(ValidationError):
        EvalItem(
            item_id="one",
            source="source-a",
            title="Title",
            url="https://example.com/one",
            excerpt="Excerpt",
            published_at=datetime.now(UTC),
            dataset_version="",
        )

    with pytest.raises(ValidationError):
        EvalLabel(
            item_id="one",
            relevance_grade=3,
            needs_full_text=False,
            expected_tags=[],
            redaction_status="public",
            dataset_version="sample-v1",
        )

    with pytest.raises(ValidationError, match="private notes"):
        EvalLabel(
            item_id="one",
            relevance_grade=2,
            needs_full_text=False,
            expected_tags=[],
            redaction_status="unredacted",
            private_notes="owner secret",
            dataset_version="sample-v1",
        )


def test_private_note_validation_errors_hide_rejected_input(tmp_path: Path):
    secret = "TOPSECRET"
    payload = {
        "item_id": "one",
        "relevance_grade": 2,
        "needs_full_text": False,
        "expected_tags": [],
        "redaction_status": "unredacted",
        "dataset_version": "sample-v1",
        "private_notes": secret,
    }

    with pytest.raises(ValidationError) as model_error:
        EvalLabel.model_validate(payload)
    assert secret not in str(model_error.value)
    assert secret not in repr(model_error.value)

    path = tmp_path / "private-label.jsonl"
    path.write_text(json.dumps(payload) + "\n", encoding="utf-8")
    with pytest.raises(ValidationError) as loader_error:
        load_labels(path)
    assert secret not in str(loader_error.value)
    assert secret not in repr(loader_error.value)


def test_eval_items_require_aware_times_and_normalize_equal_instants_to_utc():
    with pytest.raises(ValidationError, match="timezone-aware"):
        item("naive", published_at=datetime(2026, 7, 20, 2))

    offset_item = item(
        "b",
        published_at=datetime(2026, 7, 20, 10, tzinfo=timezone(timedelta(hours=8))),
    )
    utc_item = item("a", published_at=datetime(2026, 7, 20, 2, tzinfo=UTC))

    assert offset_item.published_at == utc_item.published_at
    assert offset_item.published_at.tzinfo is UTC
    assert [entry.item_id for entry in latest_first([offset_item, utc_item]).ranked_items] == [
        "a",
        "b",
    ]


@pytest.mark.parametrize("score", [math.nan, math.inf, -math.inf])
def test_ranked_items_reject_non_finite_scores(score: float):
    with pytest.raises(ValidationError, match="finite number"):
        RankedItem(item_id="one", score=score, source="source-a")


@pytest.mark.parametrize(
    ("candidate_ids", "ranked_ids"),
    [
        ([], []),
        (["a", "a"], []),
        (["a"], ["a", "a"]),
        (["a"], ["unknown"]),
        (["a", "b", "c", "d", "e", "f"], ["a", "b", "c", "d", "e", "f"]),
    ],
    ids=[
        "empty-candidates",
        "duplicate-candidates",
        "duplicate-ranked-items",
        "ranked-item-outside-candidates",
        "more-than-five-ranked-items",
    ],
)
def test_baseline_result_rejects_malformed_membership(
    candidate_ids: list[str], ranked_ids: list[str]
):
    with pytest.raises(ValidationError):
        BaselineResult(
            baseline="test",
            dataset_version="sample-v1",
            candidate_ids=candidate_ids,
            ranked_items=[
                RankedItem(item_id=item_id, score=1.0, source="source-a")
                for item_id in ranked_ids
            ],
        )


@pytest.mark.parametrize("grade", [True, "1"], ids=["boolean", "string"])
def test_eval_label_model_rejects_non_integer_grades(grade: object):
    with pytest.raises(ValidationError, match="valid integer"):
        EvalLabel(
            item_id="one",
            relevance_grade=grade,  # type: ignore[arg-type]
            needs_full_text=False,
            expected_tags=[],
            redaction_status="public",
            dataset_version="sample-v1",
        )


@pytest.mark.parametrize("grade", [True, "1"], ids=["boolean", "string"])
def test_label_loader_rejects_non_integer_grades(tmp_path: Path, grade: object):
    path = tmp_path / "labels.jsonl"
    path.write_text(
        json.dumps(
            {
                "item_id": "one",
                "relevance_grade": grade,
                "needs_full_text": False,
                "expected_tags": [],
                "redaction_status": "public",
                "dataset_version": "sample-v1",
            }
        )
        + "\n",
        encoding="utf-8",
    )

    with pytest.raises(ValidationError, match="valid integer"):
        load_labels(path)


@pytest.mark.parametrize("loader,record", [(load_items, item("one")), (load_labels, EvalLabel(
    item_id="one",
    relevance_grade=2,
    needs_full_text=False,
    expected_tags=["agents"],
    redaction_status="public",
    dataset_version="sample-v1",
))])
def test_jsonl_loaders_reject_duplicate_ids(tmp_path: Path, loader, record):
    path = tmp_path / "duplicate.jsonl"
    line = record.model_dump_json()
    path.write_text(f"{line}\n{line}\n", encoding="utf-8")

    with pytest.raises(ValueError, match="duplicate item_id: one"):
        loader(path)


def test_metrics_match_hand_calculated_values_and_edge_cases():
    ranked = ["a", "b", "b", "c"]
    grades = {"a": 2, "b": 1, "c": 0, "d": 2}

    assert precision_at_5(ranked, grades) == pytest.approx(0.25)
    assert useful_rate(ranked, grades) == pytest.approx(0.75)
    expected_dcg = 3 + 1 / math.log2(3)
    ideal_dcg = 3 + 3 / math.log2(3) + 1 / math.log2(4)
    assert ndcg_at_5(["a", "b", "c"], grades) == pytest.approx(expected_dcg / ideal_dcg)
    assert duplicate_rate(ranked) == pytest.approx(0.25)
    assert source_diversity(["one", "two", "one", "three"]) == pytest.approx(0.75)

    assert precision_at_5([], grades) == 0.0
    assert useful_rate([], grades) == 0.0
    assert ndcg_at_5([], grades) == 0.0
    assert duplicate_rate([]) == 0.0
    assert source_diversity([]) == 0.0


def test_ndcg_rejects_duplicate_ranked_ids_instead_of_exceeding_one():
    with pytest.raises(ValueError, match="ranked IDs must be unique"):
        ndcg_at_5(["a", "a", "a", "a", "a"], {"a": 2})


def test_latest_first_is_stable_for_tied_times_and_limits_to_five():
    items = [item("b", hour=2), item("a", hour=2), item("old", hour=1)]

    result = latest_first(items, limit=2)

    assert result.candidate_ids == ["b", "a", "old"]
    assert [entry.item_id for entry in result.ranked_items] == ["a", "b"]
    assert result.baseline == "latest-first"


def test_baselines_reject_empty_candidate_sets():
    with pytest.raises(ValueError, match="at least one candidate"):
        latest_first([])


@pytest.mark.parametrize("baseline", ["latest-first", "static-one-shot"])
@pytest.mark.parametrize("limit", [0, -1, 6, True, 1.0, "1"])
def test_baselines_require_strict_limits_from_one_to_five(baseline: str, limit: object):
    class EmptyProvider:
        def rank(self, *, items, preferences, limit):
            return []

    with pytest.raises(ValueError, match="limit must be an integer from 1 to 5"):
        if baseline == "latest-first":
            latest_first([item("one")], limit=limit)  # type: ignore[arg-type]
        else:
            static_one_shot(
                [item("one")],
                preferences={},
                provider=EmptyProvider(),
                limit=limit,  # type: ignore[arg-type]
            )


class FakeStructuredProvider:
    def rank(self, *, items, preferences, limit):
        assert [entry.item_id for entry in items] == ["b", "a", "old"]
        assert preferences == {"interests": ["agent engineering"]}
        assert limit == 2
        return [
            RankedItem(item_id="old", score=0.9, source="source-a"),
            RankedItem(item_id="a", score=0.9, source="source-a"),
        ]


def test_static_one_shot_uses_injected_provider_and_writes_normalized_output(tmp_path: Path):
    items = [item("b", hour=2), item("a", hour=2), item("old", hour=1)]
    result = static_one_shot(
        items,
        preferences={"interests": ["agent engineering"]},
        provider=FakeStructuredProvider(),
        limit=2,
    )
    output_path = tmp_path / "result.json"

    write_result(result, output_path)
    payload = json.loads(output_path.read_text(encoding="utf-8"))

    assert isinstance(result, BaselineResult)
    assert result.candidate_ids == ["b", "a", "old"]
    assert [entry.item_id for entry in result.ranked_items] == ["a", "old"]
    assert payload["schema_version"] == "1.0"
    assert payload["baseline"] == "static-one-shot"


def test_static_one_shot_rejects_ids_outside_candidate_set():
    class BadProvider:
        def rank(self, *, items, preferences, limit):
            return [RankedItem(item_id="unknown", score=1.0, source="x")]

    with pytest.raises(ValueError, match="unknown candidate ID"):
        static_one_shot([item("one")], preferences={}, provider=BadProvider())


def test_static_one_shot_rejects_duplicate_ranked_ids():
    class DuplicateProvider:
        def rank(self, *, items, preferences, limit):
            return [
                RankedItem(item_id="one", score=1.0, source="source-a"),
                RankedItem(item_id="one", score=0.5, source="source-a"),
            ]

    with pytest.raises(ValueError, match="duplicate ranked item ID: one"):
        static_one_shot([item("one")], preferences={}, provider=DuplicateProvider())


def test_static_one_shot_normalizes_ranked_sources_from_candidates():
    class WrongSourceProvider:
        def rank(self, *, items, preferences, limit):
            return [RankedItem(item_id="one", score=1.0, source="untrusted-source")]

    result = static_one_shot([item("one")], preferences={}, provider=WrongSourceProvider())

    assert result.ranked_items[0].source == "source-a"


class CountingProvider:
    def __init__(self):
        self.calls = 0

    def rank(self, *, items, preferences, limit):
        self.calls += 1
        return []


def test_static_one_shot_rejects_empty_candidates_before_calling_provider():
    provider = CountingProvider()

    with pytest.raises(ValueError, match="at least one candidate"):
        static_one_shot([], preferences={}, provider=provider)

    assert provider.calls == 0


def test_static_one_shot_rejects_mixed_versions_before_calling_provider():
    provider = CountingProvider()
    candidates = [item("one"), item("two", dataset_version="other-v1")]

    with pytest.raises(ValueError, match="share one dataset version"):
        static_one_shot(candidates, preferences={}, provider=provider)

    assert provider.calls == 0


def test_evaluate_result_rejects_mismatched_labels_and_returns_metrics():
    items = [item("a", source="one"), item("b", source="two")]
    labels = [
        EvalLabel(
            item_id="a",
            relevance_grade=2,
            needs_full_text=False,
            expected_tags=["agents"],
            redaction_status="public",
            dataset_version="sample-v1",
        ),
        EvalLabel(
            item_id="b",
            relevance_grade=1,
            needs_full_text=True,
            expected_tags=["product"],
            redaction_status="public",
            dataset_version="sample-v1",
        ),
    ]
    result = latest_first(items)

    report = evaluate_result(result, items, labels)

    assert report == {
        "precision_at_5": 0.5,
        "useful_rate": 1.0,
        "ndcg_at_5": 1.0,
        "duplicate_rate": 0.0,
        "source_diversity": 1.0,
    }

    with pytest.raises(ValueError, match="label item IDs must match candidate IDs"):
        evaluate_result(result, items, labels[:1])


def test_evaluate_result_rejects_duplicate_item_ids():
    result = latest_first([item("a", source="one"), item("b", source="two")])

    with pytest.raises(ValueError, match="duplicate evaluation item ID: a"):
        evaluate_result(
            result,
            [item("a", source="one"), item("a", source="other"), item("b", source="two")],
            [label("a"), label("b")],
        )


def test_evaluate_result_rejects_item_candidate_mismatch():
    result = latest_first([item("a"), item("b")])

    with pytest.raises(ValueError, match="evaluation item IDs must match candidate IDs"):
        evaluate_result(result, [item("a")], [label("a"), label("b")])


def test_evaluate_result_rejects_item_dataset_version_mismatch():
    result = latest_first([item("a"), item("b")])

    with pytest.raises(ValueError, match="item and result dataset versions must match"):
        evaluate_result(
            result,
            [item("a"), item("b", dataset_version="other-v1")],
            [label("a"), label("b")],
        )


def test_evaluate_result_rejects_duplicate_label_ids():
    result = latest_first([item("a"), item("b")])

    with pytest.raises(ValueError, match="duplicate evaluation label ID: a"):
        evaluate_result(result, [item("a"), item("b")], [label("a"), label("a"), label("b")])


def test_evaluate_result_rejects_ranked_ids_outside_candidates_defensively():
    malformed = BaselineResult.model_construct(
        schema_version="1.0",
        baseline="malformed",
        dataset_version="sample-v1",
        candidate_ids=["a"],
        ranked_items=[RankedItem(item_id="unknown", score=1.0, source="source-a")],
    )

    with pytest.raises(ValueError, match="ranked item IDs must be candidates"):
        evaluate_result(malformed, [item("a")], [label("a")])


def test_runner_prints_normalized_result_and_metrics(tmp_path: Path, capsys):
    items_path = tmp_path / "items.jsonl"
    labels_path = tmp_path / "labels.jsonl"
    item_lines = "\n".join(entry.model_dump_json() for entry in [item("a"), item("b")])
    items_path.write_text(item_lines, encoding="utf-8")
    labels_path.write_text(
        "\n".join(
            EvalLabel(
                item_id=item_id,
                relevance_grade=grade,
                needs_full_text=False,
                expected_tags=[],
                redaction_status="public",
                dataset_version="sample-v1",
            ).model_dump_json()
            for item_id, grade in [("a", 2), ("b", 0)]
        ),
        encoding="utf-8",
    )

    args = [
        "--dataset",
        str(items_path),
        "--labels",
        str(labels_path),
        "--baseline",
        "latest-first",
    ]
    assert main(args) == 0
    output = json.loads(capsys.readouterr().out)

    assert output["result"]["candidate_ids"] == ["a", "b"]
    assert output["metrics"]["precision_at_5"] == 0.5


def test_committed_sample_is_versioned_sanitized_and_aligned():
    items = load_items(ROOT / "evals/datasets/items.sample.jsonl")
    labels = load_labels(ROOT / "evals/datasets/labels.sample.jsonl")

    assert len(items) >= 10
    assert len(labels) == len(items)
    assert {item.item_id for item in items} == {label.item_id for label in labels}
    assert {item.dataset_version for item in items} == {"sample-v1"}
    assert {label.dataset_version for label in labels} == {"sample-v1"}
    assert all(label.redaction_status in {"public", "sanitized"} for label in labels)


def test_eval_docs_define_labeling_and_truthful_control_protocol():
    rubric = (ROOT / "docs/evals/labeling-rubric.md").read_text(encoding="utf-8")
    control = (ROOT / "docs/evals/20-minute-control-group.md").read_text(encoding="utf-8")

    for grade in ("Grade 0", "Grade 1", "Grade 2"):
        assert grade in rubric
    assert "needs_full_text" in rubric
    assert "Exact prompt" in control
    assert "not executed" not in control.lower()
    for evidence in (
        "Attempt 1",
        "Attempt 2",
        "Start timestamp",
        "End timestamp",
        "Raw output",
        "Normalized output",
        "87.143",
        '"baseline": "coding-agent-control"',
        '"precision_at_5": 0.8',
        '"ndcg_at_5": 1.0',
    ):
        assert evidence in control
    assert "persistent state" in control.lower()
    assert "production reliability" in control.lower()


def test_quality_and_trajectory_metrics_cover_threshold_boundaries():
    labels = {
        "needed": EvalLabel(
            item_id="needed",
            relevance_grade=2,
            needs_full_text=True,
            expected_tags=[],
            redaction_status="public",
            dataset_version="sample-v1",
        ),
        "unneeded": label("unneeded", grade=0),
        "unneeded-two": label("unneeded-two", grade=1),
    }
    traces = [
        {
            "run_id": "run-1",
            "sequence": 1,
            "item_id": "needed",
            "tool_name": "fetch_full_text",
            "status": "succeeded",
            "latency_ms": 1,
        },
        {
            "run_id": "run-2",
            "sequence": 1,
            "item_id": "unneeded",
            "tool_name": "fetch_full_text",
            "status": "succeeded",
            "latency_ms": 1,
        },
        {
            "run_id": "run-2",
            "sequence": 2,
            "item_id": "unneeded",
            "tool_name": "lookup_recent_topics",
            "status": "succeeded",
            "latency_ms": 1,
        },
        {
            "run_id": "run-2",
            "sequence": 3,
            "item_id": "unneeded",
            "tool_name": "get_preference_evidence",
            "status": "succeeded",
            "latency_ms": 1,
        },
        {
            "run_id": "run-2",
            "sequence": 4,
            "item_id": "unneeded",
            "tool_name": "send_email",
            "status": "failed",
            "latency_ms": 1,
        },
        {"run_id": "incomplete", "tool_name": "lookup_recent_topics"},
    ]

    assert original_link_coverage(
        ["needed", "unneeded"], {"needed": "https://x", "unneeded": ""}
    ) == 0.5
    assert full_text_precision(traces, labels) == 0.5
    assert avoided_full_text_rate(traces, labels) == 0.5
    assert tool_budget_violations(traces) == 1
    assert unauthorized_tool_attempts(traces) == 1
    assert complete_trace_rate(traces) == pytest.approx(5 / 6)


def test_all_baselines_share_candidates_and_emit_auditable_metadata(tmp_path: Path):
    items = [item("a", source="one"), item("b", source="two"), item("c", source="three")]
    labels = [label("a", grade=2), label("b", grade=1), label("c", grade=0)]

    report = run_all_baselines(
        items,
        labels,
        preferences={"interests": ["agent engineering"]},
        output=tmp_path / "all-baselines.json",
    )

    assert {run["baseline"] for run in report["runs"]} == {
        "latest-first",
        "static-one-shot",
        "fixed-structured-workflow",
        "bounded-agent",
    }
    assert all(run["candidate_ids"] == ["a", "b", "c"] for run in report["runs"])
    assert all(len(run["dataset_sha256"]) == 64 for run in report["runs"])
    assert all("latency_ms" in run and "input_tokens" in run for run in report["runs"])
    latest = next(run for run in report["runs"] if run["baseline"] == "latest-first")
    assert latest["quality_targets"]["full_text_precision"] is None
    assert report["framework_exit"]["status"] in {"justified", "simplify"}
    assert json.loads((tmp_path / "all-baselines.json").read_text(encoding="utf-8")) == report


def test_quality_targets_include_exact_boundaries_and_honest_framework_exit():
    metrics = {
        "original_link_coverage": 1.0,
        "full_text_precision": 0.8,
        "avoided_full_text_rate": 0.7,
        "tool_budget_violations": 0,
        "unauthorized_tool_attempts": 0,
        "complete_trace_rate": 1.0,
    }

    assert all(evaluate_quality_targets(metrics).values())
    metrics["full_text_precision"] = 0.799
    assert not evaluate_quality_targets(metrics)["full_text_precision"]

    report = run_all_baselines(
        [item("a"), item("b")],
        [label("a"), label("b")],
        preferences={"interests": ["agent engineering"]},
    )
    assert report["framework_exit"]["criteria"]["trace_shortened_debugging"] is False
    assert report["framework_exit"]["status"] == "simplify"
