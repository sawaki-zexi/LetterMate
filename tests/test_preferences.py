from datetime import UTC, datetime, timedelta

import pytest

from lettermate.preferences.signing import FeedbackSigner


def test_feedback_token_binds_payload_and_rejects_tampering():
    signer = FeedbackSigner("test-secret")
    now = datetime(2026, 7, 20, 3, tzinfo=UTC)
    token = signer.sign(
        issue_id=10,
        item_id=20,
        action="useful",
        expires_at=now + timedelta(hours=1),
    )

    payload = signer.verify(token, now=now)

    assert payload.issue_id == 10
    assert payload.item_id == 20
    assert payload.action == "useful"
    with pytest.raises(ValueError, match="signature"):
        signer.verify(token[:-1] + ("A" if token[-1] != "A" else "B"), now=now)


def test_feedback_token_rejects_expired_and_unknown_actions():
    signer = FeedbackSigner("test-secret")
    now = datetime(2026, 7, 20, 3, tzinfo=UTC)
    expired = signer.sign(
        issue_id=1,
        item_id=2,
        action="saved",
        expires_at=now - timedelta(seconds=1),
    )

    with pytest.raises(ValueError, match="expired"):
        signer.verify(expired, now=now)
    with pytest.raises(ValueError, match="unknown feedback action"):
        signer.sign(issue_id=1, item_id=2, action="delete", expires_at=now)
