"""Discovery helper: list each teesheet's slot count under each of the user's
booking classes for the next 60 days, for both 9-hole and 18-hole rounds.
Use this to pick the right values when writing a new ``configs/*.yaml``.

Usage::

    SDGOLF_USERNAME=... SDGOLF_PASSWORD=... python -m sdgolf_monitor.discover
    # or just one hole count:
    python -m sdgolf_monitor.discover --holes 9
"""

from __future__ import annotations

import os
import sys
from datetime import date, timedelta

from .client import BASE, ForeUpClient, Target

# San Diego City Golf course/teesheet mapping (discovered via the
# /api/booking/courses/{id}/schedules endpoint).
KNOWN_TEESHEETS = [
    ("Balboa Park 18", 1470),
    ("Balboa Park 9", 1490),
    ("Torrey Pines North", 1468),
    ("Torrey Pines South", 1487),
]


def main(holes_to_probe: tuple[int, ...] = (9, 18)) -> int:
    user_env = os.environ.get("SDGOLF_USERNAME")
    pw_env = os.environ.get("SDGOLF_PASSWORD")
    if not user_env or not pw_env:
        print("set SDGOLF_USERNAME and SDGOLF_PASSWORD env vars", file=sys.stderr)
        return 2

    client = ForeUpClient()
    user = client.login(user_env, pw_env)
    print(f"logged in as {user['first_name']} {user['last_name']}")
    classes = user["booking_class_ids"]
    print(f"booking_class_ids: {classes}")
    print()

    probe_dates = [(date.today() + timedelta(days=n)).isoformat() for n in (3, 10, 30, 60)]
    print(f"probing dates: {probe_dates}")
    print(f"probing hole counts: {holes_to_probe}")
    print()

    header = f"{'teesheet':<22} {'holes':>5} {'class':>6}  " + "  ".join(f"{d:>10}" for d in probe_dates)
    print(header)
    print("-" * len(header))
    for sheet_name, sheet_id in KNOWN_TEESHEETS:
        for holes in holes_to_probe:
            for cls in classes:
                counts = []
                for d in probe_dates:
                    try:
                        times = client.get_times(Target(sheet_name, sheet_id, cls), d, holes=holes)
                        counts.append(str(len(times)))
                    except Exception as e:  # noqa: BLE001
                        counts.append(f"err({type(e).__name__})")
                if any(c != "0" for c in counts):
                    print(
                        f"{sheet_name:<22} {holes:>5} {cls:>6}  "
                        + "  ".join(f"{c:>10}" for c in counts)
                    )
    return 0


def cli() -> int:
    import argparse
    p = argparse.ArgumentParser()
    p.add_argument(
        "--holes", type=int, choices=(9, 18), action="append",
        help="probe only this hole count (can be passed twice). Default: both.",
    )
    args = p.parse_args()
    holes = tuple(args.holes) if args.holes else (9, 18)
    return main(holes)


if __name__ == "__main__":
    sys.exit(cli())
