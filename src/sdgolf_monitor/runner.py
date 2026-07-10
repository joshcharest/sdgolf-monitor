"""Run one check set: fetch tee times, diff against state, email new matches.

Extracted from ``main.py`` so the orchestrator can loop over many config files
while reusing a single ForeUp login.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import date, datetime, time as _dttime, timedelta
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from . import autobook, notify, state
from .client import Target, TeeTime
from .filter import Filter, Window, date_range, parse_hhmm, parse_holes, parse_weekdays

log = logging.getLogger("sdgolf")


@dataclass(frozen=True)
class SmtpCreds:
    user: str
    password: str


def run_check_set(
    *,
    clients: dict[str, Any],
    cfg: dict[str, Any],
    state_path: Path,
    set_name: str,
    dry_run: bool,
    smtp: SmtpCreds | None,
    recipients_override: list[str] | None = None,
    worker_url: str | None = None,
    unsubscribe_secret: str | None = None,
    autobook_budget: autobook.Budget | None = None,
    autobook_account_email: str | None = None,
) -> list[TeeTime]:
    """Run one config to completion. Caller handles exception isolation.

    Returns the full list of current matches for this set (independent of
    dedup state) so the orchestrator can build a snapshot for the UI.

    Args:
        clients: Map of provider name -> client. Each Target picks its
            client by ``target.provider`` (defaults to "foreup").
        cfg: Parsed YAML config (see configs/*.yaml schema).
        state_path: Where to read/write the dedup state for this set.
        set_name: Used in log lines and the email subject.
        dry_run: If True, never send email and never write state.
        smtp: SMTP credentials. May be None only in dry_run mode.
    """
    targets = [_build_target(t) for t in cfg["targets"]]
    flt = Filter(
        min_players=int(cfg["filter"].get("min_players", 1)),
        max_green_fee=cfg["filter"].get("max_green_fee"),
        holes=parse_holes(cfg["filter"].get("holes")),
        windows=tuple(
            Window(
                start=parse_hhmm(w["start"]),
                end=parse_hhmm(w["end"]),
                weekdays=parse_weekdays(w.get("weekdays")),
                include_dates=_parse_date_list(w.get("include_dates")),
                exclude_dates=_parse_date_list(w.get("exclude_dates")),
            )
            for w in cfg["filter"]["windows"]
        ),
    )
    all_dates = date_range(cfg["dates"]["start"], cfg["dates"]["end"])
    # Skip dates no window can match — saves an HTTP call per (target, holes)
    # for every day that fails weekday / include / exclude.
    dates = [d for d in all_dates if flt.date_in_play(d)]
    skipped = len(all_dates) - len(dates)
    if skipped:
        log.info("[%s] scanning %d/%d date(s); %d skipped by window rules",
                 set_name, len(dates), len(all_dates), skipped)

    matches: list[TeeTime] = []
    for target in targets:
        client = clients.get(target.provider)
        if client is None:
            log.error("[%s] no client for provider %r (target %s); skipping",
                      set_name, target.provider, target.name)
            continue
        # Always query holes=all so two configs scanning the same teesheet
        # on the same date share a cache hit regardless of whether they
        # filter for 9, 18, or both. Per-slot filtering in flt.matches
        # drops anything outside the config's actual holes preference.
        holes_query: int | str = "all"
        horizon = _target_horizon_date(target.provider)
        target_dates = (
            dates if horizon is None
            else [d for d in dates if date.fromisoformat(d) <= horizon]
        )
        if horizon is not None and len(target_dates) < len(dates):
            log.info(
                "[%s] %s: skipping %d date(s) past %s horizon (%s)",
                set_name, target.name, len(dates) - len(target_dates),
                target.provider, horizon.isoformat(),
            )
        for d in target_dates:
            t_for_date = _resolve_target_for_date(target, d)
            try:
                times = client.get_times(t_for_date, d, holes=holes_query)
            except Exception:
                log.exception("[%s] failed to fetch %s on %s", set_name, target.name, d)
                continue
            hits = [t for t in times if flt.matches(t)]
            log.info(
                "[%s] %s %s holes=%s: %d total, %d match",
                set_name, target.name, d, holes_query, len(times), len(hits),
            )
            matches.extend(hits)

    seen = state.load(state_path)
    new = [t for t in matches if state.mark(seen, t.key)]

    if not new:
        log.info("[%s] no new matches (%d already known)", set_name, len(matches))
        if not dry_run:
            state.save(state_path, seen)
        return matches

    log.info("[%s] found %d new tee time(s)", set_name, len(new))
    if dry_run:
        log.info("[%s] DRY RUN — would email subject %r", set_name, notify._subject(set_name, new))
        return matches

    if smtp is None:
        raise RuntimeError("smtp creds required for non-dry-run with new matches")
    recipients = recipients_override if recipients_override is not None else recipients_for(cfg)
    if not recipients:
        log.info("[%s] no recipients for this run (e.g. all pending-confirmation); skipping standard email", set_name)
    else:
        notify.send_email(
            smtp_user=smtp.user,
            smtp_password=smtp.password,
            to_addrs=recipients,
            set_name=set_name,
            new_times=new,
            owner=cfg.get("owner"),
            config_id=cfg.get("id"),
            worker_url=worker_url,
            unsubscribe_secret=unsubscribe_secret,
            autobook_account_email=autobook_account_email,
            recipient_away=_recipient_away_set(cfg),
        )

    # Autobook runs after the regular digest so the owner gets both:
    # (a) the full new-matches list, and (b) a separate "AUTO-BOOK" mail
    # for the one slot we acted on. Currently dry-run — see autobook.py.
    if autobook_budget is not None:
        decision = autobook_budget.consider(cfg, new)
        if decision is not None:
            log.info(
                "[%s] AUTO-BOOK (dry run): would book %s on %s at %s for %d player(s)",
                set_name, decision.slot.target, decision.slot.date,
                decision.slot.time, decision.players,
            )
            try:
                notify.send_autobook_email(
                    smtp_user=smtp.user,
                    smtp_password=smtp.password,
                    to_addr=decision.owner,
                    set_name=set_name,
                    slot=decision.slot,
                    players=decision.players,
                    dry_run=True,
                )
                autobook_budget.record(decision)
            except Exception:
                log.exception("[%s] failed to send autobook email; will retry on next tick", set_name)

    state.save(state_path, seen)
    return matches


_ISO_DATE_LEN = 10  # "YYYY-MM-DD"


def _parse_date_list(value: Any) -> frozenset[str]:
    """Accept a list of YYYY-MM-DD strings (or None) and return a frozenset.

    Silently drops anything that isn't a parseable ISO date so a hostile or
    stale UI write can't crash the scan.
    """
    if not value:
        return frozenset()
    out: set[str] = set()
    for v in value:
        if not isinstance(v, str) or len(v) != _ISO_DATE_LEN:
            continue
        try:
            date.fromisoformat(v)
        except ValueError:
            continue
        out.add(v)
    return frozenset(out)


def _recipient_away_set(cfg: dict[str, Any]) -> dict[str, set[str]] | None:
    """Convert the worker's recipient_away map (email -> [dates]) to sets.

    Returns None when the worker provided nothing, so notify.send_email can
    take its fast path. Keys are lower-cased to match the recipient
    normalization in send_email's per-addr loop.
    """
    raw = cfg.get("recipient_away")
    if not isinstance(raw, dict) or not raw:
        return None
    return {
        str(email).lower(): {d for d in dates if isinstance(d, str)}
        for email, dates in raw.items()
        if isinstance(dates, list)
    }


def _build_target(t: dict[str, Any]) -> Target:
    provider = (t.get("provider") or "foreup").lower()
    if provider == "teeitup":
        return Target(
            name=t["name"],
            provider="teeitup",
            facility_id=int(t["facility_id"]),
            alias=str(t["alias"]),
        )
    if provider == "webtrac":
        return Target(
            name=t["name"],
            provider="webtrac",
            secondarycode=int(t["secondarycode"]),
        )
    if provider == "golfdistrict":
        return Target(
            name=t["name"],
            provider="golfdistrict",
            course_id=str(t["course_id"]),
        )
    raw_bc = t.get("booking_class")
    return Target(
        name=t["name"],
        provider="foreup",
        teesheet_id=int(t["teesheet_id"]),
        booking_class=int(raw_bc) if raw_bc is not None else None,
    )


# ForeUp resident booking-class boundaries for SD City Golf. The 0-7 day
# window (no booking fee) uses 929; the 8-90 day window (advanced fee)
# uses 51735. The same two classes work for all three SD city courses,
# so the date alone picks the class.
#
# The booking horizon rolls forward at 7pm Pacific each day: that's when
# the next day's slot opens. Before 7pm Pacific, you can only book up to
# today+6 in the 929 window; at/after 7pm, today+7 also lands in 929.
_BC_NEAR = 929
_BC_FAR = 51735
_PACIFIC = ZoneInfo("America/Los_Angeles")
_BOOKING_RELEASE_HOUR = 19  # 7pm Pacific


def _booking_horizon(now_utc: datetime | None = None) -> date:
    """Most-distant date currently inside the 0-7 day (929) window.

    Anchored to Pacific time, not the runner's local clock — the GH Actions
    runner is UTC, so naive ``date.today()`` would shift the boundary by a
    day during Pacific evenings.
    """
    now_pac = (now_utc or datetime.now(tz=ZoneInfo("UTC"))).astimezone(_PACIFIC)
    offset = 7 if now_pac.time() >= _dttime(_BOOKING_RELEASE_HOUR, 0) else 6
    return now_pac.date() + timedelta(days=offset)


# How far out each provider lets us book. ForeUp resident class 51735 caps
# at 90 days; Coronado's TeeItUp tenant advertises maxDaysOut=14 in its SPA
# config; the Navy WebTrac datepicker allows today+30; the Golf District
# resale marketplace lists ~60 days out. Dates beyond a target's horizon
# return empty, so skip the call.
_PROVIDER_HORIZON_DAYS = {"foreup": 90, "teeitup": 14, "webtrac": 30, "golfdistrict": 60}


def _target_horizon_date(provider: str, *, now_utc: datetime | None = None) -> date | None:
    """Latest bookable course-local date for a provider, or None if unbounded."""
    days = _PROVIDER_HORIZON_DAYS.get(provider)
    if days is None:
        return None
    now_pac = (now_utc or datetime.now(tz=ZoneInfo("UTC"))).astimezone(_PACIFIC)
    return now_pac.date() + timedelta(days=days)


class CachingClient:
    """Per-tick wrapper that folds identical get_times calls into one HTTP call.

    Two check sets scanning the same (teesheet, booking_class, date, holes)
    used to make the same request twice; with this wrapper they share one
    result. Scope is intentionally one ``main()`` invocation — instances
    are constructed fresh each cron tick so cached responses can't go
    stale across ticks. The underlying client (login state, session
    cookies) is reused unchanged.
    """

    def __init__(self, inner: Any) -> None:
        self._inner = inner
        self._cache: dict[tuple, list[TeeTime]] = {}
        self.hits = 0
        self.misses = 0

    def get_times(self, target: Target, date_str: str, holes: int | str = 18) -> list[TeeTime]:
        key = (
            target.provider,
            target.teesheet_id,
            target.booking_class,
            target.facility_id,
            target.alias,
            target.secondarycode,
            target.course_id,
            date_str,
            holes,
        )
        cached = self._cache.get(key)
        if cached is not None:
            self.hits += 1
            return cached
        self.misses += 1
        result = self._inner.get_times(target, date_str, holes=holes)
        self._cache[key] = result
        return result


def _resolve_target_for_date(target: Target, date_str: str) -> Target:
    """If a ForeUp target left booking_class unset, pick it by date proximity."""
    if target.provider != "foreup" or target.booking_class is not None:
        return target
    try:
        target_date = date.fromisoformat(date_str)
    except ValueError:
        return target
    bc = _BC_NEAR if target_date <= _booking_horizon() else _BC_FAR
    return Target(
        name=target.name,
        teesheet_id=target.teesheet_id,
        booking_class=bc,
        provider=target.provider,
    )


def recipients_for(cfg: dict[str, Any]) -> list[str]:
    """Owner + de-duped subscribers, dropping blanks. Order: owner first."""
    seen: set[str] = set()
    out: list[str] = []
    for addr in [cfg.get("owner"), *(cfg.get("subscribers") or [])]:
        if not isinstance(addr, str):
            continue
        a = addr.strip().lower()
        if not a or a in seen:
            continue
        seen.add(a)
        out.append(a)
    return out
