"""Minimal ForeUp HTTP client for San Diego City Golf.

ForeUp's online booking is a SPA backed by a JSON API. The bundle hardcodes
``api_key=no_limits`` for unauthenticated browser sessions. San Diego City Golf
additionally requires a logged-in session (cookie + JWT) before the times
endpoint will return non-``false`` results.

Discovery notes:
- Each physical course is a separate ``teesheet_id``. The times endpoint takes
  this value in its ``schedule_id`` query param (yes, the naming is confusing).
- ``booking_class`` must be one the logged-in user is entitled to (see the
  ``booking_class_ids`` field of the login response). Different classes
  represent different rate plans / booking windows (e.g. resident 7-day vs
  Torrey 8-90-day).
"""

from __future__ import annotations

import logging
import os
import time
from dataclasses import dataclass
from typing import Any

import requests

BASE = "https://foreupsoftware.com"

log = logging.getLogger("sdgolf")

# ForeUp's edge/WAF intermittently 403s (and occasionally 429s or 5xxs)
# requests from shared CI runner IPs. These blocks are transient — a retry a
# few seconds later almost always succeeds — so login() retries them rather
# than crashing the whole monitor tick. Backoff is the gap *before* each retry.
LOGIN_RETRY_STATUSES = frozenset({403, 429, 500, 502, 503, 504})
LOGIN_RETRY_BACKOFF = (2.0, 5.0)  # len + 1 = total attempts


def is_transient_login_error(exc: Exception) -> bool:
    """True if a login failure looks like a transient edge/WAF block.

    Distinguishes a block worth retrying / skipping the tick over (403/429/5xx
    from the WAF, a dropped connection — all clear on a later attempt, often
    just a fresh source IP) from a genuine rejection (bad password → 200 with
    ``success: false``, or a non-JSON body) that won't self-heal and should
    surface loudly. Genuine rejections carry no retryable ``status_code``.
    """
    if isinstance(exc, requests.RequestException):
        return True
    return getattr(exc, "status_code", None) in LOGIN_RETRY_STATUSES


@dataclass(frozen=True)
class Target:
    """A specific course/rate-window pair to monitor.

    Defaults match ForeUp (the SD City Golf courses). For TeeItUp-backed
    courses like Coronado, set ``provider="teeitup"`` and populate
    ``facility_id`` + ``alias`` instead of teesheet_id/booking_class.
    """
    name: str                                # human-readable, e.g. "Balboa Park 18"
    teesheet_id: int | None = None           # ForeUp: schedule_id query param
    booking_class: int | None = None         # ForeUp: account-allowed booking class
    provider: str = "foreup"                 # "foreup" or "teeitup"
    facility_id: int | None = None           # TeeItUp: golfFacilityId
    alias: str | None = None                 # TeeItUp: x-be-alias / subdomain


@dataclass(frozen=True)
class TeeTime:
    target: str          # Target.name
    date: str            # "YYYY-MM-DD"
    time: str            # "HH:MM" 24h, course-local
    available_spots: int
    holes: int
    green_fee: float | None
    booking_fee: float | None

    @property
    def key(self) -> str:
        return f"{self.target}|{self.date}|{self.time}|{self.holes}"


class ForeUpAuthError(RuntimeError):
    pass


