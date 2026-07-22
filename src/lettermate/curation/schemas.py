from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, HttpUrl, model_validator


class CurationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    item_id: int = Field(gt=0)
    title: str = Field(min_length=1)
    excerpt: str
    url: HttpUrl
    preferences: list[str] = Field(default_factory=list)
    available_evidence_ids: list[str] = Field(default_factory=list)
    source_url: HttpUrl | None = None
    preference_snapshot_id: int | None = Field(default=None, gt=0)
    preference_snapshot: dict[str, object] = Field(default_factory=dict)
    current_issue_context: dict[str, object] = Field(default_factory=dict)
    prompt_version: str = "curation-v2"


class CurationOutput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    summary: str = Field(min_length=1)
    tags: list[str]
    semantic_score: int = Field(ge=1, le=5, strict=True)
    recommendation: Literal["include", "exclude", "review"]
    reason: str = Field(min_length=1)
    evidence_references: list[str]
    confidence: float = Field(ge=0, le=1, allow_inf_nan=False)
    available_evidence_ids: list[str] = Field(default_factory=list, exclude=True)
    model_identifier: str | None = None
    agent_run_id: int | None = Field(default=None, exclude=True)

    @model_validator(mode="after")
    def validate_evidence_references(self) -> "CurationOutput":
        # The SDK constructs structured output before runtime tool evidence can be attached.
        # The provider immediately re-validates with a non-empty allowlist after the run.
        if not self.available_evidence_ids:
            return self
        unknown = set(self.evidence_references) - set(self.available_evidence_ids)
        if unknown:
            raise ValueError(f"unknown evidence reference: {sorted(unknown)[0]}")
        return self
