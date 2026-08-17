"""Out-of-band liveness check: is the monitor still publishing fresh data?

Runs on GitHub's own ``schedule:`` trigger, deliberately *not* on the
Cloudflare cron that drives the monitor. The whole point is to survive the
failure it is watching for: on 2026-08-16 the dispatch token hit its 90-day
expiry, dispatch started 401'ing, and the monitor sat dead for five hours
with no symptom other than an inbox that had gone quiet — which looks
exactly like a Sunday evening with no cancellations.

Asks the Worker how old the published snapshot is and emails the admins when
it has gone stale. Exits non-zero in that case so the workflow run goes red
too: GitHub's own failure notification is a second, independent channel that
does not depend on Gmail delivering.
"""

from __future__ import annotations

import logging
import os
import sys

import requests

from . import notify

log = logging.getLogger("sdgolf.heartbeat")

TIMEOUT_SEC = 20


def _admin_addrs() -> list[str]:
    """Admins first, NOTIFY_TO as the fallback for a single-user install."""
    raw = os.environ.get("ADMIN_EMAILS", "") or os.environ.get("NOTIFY_TO", "")
    return [e.strip() for e in raw.split(",") if e.strip()]


def fetch_health(worker_url: str) -> dict:
    """Read /api/health. A stale Worker answers 503, which is not an error."""
    resp = requests.get(f"{worker_url.rstrip('/')}/api/health", timeout=TIMEOUT_SEC)
    if resp.status_code not in (200, 503):
        resp.raise_for_status()
    return resp.json()


def cli() -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    worker_url = os.environ.get("WORKER_URL", "").strip()
    if not worker_url:
        log.error("WORKER_URL is not set")
        return 2

    try:
        health = fetch_health(worker_url)
    except Exception:
        # The Worker being unreachable is itself an outage, but this check
        # cannot tell a Cloudflare blip from a real one and has no state to
        # debounce with. Fail loudly (red run) without emailing on a blip.
        log.exception("could not reach %s/api/health", worker_url)
        return 1

    age = health.get("age_seconds")
    age_text = notify._duration(age) if isinstance(age, (int, float)) else "unknown"
    if not health.get("stale"):
        log.info("healthy — snapshot published %s ago", age_text)
        return 0

    log.error(
        "STALE — snapshot last published %s (%s ago); threshold %s",
        health.get("generated_at") or "never",
        age_text,
        notify._duration(health.get("stale_after_seconds")),
    )

    to_addrs = _admin_addrs()
    smtp_user = os.environ.get("GMAIL_USERNAME", "").strip()
    smtp_password = os.environ.get("GMAIL_APP_PASSWORD", "").strip()
    if not (to_addrs and smtp_user and smtp_password):
        # Still exit non-zero: the red run is the surviving signal.
        log.error("cannot email the alert — ADMIN_EMAILS/GMAIL_* not fully set")
        return 1

    try:
        notify.send_stale_alert(
            smtp_user=smtp_user,
            smtp_password=smtp_password,
            to_addrs=to_addrs,
            health=health,
            worker_url=worker_url,
        )
        log.info("stale alert emailed to %s", ", ".join(to_addrs))
    except Exception:
        log.exception("failed to email the stale alert")

    return 1


if __name__ == "__main__":
    sys.exit(cli())
