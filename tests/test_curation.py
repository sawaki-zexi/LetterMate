import pytest
from pydantic import ValidationError

from lettermate.curation.provider import FakeCurationProvider
from lettermate.curation.schemas import CurationOutput, CurationRequest


def request() -> CurationRequest:
    return CurationRequest(
        item_id=1,
        title="Bounded agents",
        excerpt="Structured output and deterministic ranking.",
        url="https://example.com/agents",
        preferences=["agent engineering"],
        available_evidence_ids=["feed:1"],
    )


def test_curation_output_enforces_score_confidence_and_evidence_contract():
    with pytest.raises(ValidationError):
        CurationOutput(
            summary="Summary",
            tags=["agents"],
            semantic_score=6,
            recommendation="include",
            reason="Relevant",
            evidence_references=["feed:1"],
            confidence=0.8,
            available_evidence_ids=["feed:1"],
        )
    with pytest.raises(ValidationError, match="unknown evidence"):
        CurationOutput(
            summary="Summary",
            tags=["agents"],
            semantic_score=5,
            recommendation="include",
            reason="Relevant",
            evidence_references=["missing"],
            confidence=0.8,
            available_evidence_ids=["feed:1"],
        )


def test_fake_provider_is_deterministic_and_exposes_metadata():
    provider = FakeCurationProvider()

    first = provider.curate(request())
    second = provider.curate(request())

    assert first == second
    assert first.semantic_score in range(1, 6)
    assert provider.model == "fake-local"
    assert provider.prompt_version == "curation-v1"
