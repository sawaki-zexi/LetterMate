from pathlib import Path

from lettermate.sources.config_loader import load_preferences, load_sources


def test_load_sources_from_yaml(tmp_path: Path):
    path = tmp_path / "sources.yaml"
    path.write_text(
        """
sources:
  - name: Example Blog
    platform: blog
    type: rss
    url: https://example.com/feed.xml
    tags: [AI, Career]
    enabled: true
""",
        encoding="utf-8",
    )

    sources = load_sources(path)

    assert len(sources) == 1
    assert sources[0].name == "Example Blog"
    assert sources[0].source_type == "rss"
    assert sources[0].tags == ["AI", "Career"]


def test_load_preferences_defaults(tmp_path: Path):
    path = tmp_path / "preferences.yaml"
    path.write_text(
        """
profile:
  interests:
    - agent engineering
newsletter:
  max_items: 8
""",
        encoding="utf-8",
    )

    preferences = load_preferences(path)

    assert preferences.profile.interests == ["agent engineering"]
    assert preferences.newsletter.max_items == 8
    assert preferences.newsletter.min_score_to_include == 4
