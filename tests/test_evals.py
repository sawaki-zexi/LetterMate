import json
import math
from datetime import UTC, datetime
from pathlib import Path

import pytest
from pydantic import ValidationError

from lettermate.evals.baselines import latest_first, static_one_shot, write_result
from lettermate.evals.metrics import (
    duplicate_rate,
    ndcg_at_5,
    precision_at_5,
    source_diversity,
    useful_rate,
)
from lettermate.evals.runner import evaluate_result, main
from lettermate.evals.schemas import (
    BaselineResult,
    EvalItem,
    EvalLabel,
    RankedItem,
    load_items,
    load_labels,
)

ROOT = Path(__file__).resolve().parents[1]


def item(item_id: str, *, hour: int = 0, source: str = "source-a") -> EvalItem:
    return EvalItem(
        item_id=item_id,
        source=source,
        title=f"Title {item_id}",
        url=f"https://example.com/{item_id}",
        excerpt="A public, synthetic excerpt with enough context.",
        published_at=datetime(2026, 7, 20, hour, tzinfo=UTC),
        dataset_version="sample-v1",
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


def test_latest_first_is_stable_for_tied_times_and_limits_to_five():
    items = [item("b", hour=2), item("a", hour=2), item("old", hour=1)]

    result = latest_first(items, limit=2)

    assert result.candidate_ids == ["b", "a", "old"]
    assert [entry.item_id for entry in result.ranked_items] == ["a", "b"]
    assert result.baseline == "latest-first"


def test_baselines_reject_empty_candidate_sets():
    with pytest.raises(ValueError, match="at least one candidate"):
        latest_first([])


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
    assert "not executed" in control.lower()
    assert "elapsed" in control.lower()
    assert "persistent state" in control.lower()
    assert "precision_at_5" in control
    assert "production reliability" in control.lower()
