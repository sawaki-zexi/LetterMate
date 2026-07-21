from datetime import UTC, datetime

from lettermate.db.models import AnalysisResult, ContentItem, Newsletter, Source


def test_create_source_content_analysis_and_newsletter(temp_db_session):
    source = Source(
        name="Example Blog",
        platform="blog",
        source_type="rss",
        url="https://example.com/feed.xml",
        tags=["AI", "Career"],
        enabled=True,
    )
    temp_db_session.add(source)
    temp_db_session.flush()

    item = ContentItem(
        source_id=source.id,
        external_id="entry-1",
        title="Agent engineering notes",
        url="https://example.com/agent",
        author="Example Author",
        published_at=datetime(2026, 6, 26, tzinfo=UTC),
        raw_content="Useful article about agent engineering.",
        content_hash="hash-1",
        status="pending_analysis",
    )
    temp_db_session.add(item)
    temp_db_session.flush()

    analysis = AnalysisResult(
        content_item_id=item.id,
        summary="A short summary.",
        tags=["AI"],
        score=4,
        reason="Relevant to agent engineering.",
        actionable_insight="Add evaluation metrics to the project.",
        should_include=True,
        model="fake-local",
    )
    temp_db_session.add(analysis)

    newsletter = Newsletter(
        issue_date=datetime(2026, 6, 26, tzinfo=UTC).date(),
        title="LetterMate Daily - 2026-06-26",
        markdown_body="# Daily",
        html_body="<h1>Daily</h1>",
        status="draft",
    )
    temp_db_session.add(newsletter)
    temp_db_session.commit()

    assert source.id is not None
    assert item.id is not None
    assert analysis.id is not None
    assert newsletter.id is not None
