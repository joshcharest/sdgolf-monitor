"""Entry point: scan every check set returned by the Worker in one pass.

Logs into ForeUp once, then runs each enabled check set independently. A
failure in one set is logged and skipped so it can't take down the others.

Configs no longer live on disk — the Cloudflare Worker is the source of
truth. ``cli()`` fetches them over HTTPS at startup; ``main()`` operates on
the already-fetched list so tests can pass dicts directly.
"""

from __future__ import annotations

import json
import logging
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import requests

from . import autobook, notify
from .client import ForeUpClient, TeeTime
from .runner import CachingClient, SmtpCreds, recipients_for, run_check_set
from .teeitup import TeeItUpClient

log = logging.getLogger("sdgolf")


def main(
    state_dir: Path,
    *,
    configs: list[dict[str, Any]],
    dry_run: bool = False,
    snapshot_path: Path | None = None,
    pending: list[dict[str, Any]] | None = None,
    pending_consume: "callable[[str], None] | None" = None,
    bugs: list[dict[str, Any]] | None = None,
    bug_consume: "callable[[str], None] | None" = None,
    admin_emails: list[str] | None = None,
    worker_url: str | None = None,
    unsubscribe_secret: str | None = None,
    autobook_account_email: str | None = None,
) -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )

    if not configs:
        log.warning("no check sets returned from worker")
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
        )

    client = ForeUpClient()
    client.login(username, password)
    # CachingClient dedupes identical get_times calls across check sets in
    # this tick — two configs scanning the same teesheet/date now share
    # one HTTP response. Fresh wrapper per tick so caches don't persist.
    foreup_cached = CachingClient(client)
    teeitup_cached = CachingClient(TeeItUpClient())
    clients = {"foreup": foreup_cached, "teeitup": teeitup_cached}
    log.info(
        "logged in as %s %s; %d check set(s) to scan",
        client.user["first_name"], client.user["last_name"], len(configs),
    )

    # Group pending confirmations by config id so we can suppress the regular
    # new-matches email for those recipients (they'll get the confirmation
    # email with the same matches included; avoids a duplicate).
    pending = pending or []
    pending_by_config: dict[str, list[dict[str, Any]]] = {}
    for p in pending:
        pending_by_config.setdefault(p.get("config_id"), []).append(p)

    snapshot: dict[str, dict] = {}
    state_dir.mkdir(parents=True, exist_ok=True)

    # Autobook budget is shared across all check sets in this tick so the
    # daily cap (1 attempt/day) holds globally. Loaded once, saved once.
    autobook_state_path = state_dir / "autobook.json"
    autobook_budget: autobook.Budget | None = None
    if autobook_account_email and not dry_run:
        autobook_state = autobook.prune_future(autobook.load_state(autobook_state_path))
        autobook_budget = autobook.Budget(autobook_state, autobook_account_email)

    for cfg in configs:
        config_id = cfg.get("id") or cfg.get("name") or "<unnamed>"
        set_name = cfg.get("name") or config_id
        common = {
            "id": config_id,
            "name": set_name,
            "owner": cfg.get("owner"),
            "subscribers": cfg.get("subscribers") or [],
        }

        if cfg.get("enabled", True) is False:
            log.info("[%s] disabled, skipping", set_name)
            snapshot[config_id] = {**common, "enabled": False, "matches": []}
            continue

        pending_emails = {p.get("email") for p in pending_by_config.get(config_id, [])}
        recipients_override = None
        if pending_emails:
            recipients_override = [r for r in recipients_for(cfg) if r not in pending_emails]

        try:
            matches = run_check_set(
                clients=clients,
                cfg=cfg,
                state_path=state_dir / f"{config_id}.json",
                set_name=set_name,
                dry_run=dry_run,
                smtp=smtp,
                recipients_override=recipients_override,
                worker_url=worker_url,
                unsubscribe_secret=unsubscribe_secret,
                autobook_budget=autobook_budget,
                autobook_account_email=autobook_account_email,
            )
            snapshot[config_id] = {
                **common,
                "enabled": True,
                "matches": [_match_dict(m) for m in (matches or [])],
            }
        except Exception as e:
            log.exception("[%s] check set failed; continuing with remaining sets", set_name)
            snapshot[config_id] = {
                **common,
                "enabled": True,
                "error": str(e),
                "matches": [],
            }

    # Process pending confirmations after all check sets ran so we can attach
    # the freshly computed current matches.
    if pending and not dry_run and smtp is not None:
        cfgs_by_id = {c["id"]: c for c in configs}
        for p in pending:
            cfg = cfgs_by_id.get(p.get("config_id"))
            if not cfg:
                log.warning("pending confirmation references missing config %s; dropping", p.get("config_id"))
                if pending_consume:
                    pending_consume(p["key"])
                continue
            matches_for_email = snapshot.get(p["config_id"], {}).get("matches") or []
            try:
                notify.send_confirmation_email(
                    smtp_user=smtp.user,
                    smtp_password=smtp.password,
                    to_addr=p["email"],
                    action=p.get("action", "subscribe"),
                    cfg=cfg,
                    current_matches=matches_for_email,
                    worker_url=worker_url,
                    unsubscribe_secret=unsubscribe_secret,
                )
                log.info("[%s] sent %s confirmation to %s", cfg.get("name"), p.get("action"), p["email"])
            except Exception:
                log.exception("failed to send confirmation for %s to %s; will retry next run",
                              p.get("config_id"), p.get("email"))
                continue  # don't consume; retry on next tick
            if pending_consume:
                pending_consume(p["key"])

    # Process bug reports — email each pending bug to the admin list, then
    # consume the KV record so we don't re-send.
    if bugs and not dry_run and smtp is not None and admin_emails:
        for b in bugs:
            try:
                notify.send_bug_report(
                    smtp_user=smtp.user,
                    smtp_password=smtp.password,
                    to_addrs=admin_emails,
                    bug=b,
                )
                log.info("emailed bug %s from %s to %d admin(s)", b.get("id"), b.get("email"), len(admin_emails))
            except Exception:
                log.exception("failed to send bug report %s; will retry next run", b.get("id"))
                continue
            if bug_consume:
                bug_consume(b["key"])

    if autobook_budget is not None:
        autobook.save_state(autobook_state_path, autobook_budget.snapshot())

    total_hits = foreup_cached.hits + teeitup_cached.hits
    total_misses = foreup_cached.misses + teeitup_cached.misses
    if total_hits + total_misses:
        log.info(
            "request cache: %d hit(s) / %d miss(es) — saved %d HTTP call(s)",
            total_hits, total_misses, total_hits,
        )

    if snapshot_path:
        reservations = _extract_reservations(client.user or {})
        _write_snapshot(snapshot_path, snapshot, reservations)

    return 0


