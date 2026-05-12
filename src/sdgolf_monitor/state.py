"""On-disk state tracking which tee-time slots have already triggered an alert.

The file is a JSON map ``{ tee_time_key: iso_timestamp_first_seen }``. Entries
are pruned when their date is in the past so the file stays small.
"""

from __future__ import annotations

import json
from datetime import date, datetime, timezone
from pathlib import Path


def load(path: Path) -> dict[str, str]:
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text())
    except json.JSONDecodeError:
        return {}


def save(path: Path, state: dict[str, str]) -> None:
    pruned = _prune_past(state)
    path.write_text(json.dumps(dict(sorted(pruned.items())), indent=2) + "\n")


def mark(state: dict[str, str], key: str) -> bool:
    """Record ``key`` as notified. Returns True if it was new, False if already present."""
    if key in state:
        return False
    state[key] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    return True


def _prune_past(state: dict[str, str]) -> dict[str, str]:
    today = date.today().isoformat()
    out = {}
    for key, ts in state.items():
        # key format: "target|YYYY-MM-DD|HH:MM|holes"
        parts = key.split("|")
        if len(parts) >= 2 and parts[1] >= today:
            out[key] = ts
    return out
