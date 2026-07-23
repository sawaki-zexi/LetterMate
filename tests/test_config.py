import pytest
from pydantic import ValidationError
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


def test_feedback_settings_expose_configurable_weights_and_expiry():
    settings = Settings(_env_file=None)

    assert settings.feedback_action_weights == {
        "useful": 1,
        "saved": 2,
        "not_interested": -2,
    }
    assert settings.feedback_token_ttl_hours == 168
    assert settings.feedback_base_url == "http://localhost:8000/feedback"


def test_production_rejects_default_or_short_feedback_secrets():
    with pytest.raises(ValidationError, match="feedback signing secret"):
        Settings(app_env="production", _env_file=None)
    with pytest.raises(ValidationError, match="feedback signing secret"):
        Settings(
            app_env="production",
            feedback_signing_secret="short",
            _env_file=None,
        )

    settings = Settings(
        app_env="production",
        feedback_signing_secret="a-secure-production-feedback-secret",
        owner_api_token="a-long-unpredictable-owner-token-value",
        scheduler_token="a-long-unpredictable-scheduler-token-value",
        _env_file=None,
    )

    assert len(settings.feedback_signing_secret) >= 32


def test_production_rejects_default_or_short_owner_and_scheduler_tokens():
    secure_feedback_secret = "a-secure-production-feedback-secret"
    with pytest.raises(ValidationError, match="owner and scheduler tokens"):
        Settings(
            app_env="production",
            feedback_signing_secret=secure_feedback_secret,
            _env_file=None,
        )
    with pytest.raises(ValidationError, match="owner and scheduler tokens"):
        Settings(
            app_env="production",
            feedback_signing_secret=secure_feedback_secret,
            owner_api_token="short",
            scheduler_token="also-short",
            _env_file=None,
        )

    settings = Settings(
        app_env="production",
        feedback_signing_secret=secure_feedback_secret,
        owner_api_token="a-long-unpredictable-owner-token-value",
        scheduler_token="a-long-unpredictable-scheduler-token-value",
        _env_file=None,
    )

    assert len(settings.owner_api_token) >= 32
    assert len(settings.scheduler_token) >= 32


def test_settings_reject_unknown_or_unconfigured_live_curation_provider(monkeypatch: MonkeyPatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)

    with pytest.raises(ValidationError, match="LLM_PROVIDER"):
        Settings(llm_provider="unsupported", _env_file=None)
    with pytest.raises(ValidationError, match="OPENAI_API_KEY"):
        Settings(llm_provider="openai", _env_file=None)
    with pytest.raises(ValidationError, match="OPENAI_API_KEY"):
        Settings(
            llm_provider="openai",
            openai_api_key="   ",
            _env_file=None,
        )
