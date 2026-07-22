from typing import Self

from pydantic import Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    database_url: str = Field(default="sqlite:///./data/lettermate.db")
    app_env: str = Field(default="local")
    log_level: str = Field(default="INFO")

    llm_provider: str = Field(default="fake")
    llm_model: str = Field(default="fake-local")
    openai_api_key: str = Field(default="")
    curation_max_turns: int = Field(default=4, ge=1, le=8)
    curation_timeout_seconds: float = Field(default=30.0, gt=0, le=120)
    curation_minimum_confidence: float = Field(default=0.6, ge=0, le=1)

    smtp_host: str = Field(default="localhost")
    smtp_port: int = Field(default=1025)
    smtp_username: str = Field(default="")
    smtp_password: str = Field(default="")
    smtp_from: str = Field(default="lettermate@example.com")
    smtp_to: str = Field(default="you@example.com")
    smtp_use_tls: bool = Field(default=False)
    email_dry_run: bool = Field(default=True)

    feedback_signing_secret: str = Field(default="dev-only-change-me")
    feedback_base_url: str = Field(default="http://localhost:8000/feedback")
    feedback_token_ttl_hours: int = Field(default=168, gt=0)
    feedback_useful_weight: int = Field(default=1)
    feedback_saved_weight: int = Field(default=2)
    feedback_not_interested_weight: int = Field(default=-2)

    owner_api_token: str = Field(default="local-owner-token")
    scheduler_token: str = Field(default="local-scheduler-token")
    scheduler_timezone: str = Field(default="UTC")
    scheduler_collect_interval_minutes: int = Field(default=30, ge=5, le=1440)
    scheduler_daily_hour: int = Field(default=8, ge=0, le=23)
    scheduler_daily_minute: int = Field(default=0, ge=0, le=59)
    scheduler_recovery_window_minutes: int = Field(default=90, ge=1, le=1440)
    scheduler_claim_stale_minutes: int = Field(default=15, ge=1, le=1440)

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")

    @property
    def feedback_action_weights(self) -> dict[str, int]:
        return {
            "useful": self.feedback_useful_weight,
            "saved": self.feedback_saved_weight,
            "not_interested": self.feedback_not_interested_weight,
        }

    @model_validator(mode="after")
    def validate_feedback_secret(self) -> Self:
        is_local = self.app_env.lower() in {"development", "local", "test"}
        if not is_local and (
            self.feedback_signing_secret == "dev-only-change-me"
            or len(self.feedback_signing_secret) < 32
        ):
            raise ValueError(
                "feedback signing secret must be configured with at least 32 characters"
            )
        if not self.owner_api_token or not self.scheduler_token:
            raise ValueError("owner and scheduler tokens must be configured")
        if not is_local and (
            self.owner_api_token == "local-owner-token"
            or self.scheduler_token == "local-scheduler-token"
            or len(self.owner_api_token) < 32
            or len(self.scheduler_token) < 32
        ):
            raise ValueError("owner and scheduler tokens must be at least 32 characters")
        return self


def get_settings() -> Settings:
    return Settings()
