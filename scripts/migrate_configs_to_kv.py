"""One-shot migration: emit Cloudflare KV bulk-put JSON from configs/*.yaml.

Run once after the Phase 2 worker is deployed:

    python scripts/migrate_configs_to_kv.py joshcharest1@gmail.com > /tmp/kv_bulk.json
    npx wrangler kv bulk put --binding=SNAPSHOT_KV --remote /tmp/kv_bulk.json

After verifying the keys land (``npx wrangler kv key list --binding=SNAPSHOT_KV
--remote``) you can delete the YAML files from the repo — KV is now the source
of truth.
"""

from __future__ import annotations

import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

import yaml


def slugify(name: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:60]
    return s or "set"


def normalise_time(v: object) -> str | object:
    # PyYAML 1.1 parses unquoted ``16:00`` as the sexagesimal int ``960``.
    # Normalise back to ``"HH:MM"`` so KV data is clean.
    if isinstance(v, int) and 0 <= v < 24 * 60:
        return f"{v // 60:02d}:{v % 60:02d}"
    return v


def normalise_filter(f: dict) -> dict:
    out = dict(f or {})
    out.pop("max_green_fee", None)  # deprecated, no longer in schema
    if "windows" in out and isinstance(out["windows"], list):
        out["windows"] = [
            {**w, "start": normalise_time(w.get("start")), "end": normalise_time(w.get("end"))}
            for w in out["windows"]
        ]
    return out


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__, file=sys.stderr)
        return 1
    owner = sys.argv[1]
    config_dir = Path("configs")
    if not config_dir.is_dir():
        print(f"no configs/ directory at {config_dir.resolve()}", file=sys.stderr)
        return 1
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")

    bulk: list[dict] = []
    for path in sorted(config_dir.glob("*.yaml")):
        cfg = yaml.safe_load(path.read_text())
        name = path.stem
        # Deterministic id (slug only, no random suffix) so re-running this
        # script is idempotent — it overwrites the existing KV entry in place
        # instead of creating a duplicate. UI-created configs use slug-<hex>
        # so they never collide with these migration ids.
        config_id = slugify(name)
        record = {
            "id": config_id,
            "name": name,
            "owner": owner,
            "subscribers": [],
            "enabled": cfg.get("enabled", True),
            "targets": cfg["targets"],
            "dates": cfg["dates"],
            "filter": normalise_filter(cfg["filter"]),
            "created_at": now,
            "updated_at": now,
        }
        bulk.append({"key": f"config:{config_id}", "value": json.dumps(record)})
        print(f"  staged config:{config_id}  ({path.name})", file=sys.stderr)

    json.dump(bulk, sys.stdout, indent=2)
    print(f"\nstaged {len(bulk)} config(s) for owner {owner}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
