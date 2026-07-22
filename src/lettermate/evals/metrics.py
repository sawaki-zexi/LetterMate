import math
from collections.abc import Mapping, Sequence

TOP_K = 5


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
