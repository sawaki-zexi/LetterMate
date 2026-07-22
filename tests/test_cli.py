from typer.testing import CliRunner

from lettermate.cli import app


def test_cli_exposes_implemented_workflow_commands():
    result = CliRunner().invoke(app, ["--help"])

    assert result.exit_code == 0
    assert "sync-sources" in result.stdout
    assert "collect" in result.stdout
    assert "analyze" in result.stdout
    assert "newsletter" in result.stdout
    assert "send" in result.stdout
