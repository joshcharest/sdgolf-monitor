"""Anonymous client for the Golf District resale marketplace (JC Golf).

JC Golf's prepaid tee-time RESALE marketplace runs on Golf District
(golfdistrict.com) — a Next.js/Vercel app with a public tRPC API and, unlike
the primary cps.golf booking system, no Cloudflare challenge. Golfers who
bought prepaid tee times list them for resale here; this client surfaces
those second-hand listings so the monitor can alert when one appears.

Discovery notes (probed 2026-07):
- One tenant per operator: JC Golf lives at ``jcresorts.golfdistrict.com``.
  ``course_id`` (the UUID in the page URL) picks the course — Encinitas
  Ranch = ``3f755992-90e0-11ef-9af2-6a003139847e``.
- The tRPC route ``searchRouter.getTeeTimesForDay`` takes a course + a single
  day + filters and returns BOTH the course's own first-hand marketplace
  listings and golfer resale listings, tagged by ``firstOrSecondHandTeeTime``.
  Both kinds surface as TeeTimes (resales flagged via ``TeeTime.resale``):
  first-hand is NOT the course's full tee sheet — it's sparse prepaid
  inventory (a handful of slots per day, none in the near term), and it's the
  only Encinitas inventory reachable headlessly, so it's signal too. Records
  of the two kinds differ in shape — parse defensively; unknown kinds are
  dropped.
- Per record: ``date`` is a course-local ISO datetime (no tz), ``time`` is
  HHMM, ``numberOfHoles`` is 9/18, ``pricePerGolfer`` is dollars (final),
  and ``availableSlots`` is how many of the listing's slots are still
  buyable. No booking fee concept.
- Horizon ~60 days; a date past it returns an empty list, not an error.
- tRPC batch GET: ``?batch=1&input=<url-encoded json>``. The response is
  ``[{"result":{"data":{"json":{results,cursor,count}}}}]``. superjson wants
  ``cursor: undefined``, expressed via the ``meta`` sidecar, not ``null``.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from typing import Any

import requests

from .client import Target, TeeTime

# JC Golf's Golf District tenant. Other operators are other subdomains; all
# JC courses (Encinitas Ranch, The Crossings, Rancho Bernardo Inn, Twin Oaks)
# share this host and differ only by course_id.
BASE = "https://jcresorts.golfdistrict.com"
_ROUTE = "searchRouter.getTeeTimesForDay"
# Pacific offset the SPA sends as timezoneCorrection. -7 = PDT; the value only
# nudges the server's day-boundary math, and we re-filter by exact local date
# below, so a DST mismatch can't leak a neighbouring day's listings.
_TZ_CORRECTION = -7


def _gmt(dt: datetime) -> str:
    """Format as the JS ``Date.toUTCString()`` shape the API expects."""
    return dt.strftime("%a, %d %b %Y %H:%M:%S GMT")


def booking_url(course_id: str) -> str:
    """The resale marketplace page for a course — lands on its live listings."""
    return f"{BASE}/{course_id}"


class GolfDistrictClient:
    """No-login client. One stateless tRPC GET per (course, day)."""

    def __init__(self) -> None:
        self.session = requests.Session()
        self.session.headers.update({
            "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
            "Accept": "application/json",
            "content-type": "application/json",
        })

    def get_times(self, target: Target, date: str, holes: int | str = 18) -> list[TeeTime]:
        """Fetch marketplace listings (course + resale) for one course-local date."""
        if not target.course_id:
            raise ValueError(f"golfdistrict target {target.name!r} missing course_id")
        out: list[TeeTime] = []
        for raw in self._fetch_day(target.course_id, date):
            if raw.get("firstOrSecondHandTeeTime") not in ("FIRST_HAND", "SECOND_HAND"):
                continue  # unknown/missing kind — don't guess at its shape
            tt = _record_to_teetime(raw, target.name)
            if tt is None:
                continue
            # The API keys results by day but the -7h correction can bleed in a
            # neighbour; keep only the exact requested date. Runner scans per day.
            if tt.date != date:
                continue
            if holes == "all" or tt.holes == holes:
                out.append(tt)
        return out

    def _fetch_day(self, course_id: str, date_iso: str) -> list[dict[str, Any]]:
        day = datetime.fromisoformat(date_iso).replace(hour=0, minute=0, second=0)
        now = datetime.now(timezone.utc)
        params = {
            "courseId": course_id,
            "date": _gmt(day),
            "minDate": _gmt(now),
            "maxDate": _gmt(now + timedelta(days=90)),
            "startTime": 0,
            "endTime": 2400,          # HHMM bounds — full day
            "showUnlisted": False,
            "includesCart": True,
            "golfers": -1,
            "sortTime": "asc",
            "sortPrice": "",
            "timezoneCorrection": _TZ_CORRECTION,
            "take": 50,
            "cursor": None,
        }
        # superjson: express cursor=undefined via the meta sidecar, not null.
        inp = {"0": {"json": params, "meta": {"values": {"cursor": ["undefined"]}}}}
        resp = self.session.get(
            f"{BASE}/api/trpc/{_ROUTE}",
            params={"batch": 1, "input": json.dumps(inp, separators=(",", ":"))},
            timeout=20,
        )
        resp.raise_for_status()
        try:
            body = resp.json()
        except ValueError:
            return []
        try:
            data = body[0]["result"]["data"]["json"]
        except (KeyError, IndexError, TypeError):
            return []
        results = data.get("results") if isinstance(data, dict) else None
        return results if isinstance(results, list) else []


def _record_to_teetime(r: dict[str, Any], target_name: str) -> TeeTime | None:
    iso = r.get("date")
    if not isinstance(iso, str):
        return None
    try:
        dt = datetime.fromisoformat(iso)  # course-local, naive
    except ValueError:
        return None
    try:
        holes = int(r.get("numberOfHoles") or 18)
    except (TypeError, ValueError):
        holes = 18
    # availableSlots = still-buyable; fall back to the listing size.
    available = _to_int(r.get("availableSlots"))
    if available is None:
        available = _to_int(r.get("listedSlots")) or 0
    return TeeTime(
        target=target_name,
        date=dt.strftime("%Y-%m-%d"),
        time=dt.strftime("%H:%M"),
        available_spots=available,
        holes=holes,
        green_fee=_to_price(r.get("pricePerGolfer")),
        booking_fee=None,
        resale=r.get("firstOrSecondHandTeeTime") == "SECOND_HAND",
    )


def _to_price(v: Any) -> float | None:
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    return round(float(v), 2)


def _to_int(v: Any) -> int | None:
    if isinstance(v, bool):
        return None
    try:
        return int(v)
    except (TypeError, ValueError):
        return None
