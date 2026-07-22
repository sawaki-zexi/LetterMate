import smtplib
from collections.abc import Callable
from dataclasses import dataclass
from email.message import EmailMessage
from types import TracebackType
from typing import Protocol, Self


@dataclass(frozen=True)
class EmailSettings:
    host: str
    port: int
    username: str
    password: str
    sender: str
    recipient: str
    use_tls: bool
    dry_run: bool


@dataclass(frozen=True)
class SendResult:
    accepted: bool
    dry_run: bool


class SmtpConnection(Protocol):
    def __enter__(self) -> Self: ...

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback: TracebackType | None,
    ) -> None: ...

    def starttls(self) -> object: ...

    def login(self, username: str, password: str) -> object: ...

    def send_message(self, message: EmailMessage) -> object: ...


def _smtp_factory(host: str, port: int) -> SmtpConnection:
    return smtplib.SMTP(host, port, timeout=15)


class EmailNotifier:
    def __init__(
        self,
        settings: EmailSettings,
        *,
        smtp_factory: Callable[[str, int], SmtpConnection] = _smtp_factory,
    ) -> None:
        self._settings = settings
        self._smtp_factory = smtp_factory

    def send(self, *, subject: str, html_body: str) -> SendResult:
        if self._settings.dry_run:
            return SendResult(accepted=False, dry_run=True)
        message = EmailMessage()
        message["Subject"] = subject
        message["From"] = self._settings.sender
        message["To"] = self._settings.recipient
        message.set_content("This briefing requires an HTML-capable email client.")
        message.add_alternative(html_body, subtype="html")
        with self._smtp_factory(self._settings.host, self._settings.port) as smtp:
            if self._settings.use_tls:
                smtp.starttls()
            if self._settings.username:
                smtp.login(self._settings.username, self._settings.password)
            smtp.send_message(message)
        return SendResult(accepted=True, dry_run=False)
