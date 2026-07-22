from datetime import UTC, datetime

import pytest

from lettermate.sources.cleaner import clean_html
from lettermate.sources.collector import FeedClient, FeedResponse, parse_feed
from lettermate.sources.service import collect_sources


def test_clean_html_removes_active_content_and_marks_links_safe():
    cleaned = clean_html(
        '<p onclick="steal()">Hello <a href="https://example.com" target="_blank">link</a>'
        '<script>alert(1)</script></p>'
    )

    assert "script" not in cleaned.lower()
    assert "onclick" not in cleaned.lower()
    assert 'rel="noopener noreferrer"' in cleaned
    assert "Hello" in cleaned


def test_parse_feed_normalizes_rss_entry_and_sanitizes_markup():
    response = FeedResponse(
        status_code=200,
        content=b'''<?xml version="1.0"?><rss version="2.0"><channel><item>
        <guid>entry-1</guid><title>Example</title><link>https://example.com/post?utm_source=x</link>
        <author>Author</author><pubDate>Mon, 20 Jul 2026 03:00:00 GMT</pubDate>
        <description><![CDATA[<p onclick="x()">Summary<script>x()</script></p>]]></description>
        </item></channel></rss>''',
        etag='"v1"',
        last_modified="Mon, 20 Jul 2026 03:00:00 GMT",
    )

    parsed = parse_feed(response)

    assert parsed.etag == '"v1"'
    assert parsed.last_modified == "Mon, 20 Jul 2026 03:00:00 GMT"
    assert len(parsed.items) == 1
    item = parsed.items[0]
    assert item.external_id == "entry-1"
    assert item.url == "https://example.com/post?utm_source=x"
    assert item.published_at == datetime(2026, 7, 20, 3, tzinfo=UTC)
    assert "script" not in item.raw_content.lower()
    assert "onclick" not in item.raw_content.lower()


def test_parse_feed_rejects_not_modified_response():
    with pytest.raises(ValueError, match="304"):
        parse_feed(FeedResponse(status_code=304, content=b"", etag=None, last_modified=None))


def test_feed_client_sends_conditional_headers_and_enforces_response_limit():
    class FakeHttpClient:
        def __init__(self) -> None:
            self.headers: dict[str, str] | None = None

        def get(self, url: str, *, headers: dict[str, str], timeout: float):
            del url, timeout
            self.headers = headers
            return type(
                "Response",
                (),
                {
                    "status_code": 200,
                    "content": b"feed",
                    "headers": {"ETag": '"v2"', "Last-Modified": "date"},
                },
            )()

    http = FakeHttpClient()
    response = FeedClient(http, max_response_bytes=10).fetch(
        "https://example.com/feed", etag='"v1"', last_modified="old"
    )

    assert http.headers == {"If-None-Match": '"v1"', "If-Modified-Since": "old"}
    assert response.etag == '"v2"'
    assert response.last_modified == "date"


def test_collect_sources_isolates_one_failed_source():
    sources = [(1, "https://example.com/good"), (2, "https://example.com/bad")]

    def fetch(url: str) -> FeedResponse:
        if url.endswith("bad"):
            raise TimeoutError("timed out")
        return FeedResponse(
            status_code=200,
            content=b"<rss version='2.0'><channel><item><title>Good</title>"
            b"<link>https://example.com/post</link></item></channel></rss>",
            etag=None,
            last_modified=None,
        )

    results = collect_sources(sources, fetch=fetch)

    assert [result.source_id for result in results] == [1, 2]
    assert results[0].error is None
    assert len(results[0].items) == 1
    assert results[1].items == ()
    assert results[1].error == "TimeoutError: timed out"
