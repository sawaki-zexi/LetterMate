# Bilingual AGENTS.md Implementation Plan

> **Status:** Completed on 2026-07-23. This is a historical maintenance plan; the active product
> implementation sequence remains `2026-07-21-lettermate-agentic-mvp-v3-implementation-plan.md`.
> Its original four-foundation baseline was superseded when the verified `feature/agentic-mvp`
> implementation was integrated into `master`. Current implementation status is maintained in
> `README.md` and `AGENTS.md`.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a bilingual root `AGENTS.md` that gives coding agents accurate, maintainable LetterMate repository rules.

**Architecture:** Keep stable project invariants and maintenance triggers in the root guide. Link to the active PRD and implementation plan for changing product detail and task order; do not duplicate their full contents. Validate the guide against tracked paths, current configuration, tests, and explicit README status.

**Tech Stack:** Markdown, PowerShell, Git, Python 3.12, pytest, Ruff, mypy, setuptools build.

---

### Task 1: Reconfirm authoritative repository facts

**Files:**
- Read: `README.md`
- Read: `pyproject.toml`
- Read: `docs/lettermate-agentic-product-requirements-v2.md`
- Read: `docs/project-proposal-and-architecture.md`
- Read: `docs/newsletter-assistant-tech-selection.md`
- Read: `docs/superpowers/plans/2026-07-21-lettermate-agentic-mvp-v3-implementation-plan.md`

- [ ] **Step 1: Confirm current implementation status**

Verify that the README still describes only configuration, database foundations, repository operations, and YAML loading as implemented, and explicitly calls the end-to-end workflow incomplete.

- [ ] **Step 2: Confirm commands and runtime**

Verify that `pyproject.toml` requires Python 3.12 and defines pytest, Ruff, mypy, and build-compatible development dependencies.

- [ ] **Step 3: Confirm boundaries to preserve**

Extract the PRD invariants that must appear in the guide: deterministic workflow before bounded Agent autonomy, read-only Agent tools, structured preference memory, safe reruns, private-by-default data handling, and evidence-based evaluation.

### Task 2: Create the bilingual agent guide

**Files:**
- Create: `AGENTS.md`

- [ ] **Step 1: Write project status and source precedence**

State the current implemented scope and link the active PRD, V3 plan, README, architecture, technology-selection, and historical-plan documents. Mark planned features as planned.

- [ ] **Step 2: Write repository and architecture rules**

Document the `src/lettermate` and `tests` responsibilities, configuration through environment/YAML, deterministic business workflow boundaries, SQL-backed feedback/preference state, and the bounded curation Agent permissions.

- [ ] **Step 3: Write development and safety rules**

Include Python 3.12 commands, focused-test guidance, full quality gates, idempotency and failure-isolation requirements, untrusted-content and secret-handling rules, and the prohibition on claiming unsupported Eval or deployment evidence.

- [ ] **Step 4: Write documentation maintenance triggers**

Specify when to update `AGENTS.md`, README, PRD, active plan, ADRs, Eval reports, and pilot evidence. Include a concise pre- and post-change checklist.

### Task 3: Validate and commit the guide

**Files:**
- Test: `AGENTS.md` via repository checks

- [ ] **Step 1: Check Markdown and required links**

Run:

```powershell
git diff --check
Select-String -Path AGENTS.md -Pattern 'docs/lettermate-agentic-product-requirements-v2.md','docs/superpowers/plans/2026-07-21-lettermate-agentic-mvp-v3-implementation-plan.md','pyproject.toml'
```

Expected: no whitespace errors; all three authoritative references are present.

- [ ] **Step 2: Check for unresolved placeholders and stale claims**

Run:

```powershell
$text = Get-Content -Raw -Encoding utf8 AGENTS.md
if ($text -match '\b(TBD|TODO)\b') { throw 'Unresolved placeholder found' }
if ($text -match 'implemented[^\r\n]*(API|dashboard|scheduler|Agent|deployment)') { throw 'Potential stale implementation claim' }
```

Expected: the command exits successfully.

- [ ] **Step 3: Run repository quality gates**

Run:

```powershell
..\..\..\.venv\Scripts\python.exe -m pytest -q
..\..\..\.venv\Scripts\python.exe -m ruff check .
..\..\..\.venv\Scripts\python.exe -m mypy src
..\..\..\.venv\Scripts\python.exe -m build
```

Expected: all commands return exit code 0. The document-only change must not regress the existing Python package.

- [ ] **Step 4: Review the final diff**

Run `git diff -- AGENTS.md` and confirm every rule is bilingual, actionable, scoped to current repository facts, and free of unrelated code changes.

- [ ] **Step 5: Commit**

```powershell
git add AGENTS.md docs/superpowers/plans/2026-07-23-agents-maintenance-implementation-plan.md
git commit -m "docs: add bilingual agent maintenance guide"
```
