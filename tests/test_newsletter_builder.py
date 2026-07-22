from datetime import UTC, date, datetime, timedelta
from urllib.parse import parse_qs, urlparse

from lettermate.newsletters.builder import (
    NewsletterEntry,
    attach_signed_feedback,
    build_newsletter,
)
from lettermate.preferences.signing import FeedbackSigner


def entry(position: int, *, title: str = "Agent update") -> NewsletterEntry:
    return NewsletterEntry(
        content_item_id=position,
        decision_id=position,
        position=position,
        section="Top picks",
        final_score=5.0 - position / 10,
        title=title,
        source="Example Source",
        url=f"https://example.com/{position}",
        summary="A useful summary.",
        reason="Matches agent engineering interests.",
        confidence=0.9,
        feedback_urls={
            "useful": "https://feedback/useful",
            "not_interested": "https://feedback/no",
            "saved": "https://feedback/save",
        },
    )


def test_builder_generates_ordered_safe_markdown_html_and_membership():
    result = build_newsletter(date(2026, 7, 20), [entry(2), entry(1, title="<unsafe>")])

    assert result.title == "LetterMate Daily - 2026-07-20"
    assert result.markdown_body.index("<unsafe>") < result.markdown_body.index("Agent update")
    assert "https://example.com/1" in result.markdown_body
    assert "&lt;unsafe&gt;" in result.html_body
    assert "https://feedback/useful" in result.html_body
    assert [member.position for member in result.memberships] == [1, 2]


def test_builder_rejects_more_than_five_or_non_contiguous_entries():
    entries = [entry(position) for position in range(1, 7)]

    try:
        build_newsletter(date(2026, 7, 20), entries)
    except ValueError as error:
        assert "five" in str(error)
    else:
        raise AssertionError("expected item limit validation")


def test_signed_feedback_is_attached_to_every_newsletter_membership():
    signer = FeedbackSigner("test-secret")
    expires_at = datetime(2026, 7, 27, 3, tzinfo=UTC)
    unsigned = [entry(2), entry(1)]

    signed = attach_signed_feedback(
        unsigned,
        issue_id=42,
        signer=signer,
        base_url="https://letters.example/feedback",
        expires_at=expires_at,
    )
    built = build_newsletter(date(2026, 7, 22), signed)

    assert [item.content_item_id for item in signed] == [2, 1]
    assert "token=" in built.html_body
    for item in signed:
        assert set(item.feedback_urls) == {"useful", "not_interested", "saved"}
        for action, url in item.feedback_urls.items():
            token = parse_qs(urlparse(url).query)["token"][0]
            payload = signer.verify(token, now=expires_at - timedelta(seconds=1))
            assert payload.issue_id == 42
            assert payload.item_id == item.content_item_id
            assert payload.action == action
