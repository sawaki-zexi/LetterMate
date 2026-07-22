from enum import StrEnum


class SourceStatus(StrEnum):
    ACTIVE = "active"
    DISABLED = "disabled"
    ERROR = "error"


class ContentItemStatus(StrEnum):
    PENDING_ANALYSIS = "pending_analysis"
    ANALYZED = "analyzed"
    FAILED = "failed"


class AgentRunStatus(StrEnum):
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"


class NewsletterStatus(StrEnum):
    DRAFT = "draft"
    PREVIEW = "preview"
    SENDING = "sending"
    SENT = "sent"
    FAILED = "failed"
    SEND_FAILED = "send_failed"


class JobRunStatus(StrEnum):
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"


def require_status(status: str, enum_type: type[StrEnum]) -> str:
    try:
        return enum_type(status).value
    except ValueError as error:
        allowed = ", ".join(member.value for member in enum_type)
        raise ValueError(
            f"unknown {enum_type.__name__} value {status!r}; expected one of: {allowed}"
        ) from error