class ForeUpClient:
    """Authenticated HTTP client for the ForeUp booking API."""

    def __init__(
        self,
        primary_course_id: int = 19348,
        *,
        base: str | None = None,
        proxy_secret: str | None = None,
    ):
        """Talk to ForeUp directly, or tunnel through the Worker proxy.

        ForeUp's WAF 403s a chunk of GitHub's shared runner IPs. Set
        ``FOREUP_PROXY_URL`` (e.g. ``https://<worker>/api/internal/foreup``) to
        route every call through the Worker's better-reputation egress instead.
        When proxying, the runner authenticates to the Worker with
        ``RUNNER_SECRET`` via a Bearer header; the Worker strips it before
        forwarding. Unset → direct to ForeUp (used by tests and discovery).
        """
        self.primary_course_id = primary_course_id
        self.base = (base or os.environ.get("FOREUP_PROXY_URL") or BASE).rstrip("/")
        self.session = requests.Session()
        self.session.headers.update({
            "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
            "Accept": "application/json, text/javascript, */*; q=0.01",
            "X-Requested-With": "XMLHttpRequest",
            "Api-Key": "no_limits",
        })
        secret = proxy_secret or os.environ.get("RUNNER_SECRET")
        if self.base != BASE and secret:
            self.session.headers["Authorization"] = f"Bearer {secret}"
        self.user: dict[str, Any] | None = None

    def login(
        self,
        username: str,
        password: str,
        booking_class: int = 929,
        *,
        sleep: "callable[[float], None]" = time.sleep,
    ) -> dict[str, Any]:
        """Authenticate. Returns the user object (includes booking_class_ids, jwt).

        ``booking_class`` here is only used to satisfy the login form; the same
        cookie/JWT then unlocks every booking class the user is entitled to.

        Transient edge failures (403/429/5xx, timeouts, connection drops) are
        retried with backoff — see ``LOGIN_RETRY_BACKOFF``. A genuine rejection
        (bad password → 200 with ``success: false``) is not retried.
        """
        last_exc: ForeUpAuthError | None = None
        for attempt, backoff in enumerate((*LOGIN_RETRY_BACKOFF, None)):
            try:
                return self._login_once(username, password, booking_class)
            except (ForeUpAuthError, requests.RequestException) as exc:
                # Only retry transient edge failures; surface real rejections.
                if not is_transient_login_error(exc) or backoff is None:
                    raise
                last_exc = exc if isinstance(exc, ForeUpAuthError) else None
                log.warning(
                    "login attempt %d failed (%s); retrying in %.0fs",
                    attempt + 1, exc, backoff,
                )
                sleep(backoff)
        # Unreachable: the final iteration has backoff=None and re-raises.
        raise last_exc or ForeUpAuthError("login failed")

    def _login_once(self, username: str, password: str, booking_class: int) -> dict[str, Any]:
        self.session.get(
            f"{self.base}/index.php/booking/{self.primary_course_id}/{booking_class}",
            timeout=20,
        )
        resp = self.session.post(
            f"{self.base}/index.php/api/booking/users/login",
            data={
                "username": username,
                "password": password,
                "booking_class_id": booking_class,
                "api_key": "no_limits",
                "course_id": self.primary_course_id,
            },
            timeout=20,
        )
        if resp.status_code != 200:
            err = ForeUpAuthError(f"login http {resp.status_code}: {resp.text[:200]}")
            err.status_code = resp.status_code
            raise err
        try:
            body = resp.json()
        except ValueError:
            raise ForeUpAuthError(f"login non-JSON: {resp.text[:200]}")
        if not isinstance(body, dict) or body.get("success") is False or body.get("status") is False:
            raise ForeUpAuthError(f"login rejected: {body}")
        jwt = body.get("jwt")
        if jwt:
            self.session.headers["X-Authorization"] = f"Bearer {jwt}"
        self.user = body
        return body

    def get_times(self, target: Target, date: str, holes: int | str = 18) -> list[TeeTime]:
        """Fetch tee times for a target on a given date.

        Args:
            target: Course + booking class to query.
            date: "YYYY-MM-DD".
            holes: 9, 18, or "all" (returns both 9 and 18 hole slots in one
                response — same as the booking SPA's "Both" toggle).
        """
        y, m, d = date.split("-")
        params = {
            "time": "all",
            "date": f"{m}-{d}-{y}",
            "holes": holes,
            "players": 0,
            "booking_class": target.booking_class,
            "schedule_id": target.teesheet_id,
            "schedule_ids[]": target.teesheet_id,
            "specials_only": 0,
            "api_key": "no_limits",
        }
        resp = self.session.get(
            f"{self.base}/index.php/api/booking/times",
            params=params,
            timeout=20,
        )
        resp.raise_for_status()
        try:
            body = resp.json()
        except ValueError:
            return []
        if not isinstance(body, list):
            if isinstance(body, dict) and body.get("status") is False:
                raise ForeUpAuthError(f"api rejected: {body}")
            return []
        return [_record_to_teetime(r, target.name) for r in body]


def _record_to_teetime(r: dict[str, Any], target_name: str) -> TeeTime:
    ts = r.get("time", "")
    date, time = (ts.split(" ", 1) + [""])[:2] if " " in ts else (ts, "")
    return TeeTime(
        target=target_name,
        date=date,
        time=time[:5],
        available_spots=int(r.get("available_spots", 0) or 0),
        holes=int(r.get("holes", 18) or 18),
        green_fee=_to_float(r.get("green_fee")),
        booking_fee=_to_float(r.get("booking_fee_price")) if r.get("booking_fee_required") else None,
    )


def _to_float(v: Any) -> float | None:
    if v in (None, "", False):
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None
