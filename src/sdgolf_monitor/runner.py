"""Run one check set: fetch tee times, diff against state, email new matches.

Extracted from ``main.py`` so the orchestrator can loop over many config files
while reusing a single ForeUp login.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Any

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
            )
            for w in cfg["filter"]["windows"]
        ),
    )
    dates = date_range(cfg["dates"]["start"], cfg["dates"]["end"])

    matches: list[TeeTime] = []
    for target in targets:
        client = clients.get(target.provider)
        if client is None:
            log.error("[%s] no client for provider %r (target %s); skipping",
                      set_name, target.provider, target.name)
            continue
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


def _build_target(t: dict[str, Any]) -> Target:
    provider = (t.get("provider") or "foreup").lower()
    if provider == "teeitup":
        return Target(
            name=t["name"],
            provider="teeitup",
            facility_id=int(t["facility_id"]),
            alias=str(t["alias"]),
        )
    return Target(
        name=t["name"],
        provider="foreup",
        teesheet_id=int(t["teesheet_id"]),
        booking_class=int(t["booking_class"]),
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
