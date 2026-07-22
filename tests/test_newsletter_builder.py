from datetime import date

from lettermate.newsletters.builder import NewsletterEntry, build_newsletter


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
