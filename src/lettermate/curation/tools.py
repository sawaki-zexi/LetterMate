"""Read-only, SSRF-resistant tools exposed to the curation agent."""

from __future__ import annotations

import ipaddress
import re
import socket
from collections.abc import Callable
from typing import Any, cast

import httpx
from bs4 import BeautifulSoup

from lettermate.curation.tracing import TraceRecorder


class ToolError(RuntimeError):
    error_category = "tool_error"


class ToolSecurityError(ToolError):
    error_category = "tool_security"


class ToolBudgetError(ToolError):
    error_category = "tool_budget"


class CurationTools:
    MAX_CALLS = 3
    MAX_REDIRECTS = 3
    MAX_BYTES = 1_000_000
    MAX_TEXT_CHARS = 20_000
    MAX_ITEMS = 5
    ALLOWED_CONTENT_TYPES = {"text/html", "application/xhtml+xml", "text/plain"}

    def __init__(
        self,
        context: Any,
        *,
        client: Any = None,
        resolver: Callable[[str], list[str]] | None = None,
        tracer: TraceRecorder | None = None,
        timeout: float = 5.0,
    ) -> None:
        self.context = context
        self.client = client or httpx.Client(follow_redirects=False, timeout=timeout)
        self.resolver = resolver or _resolve_host
        self.tracer = tracer or TraceRecorder()
        self.timeout = timeout
        self._attempts = 0
        self._used_tools: set[str] = set()
        self.evidence_ids: set[str] = set()

    def fetch_full_text(self, url: str) -> str:
        return cast(
            str,
            self._invoke(
            "fetch_full_text",
            {"url": url},
            f"host={_safe_host(url)}",
            lambda: self._fetch(url),
            ),
        )

    def lookup_recent_topics(self, query: str = "") -> list[dict[str, Any]]:
        return cast(
            list[dict[str, Any]],
            self._invoke(
            "lookup_recent_topics",
            {"query": query},
            f"query_length={len(query)}",
            lambda: self._lookup_topics(query),
            ),
        )

    def get_preference_evidence(self, topic: str = "") -> list[dict[str, Any]]:
        return cast(
            list[dict[str, Any]],
            self._invoke(
            "get_preference_evidence",
            {"topic": topic},
            f"topic_length={len(topic)}",
            lambda: self._lookup_evidence(topic),
            ),
        )

    def _invoke(
        self,
        name: str,
        arguments: dict[str, Any],
        summary: str,
        operation: Callable[[], Any],
    ) -> Any:
        self._attempts += 1
        if self._attempts > self.MAX_CALLS:
            error = ToolBudgetError(f"tool budget exceeded ({self.MAX_CALLS})")
            error.error_category = "tool_budget"
            return self.tracer.call(
                name, arguments, lambda: _raise(error), argument_summary=summary
            )
        if name in self._used_tools:
            error = ToolBudgetError(f"duplicate tool call: {name}")
            error.error_category = "tool_duplicate"
            return self.tracer.call(
                name, arguments, lambda: _raise(error), argument_summary=summary
            )
        self._used_tools.add(name)
        return self.tracer.call(name, arguments, operation, argument_summary=summary)

    def _fetch(self, url: str) -> str:
        current = url
        for _redirect in range(self.MAX_REDIRECTS + 1):
            parsed = _validate_url(current, self.context)
            _validate_dns(parsed.host or "", self.resolver)
            response = self.client.get(current, follow_redirects=False, timeout=self.timeout)
            if 300 <= response.status_code < 400:
                location = response.headers.get("location")
                if not location:
                    raise ToolSecurityError("redirect missing location")
                current = str(parsed.join(location))
                continue
            if response.status_code >= 400:
                raise ToolError(f"content request failed with status {response.status_code}")
            content_type = response.headers.get("content-type", "").split(";", 1)[0].strip().lower()
            if content_type not in self.ALLOWED_CONTENT_TYPES:
                raise ToolError(f"unsupported content type: {content_type or 'missing'}")
            declared_length = response.headers.get("content-length")
            if declared_length is not None:
                try:
                    if int(declared_length) > self.MAX_BYTES:
                        raise ToolError("content exceeds byte limit")
                except ValueError as error:
                    raise ToolError("invalid content length") from error
            body = response.content
            if len(body) > self.MAX_BYTES:
                raise ToolError("content exceeds byte limit")
            if content_type == "text/plain":
                text = body.decode(response.encoding or "utf-8", errors="replace")
            else:
                soup = BeautifulSoup(body, "html.parser")
                for node in soup(["script", "style", "noscript", "template"]):
                    node.decompose()
                text = soup.get_text(" ", strip=True)
            return re.sub(r"\s+", " ", text).strip()[: self.MAX_TEXT_CHARS]
        raise ToolSecurityError("redirect limit exceeded")

    def _lookup_topics(self, query: str) -> list[dict[str, Any]]:
        repository = getattr(self.context, "repository", None)
        if repository is None:
            return []
        records = cast(
            list[dict[str, Any]],
            repository.list_recent_topics(query=query, limit=self.MAX_ITEMS),
        )
        self.evidence_ids.update(
            f"item:{record['item_id']}"
            for record in records
            if "item_id" in record
        )
        return records

    def _lookup_evidence(self, topic: str) -> list[dict[str, Any]]:
        repository = getattr(self.context, "repository", None)
        if repository is None:
            return []
        records = cast(
            list[dict[str, Any]],
            repository.list_preference_evidence(topic=topic, limit=self.MAX_ITEMS),
        )
        self.evidence_ids.update(
            f"feedback:{record['feedback_id']}"
            for record in records
            if "feedback_id" in record
        )
        return records


def _raise(error: Exception) -> Any:
    raise error


def _resolve_host(host: str) -> list[str]:
    return list(
        {
            str(result[4][0])
            for result in socket.getaddrinfo(host, None, type=socket.SOCK_STREAM)
        }
    )


def _validate_dns(host: str, resolver: Callable[[str], list[str]]) -> None:
    addresses = resolver(host)
    if not addresses:
        raise ToolSecurityError("hostname did not resolve")
    for address in addresses:
        ip = ipaddress.ip_address(address)
        if (
            ip.is_loopback
            or ip.is_private
            or ip.is_link_local
            or ip.is_reserved
            or ip.is_multicast
            or ip.is_unspecified
        ):
            raise ToolSecurityError("resolved address is not public")


def _validate_url(url: str, context: Any) -> httpx.URL:
    try:
        parsed = httpx.URL(url)
    except Exception as error:
        raise ToolSecurityError("invalid URL") from error
    if parsed.scheme not in {"http", "https"} or parsed.host is None or parsed.userinfo:
        raise ToolSecurityError("only public HTTP(S) URLs are allowed")
    allowed = {
        host.casefold()
        for candidate in (
            getattr(context, "candidate_url", None),
            getattr(context, "source_url", None),
        )
        if candidate
        for host in [httpx.URL(str(candidate)).host]
        if host
    }
    if parsed.host.casefold() not in allowed:
        raise ToolSecurityError("URL host is unrelated to the current item/source")
    return parsed


def _safe_host(url: str) -> str:
    try:
        return httpx.URL(url).host or "invalid"
    except Exception:
        return "invalid"
