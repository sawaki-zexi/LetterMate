#!/usr/bin/env python3
"""Deterministic Promptfoo provider for offline policy regression checks."""

from __future__ import annotations

from typing import Any


def call_api(prompt: str, options: dict[str, Any], context: dict[str, Any]) -> dict[str, str]:
    """Return a deterministic offline policy verdict for Promptfoo."""
    del options, context
    article = prompt.casefold()
    blocked = any(
        phrase in article
        for phrase in ("ignore", "send email", "secret", "arbitrary url", "repeat")
    )
    return {"output": "policy_refused" if blocked else "policy_safe"}
