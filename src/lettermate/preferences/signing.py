import base64
import hashlib
import hmac
import json
from dataclasses import dataclass
from datetime import UTC, datetime

ALLOWED_ACTIONS = frozenset({"useful", "not_interested", "saved"})


@dataclass(frozen=True)
class FeedbackPayload:
    issue_id: int
    item_id: int
    action: str
    expires_at: datetime


class FeedbackSigner:
    def __init__(self, secret: str) -> None:
        if not secret:
            raise ValueError("feedback signing secret must not be empty")
        self._secret = secret.encode()

    def sign(
        self,
        *,
        issue_id: int,
        item_id: int,
        action: str,
        expires_at: datetime,
    ) -> str:
        self._validate_action(action)
        if expires_at.tzinfo is None:
            raise ValueError("feedback expiry must be timezone-aware")
        payload = json.dumps(
            {
                "action": action,
                "expires_at": int(expires_at.timestamp()),
                "issue_id": issue_id,
                "item_id": item_id,
            },
            sort_keys=True,
            separators=(",", ":"),
        ).encode()
        encoded = base64.urlsafe_b64encode(payload).rstrip(b"=")
        signature = hmac.new(self._secret, encoded, hashlib.sha256).hexdigest().encode()
        return f"{encoded.decode()}.{signature.decode()}"

    def verify(self, token: str, *, now: datetime) -> FeedbackPayload:
        if now.tzinfo is None:
            raise ValueError("verification time must be timezone-aware")
        try:
            encoded_text, provided_signature = token.split(".", maxsplit=1)
        except ValueError as error:
            raise ValueError("invalid feedback token signature") from error
        encoded = encoded_text.encode()
        expected = hmac.new(self._secret, encoded, hashlib.sha256).hexdigest()
        if not hmac.compare_digest(expected, provided_signature):
            raise ValueError("invalid feedback token signature")
        padding = b"=" * (-len(encoded) % 4)
        try:
            data = json.loads(base64.urlsafe_b64decode(encoded + padding))
        except (ValueError, json.JSONDecodeError) as error:
            raise ValueError("invalid feedback token payload") from error
        action = str(data["action"])
        self._validate_action(action)
        expires_at = datetime.fromtimestamp(int(data["expires_at"]), UTC)
        if now.astimezone(UTC) > expires_at:
            raise ValueError("feedback token expired")
        return FeedbackPayload(
            issue_id=int(data["issue_id"]),
            item_id=int(data["item_id"]),
            action=action,
            expires_at=expires_at,
        )

    @staticmethod
    def _validate_action(action: str) -> None:
        if action not in ALLOWED_ACTIONS:
            raise ValueError(f"unknown feedback action: {action}")
