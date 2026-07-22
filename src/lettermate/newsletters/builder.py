from collections.abc import Mapping
from dataclasses import dataclass, replace
from datetime import date, datetime
from html import escape

from lettermate.preferences.service import build_feedback_urls
from lettermate.preferences.signing import FeedbackSigner


@dataclass(frozen=True)
class NewsletterEntry:
    content_item_id: int
    decision_id: int
    position: int
    section: str
    final_score: float
    title: str
    source: str
    url: str
    summary: str
    reason: str
    confidence: float
    feedback_urls: Mapping[str, str]


@dataclass(frozen=True)
class NewsletterMembership:
    content_item_id: int
    decision_id: int
    position: int
    section: str
    final_score: float


@dataclass(frozen=True)
class BuiltNewsletter:
    title: str
    markdown_body: str
    html_body: str
    memberships: tuple[NewsletterMembership, ...]


def attach_signed_feedback(
    entries: list[NewsletterEntry],
    *,
    issue_id: int,
    signer: FeedbackSigner,
    base_url: str,
    expires_at: datetime,
) -> list[NewsletterEntry]:
    return [
        replace(
            entry,
            feedback_urls=build_feedback_urls(
                signer=signer,
                base_url=base_url,
                issue_id=issue_id,
                item_id=entry.content_item_id,
                expires_at=expires_at,
            ),
        )
        for entry in entries
    ]


def build_newsletter(issue_date: date, entries: list[NewsletterEntry]) -> BuiltNewsletter:
    if len(entries) > 5:
        raise ValueError("newsletter may contain at most five items")
    ordered = sorted(entries, key=lambda entry: entry.position)
    positions = [entry.position for entry in ordered]
    if positions != list(range(1, len(ordered) + 1)):
        raise ValueError("newsletter positions must be contiguous from one")
    title = f"LetterMate Daily - {issue_date.isoformat()}"
    markdown_lines = [f"# {title}", ""]
    html_items: list[str] = []
    for entry in ordered:
        markdown_lines.extend(
            [
                f"## {entry.position}. {entry.title}",
                f"Source: {entry.source}",
                entry.summary,
                f"Why: {entry.reason}",
                f"Original: {entry.url}",
                " ".join(f"[{action}]({url})" for action, url in entry.feedback_urls.items()),
                "",
            ]
        )
        feedback = " ".join(
            f'<a href="{escape(url, quote=True)}">{escape(action)}</a>'
            for action, url in entry.feedback_urls.items()
        )
        html_items.append(
            "<article>"
            f"<h2>{entry.position}. {escape(entry.title)}</h2>"
            f"<p><strong>{escape(entry.source)}</strong></p>"
            f"<p>{escape(entry.summary)}</p>"
            f"<p>{escape(entry.reason)}</p>"
            "<p>"
            f'<a href="{escape(entry.url, quote=True)}" rel="noopener noreferrer">Original</a>'
            "</p>"
            f"<p>{feedback}</p>"
            "</article>"
        )
    return BuiltNewsletter(
        title=title,
        markdown_body="\n".join(markdown_lines).strip() + "\n",
        html_body=f"<h1>{escape(title)}</h1>" + "".join(html_items),
        memberships=tuple(
            NewsletterMembership(
                content_item_id=entry.content_item_id,
                decision_id=entry.decision_id,
                position=entry.position,
                section=entry.section,
                final_score=entry.final_score,
            )
            for entry in ordered
        ),
    )
