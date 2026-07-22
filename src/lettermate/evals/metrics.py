import math
from collections.abc import Mapping, Sequence
from urllib.parse import urlparse

TOP_K = 5
ALLOWED_TOOL_NAMES = {
    "fetch_full_text",
    "lookup_recent_topics",
    "get_preference_evidence",
}


def _top_five(ranked_ids: Sequence[str]) -> Sequence[str]:
    return ranked_ids[:TOP_K]


def precision_at_5(ranked_ids: Sequence[str], grades: Mapping[str, int]) -> float:
    """Return grade-2 selections divided by the number returned, capped at five."""
    selected = _top_five(ranked_ids)
    if not selected:
        return 0.0
    return sum(grades.get(item_id, 0) == 2 for item_id in selected) / len(selected)


def useful_rate(ranked_ids: Sequence[str], grades: Mapping[str, int]) -> float:
    """Return grade-1-or-2 selections divided by the number returned, capped at five."""
    selected = _top_five(ranked_ids)
    if not selected:
        return 0.0
    return sum(grades.get(item_id, 0) >= 1 for item_id in selected) / len(selected)


def _dcg(grades: Sequence[int]) -> float:
    return float(
        sum((2**grade - 1) / math.log2(index + 2) for index, grade in enumerate(grades))
    )


def ndcg_at_5(ranked_ids: Sequence[str], grades: Mapping[str, int]) -> float:
    """Return top-five graded DCG divided by ideal DCG from all labeled candidates."""
    selected = _top_five(ranked_ids)
    if len(set(selected)) != len(selected):
        raise ValueError("ranked IDs must be unique for nDCG")
    selected_grades = [grades.get(item_id, 0) for item_id in selected]
    ideal_grades = sorted(grades.values(), reverse=True)[:TOP_K]
    ideal_dcg = _dcg(ideal_grades)
    if ideal_dcg == 0:
        return 0.0
    return _dcg(selected_grades) / ideal_dcg


def duplicate_rate(ranked_ids: Sequence[str]) -> float:
    """Return repeated occurrences divided by returned selections, capped at five."""
    selected = _top_five(ranked_ids)
    if not selected:
        return 0.0
    return (len(selected) - len(set(selected))) / len(selected)


def source_diversity(sources: Sequence[str]) -> float:
    """Return unique sources divided by returned selections, capped at five."""
    selected = _top_five(sources)
    if not selected:
        return 0.0
    return len(set(selected)) / len(selected)


def original_link_coverage(
    ranked_ids: Sequence[str], item_urls: Mapping[str, str]
) -> float:
    selected = _top_five(ranked_ids)
    if not selected:
        return 0.0
    return sum(
        urlparse(item_urls.get(item_id, "")).scheme in {"http", "https"}
        and bool(urlparse(item_urls.get(item_id, "")).netloc)
        for item_id in selected
    ) / len(selected)


def full_text_precision(
    traces: Sequence[Mapping[str, object]], labels: Mapping[str, object]
) -> float:
    calls = [trace for trace in traces if trace.get("tool_name") == "fetch_full_text"]
    if not calls:
        return 1.0
    return sum(
        bool(getattr(labels.get(str(trace.get("item_id"))), "needs_full_text", False))
        for trace in calls
    ) / len(calls)


def avoided_full_text_rate(
    traces: Sequence[Mapping[str, object]], labels: Mapping[str, object]
) -> float:
    unneeded_ids = {
        item_id
        for item_id, label in labels.items()
        if not bool(getattr(label, "needs_full_text", False))
    }
    if not unneeded_ids:
        return 1.0
    fetched_ids = {
        str(trace.get("item_id"))
        for trace in traces
        if trace.get("tool_name") == "fetch_full_text"
    }
    return len(unneeded_ids - fetched_ids) / len(unneeded_ids)


def tool_budget_violations(traces: Sequence[Mapping[str, object]]) -> int:
    by_run: dict[str, list[Mapping[str, object]]] = {}
    for trace in traces:
        run_id = str(trace.get("run_id", ""))
        by_run.setdefault(run_id, []).append(trace)
    violations = 0
    for run_traces in by_run.values():
        tool_names = [str(trace.get("tool_name", "")) for trace in run_traces]
        if len(tool_names) > 3 or len(tool_names) != len(set(tool_names)):
            violations += 1
    return violations


def unauthorized_tool_attempts(traces: Sequence[Mapping[str, object]]) -> int:
    return sum(str(trace.get("tool_name", "")) not in ALLOWED_TOOL_NAMES for trace in traces)


def complete_trace_rate(traces: Sequence[Mapping[str, object]]) -> float:
    if not traces:
        return 1.0
    required = {"run_id", "sequence", "tool_name", "status", "latency_ms"}
    return sum(required <= set(trace) for trace in traces) / len(traces)
