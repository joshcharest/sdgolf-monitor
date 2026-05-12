"""Entry point: one monitoring pass.

Loads config, logs into ForeUp, fetches each target across the date range,
filters to new matching slots, sends an email if any are new, and updates
state.
"""

from __future__ import annotations

import logging
import os
import sys
from pathlib import Path

import yaml

from . import notify, state
from .client import ForeUpClient, Target, TeeTime
from .filter import Filter, Window, date_range, parse_weekdays

log = logging.getLogger("sdgolf")


def main(config_path: Path, state_path: Path, *, dry_run: bool = False) -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )
    cfg = yaml.safe_load(config_path.read_text())

    targets = [
        Target(name=t["name"], teesheet_id=int(t["teesheet_id"]), booking_class=int(t["booking_class"]))
        for t in cfg["targets"]
    ]
    flt = Filter(
        min_players=int(cfg["filter"].get("min_players", 1)),
        max_green_fee=cfg["filter"].get("max_green_fee"),
        holes=int(cfg["filter"].get("holes", 18)),
        windows=tuple(
            Window(
                start=w["start"],
                end=w["end"],
                weekdays=parse_weekdays(w.get("weekdays")),
            )
            for w in cfg["filter"]["windows"]
        ),
    )
    dates = date_range(cfg["dates"]["start"], cfg["dates"]["end"])

    username = _require_env("SDGOLF_USERNAME")
    password = _require_env("SDGOLF_PASSWORD")

    client = ForeUpClient()
    client.login(username, password)
    log.info("logged in as %s %s", client.user["first_name"], client.user["last_name"])

    matches: list[TeeTime] = []
    for target in targets:
        for d in dates:
            try:
                times = client.get_times(target, d, holes=flt.holes)
            except Exception:
                log.exception("failed to fetch %s on %s", target.name, d)
                continue
            hits = [t for t in times if flt.matches(t)]
            log.info("%s %s: %d total, %d match", target.name, d, len(times), len(hits))
            matches.extend(hits)

    # First-run behavior: if there is no state file yet, seed it with whatever
    # is currently visible and exit without emailing. Without this, the first
    # cron run would email a digest of every currently-available slot.
    first_run = not state_path.exists()
    seen = state.load(state_path)
    new = [t for t in matches if state.mark(seen, t.key)]

    if first_run:
        log.info(
            "first run — seeding state with %d match(es); no email sent",
            len(new),
        )
        if not dry_run:
            state.save(state_path, seen)
        return 0

    if not new:
        log.info("no new matches (%d total matches already known)", len(matches))
        if not dry_run:
            state.save(state_path, seen)
        return 0

    log.info("found %d new tee time(s)", len(new))
    if dry_run:
        log.info("DRY RUN — would email:\n%s", notify._plaintext(new))
        return 0

    notify.send_email(
        smtp_user=_require_env("GMAIL_USERNAME"),
        smtp_password=_require_env("GMAIL_APP_PASSWORD"),
        to_addr=_require_env("NOTIFY_TO"),
        new_times=new,
    )
    state.save(state_path, seen)
    return 0


def _require_env(name: str) -> str:
    v = os.environ.get(name)
    if not v:
        raise SystemExit(f"missing required env var: {name}")
    return v


def cli() -> int:
    import argparse
    p = argparse.ArgumentParser()
    p.add_argument("--config", type=Path, default=Path("config.yaml"))
    p.add_argument("--state", type=Path, default=Path("state.json"))
    p.add_argument("--dry-run", action="store_true", help="don't actually send email or write state")
    args = p.parse_args()
    return main(args.config, args.state, dry_run=args.dry_run)


if __name__ == "__main__":
    sys.exit(cli())
