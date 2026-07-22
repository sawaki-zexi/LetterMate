import json
from datetime import UTC, datetime
from hashlib import sha256

from pydantic import HttpUrl

from lettermate.curation.provider import CurationProvider
from lettermate.curation.schemas import CurationRequest
from lettermate.db.models import AnalysisResult, ContentItem, PreferenceSnapshot
from lettermate.db.repository import Repository
from lettermate.ranking.policy import RankingCandidate, RankingPolicy


class CurationService:
    def __init__(
        self,
        repository: Repository,
        *,
        provider: CurationProvider,
        ranking_policy: RankingPolicy,
    ) -> None:
        self._repository = repository
        self._provider = provider
        self._ranking_policy = ranking_policy

    def analyze_pending(self, *, now: datetime | None, limit: int = 50) -> list[AnalysisResult]:
        snapshot = self._repository.get_latest_preference_snapshot()
        if snapshot is None:
            raise RuntimeError("analysis requires a preference snapshot")
        items = self._repository.list_pending_analysis_items(limit)
        if not items:
            return []
        recent = self._repository.list_included_analyses(limit=5)
        recent_tags = sorted({tag for analysis in recent for tag in analysis.tags})
        issue_context: dict[str, object] = {
            "recent_item_ids": [analysis.content_item_id for analysis in recent],
            "recent_tags": recent_tags,
        }
        requests = [
            (item, self._request_for(item, snapshot, issue_context)) for item in items
        ]
        outputs = [(item, request, self._provider.curate(request)) for item, request in requests]
        ranked = self._ranking_policy.rank(
            [
                RankingCandidate(
                    item_id=item.id,
                    source_id=item.source_id,
                    published_at=item.published_at,
                    semantic_score=output.semantic_score,
                    tags=output.tags,
                )
                for item, _, output in outputs
            ],
            tag_weights={key: float(value) for key, value in snapshot.tag_weights.items()},
            source_weights={
                int(key): float(value) for key, value in snapshot.source_weights.items()
            },
            recent_tags=set(recent_tags),
            now=now.astimezone(UTC) if now is not None else datetime.now(UTC),
        )
        decisions = {decision.item_id: decision for decision in ranked}
        saved: list[AnalysisResult] = []
        for item, request, output in outputs:
            model = output.model_identifier or self._provider.model
            if output.agent_run_id is None:
                run = self._repository.start_agent_run(
                    content_item_id=item.id,
                    preference_snapshot_id=snapshot.id,
                    prompt_version=self._provider.prompt_version,
                    model=model,
                    input_hash=self._input_hash(request),
                )
                self._repository.complete_agent_run(
                    run.id,
                    semantic_output=output.model_dump(
                        exclude={"available_evidence_ids", "agent_run_id"}
                    ),
                    latency_ms=0,
                    input_tokens=0,
                    output_tokens=0,
                    cost_usd="0",
                )
                agent_run_id = run.id
            else:
                agent_run_id = output.agent_run_id
            decision = decisions[item.id]
            saved.append(
                self._repository.save_analysis(
                    item,
                    summary=output.summary,
                    tags=output.tags,
                    score=output.semantic_score,
                    reason=output.reason,
                    actionable_insight=output.reason,
                    should_include=decision.included,
                    model=model,
                    agent_run_id=agent_run_id,
                    semantic_score=decision.semantic_score,
                    preference_boost=decision.preference_boost,
                    freshness_bonus=decision.freshness_bonus,
                    repetition_penalty=decision.repetition_penalty,
                    source_diversity_adjustment=decision.source_diversity_adjustment,
                    final_score=decision.final_score,
                    decision="include" if decision.included else "exclude",
                )
            )
        return saved

    @staticmethod
    def _request_for(
        item: ContentItem,
        snapshot: PreferenceSnapshot,
        current_issue_context: dict[str, object],
    ) -> CurationRequest:
        return CurationRequest(
            item_id=item.id,
            title=item.title,
            excerpt=item.raw_content,
            url=HttpUrl(item.url),
            preferences=list(snapshot.explicit_interests),
            available_evidence_ids=[f"feed:{item.id}"],
            source_url=HttpUrl(item.source.url),
            preference_snapshot_id=snapshot.id,
            preference_snapshot={
                "id": snapshot.id,
                "version": snapshot.version,
                "content_hash": snapshot.content_hash,
                "explicit_interests": list(snapshot.explicit_interests),
                "exclusions": list(snapshot.exclusions),
                "tag_weights": dict(snapshot.tag_weights),
                "source_weights": dict(snapshot.source_weights),
            },
            current_issue_context=current_issue_context,
        )

    @staticmethod
    def _input_hash(request: CurationRequest) -> str:
        payload = json.dumps(request.model_dump(mode="json"), sort_keys=True, separators=(",", ":"))
        return sha256(payload.encode()).hexdigest()
