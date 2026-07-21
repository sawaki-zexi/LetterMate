from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    database_url: str = Field(default="sqlite:///./data/lettermate.db")
    app_env: str = Field(default="local")
    log_level: str = Field(default="INFO")

    llm_provider: str = Field(default="fake")
    llm_model: str = Field(default="fake-local")
    openai_api_key: str = Field(default="")

    smtp_host: str = Field(default="localhost")
    smtp_port: int = Field(default=1025)
    smtp_username: str = Field(default="")
    smtp_password: str = Field(default="")
    smtp_from: str = Field(default="lettermate@example.com")
    smtp_to: str = Field(default="you@example.com")
    smtp_use_tls: bool = Field(default=False)
    email_dry_run: bool = Field(default=True)

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")


def get_settings() -> Settings:
    return Settings()
