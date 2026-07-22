from lettermate.notifiers.email import EmailNotifier, EmailSettings


def settings(*, dry_run: bool) -> EmailSettings:
    return EmailSettings(
        host="smtp.example.com",
        port=587,
        username="user",
        password="secret",
        sender="from@example.com",
        recipient="to@example.com",
        use_tls=True,
        dry_run=dry_run,
    )


def test_dry_run_does_not_open_smtp_connection():
    def forbidden_factory(host: str, port: int):
        raise AssertionError(f"SMTP opened: {host}:{port}")

    result = EmailNotifier(settings(dry_run=True), smtp_factory=forbidden_factory).send(
        subject="Daily", html_body="<p>Preview</p>"
    )

    assert result.accepted is False
    assert result.dry_run is True


def test_notifier_exposes_its_configured_dry_run_mode():
    assert EmailNotifier(settings(dry_run=True)).dry_run is True
    assert EmailNotifier(settings(dry_run=False)).dry_run is False


def test_real_send_uses_tls_login_and_message():
    class FakeSmtp:
        def __init__(self) -> None:
            self.calls: list[str] = []

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return None

        def starttls(self):
            self.calls.append("tls")

        def login(self, username: str, password: str):
            self.calls.append(f"login:{username}:{password}")

        def send_message(self, message):
            self.calls.append(f"send:{message['Subject']}")

    smtp = FakeSmtp()
    notifier = EmailNotifier(settings(dry_run=False), smtp_factory=lambda host, port: smtp)

    result = notifier.send(subject="Daily", html_body="<p>Issue</p>")

    assert result.accepted is True
    assert smtp.calls == ["tls", "login:user:secret", "send:Daily"]
