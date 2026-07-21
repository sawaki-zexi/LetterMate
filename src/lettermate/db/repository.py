from dataclasses import dataclass
from datetime import date, datetime
from hashlib import sha256

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from lettermate.db.models import AnalysisResult, ContentItem, Newsletter, Source


@dataclass(frozen=True)
class ContentInput:
    source_id: int
    external_id: str
    title: str
    url: str
    author: str
    published_at: datetime | None
    raw_content: str


def make_content_hash(title: str, url: str, raw_content: str) -> str:
    payload = f"{title.strip()}|{url.strip()}|{raw_content.strip()}".encode()
    return sha256(payload).hexdigest()


class Repository:
    def __init__(self, session: Session) -> None:
        self.session = session

    def create_source(
        self,
        name: str,
        platform: str,
        source_type: str,
        url: str,
        tags: list[str],
        enabled: bool = True,
    ) -> Source:
        source = Source(
            name=name,
            platform=platform,
            source_type=source_type,
            url=url,
            tags=tags,
            enabled=enabled,
        )
        self.session.add(source)
        self.session.commit()
        return source

    def list_enabled_sources(self) -> list[Source]:
        statement = select(Source).where(Source.enabled.is_(True)).order_by(Source.id)
        return list(self.session.scalars(statement))

    def upsert_content_item(self, item: ContentInput) -> ContentItem:
        content_hash = make_content_hash(item.title, item.url, item.raw_content)
        existing = self.session.scalar(select(ContentItem).where(ContentItem.url == item.url))
        if existing is not None:
            return existing

        model = ContentItem(
            source_id=item.source_id,
            external_id=item.external_id,
            title=item.title,
            url=item.url,
            author=item.author,
            published_at=item.published_at,
            raw_content=item.raw_content,
            content_hash=content_hash,
            status="pending_analysis",
        )
        self.session.add(model)
        try:
            self.session.commit()
        except IntegrityError:
            self.session.rollback()
            duplicate = self.session.scalar(
                select(ContentItem).where(ContentItem.content_hash == content_hash)
            )
            if duplicate is None:
                duplicate = self.session.scalar(
                    select(ContentItem).where(ContentItem.url == item.url)
                )
            if duplicate is None:
                raise
            return duplicate
        return model

    def count_content_items(self) -> int:
        return len(list(self.session.scalars(select(ContentItem.id))))

    def list_pending_analysis_items(self, limit: int) -> list[ContentItem]:
        statement = (
            select(ContentItem)
            .where(ContentItem.status == "pending_analysis")
            .order_by(ContentItem.created_at)
            .limit(limit)
        )
        return list(self.session.scalars(statement))

    def save_analysis(
        self,
        item: ContentItem,
        summary: str,
        tags: list[str],
        score: int,
        reason: str,
        actionable_insight: str,
        should_include: bool,
        model: str,
    ) -> AnalysisResult:
        analysis = AnalysisResult(
            content_item_id=item.id,
            summary=summary,
            tags=tags,
            score=score,
            reason=reason,
            actionable_insight=actionable_insight,
            should_include=should_include,
            model=model,
        )
        item.status = "analyzed"
        self.session.add(analysis)
        self.session.commit()
        return analysis

    def save_newsletter(
        self,
        issue_date: date,
        title: str,
        markdown_body: str,
        html_body: str,
        status: str,
    ) -> Newsletter:
        newsletter = Newsletter(
            issue_date=issue_date,
            title=title,
            markdown_body=markdown_body,
            html_body=html_body,
            status=status,
        )
        self.session.add(newsletter)
        self.session.commit()
        return newsletter
