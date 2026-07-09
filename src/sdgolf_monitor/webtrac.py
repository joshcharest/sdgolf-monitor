"""Anonymous HTTP client for Navy MWR WebTrac golf search (Admiral Baker).

Admiral Baker and the other Navy Southwest courses book through a WebTrac
(Vermont Systems) portal at ``myffr.navyaims.com``. There is no JSON API —
the search page is a classic server-rendered form — so this client scrapes
the results table. Browsing requires no login; only add-to-cart does.

Discovery notes (probed 2026-07):
- ``search.html?module=GR`` with ``Action=Start`` runs a search directly.
  The form embeds a ``_csrf_token``, but the server does not enforce it on
  this GET — a stateless request with no cookie jar returns results, which
  also makes the same URL usable as a human deep-link in emails.
- ``secondarycode`` picks the course (28 = Admiral Baker North,
  29 = Admiral Baker South, 27 = Sea 'N Air). One query returns one
  course-local date; times are rendered course-local ("4:09 pm").
- ``numberofholes`` must be 9 or 18 — there is no "all", so
  ``holes="all"`` issues both queries. The same first-tee slot is sold
  as a 9- or 18-hole *reservation type*: Admiral Baker returns nothing
  for 9 even on wide-open days (not sold online there), while Sea 'N
  Air returns the full sheet under both.
- The whole day comes back in one response (no pagination; 72 rows on an
  open day). "No results" re-renders the search form *without* the output
  table, indistinguishable from an invalid query — parse defensively.
- Results table ``#grwebsearch_output_table`` cells carry ``data-title``
  attributes: Time, Date (MM/DD/YYYY), Holes ("18 (Front)"), Course,
  Open Slots (remaining seats in the slot). No prices anywhere — Navy
  green fees depend on patron category (rank/status), so ``green_fee``
  is always None.
- Booking horizon: the datepicker allows today through today+30.
- The portal's WAF resets connections from bare/abbreviated User-Agents
  (plain "Mozilla/5.0" gets TCP RST); the full Chrome UA string below
  passes. Keep it a real browser string.
"""

from __future__ import annotations

import re
from datetime import date
from typing import Any
from urllib.parse import urlencode

import requests

from .client import Target, TeeTime

BASE = "https://myffr.navyaims.com/navywest/webtrac/web"
INTERFACE = "webtrac_southwest"

# Earliest slot observed is ~6am; 5am keeps the window safely open.
_BEGIN_TIME = "05:00 am"

_TABLE_RE = re.compile(r'<table[^>]*id="grwebsearch_output_table".*?</table>', re.S)
_ROW_RE = re.compile(r"<tr[^>]*>(.*?)</tr>", re.S)
_TIME_RE = re.compile(r"^(\d{1,2}):(\d{2})\s*([ap]m)$")


def _search_params(secondarycode: int, date_iso: str | None, holes: int) -> dict[str, Any]:
    """Query params for one search. Shared by the client and booking_url."""
    params: dict[str, Any] = {
        "Action": "Start",
        "SubAction": "",
        "interfaceparameter": INTERFACE,
        "module": "GR",
        "multiselectlist_value": "",
        "secondarycode": secondarycode,
        "begintime": _BEGIN_TIME,
        "numberofplayers": 1,
        "numberofholes": holes,
        "reservee": "",
        "display": "Detail",
    }
    if date_iso:
        y, m, d = date_iso.split("-")
        params["begindate"] = f"{m}/{d}/{y}"
    return params


def booking_url(secondarycode: int, date_iso: str) -> str:
    """Human deep-link that lands on live results for a course + date.

    The CSRF token isn't enforced on the search GET, so the link runs the
    search immediately for whoever clicks it (login only needed to book).
    A malformed date degrades to the search form for that course.
    """
    try:
        date.fromisoformat(date_iso)
    except ValueError:
        date_iso = None  # type: ignore[assignment]
    return f"{BASE}/search.html?{urlencode(_search_params(secondarycode, date_iso, 18))}"


class WebTracClient:
    """No-login client. Each query is one stateless GET."""

    def __init__(self) -> None:
        self.session = requests.Session()
        self.session.headers.update({
            "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml",
        })

    def get_times(self, target: Target, date: str, holes: int | str = 18) -> list[TeeTime]:
        """Fetch tee times. ``holes`` is 9, 18, or "all" (queries both)."""
        if target.secondarycode is None:
            raise ValueError(f"webtrac target {target.name!r} missing secondarycode")
        hole_queries = (18, 9) if holes == "all" else (int(holes),)
        out: list[TeeTime] = []
        for h in hole_queries:
            resp = self.session.get(
                f"{BASE}/search.html",
                params=_search_params(target.secondarycode, date, h),
                timeout=20,
            )
            resp.raise_for_status()
            out.extend(_parse_results(resp.text, target.name))
        return out


def _parse_results(html: str, target_name: str) -> list[TeeTime]:
    """Extract TeeTimes from a results page; [] when the table is absent."""
    m = _TABLE_RE.search(html)
    if not m:
        return []
    out: list[TeeTime] = []
    for row in _ROW_RE.findall(m.group(0)):
        tt = _row_to_teetime(row, target_name)
        if tt is not None:
            out.append(tt)
    return out


def _row_to_teetime(row: str, target_name: str) -> TeeTime | None:
    time_24 = _to_24h(_cell(row, "Time"))
    date_iso = _to_iso_date(_cell(row, "Date"))
    if time_24 is None or date_iso is None:
        return None  # header row, or markup drifted
    return TeeTime(
        target=target_name,
        date=date_iso,
        time=time_24,
        available_spots=_to_int(_cell(row, "Open Slots")) or 0,
        holes=_holes_from_label(_cell(row, "Holes")),
        green_fee=None,   # not published pre-cart; depends on patron category
        booking_fee=None,
    )


def _cell(row_html: str, title: str) -> str:
    m = re.search(rf'data-title="{title}"[^>]*>\s*([^<]*)', row_html)
    return m.group(1).strip() if m else ""


def _to_24h(text: str) -> str | None:
    """'4:09 pm' -> '16:09'; '12:05 am' -> '00:05'."""
    m = _TIME_RE.match(text.lower())
    if not m:
        return None
    h, mnt, ampm = int(m.group(1)), m.group(2), m.group(3)
    if not 1 <= h <= 12:
        return None
    h = h % 12 + (12 if ampm == "pm" else 0)
    return f"{h:02d}:{mnt}"


def _to_iso_date(text: str) -> str | None:
    """'07/12/2026' -> '2026-07-12'."""
    parts = text.split("/")
    if len(parts) != 3:
        return None
    m, d, y = parts
    try:
        return date(int(y), int(m), int(d)).isoformat()
    except ValueError:
        return None


def _holes_from_label(text: str) -> int:
    """'18 (Front)' -> 18; '9 (Back)' -> 9; unparseable defaults to 18."""
    m = re.match(r"\s*(\d+)", text)
    return int(m.group(1)) if m else 18


def _to_int(v: str) -> int | None:
    try:
        return int(v)
    except (TypeError, ValueError):
        return None
