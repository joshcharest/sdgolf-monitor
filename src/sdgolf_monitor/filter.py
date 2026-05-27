"""Filter tee times against the user's preferences."""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date, datetime, timedelta

from .client import TeeTime


@dataclass(frozen=True)
class Window:
    """A time-of-day window on specific weekdays, with date overrides.

    ``include_dates`` are added to whatever weekdays would normally pass
    (e.g. a Tuesday off when the weekday set is Sat+Sun). ``exclude_dates``
    are dropped from whatever would normally pass (e.g. a weekend away).
    Excludes always win — listing the same date in both rejects it.
    """
    start: str           # "HH:MM" 24h, inclusive
    end: str             # "HH:MM" 24h, inclusive
    weekdays: frozenset[int] | None = None  # Mon=0..Sun=6; None = any day
    include_dates: frozenset[str] = frozenset()  # extra YYYY-MM-DD dates
    exclude_dates: frozenset[str] = frozenset()  # YYYY-MM-DD dates to skip

    def matches(self, d: str, t: str) -> bool:
        if d in self.exclude_dates:
            return False
        if self.weekdays is not None and d not in self.include_dates:
            dow = datetime.strptime(d, "%Y-%m-%d").weekday()
            if dow not in self.weekdays:
                return False
        return self.start <= t <= self.end


@dataclass(frozen=True)
class Filter:
    min_players: int                 # require at least this many open spots
    windows: tuple[Window, ...]      # OR'd: any window may match
    max_green_fee: float | None      # skip if green_fee strictly above this
    holes: tuple[int, ...]           # subset of {9, 18}; len 1 = one count, len 2 = both

    def matches(self, tt: TeeTime) -> bool:
        if tt.holes not in self.holes:
            return False
        if tt.available_spots < self.min_players:
            return False
        if self.max_green_fee is not None and tt.green_fee is not None and tt.green_fee > self.max_green_fee:
            return False
        return any(w.matches(tt.date, tt.time) for w in self.windows)


def parse_holes(value: object) -> tuple[int, ...]:
    """Accept ``18``, ``9``, or ``[9, 18]``. Returns a sorted, deduped tuple."""
    if isinstance(value, (list, tuple)):
        out = tuple(sorted({int(v) for v in value}))
    elif value is None:
        out = (18,)
    else:
        out = (int(value),)
    if not out or any(h not in (9, 18) for h in out):
        raise ValueError(f"holes must be 9, 18, or [9, 18]; got {value!r}")
    return out


_RELATIVE_RE = re.compile(r"^today\s*([+-]\s*\d+)?$")


def resolve_date(spec: str, today: date | None = None) -> date:
    """Resolve a config date string. Accepts ``YYYY-MM-DD`` or ``today[±N]``."""
    today = today or date.today()
    s = spec.strip().lower()
    m = _RELATIVE_RE.match(s)
    if m:
        offset = int((m.group(1) or "0").replace(" ", ""))
        return today + timedelta(days=offset)
    return date.fromisoformat(spec)


def date_range(start: str, end: str, *, today: date | None = None) -> list[str]:
    """Inclusive date range. Accepts ISO dates or ``today[±N]`` shorthand."""
    s = resolve_date(start, today)
    e = resolve_date(end, today)
    if e < s:
        raise ValueError(f"end {end} resolves before start {start}")
    return [(s + timedelta(days=i)).isoformat() for i in range((e - s).days + 1)]


WEEKDAY_NAMES = {
    "mon": 0, "tue": 1, "wed": 2, "thu": 3, "fri": 4, "sat": 5, "sun": 6,
    "monday": 0, "tuesday": 1, "wednesday": 2, "thursday": 3,
    "friday": 4, "saturday": 5, "sunday": 6,
}


def parse_hhmm(value: object) -> str:
    """Normalize a HH:MM time to a zero-padded string.

    PyYAML parses unquoted ``16:00`` as the int ``960`` (YAML 1.1 sexagesimal),
    while ``08:00`` stays a string because the leading zero foils the int regex.
    Accept either form and produce ``"HH:MM"``.
    """
    if isinstance(value, int):
        if not 0 <= value < 24 * 60:
            raise ValueError(f"time out of range: {value}")
        return f"{value // 60:02d}:{value % 60:02d}"
    if isinstance(value, str):
        h, _, m = value.partition(":")
        return f"{int(h):02d}:{int(m):02d}"
    raise ValueError(f"unrecognized HH:MM value: {value!r}")


def parse_weekdays(value: list[str] | None) -> frozenset[int] | None:
    if not value:
        return None
    try:
        return frozenset(WEEKDAY_NAMES[v.strip().lower()] for v in value)
    except KeyError as e:
        raise ValueError(f"unknown weekday: {e.args[0]}") from None
