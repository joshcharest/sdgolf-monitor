"""Unit tests for ForeUpClient.login retry behavior (no real network)."""

from __future__ import annotations

import pytest
import requests

from sdgolf_monitor.client import ForeUpAuthError, ForeUpClient


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

    def get(self, *_a, **_k):
        self.get_calls += 1
        return FakeResp(200)

    def post(self, *_a, **_k):
        self.post_calls += 1
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
