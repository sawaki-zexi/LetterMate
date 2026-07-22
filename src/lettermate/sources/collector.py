from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Protocol

import feedparser

from lettermate.sources.cleaner import clean_html


@dataclass(frozen=True)
class FeedResponse:
    status_code: int
    content: bytes
    etag: str | None
    last_modified: str | None


@dataclass(frozen=True)
class CollectedItem:
    external_id: str | None
    title: str
    url: str
    author: str
    published_at: datetime | None
    raw_content: str


@dataclass(frozen=True)
class ParsedFeed:
    items: tuple[CollectedItem, ...]
    etag: str | None
    last_modified: str | None


class HttpResponse(Protocol):
    status_code: int
    content: bytes
    headers: dict[str, str]


class HttpClient(Protocol):
    def get(self, url: str, *, headers: dict[str, str], timeout: float) -> HttpResponse: ...


class FeedClient:
    def __init__(
        self,
        http: HttpClient,
        *,
        timeout_seconds: float = 10.0,
        max_response_bytes: int = 2_000_000,
    ) -> None:
        self._http = http
        self._timeout_seconds = timeout_seconds
        self._max_response_bytes = max_response_bytes

    def fetch(self, url: str, *, etag: str | None, last_modified: str | None) -> FeedResponse:
        headers: dict[str, str] = {}
        if etag:
            headers["If-None-Match"] = etag
        if last_modified:
            headers["If-Modified-Since"] = last_modified
        response = self._http.get(url, headers=headers, timeout=self._timeout_seconds)
        if len(response.content) > self._max_response_bytes:
            raise ValueError("feed response exceeds configured size limit")
        return FeedResponse(
            status_code=response.status_code,
            content=response.content,
            etag=response.headers.get("ETag"),
            last_modified=response.headers.get("Last-Modified"),
        )


def _entry_datetime(entry: object) -> datetime | None:
    published = getattr(entry, "published_parsed", None) or getattr(entry, "updated_parsed", None)
    if published is None:
        return None
    return datetime(
        published.tm_year,
        published.tm_mon,
        published.tm_mday,
        published.tm_hour,
        published.tm_min,
        published.tm_sec,
        tzinfo=UTC,
    )


def _entry_content(entry: object) -> str:
    content = getattr(entry, "content", None)
    if content:
        return str(content[0].get("value", ""))
    return str(getattr(entry, "summary", "") or getattr(entry, "description", ""))


def parse_feed(response: FeedResponse) -> ParsedFeed:
    if response.status_code == 304:
        raise ValueError("cannot parse 304 Not Modified response")
    if response.status_code != 200:
        raise ValueError(f"cannot parse HTTP {response.status_code} response")
    parsed = feedparser.parse(response.content)
    if parsed.bozo and not parsed.entries:
        raise ValueError("feed parsing failed")
    items = tuple(
        CollectedItem(
            external_id=str(entry.get("id") or entry.get("guid") or "") or None,
            title=str(entry.get("title", "")).strip(),
            url=str(entry.get("link", "")).strip(),
            author=str(entry.get("author", "")).strip(),
            published_at=_entry_datetime(entry),
            raw_content=clean_html(_entry_content(entry)),
        )
        for entry in parsed.entries
        if str(entry.get("title", "")).strip() and str(entry.get("link", "")).strip()
    )
    return ParsedFeed(items=items, etag=response.etag, last_modified=response.last_modified)
