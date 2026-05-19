"""Run one check set: fetch tee times, diff against state, email new matches.

Extracted from ``main.py`` so the orchestrator can loop over many config files
while reusing a single ForeUp login.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from . import notify, state
from .client import ForeUpClient, Target, TeeTime
from .filter import Filter, Window, date_range, parse_hhmm, parse_holes, parse_weekdays

log = logging.getLogger("sdgolf")


@dataclass(frozen=True)
class SmtpCreds:
    user: str
    password: str


def run_check_set(
    *,
    client: ForeUpClient,
    cfg: dict[str, Any],
    state_path: Path,
    set_name: str,
    dry_run: bool,
    smtp: SmtpCreds | None,
) -> list[TeeTime]:
    """Run one config to completion. Caller handles exception isolation.

    Returns the full list of current matches for this set (independent of
    dedup state) so the orchestrator can build a snapshot for the UI.

    Args:
        client: Already-logged-in ForeUp client; reused across check sets.
        cfg: Parsed YAML config (see configs/*.yaml schema).
        state_path: Where to read/write the dedup state for this set.
        set_name: Used in log lines and the email subject.
        dry_run: If True, never send email and never write state.
        smtp: SMTP credentials. May be None only in dry_run mode.
    """
    targets = [
        Target(
            name=t["name"],
            teesheet_id=int(t["teesheet_id"]),
            booking_class=int(t["booking_class"]),
        )
        for t in cfg["targets"]
    ]
    flt = Filter(
        min_players=int(cfg["filter"].get("min_players", 1)),
        max_green_fee=cfg["filter"].get("max_green_fee"),
        holes=parse_holes(cfg["filter"].get("holes")),
        windows=tuple(
            Window(
                start=parse_hhmm(w["start"]),
                end=parse_hhmm(w["end"]),
                weekdays=parse_weekdays(w.get("weekdays")),
            )
            for w in cfg["filter"]["windows"]
        ),
    )
    dates = date_range(cfg["dates"]["start"], cfg["dates"]["end"])

    matches: list[TeeTime] = []
    for target in targets:
        for d in dates:
            for h in flt.holes:
                try:
                    times = client.get_times(target, d, holes=h)
                except Exception:
                    log.exception("[%s] failed to fetch %s on %s (%dh)", set_name, target.name, d, h)
                    continue
                hits = [t for t in times if flt.matches(t)]
                log.info(
                    "[%s] %s %s %dh: %d total, %d match",
                    set_name, target.name, d, h, len(times), len(hits),
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
    recipients = _recipients(cfg)
    if not recipients:
        log.warning("[%s] no recipients (no owner/subscribers); skipping email", set_name)
    else:
        notify.send_email(
            smtp_user=smtp.user,
            smtp_password=smtp.password,
            to_addrs=recipients,
            set_name=set_name,
            new_times=new,
        )
    state.save(state_path, seen)
    return matches


def _recipients(cfg: dict[str, Any]) -> list[str]:
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
