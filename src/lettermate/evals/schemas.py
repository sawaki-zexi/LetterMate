from datetime import datetime
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, HttpUrl, model_validator


class EvalItem(BaseModel):
    model_config = ConfigDict(extra="forbid")

    item_id: str = Field(min_length=1)
    source: str = Field(min_length=1)
    title: str = Field(min_length=1)
    url: HttpUrl
    excerpt: str
    published_at: datetime
    dataset_version: str = Field(min_length=1)


class EvalLabel(BaseModel):
    model_config = ConfigDict(extra="forbid")

    item_id: str = Field(min_length=1)
    relevance_grade: int = Field(ge=0, le=2)
    needs_full_text: bool
    expected_tags: list[str]
    redaction_status: Literal["public", "sanitized", "unredacted"]
    dataset_version: str = Field(min_length=1)
    private_notes: str | None = Field(default=None, exclude=True)

    @model_validator(mode="after")
    def reject_unredacted_private_notes(self) -> "EvalLabel":
        if self.redaction_status == "unredacted" or self.private_notes:
            raise ValueError("unredacted private notes are not allowed in Eval labels")
        return self


class RankedItem(BaseModel):
    model_config = ConfigDict(extra="forbid")

    item_id: str = Field(min_length=1)
    score: float
    source: str = Field(min_length=1)


class BaselineResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal["1.0"] = "1.0"
    baseline: str = Field(min_length=1)
    dataset_version: str = Field(min_length=1)
    candidate_ids: list[str]
    ranked_items: list[RankedItem]


def _load_jsonl[RecordT: (EvalItem, EvalLabel)](
    path: Path, model: type[RecordT]
) -> list[RecordT]:
    records: list[RecordT] = []
    seen_ids: set[str] = set()
    with path.open(encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, start=1):
            if not line.strip():
                continue
            record = model.model_validate_json(line)
            if record.item_id in seen_ids:
                raise ValueError(f"duplicate item_id: {record.item_id} (line {line_number})")
            seen_ids.add(record.item_id)
            records.append(record)
    return records


def load_items(path: Path) -> list[EvalItem]:
    return _load_jsonl(path, EvalItem)


def load_labels(path: Path) -> list[EvalLabel]:
    return _load_jsonl(path, EvalLabel)
