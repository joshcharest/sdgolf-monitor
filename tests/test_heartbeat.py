"""Heartbeat tests using a stub Worker response (no real network or SMTP)."""

from __future__ import annotations

import pytest

from sdgolf_monitor import heartbeat, notify


class StubResponse:
    """Minimal requests.Response stand-in for /api/health."""

    def __init__(self, payload: dict, status_code: int = 200):
        self._payload = payload
        self.status_code = status_code

    def json(self) -> dict:
        return self._payload

    def raise_for_status(self) -> None:
        raise AssertionError("raise_for_status should not fire on 200/503")


def _health(*, stale: bool, age: int | None) -> dict:
    return {
        "ok": not stale,
        "stale": stale,
        "generated_at": None if age is None else "2026-08-16T23:32:01+00:00",
        "age_seconds": age,
        "stale_after_seconds": 1200,
    }


@pytest.fixture
def env(monkeypatch):
    """Fully configured environment; individual tests strip what they test."""
    for key, value in {
        "WORKER_URL": "https://worker.example",
        "ADMIN_EMAILS": "admin@example.com",
        "GMAIL_USERNAME": "bot@example.com",
        "GMAIL_APP_PASSWORD": "app-password",
        "NOTIFY_TO": "",
    }.items():
        monkeypatch.setenv(key, value)
    return monkeypatch


@pytest.fixture
def sent(monkeypatch):
    """Capture send_stale_alert calls instead of opening an SMTP connection."""
    calls: list[dict] = []
    monkeypatch.setattr(heartbeat.notify, "send_stale_alert",
                        lambda **kw: calls.append(kw))
    return calls


def _stub_get(monkeypatch, payload: dict, status_code: int = 200):
    monkeypatch.setattr(heartbeat.requests, "get",
                        lambda *a, **k: StubResponse(payload, status_code))


def test_fresh_snapshot_exits_zero_and_sends_nothing(env, sent):
    _stub_get(env, _health(stale=False, age=95))
    assert heartbeat.cli() == 0
    assert sent == []


def test_stale_snapshot_emails_and_exits_nonzero(env, sent):
    _stub_get(env, _health(stale=True, age=19095), status_code=503)
    assert heartbeat.cli() == 1
    assert len(sent) == 1
    assert sent[0]["to_addrs"] == ["admin@example.com"]
    assert sent[0]["health"]["age_seconds"] == 19095


def test_snapshot_that_never_published_counts_as_stale(env, sent):
    _stub_get(env, _health(stale=True, age=None), status_code=503)
    assert heartbeat.cli() == 1
    assert len(sent) == 1


def test_unreachable_worker_fails_without_emailing(env, sent):
    def boom(*a, **k):
        raise heartbeat.requests.ConnectionError("refused")
    env.setattr(heartbeat.requests, "get", boom)
    assert heartbeat.cli() == 1
    assert sent == []


def test_missing_worker_url_is_a_config_error(env, sent):
    env.setenv("WORKER_URL", "")
    assert heartbeat.cli() == 2
    assert sent == []


def test_stale_still_fails_when_email_is_unconfigured(env, sent):
    """The red run is the surviving signal when Gmail creds are absent."""
    env.setenv("GMAIL_APP_PASSWORD", "")
    _stub_get(env, _health(stale=True, age=19095), status_code=503)
    assert heartbeat.cli() == 1
    assert sent == []


def test_smtp_failure_does_not_mask_the_outage(env, monkeypatch):
    """A bounced alert must still exit non-zero, not crash or report health."""
    _stub_get(monkeypatch, _health(stale=True, age=19095), status_code=503)

    def boom(**kw):
        raise OSError("smtp down")
    monkeypatch.setattr(heartbeat.notify, "send_stale_alert", boom)
    assert heartbeat.cli() == 1


def test_notify_to_is_the_fallback_recipient(env, sent):
    env.setenv("ADMIN_EMAILS", "")
    env.setenv("NOTIFY_TO", "fallback@example.com")
    _stub_get(env, _health(stale=True, age=19095), status_code=503)
    assert heartbeat.cli() == 1
    assert sent[0]["to_addrs"] == ["fallback@example.com"]


@pytest.mark.parametrize("seconds,expected", [
    (19095, "5h 18m"),   # tonight's outage
    (17520, "4h 52m"),   # even hours keep two-digit minutes
    (3600, "1h 00m"),
    (2100, "35m"),
    (45, "45s"),
    (0, "0s"),
    (None, "unknown"),
])
def test_duration_formatting(seconds, expected):
    assert notify._duration(seconds) == expected
