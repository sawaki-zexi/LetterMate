import nh3

_ALLOWED_TAGS = frozenset(
    {"a", "blockquote", "br", "code", "em", "li", "ol", "p", "pre", "strong", "ul"}
)
_ALLOWED_ATTRIBUTES = {"a": {"href", "target", "title"}}


def clean_html(value: str) -> str:
    """Return inert, presentation-safe feed HTML."""
    return nh3.clean(
        value,
        tags=set(_ALLOWED_TAGS),
        attributes=_ALLOWED_ATTRIBUTES,
        link_rel="noopener noreferrer",
        url_schemes={"http", "https", "mailto"},
    )
