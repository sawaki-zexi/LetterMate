from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_container_image_installs_the_wheel_and_includes_runtime_migrations():
    dockerfile = (ROOT / "Dockerfile").read_text(encoding="utf-8")

    assert "python:3.12-slim" in dockerfile
    assert "python -m build" in dockerfile
    assert "pip install" in dockerfile
    assert "migrations" in dockerfile
    assert "configs" in dockerfile


def test_compose_runs_one_postgres_backed_web_and_worker_stack():
    compose = (ROOT / "docker-compose.yml").read_text(encoding="utf-8")

    for service in ("db:", "migrate:", "web:", "worker:"):
        assert service in compose
    assert "postgres:17" in compose
    assert "service_healthy" in compose
    assert "service_completed_successfully" in compose
    assert "DATABASE_URL: ${DATABASE_URL:?" in compose
    assert '"alembic", "upgrade", "head"' in compose
    assert '"lettermate", "scheduler"' in compose
    for setting in ("OPENAI_API_KEY", "SMTP_PASSWORD", "SMTP_TO", "SCHEDULER_TIMEZONE"):
        assert setting in compose
    worker = compose.split("worker:\n", 1)[1]
    assert "healthcheck:" in worker
    assert "select 1" in worker
    assert "restart: unless-stopped" in worker
