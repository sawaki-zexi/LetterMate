# LetterMate

LetterMate is an early-stage personal intelligence agent for newsletter curation.

## Current status

This checkpoint implements exactly four foundations:

- Pydantic Settings and environment-based configuration
- SQLAlchemy database models and session foundations
- A Repository for the currently supported persistence operations
- YAML source and preference configuration loading

The end-to-end workflow is incomplete. Collection, analysis, newsletter generation, delivery,
the API, and the dashboard are not finished. The bounded curation Agent, formal Eval evidence,
and deployment are also not complete, so this repository does not yet claim those capabilities.

The authoritative product requirements are the
[LetterMate Agentic Product Requirements V2](docs/lettermate-agentic-product-requirements-v2.md),
and active implementation work follows the
[LetterMate Agentic MVP V3 implementation plan](docs/superpowers/plans/2026-07-21-lettermate-agentic-mvp-v3-implementation-plan.md).
The earlier V2 vertical-slice plan is retained only as historical planning context.

## Development setup

LetterMate requires Python 3.12. From PowerShell:

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\python.exe -m pip install -e ".[dev]"
.\.venv\Scripts\python.exe -m pytest -q
```
