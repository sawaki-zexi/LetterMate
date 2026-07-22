from typing import Protocol

from lettermate.curation.schemas import CurationOutput, CurationRequest


class CurationProvider(Protocol):
    model: str
    prompt_version: str

    def curate(self, request: CurationRequest) -> CurationOutput: ...


class FakeCurationProvider:
    model = "fake-local"
    prompt_version = "curation-v1"

    def curate(self, request: CurationRequest) -> CurationOutput:
        haystack = f"{request.title} {request.excerpt}".casefold()
        matches = sum(preference.casefold() in haystack for preference in request.preferences)
        score = min(5, 3 + matches)
        evidence = request.available_evidence_ids[:1]
        return CurationOutput(
            summary=request.excerpt.strip()[:280] or request.title,
            tags=[
                preference
                for preference in request.preferences
                if preference.casefold() in haystack
            ],
            semantic_score=score,
            recommendation="include" if score >= 4 else "review",
            reason="Matches configured interests." if matches else "No explicit interest match.",
            evidence_references=evidence,
            confidence=0.9 if matches else 0.5,
            available_evidence_ids=request.available_evidence_ids,
        )
