"""Unit tests for ForeUpClient.login retry behavior (no real network)."""

from __future__ import annotations

import pytest
import requests

from sdgolf_monitor.client import (
    ForeUpAuthError,
    ForeUpClient,
    is_transient_login_error,
)


class FakeResp:
    def __init__(self, status_code: int = 200, json_body=None, text: str = ""):
        self.status_code = status_code
        self._json = json_body if json_body is not None else {}
        self.text = text

    def json(self):
        if self._json is _NO_JSON:
            raise ValueError("no json")
        return self._json


_NO_JSON = object()

_OK_BODY = {"first_name": "Test", "last_name": "User", "jwt": "tok"}


class FakeSession:
    """Stands in for requests.Session: scripts the POST /login responses.

    Each entry in ``post_results`` is either a FakeResp to return or an
    exception instance to raise, consumed in order.
    """

    def __init__(self, post_results):
        self.headers = {}
        self._post_results = list(post_results)
        self.get_calls = 0
        self.post_calls = 0
        self.urls: list[str] = []

    def get(self, url="", *_a, **_k):
        self.get_calls += 1
        self.urls.append(url)
        return FakeResp(200)

    def post(self, url="", *_a, **_k):
        self.post_calls += 1
        self.urls.append(url)
        result = self._post_results.pop(0)
        if isinstance(result, Exception):
            raise result
        return result


def _client(post_results):
    c = ForeUpClient()
    c.session = FakeSession(post_results)
    return c


def _login(c, sleeps):
    return c.login("u", "p", sleep=lambda s: sleeps.append(s))


def test_login_retries_transient_403_then_succeeds():
    c = _client([FakeResp(403, text="forbidden"), FakeResp(200, _OK_BODY)])
    sleeps = []
    body = _login(c, sleeps)
    assert body["first_name"] == "Test"
    assert c.session.post_calls == 2
    assert sleeps == [2.0]  # one backoff before the single retry
    assert c.session.headers["X-Authorization"] == "Bearer tok"


def test_login_exhausts_retries_then_raises():
    c = _client([FakeResp(403, text="x")] * 3)
    sleeps = []
    with pytest.raises(ForeUpAuthError):
        _login(c, sleeps)
    assert c.session.post_calls == 3  # initial + 2 retries
    assert sleeps == [2.0, 5.0]


def test_login_does_not_retry_bad_password():
    # 200 with success:false is a genuine rejection, not a transient block.
    c = _client([FakeResp(200, {"success": False})])
    sleeps = []
    with pytest.raises(ForeUpAuthError):
        _login(c, sleeps)
    assert c.session.post_calls == 1
    assert sleeps == []


def test_login_retries_network_error_then_succeeds():
    c = _client([requests.ConnectionError("boom"), FakeResp(200, _OK_BODY)])
    sleeps = []
    body = _login(c, sleeps)
    assert body["last_name"] == "User"
    assert c.session.post_calls == 2
    assert sleeps == [2.0]


def test_proxy_base_routes_through_worker_with_bearer():
    c = ForeUpClient(base="https://w.example/api/internal/foreup", proxy_secret="s3cr3t")
    # __init__ attaches the runner secret as a Bearer header (Worker strips it).
    assert c.session.headers["Authorization"] == "Bearer s3cr3t"
    c.session = FakeSession([FakeResp(200, _OK_BODY)])  # swap in to capture URLs
    c.login("u", "p", sleep=lambda _s: None)
    assert all(u.startswith("https://w.example/api/internal/foreup/") for u in c.session.urls)


def test_direct_base_sends_no_bearer():
    c = ForeUpClient()  # no FOREUP_PROXY_URL → straight to ForeUp
    assert c.base == "https://foreupsoftware.com"
    assert "Authorization" not in c.session.headers


def test_is_transient_login_error_classifies_edge_vs_rejection():
    waf = ForeUpAuthError("login http 403: forbidden")
    waf.status_code = 403
    rejected = ForeUpAuthError("login rejected: {'success': False}")  # no status_code
    assert is_transient_login_error(waf) is True
    assert is_transient_login_error(requests.ConnectionError("boom")) is True
    assert is_transient_login_error(rejected) is False
