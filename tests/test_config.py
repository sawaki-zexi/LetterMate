from pytest import MonkeyPatch

from lettermate.config import Settings, get_settings


def test_settings_use_fake_and_dry_run_defaults(monkeypatch: MonkeyPatch):
    for env_name in (
        "LLM_PROVIDER",
        "LLM_MODEL",
        "EMAIL_DRY_RUN",
        "SMTP_HOST",
        "SMTP_PORT",
    ):
        monkeypatch.delenv(env_name, raising=False)

    settings = Settings(_env_file=None)

    assert settings.llm_provider == "fake"
    assert settings.llm_model == "fake-local"
    assert settings.email_dry_run is True
    assert settings.smtp_host == "localhost"
    assert settings.smtp_port == 1025


def test_get_settings_returns_settings_instance():
    settings = get_settings()

    assert isinstance(settings, Settings)
