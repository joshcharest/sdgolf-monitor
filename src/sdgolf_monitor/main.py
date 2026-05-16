"""Entry point: scan every ``configs/*.yaml`` check set in one pass.

Logs into ForeUp once, then runs each enabled check set independently. A
failure in one set is logged and skipped so it can't take down the others.
"""

from __future__ import annotations

import json
import logging
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import yaml

from .client import ForeUpClient, TeeTime
from .runner import SmtpCreds, run_check_set

log = logging.getLogger("sdgolf")


def main(
    config_dir: Path,
    state_dir: Path,
    *,
    dry_run: bool = False,
    snapshot_path: Path | None = None,
) -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )

    config_paths = sorted(config_dir.glob("*.yaml"))
    if not config_paths:
        log.warning("no check sets found in %s", config_dir)
        if snapshot_path:
            _write_snapshot(snapshot_path, {})
        return 0

    username = _require_env("SDGOLF_USERNAME")
    password = _require_env("SDGOLF_PASSWORD")

    smtp: SmtpCreds | None = None
    if not dry_run:
        smtp = SmtpCreds(
            user=_require_env("GMAIL_USERNAME"),
            password=_require_env("GMAIL_APP_PASSWORD"),
            to_addr=_require_env("NOTIFY_TO"),
        )

    client = ForeUpClient()
    client.login(username, password)
    log.info(
        "logged in as %s %s; %d check set(s) to scan",
        client.user["first_name"], client.user["last_name"], len(config_paths),
    )

    snapshot: dict[str, dict] = {}
    state_dir.mkdir(parents=True, exist_ok=True)
    for cfg_path in config_paths:
        set_name = cfg_path.stem
        try:
            cfg = yaml.safe_load(cfg_path.read_text())
        except Exception as e:
            log.exception("[%s] failed to parse %s; skipping", set_name, cfg_path)
            snapshot[set_name] = {"enabled": True, "error": f"parse: {e}", "matches": []}
            continue

        if cfg.get("enabled", True) is False:
            log.info("[%s] disabled, skipping", set_name)
            snapshot[set_name] = {"enabled": False, "matches": []}
            continue

        try:
            matches = run_check_set(
                client=client,
                cfg=cfg,
                state_path=state_dir / f"{set_name}.json",
                set_name=set_name,
                dry_run=dry_run,
                smtp=smtp,
            )
            snapshot[set_name] = {
                "enabled": True,
                "matches": [_match_dict(m) for m in (matches or [])],
            }
        except Exception as e:
            log.exception("[%s] check set failed; continuing with remaining sets", set_name)
            snapshot[set_name] = {"enabled": True, "error": str(e), "matches": []}

    if snapshot_path:
        _write_snapshot(snapshot_path, snapshot)

    return 0


def _match_dict(tt: TeeTime) -> dict:
    return {
        "target": tt.target,
        "date": tt.date,
        "time": tt.time,
        "holes": tt.holes,
        "available_spots": tt.available_spots,
        "green_fee": tt.green_fee,
        "booking_fee": tt.booking_fee,
    }


def _write_snapshot(path: Path, sets: dict[str, dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "sets": sets,
    }
    path.write_text(json.dumps(payload, indent=2) + "\n")


def _require_env(name: str) -> str:
    v = os.environ.get(name)
    if not v:
        raise SystemExit(f"missing required env var: {name}")
    return v


def cli() -> int:
    import argparse
    p = argparse.ArgumentParser()
    p.add_argument("--config-dir", type=Path, default=Path("configs"))
    p.add_argument("--state-dir", type=Path, default=Path("state"))
    p.add_argument("--dry-run", action="store_true", help="don't email or write state")
    p.add_argument("--snapshot-path", type=Path, default=None,
                   help="write a JSON snapshot of current matches per set to this path")
    args = p.parse_args()
    return main(args.config_dir, args.state_dir, dry_run=args.dry_run, snapshot_path=args.snapshot_path)


if __name__ == "__main__":
    sys.exit(cli())
