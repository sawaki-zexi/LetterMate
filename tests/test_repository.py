from lettermate.db.models import Source
from lettermate.db.repository import ContentInput, Repository


def test_repository_creates_source_and_skips_duplicate_content(temp_db_session):
    repo = Repository(temp_db_session)
    source = repo.create_source(
        name="Example",
        platform="blog",
        source_type="rss",
        url="https://example.com/feed.xml",
        tags=["AI"],
    )

    item_input = ContentInput(
        source_id=source.id,
        external_id="entry-1",
        title="Title",
        url="https://example.com/post",
        author="Author",
        published_at=None,
        raw_content="Body",
    )

    first = repo.upsert_content_item(item_input)
    second = repo.upsert_content_item(item_input)

    assert first.id == second.id
    assert repo.count_content_items() == 1


def test_repository_lists_pending_analysis_items(temp_db_session):
    repo = Repository(temp_db_session)
    source = Source(
        name="Example",
        platform="blog",
        source_type="rss",
        url="https://example.com/feed.xml",
        tags=[],
        enabled=True,
    )
    temp_db_session.add(source)
    temp_db_session.flush()

    repo.upsert_content_item(
        ContentInput(
            source_id=source.id,
            external_id="entry-1",
            title="Title",
            url="https://example.com/post",
            author="Author",
            published_at=None,
            raw_content="Body",
        )
    )

    pending = repo.list_pending_analysis_items(limit=10)

    assert len(pending) == 1
    assert pending[0].status == "pending_analysis"