def fetch_configs(worker_url: str, runner_secret: str) -> list[dict[str, Any]]:
    resp = requests.get(
        f"{worker_url.rstrip('/')}/api/internal/configs",
        headers={"Authorization": f"Bearer {runner_secret}"},
        timeout=20,
    )
    resp.raise_for_status()
    return resp.json()


def fetch_pending(worker_url: str, runner_secret: str) -> list[dict[str, Any]]:
    resp = requests.get(
        f"{worker_url.rstrip('/')}/api/internal/pending",
        headers={"Authorization": f"Bearer {runner_secret}"},
        timeout=20,
    )
    resp.raise_for_status()
    return resp.json()


def consume_pending(worker_url: str, runner_secret: str, key: str) -> None:
    pending_id = key.removeprefix("pending:")
    resp = requests.delete(
        f"{worker_url.rstrip('/')}/api/internal/pending/{pending_id}",
        headers={"Authorization": f"Bearer {runner_secret}"},
        timeout=20,
    )
    if resp.status_code not in (200, 204, 404):
        resp.raise_for_status()


def fetch_bugs(worker_url: str, runner_secret: str) -> list[dict[str, Any]]:
    resp = requests.get(
        f"{worker_url.rstrip('/')}/api/internal/bugs",
        headers={"Authorization": f"Bearer {runner_secret}"},
        timeout=20,
    )
    resp.raise_for_status()
    return resp.json()


def consume_bug(worker_url: str, runner_secret: str, key: str) -> None:
    bug_id = key.removeprefix("bug:")
    resp = requests.delete(
        f"{worker_url.rstrip('/')}/api/internal/bugs/{bug_id}",
        headers={"Authorization": f"Bearer {runner_secret}"},
        timeout=20,
    )
    if resp.status_code not in (200, 204, 404):
        resp.raise_for_status()


