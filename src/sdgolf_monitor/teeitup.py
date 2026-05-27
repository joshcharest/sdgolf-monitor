"""Anonymous HTTP client for the TeeItUp / Kenna booking API.

Coronado Municipal runs on a different vendor than the SD City courses.
The SPA at ``<alias>.book.teeitup.com`` calls a single backend at
``phx-api-be-east-1b.kenna.io`` with the per-tenant ``x-be-alias`` header
selecting which course + rate window is exposed. No auth is required to
browse tee times.

Discovery notes:
- ``facilityIds`` (the int from the SPA's ``?course=`` param) picks the
  course; the response's outer array is keyed by facility too.
- ``date`` is course-local (Pacific for Coronado). The ``teetime`` field
  in each slot is UTC ISO 8601 — convert to America/Los_Angeles before
  comparing against user windows.
- Each slot's ``rates`` array reflects what the alias is entitled to see;
  the alias controls the rate window, so per-Target there's typically one
  rate. Prices come back in cents in ``greenFeeCart``.
- ``maxPlayers`` is the remaining capacity of the slot (slot size minus
  already-booked players); we surface that as ``available_spots``.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

import requests

from .client import Target, TeeTime

BASE = "https://phx-api-be-east-1b.kenna.io"
COURSE_TZ = ZoneInfo("America/Los_Angeles")


class TeeItUpClient:
    """No-login client. One per process is fine; the session is cheap."""

    def __init__(self) -> None:
        self.session = requests.Session()
        self.session.headers.update({
            "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
            "Accept": "application/json",
        })

    def get_times(self, target: Target, date: str, holes: int = 18) -> list[TeeTime]:
        if target.facility_id is None or not target.alias:
            raise ValueError(f"teeitup target {target.name!r} missing facility_id/alias")
        resp = self.session.get(
            f"{BASE}/v2/tee-times",
            params={"date": date, "facilityIds": target.facility_id},
            headers={"x-be-alias": target.alias},
            timeout=20,
        )
        resp.raise_for_status()
        try:
            body = resp.json()
        except ValueError:
            return []
        if not isinstance(body, list):
            return []
        out: list[TeeTime] = []
        for facility in body:
            if not isinstance(facility, dict):
                continue
            for raw in facility.get("teetimes") or []:
                tt = _record_to_teetime(raw, target.name)
                if tt is not None and tt.holes == holes:
                    out.append(tt)
        return out


def _record_to_teetime(r: dict[str, Any], target_name: str) -> TeeTime | None:
    iso = r.get("teetime")
    if not isinstance(iso, str):
        return None
    try:
        dt_utc = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    except ValueError:
        return None
    dt_local = dt_utc.astimezone(COURSE_TZ)

    rate = ((r.get("rates") or [None])[0]) or {}
    try:
        holes = int(rate.get("holes") or 18)
    except (TypeError, ValueError):
        holes = 18
    available = _to_int(r.get("maxPlayers")) or 0
    return TeeTime(
        target=target_name,
        date=dt_local.strftime("%Y-%m-%d"),
        time=dt_local.strftime("%H:%M"),
        available_spots=available,
        holes=holes,
        green_fee=_cents_to_dollars(rate.get("greenFeeCart")),
        booking_fee=None,
    )


def _cents_to_dollars(v: Any) -> float | None:
    if v in (None, "", False):
        return None
    try:
        return round(int(v) / 100, 2)
    except (TypeError, ValueError):
        return None


def _to_int(v: Any) -> int | None:
    try:
        return int(v)
    except (TypeError, ValueError):
        return None
