from pathlib import Path
from typing import Any

import yaml
from pydantic import BaseModel, Field, HttpUrl


class SourceConfig(BaseModel):
    name: str
    platform: str
    source_type: str = Field(alias="type")
    url: HttpUrl
    tags: list[str] = Field(default_factory=list)
    enabled: bool = True


class SourcesFile(BaseModel):
    sources: list[SourceConfig]


class ProfilePreferences(BaseModel):
    interests: list[str] = Field(default_factory=list)
    exclude: list[str] = Field(default_factory=list)


class NewsletterPreferences(BaseModel):
    schedule: str = "08:30"
    max_items: int = 10
    language: str = "zh-CN"
    min_score_to_include: int = 4


class Preferences(BaseModel):
    profile: ProfilePreferences = Field(default_factory=ProfilePreferences)
    newsletter: NewsletterPreferences = Field(default_factory=NewsletterPreferences)


def read_yaml(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as file:
        data = yaml.safe_load(file) or {}
    if not isinstance(data, dict):
        raise ValueError(f"YAML root must be an object: {path}")
    return data


def load_sources(path: Path) -> list[SourceConfig]:
    return SourcesFile.model_validate(read_yaml(path)).sources


def load_preferences(path: Path) -> Preferences:
    return Preferences.model_validate(read_yaml(path))
