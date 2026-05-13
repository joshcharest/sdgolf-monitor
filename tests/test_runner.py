"""Orchestrator tests using a stub ForeUp client (no real network)."""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

import pytest
import yaml

from sdgolf_monitor import main as main_mod
from sdgolf_monitor import runner
from sdgolf_monitor.client import TeeTime


class StubClient:
    """Drop-in ForeUp client that returns canned tee times per target."""

    def __init__(self, by_target: dict[str, list[dict[str, Any]]] | None = None):
        self.user = {"first_name": "Test", "last_name": "User"}
        self.calls: list[tuple[str, str]] = []
        self._by_target = by_target or {}

    def login(self, *_args, **_kwargs):
        return self.user

    def get_times(self, target, date, holes=18):
        self.calls.append((target.name, date))
        rows = self._by_target.get(target.name, [])
        return [
            TeeTime(
                target=r.get("target", target.name),
                date=r["date"],
                time=r["time"],
                available_spots=r.get("spots", 4),
                holes=r.get("holes", holes),
                green_fee=r.get("fee", 50.0),
                booking_fee=r.get("booking_fee"),
            )
            for r in rows
        ]


def _config(targets, *, holes=18, enabled=True):
    return {
        "enabled": enabled,
        "targets": [
            {"name": n, "teesheet_id": 1470, "booking_class": 929} for n in targets
        ],
        "dates": {"start": "today", "end": "today"},
        "filter": {
            "holes": holes,
            "min_players": 1,
            "max_green_fee": None,
            "windows": [{"start": "00:00", "end": "23:59"}],
        },
    }


def _write_config(d: Path, name: str, cfg: dict) -> None:
    (d / f"{name}.yaml").write_text(yaml.safe_dump(cfg))


def test_disabled_config_is_skipped(tmp_path, monkeypatch, caplog):
    caplog.set_level(logging.INFO, logger="sdgolf")
    cfg_dir = tmp_path / "configs"
    cfg_dir.mkdir()
    _write_config(cfg_dir, "disabled-set", _config(["A"], enabled=False))

    monkeypatch.setenv("SDGOLF_USERNAME", "x")
    monkeypatch.setenv("SDGOLF_PASSWORD", "x")
    monkeypatch.setattr(main_mod, "ForeUpClient", StubClient)

    main_mod.main(cfg_dir, tmp_path / "state", dry_run=True)
    assert "[disabled-set] disabled, skipping" in caplog.text
    # No state file written for a disabled set
    assert not (tmp_path / "state" / "disabled-set.json").exists()


def test_exception_in_one_set_doesnt_kill_others(tmp_path, monkeypatch, caplog):
    caplog.set_level(logging.INFO, logger="sdgolf")
    cfg_dir = tmp_path / "configs"
    cfg_dir.mkdir()
    _write_config(cfg_dir, "a-good", _config(["A"]))
    # Malformed config (filter missing) — will raise during run_check_set
    (cfg_dir / "b-broken.yaml").write_text("enabled: true\ntargets: []\n")
    _write_config(cfg_dir, "c-good", _config(["C"]))

    monkeypatch.setenv("SDGOLF_USERNAME", "x")
    monkeypatch.setenv("SDGOLF_PASSWORD", "x")
    monkeypatch.setattr(main_mod, "ForeUpClient", StubClient)

    main_mod.main(cfg_dir, tmp_path / "state", dry_run=True)

    text = caplog.text
    # The broken set raised, was caught, and logged
    assert "[b-broken] check set failed" in text
    # Both good sets still ran (their first-run seed log appears)
    assert "[a-good] first run" in text
    assert "[c-good] first run" in text
    # And the orchestrator continued past the broken one
    assert text.index("[b-broken]") < text.index("[c-good]")


def test_per_set_state_files_are_isolated(tmp_path):
    """Two sets seeing the same time slot keep independent dedup state."""
    state_dir = tmp_path / "state"
    state_dir.mkdir()
    cfg = _config(["A"])
    # Pre-seed set "alpha" so it's not in first-run mode
    (state_dir / "alpha.json").write_text("{}")

    rows = [{"date": "2026-06-01", "time": "08:00"}]
    client = StubClient(by_target={"A": rows})

    runner.run_check_set(
        client=client, cfg=cfg, state_path=state_dir / "alpha.json",
        set_name="alpha", dry_run=True, smtp=None,
    )
    # State write is skipped under dry_run, so alpha.json stays empty
    assert json.loads((state_dir / "alpha.json").read_text()) == {}

    # Run beta fresh — its state file doesn't exist yet → first-run seed
    runner.run_check_set(
        client=client, cfg=cfg, state_path=state_dir / "beta.json",
        set_name="beta", dry_run=False, smtp=None,
    )
    beta_state = json.loads((state_dir / "beta.json").read_text())
    # Beta's first-run seeded the slot; alpha state file is untouched
    assert any("A|2026-06-01|08:00" in k for k in beta_state)


def test_set_name_appears_in_dry_run_subject(tmp_path, caplog):
    caplog.set_level(logging.INFO, logger="sdgolf")
    state_path = tmp_path / "post-seed.json"
    state_path.write_text("{}")  # not first-run

    rows = [{"date": "2026-06-01", "time": "08:00"}]
    client = StubClient(by_target={"A": rows})
    cfg = _config(["A"])

    runner.run_check_set(
        client=client, cfg=cfg, state_path=state_path,
        set_name="my-special-set", dry_run=True, smtp=None,
    )
    assert "[my-special-set] DRY RUN" in caplog.text
    assert "[sdgolf:my-special-set]" in caplog.text


def test_no_configs_returns_zero(tmp_path, monkeypatch, caplog):
    caplog.set_level(logging.WARNING, logger="sdgolf")
    cfg_dir = tmp_path / "configs"
    cfg_dir.mkdir()
    monkeypatch.setenv("SDGOLF_USERNAME", "x")
    monkeypatch.setenv("SDGOLF_PASSWORD", "x")
    rc = main_mod.main(cfg_dir, tmp_path / "state", dry_run=True)
    assert rc == 0
    assert "no check sets found" in caplog.text
