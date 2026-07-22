from typer.testing import CliRunner

from lettermate.cli import app


def test_cli_exposes_sync_sources_command():
    result = CliRunner().invoke(app, ["--help"])

    assert result.exit_code == 0
    assert "sync-sources" in result.stdout
