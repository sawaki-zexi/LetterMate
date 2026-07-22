from collections.abc import Callable, Sequence
from dataclasses import dataclass

from lettermate.sources.collector import CollectedItem, FeedResponse, parse_feed


@dataclass(frozen=True)
class SourceCollectionResult:
    source_id: int
    items: tuple[CollectedItem, ...]
    etag: str | None = None
    last_modified: str | None = None
    not_modified: bool = False
    error: str | None = None


def collect_sources(
    sources: Sequence[tuple[int, str]],
    *,
    fetch: Callable[[str], FeedResponse],
) -> list[SourceCollectionResult]:
    results: list[SourceCollectionResult] = []
    for source_id, url in sources:
        try:
            response = fetch(url)
            if response.status_code == 304:
                results.append(
                    SourceCollectionResult(source_id=source_id, items=(), not_modified=True)
                )
                continue
            parsed = parse_feed(response)
            results.append(
                SourceCollectionResult(
                    source_id=source_id,
                    items=parsed.items,
                    etag=parsed.etag,
                    last_modified=parsed.last_modified,
                )
            )
        except Exception as error:
            results.append(
                SourceCollectionResult(
                    source_id=source_id,
                    items=(),
                    error=f"{type(error).__name__}: {error}",
                )
            )
    return results
