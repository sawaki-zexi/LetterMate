import json
from pathlib import Path
from types import SimpleNamespace

from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from typer.testing import CliRunner

from lettermate.cli import app
from lettermate.db.models import AnalysisResult, JobRun, Newsletter, NewsletterItem, Source
from lettermate.sources.config_loader import load_sources

ROOT = Path(__file__).resolve().parents[1]


def test_cli_exposes_implemented_workflow_commands():
    result = CliRunner().invoke(app, ["--help"])

    assert result.exit_code == 0
    assert "sync-sources" in result.stdout
    assert "collect" in result.stdout
    assert "analyze" in result.stdout
    assert "newsletter" in result.stdout
    assert "send" in result.stdout
    assert "run-daily" in result.stdout
    assert "scheduler" in result.stdout
    assert "eval" in result.stdout


def test_committed_demo_sources_are_public_and_replaceable():
    sources = load_sources(ROOT / "configs/sources.example.yaml")

    assert len(sources) >= 5
    assert all(str(source.url).startswith("https://") for source in sources)
    assert all("example." not in str(source.url) for source in sources)
    assert "Hacker News Frontpage" in {source.name for source in sources}


def test_eval_command_runs_the_committed_real_eval_service():
    result = CliRunner().invoke(app, ["eval"])

    assert result.exit_code == 0
    payload = json.loads(result.stdout)
    assert payload["result"]["baseline"] == "latest-first"
    assert "ndcg_at_5" in payload["metrics"]


def test_default_sync_and_analyze_commands_use_committed_configs(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'defaults.db'}")
    runner = CliRunner()

    sync_result = runner.invoke(app, ["sync-sources"])
    analyze_result = runner.invoke(app, ["analyze"])

    assert sync_result.exit_code == 0
    assert "status=succeeded" in sync_result.stdout
    assert analyze_result.exit_code == 0
    assert "status=succeeded" in analyze_result.stdout


def test_single_stage_command_exits_nonzero_for_a_failed_job(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'failed-send.db'}")

    result = CliRunner().invoke(
        app,
        ["send", "--issue-date", "2026-07-23", "--dry-run"],
    )

    assert result.exit_code == 1
    assert "status=failed" in result.stdout


def test_run_daily_literal_initializes_schema_and_never_opens_smtp(
    tmp_path: Path, monkeypatch
):
    database_path = tmp_path / "cli.db"
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{database_path}")
    smtp_calls = 0

    def fail_if_smtp_is_created(*_args: object, **_kwargs: object) -> object:
        nonlocal smtp_calls
        smtp_calls += 1
        raise AssertionError("dry-run must not construct an SMTP connection")

    monkeypatch.setattr("smtplib.SMTP", fail_if_smtp_is_created)

    result = CliRunner().invoke(
        app,
        [
            "run-daily",
            "--feed-fixture",
            str(ROOT / "configs/demo-feed.xml"),
            "--dry-run",
        ],
    )

    assert result.exit_code == 0, result.stdout
    assert "idempotency_key=daily:" in result.stdout
    assert result.stdout.count("status=succeeded") == 5
    assert smtp_calls == 0
    engine = create_engine(f"sqlite:///{database_path}", future=True)
    with Session(engine) as session:
        assert session.query(JobRun).count() == 5
        assert session.query(Source).count() == 5
        assert session.query(AnalysisResult).count() == 1
        assert session.query(Newsletter).count() == 1
        assert session.query(NewsletterItem).count() == 1
    engine.dispose()


def test_run_daily_prints_a_failed_dependency_without_masking_it(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'failed-cli.db'}")
    stages = (
        SimpleNamespace(job_id=1, status="succeeded", details={"sources": 2}, warnings=()),
        SimpleNamespace(job_id=2, status="failed", details={}, warnings=()),
    )
    monkeypatch.setattr(
        "lettermate.cli.run_daily",
        lambda *_args, **_kwargs: SimpleNamespace(
            issue_date=__import__("datetime").date(2026, 7, 23),
            idempotency_key="daily:2026-07-23",
            stages=stages,
        ),
    )

    result = CliRunner().invoke(
        app,
        [
            "run-daily",
            "--feed-fixture",
            str(ROOT / "configs/demo-feed.xml"),
            "--dry-run",
        ],
    )

    assert result.exit_code == 1
    assert "stage=collect job=2 status=failed" in result.stdout
    assert not isinstance(result.exception, ValueError)
