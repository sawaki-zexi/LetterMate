import pytest
from pydantic import ValidationError

from lettermate.curation.provider import FakeCurationProvider
from lettermate.curation.schemas import CurationOutput, CurationRequest
from lettermate.curation.service import CurationService
from lettermate.db.repository import ContentInput, Repository
from lettermate.ranking.policy import RankingPolicy


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


def test_curation_service_persists_semantic_output_but_ranking_owns_inclusion(temp_db_session):
    repository = Repository(temp_db_session)
    source = repository.create_source(
        "Example", "blog", "rss", "https://example.com/feed.xml", ["agents"]
    )
    repository.upsert_content_item(
        ContentInput(
            source_id=source.id,
            external_id="one",
            title="Agent engineering notes",
            url="https://example.com/one",
            author="",
            published_at=None,
            raw_content="A useful agent engineering update.",
        )
    )
    repository.create_preference_snapshot(
        explicit_interests=["agent engineering"],
        exclusions=[],
        tag_weights={"agent engineering": 1},
        source_weights={str(source.id): 1},
        feedback_cutoff=None,
    )
    service = CurationService(
        repository,
        provider=FakeCurationProvider(),
        ranking_policy=RankingPolicy(item_limit=5, minimum_score=4),
    )

    analyses = service.analyze_pending(now=None)

    assert len(analyses) == 1
    analysis = analyses[0]
    assert analysis.semantic_score == 4
    assert analysis.preference_boost == 2
    assert analysis.source_diversity_adjustment == 0.25
    assert analysis.final_score == 6.25
    assert analysis.should_include is True
    assert analysis.decision == "include"
