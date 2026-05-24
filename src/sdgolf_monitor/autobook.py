"""Auto-book decisioning + daily-cap state.

Currently dry-run only: the runner picks one slot it *would* book per day, marks
it as seen so it doesn't keep firing, and emails the owner the booking details.
The actual ForeUp booking POST is left as a follow-up once we've captured the
real request shape from devtools.

Hard cap: at most one auto-book attempt per UTC day across the entire runner,
regardless of how many check sets have autobook enabled. Tracked in
``state/autobook.json``.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from .client import TeeTime

# Don't auto-book a slot that's less than this many seconds away. Guards
# against booking a tee time you can't realistically make (and against a
# stale match record causing an unwanted near-term booking). 3 hours covers
# wake-up + commute + ForeUp's typical check-in window.
MIN_LEAD_TIME_SEC = 3 * 60 * 60

_COURSE_TZ = ZoneInfo("America/Los_Angeles")

log = logging.getLogger("sdgolf")


@dataclass(frozen=True)
class AutobookDecision:
    """One slot the runner would book this tick, ready to be emailed/logged."""
    config_id: str
    set_name: str
    owner: str
    slot: TeeTime
    players: int                # how many spots to book (== slot.available_spots, capped at 4)


def load_state(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {"date": "", "slots": []}
    try:
        data = json.loads(path.read_text())
    except json.JSONDecodeError:
        return {"date": "", "slots": []}
    if not isinstance(data, dict):
        return {"date": "", "slots": []}
    return {"date": str(data.get("date", "")), "slots": list(data.get("slots") or [])}


def save_state(path: Path, st: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(st, indent=2) + "\n")


def _today_utc() -> str:
    return datetime.now(timezone.utc).date().isoformat()


def cap_reached(state: dict[str, Any]) -> bool:
    """True if we've already attempted (or simulated) a book today."""
    return state.get("date") == _today_utc() and len(state.get("slots") or []) >= 1


def record_attempt(state: dict[str, Any], slot_key: str) -> dict[str, Any]:
    """Return a new state dict with the attempt logged for today.

    Resets the day's slots list if the stored date is stale (yesterday or
    earlier) so the daily counter is naturally self-clearing.
    """
    today = _today_utc()
    if state.get("date") != today:
        return {"date": today, "slots": [slot_key]}
    return {"date": today, "slots": [*(state.get("slots") or []), slot_key]}


def pick_slot(new_times: list[TeeTime]) -> TeeTime | None:
    """Pick the earliest (by date, then time) match to book.

    Earliest-first because the 0-7-day Torrey resident window is heavily
    contested; the first match is also the most time-sensitive.
    """
    if not new_times:
        return None
    return min(new_times, key=lambda t: (t.date, t.time, t.target))


def far_enough_out(slot: TeeTime, now: datetime | None = None) -> bool:
    """True if the slot's tee-off is at least MIN_LEAD_TIME_SEC from now.

    Slot date/time are course-local (Pacific). ``now`` defaults to UTC; both
    sides are tz-aware so DST is handled by zoneinfo.
    """
    try:
        slot_dt = datetime.fromisoformat(f"{slot.date}T{slot.time}").replace(tzinfo=_COURSE_TZ)
    except ValueError:
        return False
    current = now if now is not None else datetime.now(timezone.utc)
    return (slot_dt - current).total_seconds() >= MIN_LEAD_TIME_SEC


def players_for(slot: TeeTime) -> int:
    return max(1, min(4, slot.available_spots))


def should_autobook(cfg: dict[str, Any], runner_account_email: str) -> bool:
    """Autobook is gated on: (a) feature toggle, (b) owner is the runner account.

    Restriction (b) is structural — the runner has one shared ForeUp login, so
    a non-owner autobook would charge the runner's card on someone else's
    behalf. The Worker also gates autobook writes to admin sessions; this is
    the second line of defense at execution time.
    """
    if not cfg.get("autobook") or not cfg["autobook"].get("enabled"):
        return False
    owner = (cfg.get("owner") or "").strip().lower()
    runner = (runner_account_email or "").strip().lower()
    if not owner or not runner or owner != runner:
        log.warning(
            "[%s] autobook enabled but owner %r != runner %r; skipping",
            cfg.get("name") or cfg.get("id"), owner, runner,
        )
        return False
    return True


def prune_future(state: dict[str, Any]) -> dict[str, Any]:
    """Drop entries for dates that have already passed so the file stays small."""
    today = date.today().isoformat()
    out_slots = []
    for s in state.get("slots") or []:
        # slot keys are "target|YYYY-MM-DD|HH:MM|holes"
        parts = str(s).split("|")
        if len(parts) >= 2 and parts[1] >= today:
            out_slots.append(s)
    return {"date": state.get("date", ""), "slots": out_slots}


class Budget:
    """Per-run autobook budget, shared across all check sets in one cron tick.

    Owns the daily-cap state in memory; the caller saves it back to disk at
    the end. Methods are non-allocating — they don't side-effect the state
    until a successful ``record()`` call.
    """

    def __init__(self, state: dict[str, Any], runner_account_email: str):
        self._state = state
        self.runner_account_email = runner_account_email

    def available(self) -> bool:
        return not cap_reached(self._state)

    def consider(self, cfg: dict[str, Any], new_times: list[TeeTime]) -> AutobookDecision | None:
        """Pick a slot for this set, or return None if not eligible.

        Doesn't mutate state — caller must call ``record(decision)`` to actually
        consume the day's budget.
        """
        if not self.available():
            return None
        if not should_autobook(cfg, self.runner_account_email):
            return None
        # Drop slots that tee off too soon — the user needs lead time to make
        # the round, and the regular alert email still goes out so they can
        # decide whether to book manually.
        eligible = [t for t in new_times if far_enough_out(t)]
        skipped = len(new_times) - len(eligible)
        if skipped:
            log.info(
                "[%s] autobook: skipping %d slot(s) within %dh of now",
                cfg.get("name") or cfg.get("id"), skipped, MIN_LEAD_TIME_SEC // 3600,
            )
        slot = pick_slot(eligible)
        if slot is None:
            return None
        return AutobookDecision(
            config_id=cfg.get("id") or cfg.get("name") or "<unnamed>",
            set_name=cfg.get("name") or cfg.get("id") or "<unnamed>",
            owner=cfg.get("owner") or "",
            slot=slot,
            players=players_for(slot),
        )

    def record(self, decision: AutobookDecision) -> None:
        self._state = record_attempt(self._state, decision.slot.key)

    def snapshot(self) -> dict[str, Any]:
        return dict(self._state)