# Teesheet id -> the human label used elsewhere in the app. Mirrors
# ui/schema.js TEESHEETS — keep in sync. Used to swap ForeUp's verbose
# "Balboa Park 18 hole" / "Torrey Pines - North" naming for the short label.
_TEESHEET_LABELS = {
    1470: "Balboa Park 18",
    1490: "Balboa Park 9",
    1468: "Torrey Pines North",
    1487: "Torrey Pines South",
}


def _extract_reservations(user: dict[str, Any]) -> list[dict]:
    """Pull upcoming reservations out of the ForeUp login response.

    The /api/booking/users/login endpoint already returns a `reservations`
    array attached to the user object, so this is free — no extra HTTP call.
    Filters out cancelled and past reservations, normalizes the fields the
    UI cares about, and sorts by start time ascending.
    """
    raw = user.get("reservations") or []
    if not isinstance(raw, list):
        return []
    out: list[dict] = []
    now = datetime.now()  # ForeUp times are course-local; local-naive compare is fine
    for r in raw:
        if not isinstance(r, dict):
            continue
        if r.get("date_cancelled") and r.get("date_cancelled") != "0000-00-00 00:00:00":
            continue
        start_str = r.get("start_datetime") or r.get("time") or ""
        try:
            start_dt = datetime.fromisoformat(start_str.replace(" ", "T"))
        except ValueError:
            continue
        if start_dt < now:
            continue
        try:
            ts_id = int(r.get("teesheet_id"))
        except (TypeError, ValueError):
            ts_id = None
        try:
            holes = int(r.get("holes") or 18)
        except ValueError:
            holes = 18
        try:
            players = int(r.get("player_count") or 0)
        except ValueError:
            players = 0
        out.append({
            "id": r.get("TTID") or r.get("teetime_id"),
            "course": _TEESHEET_LABELS.get(ts_id) or r.get("teesheet_title") or "?",
            "teesheet_id": ts_id,
            "date": start_dt.strftime("%Y-%m-%d"),
            "time": start_dt.strftime("%H:%M"),
            "holes": holes,
            "players": players,
            "title": r.get("title") or "",
        })
    out.sort(key=lambda x: (x["date"], x["time"]))
    return out


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


def _write_snapshot(path: Path, sets: dict[str, dict], reservations: list[dict] | None = None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload: dict[str, Any] = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "sets": sets,
    }
    if reservations:
        payload["reservations"] = reservations
    path.write_text(json.dumps(payload, indent=2) + "\n")


def _require_env(name: str) -> str:
    v = os.environ.get(name)
    if not v:
        raise SystemExit(f"missing required env var: {name}")
    return v


def cli() -> int:
    import argparse
    p = argparse.ArgumentParser()
    p.add_argument("--state-dir", type=Path, default=Path("state"))
    p.add_argument("--dry-run", action="store_true", help="don't email or write state")
    p.add_argument("--snapshot-path", type=Path, default=None,
                   help="write a JSON snapshot of current matches per set to this path")
    args = p.parse_args()

    worker_url = _require_env("WORKER_URL")
    runner_secret = _require_env("RUNNER_SECRET")
    configs = fetch_configs(worker_url, runner_secret)
    try:
        pending = fetch_pending(worker_url, runner_secret)
    except Exception:
        log.exception("failed to fetch pending confirmations; continuing without them")
        pending = []
    try:
        bugs = fetch_bugs(worker_url, runner_secret)
    except Exception:
        log.exception("failed to fetch bug reports; continuing without them")
        bugs = []
    admin_emails = [
        e.strip() for e in os.environ.get("ADMIN_EMAILS", "sdgolfmonitor@gmail.com").split(",") if e.strip()
    ]
    # The app-side email of whichever user "owns" the runner's ForeUp account
    # (i.e. would be charged if autobook books a slot). Autobook is restricted
    # to configs where cfg.owner matches this address. Unset = autobook off.
    autobook_account_email = os.environ.get("AUTOBOOK_OWNER_EMAIL", "").strip() or None

    return main(
        args.state_dir,
        configs=configs,
        dry_run=args.dry_run,
        snapshot_path=args.snapshot_path,
        pending=pending,
        pending_consume=lambda key: consume_pending(worker_url, runner_secret, key),
        bugs=bugs,
        bug_consume=lambda key: consume_bug(worker_url, runner_secret, key),
        admin_emails=admin_emails,
        worker_url=worker_url,
        unsubscribe_secret=runner_secret,
        autobook_account_email=autobook_account_email,
    )


if __name__ == "__main__":
    sys.exit(cli())
