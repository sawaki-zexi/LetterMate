from dataclasses import dataclass
from datetime import date
from html import escape


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
    feedback_urls: dict[str, str]


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
