"""Filter tee times against the user's preferences."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timedelta

from .client import TeeTime


@dataclass(frozen=True)
class Window:
    """A time-of-day window on specific weekdays."""
    start: str           # "HH:MM" 24h, inclusive
    end: str             # "HH:MM" 24h, inclusive
    weekdays: frozenset[int] | None = None  # Mon=0..Sun=6; None = any day

    def matches(self, d: str, t: str) -> bool:
        if self.weekdays is not None:
            dow = datetime.strptime(d, "%Y-%m-%d").weekday()
            if dow not in self.weekdays:
                return False
        return self.start <= t <= self.end


@dataclass(frozen=True)
class Filter:
    min_players: int                 # require at least this many open spots
    windows: tuple[Window, ...]      # OR'd: any window may match
    max_green_fee: float | None      # skip if green_fee strictly above this
    holes: int                       # 9 or 18

    def matches(self, tt: TeeTime) -> bool:
        if tt.holes != self.holes:
            return False
        if tt.available_spots < self.min_players:
            return False
        if self.max_green_fee is not None and tt.green_fee is not None and tt.green_fee > self.max_green_fee:
            return False
        return any(w.matches(tt.date, tt.time) for w in self.windows)


def date_range(start: str, end: str) -> list[str]:
    """Inclusive YYYY-MM-DD range."""
    s = date.fromisoformat(start)
    e = date.fromisoformat(end)
    if e < s:
        raise ValueError(f"end {end} before start {start}")
    return [(s + timedelta(days=i)).isoformat() for i in range((e - s).days + 1)]


WEEKDAY_NAMES = {
    "mon": 0, "tue": 1, "wed": 2, "thu": 3, "fri": 4, "sat": 5, "sun": 6,
    "monday": 0, "tuesday": 1, "wednesday": 2, "thursday": 3,
    "friday": 4, "saturday": 5, "sunday": 6,
}


def parse_weekdays(value: list[str] | None) -> frozenset[int] | None:
    if not value:
        return None
    try:
        return frozenset(WEEKDAY_NAMES[v.strip().lower()] for v in value)
    except KeyError as e:
        raise ValueError(f"unknown weekday: {e.args[0]}") from None
