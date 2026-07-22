from bs4 import BeautifulSoup

_ALLOWED_TAGS = frozenset(
    {"a", "blockquote", "br", "code", "em", "li", "ol", "p", "pre", "strong", "ul"}
)
_ALLOWED_ATTRIBUTES = {"a": frozenset({"href", "rel", "target", "title"})}


def clean_html(value: str) -> str:
    """Return inert, presentation-safe feed HTML."""
    soup = BeautifulSoup(value, "html.parser")
    for tag in soup.find_all(["script", "style", "iframe", "object", "embed"]):
        tag.decompose()
    for tag in soup.find_all(True):
        if tag.name not in _ALLOWED_TAGS:
            tag.unwrap()
            continue
        allowed = _ALLOWED_ATTRIBUTES.get(tag.name, frozenset())
        for attribute in list(tag.attrs):
            if attribute.lower().startswith("on") or attribute not in allowed:
                del tag.attrs[attribute]
        if tag.name == "a":
            tag["rel"] = "noopener noreferrer"
    return str(soup)
