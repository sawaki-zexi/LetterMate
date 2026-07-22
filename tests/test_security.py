import json
from pathlib import Path

import yaml

from lettermate.curation.agent import build_curation_agent
from lettermate.curation.prompts import SYSTEM_PROMPT

ROOT = Path(__file__).resolve().parents[1]


def test_prompt_injection_suite_covers_permission_escalation_and_uses_offline_provider():
    cases = yaml.safe_load(
        (ROOT / "evals/security/prompt-injection.yaml").read_text(encoding="utf-8")
    )
    prompts = "\n".join(case["vars"]["article"] for case in cases["tests"])
    provider = (ROOT / "evals/security/provider.py").read_text(encoding="utf-8")

    normalized_prompts = prompts.casefold()
    for phrase in ("ignore", "send email", "secret", "arbitrary url", "repeat"):
        assert phrase in normalized_prompts
    assert "deterministic" in provider.casefold()
    assert "def call_api(" in provider
    assert "OPENAI_API_KEY" not in provider


def test_malicious_article_text_cannot_expand_the_agent_tool_surface():
    agent = build_curation_agent(model="fake-model")

    assert [tool.name for tool in agent.tools] == [
        "fetch_full_text",
        "lookup_recent_topics",
        "get_preference_evidence",
    ]
    assert "untrusted data" in SYSTEM_PROMPT
    assert "never attempt to send messages" in SYSTEM_PROMPT


def test_security_eval_scripts_keep_live_model_execution_separate():
    package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))

    assert "promptfoo eval -c promptfooconfig.yaml" in package["scripts"]["security-eval"]
    assert "security-eval:live" in package["scripts"]
    assert "OPENAI_API_KEY" in package["scripts"]["security-eval:live"]
    assert "promptfooconfig.live.yaml" in package["scripts"]["security-eval:live"]
    assert (ROOT / "promptfooconfig.live.yaml").is_file()


def test_promptfoo_and_ci_cover_all_offline_injection_cases():
    config = yaml.safe_load((ROOT / "promptfooconfig.yaml").read_text(encoding="utf-8"))
    workflow = (ROOT / ".github/workflows/ci.yml").read_text(encoding="utf-8")

    assert len(config["tests"]) >= 5
    assert "npm ci --include=dev" in workflow
    assert "npm run security-eval" in workflow
