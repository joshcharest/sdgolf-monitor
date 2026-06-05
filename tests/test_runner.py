"""Orchestrator tests using a stub ForeUp client (no real network)."""

from __future__ import annotations

import json
import logging
from datetime import date, timedelta
from pathlib import Path
from typing import Any

import pytest

from sdgolf_monitor import autobook, main as main_mod
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
        # Real runner now passes holes="all" for mixed-holes filters and
        # lets per-slot filtering happen downstream; ignore the param and
        # default each row to 18 unless explicitly set.
        self.calls.append((target.name, date))
        rows = self._by_target.get(target.name, [])
        return [
            TeeTime(
                target=r.get("target", target.name),
                date=r["date"],
                time=r["time"],
                available_spots=r.get("spots", 4),
                holes=r.get("holes", 18),
                green_fee=r.get("fee", 50.0),
                booking_fee=r.get("booking_fee"),
            )
            for r in rows
        ]


def _config(name, targets, *, holes=18, enabled=True, owner="owner@example.com"):
    return {
        "id": name,
        "name": name,
        "owner": owner,
        "subscribers": [],
        "enabled": enabled,
        "targets": [
            {"name": n, "teesheet_id": 1470, "booking_class": 929} for n in targets
        ],
        "dates": {"start": "today", "end": "today"},
        "filter": {
            "holes": holes,
            "min_players": 1,
            "windows": [{"start": "00:00", "end": "23:59"}],
        },
    }


def test_disabled_config_is_skipped(tmp_path, monkeypatch, caplog):
    caplog.set_level(logging.INFO, logger="sdgolf")
    monkeypatch.setenv("SDGOLF_USERNAME", "x")
    monkeypatch.setenv("SDGOLF_PASSWORD", "x")
    monkeypatch.setattr(main_mod, "ForeUpClient", StubClient)

    main_mod.main(
        tmp_path / "state",
        configs=[_config("disabled-set", ["A"], enabled=False)],
        dry_run=True,
    )
    assert "[disabled-set] disabled, skipping" in caplog.text
    # No state file written for a disabled set
    assert not (tmp_path / "state" / "disabled-set.json").exists()


def test_exception_in_one_set_doesnt_kill_others(tmp_path, monkeypatch, caplog):
    caplog.set_level(logging.INFO, logger="sdgolf")
    # Malformed config (filter missing) — will raise during run_check_set
    broken = {"id": "b-broken", "name": "b-broken", "owner": "x@y", "enabled": True, "targets": []}
    monkeypatch.setenv("SDGOLF_USERNAME", "x")
    monkeypatch.setenv("SDGOLF_PASSWORD", "x")
    monkeypatch.setattr(main_mod, "ForeUpClient", StubClient)

    main_mod.main(
        tmp_path / "state",
        configs=[_config("a-good", ["A"]), broken, _config("c-good", ["C"])],
        dry_run=True,
    )

    text = caplog.text
    # The broken set raised, was caught, and logged
    assert "[b-broken] check set failed" in text
    # Both good sets still ran (StubClient returns no rows → "no new matches")
    assert "[a-good] no new matches" in text
    assert "[c-good] no new matches" in text
    # And the orchestrator continued past the broken one
    assert text.index("[b-broken]") < text.index("[c-good]")


def test_per_set_state_files_are_isolated(tmp_path, monkeypatch):
    """Two sets seeing the same time slot keep independent dedup state."""
    state_dir = tmp_path / "state"
    state_dir.mkdir()
    cfg = _config("alpha", ["A"], owner="owner@example.com")

    # Stub the email sender — we're testing state isolation, not delivery
    sent: list[dict] = []
    monkeypatch.setattr(runner.notify, "send_email", lambda **kw: sent.append(kw))

    # Use a future date so state.save's _prune_past doesn't strip the slot
    # (it drops keys whose date is before today). A hardcoded date would make
    # this test start failing the moment that date goes stale.
    slot_date = (date.today() + timedelta(days=2)).isoformat()
    rows = [{"date": slot_date, "time": "08:00"}]
    client = StubClient(by_target={"A": rows})
    smtp = runner.SmtpCreds(user="u", password="p")

    # Alpha runs dry — finds the slot, "would email", returns without saving
    runner.run_check_set(
        clients={"foreup": client}, cfg=cfg, state_path=state_dir / "alpha.json",
        set_name="alpha", dry_run=True, smtp=None,
    )
    assert not (state_dir / "alpha.json").exists()

    # Beta runs live — finds the slot, emails, saves state to its own file
    runner.run_check_set(
        clients={"foreup": client}, cfg=cfg, state_path=state_dir / "beta.json",
        set_name="beta", dry_run=False, smtp=smtp,
    )
    beta_state = json.loads((state_dir / "beta.json").read_text())
    assert any(f"A|{slot_date}|08:00" in k for k in beta_state)
    # Alpha's file was never created — state lives per-set, not shared
    assert not (state_dir / "alpha.json").exists()
    assert len(sent) == 1 and sent[0]["set_name"] == "beta"
    assert sent[0]["to_addrs"] == ["owner@example.com"]


def test_dry_run_logs_subject_with_slot_headline(tmp_path, caplog):
    """The DRY RUN log line includes the new slot-headline subject."""
    caplog.set_level(logging.INFO, logger="sdgolf")
    state_path = tmp_path / "post-seed.json"
    state_path.write_text("{}")  # not first-run

    rows = [{"date": "2026-06-01", "time": "08:00"}]
    client = StubClient(by_target={"A": rows})
    cfg = _config("my-special-set", ["A"])

    runner.run_check_set(
        clients={"foreup": client}, cfg=cfg, state_path=state_path,
        set_name="my-special-set", dry_run=True, smtp=None,
    )
    assert "[my-special-set] DRY RUN" in caplog.text
    # Subject leads with the set name, then dow / date / time / course.
    assert "my-special-set: Mon 6/1 8 AM A" in caplog.text


def test_no_configs_returns_zero(tmp_path, monkeypatch, caplog):
    caplog.set_level(logging.WARNING, logger="sdgolf")
    monkeypatch.setenv("SDGOLF_USERNAME", "x")
    monkeypatch.setenv("SDGOLF_PASSWORD", "x")
    rc = main_mod.main(tmp_path / "state", configs=[], dry_run=True)
    assert rc == 0
    assert "no check sets returned" in caplog.text


def _login_failer(exc):
    class FailingClient(StubClient):
        def login(self, *_args, **_kwargs):
            raise exc
    return FailingClient


def test_transient_login_block_skips_tick_without_snapshot(tmp_path, monkeypatch, caplog):
    """A WAF 403 surviving retries is a missed beat: exit 0, write no snapshot."""
    from sdgolf_monitor.client import ForeUpAuthError

    caplog.set_level(logging.WARNING, logger="sdgolf")
    monkeypatch.setenv("SDGOLF_USERNAME", "x")
    monkeypatch.setenv("SDGOLF_PASSWORD", "x")
    waf = ForeUpAuthError("login http 403: forbidden")
    waf.status_code = 403
    monkeypatch.setattr(main_mod, "ForeUpClient", _login_failer(waf))

    snap = tmp_path / "snapshot.json"
    rc = main_mod.main(
        tmp_path / "state",
        configs=[_config("a-good", ["A"])],
        dry_run=True,
        snapshot_path=snap,
    )
    assert rc == 0
    assert "login blocked by ForeUp edge" in caplog.text
    # No snapshot → the workflow leaves the last good KV snapshot untouched.
    assert not snap.exists()


def test_genuine_login_rejection_is_raised(tmp_path, monkeypatch):
    """Bad password (no retryable status) must fail loudly, not skip silently."""
    from sdgolf_monitor.client import ForeUpAuthError

    monkeypatch.setenv("SDGOLF_USERNAME", "x")
    monkeypatch.setenv("SDGOLF_PASSWORD", "x")
    rejected = ForeUpAuthError("login rejected: {'success': False}")
    monkeypatch.setattr(main_mod, "ForeUpClient", _login_failer(rejected))

    with pytest.raises(ForeUpAuthError):
        main_mod.main(
            tmp_path / "state",
            configs=[_config("a-good", ["A"])],
            dry_run=True,
        )


def test_autobook_fires_for_owner_and_caps_at_one_per_day(tmp_path, monkeypatch):
    """Owner's autobook fires once; second config that day is skipped by the cap."""
    from datetime import date as _date_mod, datetime, timezone
    state_dir = tmp_path / "state"
    state_dir.mkdir()
    cfg_a = _config("alpha", ["A"], owner="owner@example.com")
    cfg_a["autobook"] = {"enabled": True}
    cfg_b = _config("beta", ["B"], owner="owner@example.com")
    cfg_b["autobook"] = {"enabled": True}

    # Slot dates must land in the no-fee window (<7 days out) and outside
    # the per-course lead-time guard (3h for non-Torrey targets here).
    fake_now = datetime(2026, 5, 30, 12, 0, tzinfo=timezone.utc)
    monkeypatch.setattr(autobook, "datetime", _FakeDatetime(fake_now))
    monkeypatch.setattr(autobook, "date", _FakeDate(_date_mod(2026, 5, 30)))

    rows_a = [{"date": "2026-06-01", "time": "08:00", "spots": 3}]
    rows_b = [{"date": "2026-06-02", "time": "09:00", "spots": 4}]
    client = StubClient(by_target={"A": rows_a, "B": rows_b})

    monkeypatch.setattr(runner.notify, "send_email", lambda **kw: None)
    autobook_calls: list[dict] = []
    monkeypatch.setattr(runner.notify, "send_autobook_email",
                        lambda **kw: autobook_calls.append(kw))

    budget = autobook.Budget({"date": "", "slots": []}, "owner@example.com")
    smtp = runner.SmtpCreds(user="u", password="p")
    runner.run_check_set(clients={"foreup": client}, cfg=cfg_a, state_path=state_dir / "alpha.json",
                         set_name="alpha", dry_run=False, smtp=smtp,
                         autobook_budget=budget)
    runner.run_check_set(clients={"foreup": client}, cfg=cfg_b, state_path=state_dir / "beta.json",
                         set_name="beta", dry_run=False, smtp=smtp,
                         autobook_budget=budget)

    assert len(autobook_calls) == 1
    assert autobook_calls[0]["set_name"] == "alpha"
    assert autobook_calls[0]["slot"].target == "A"
    assert autobook_calls[0]["players"] == 3
    assert budget.available() is False


def test_autobook_skips_slot_within_lead_time(tmp_path, monkeypatch):
    """A near-term slot is filtered out; the next-earliest eligible one wins."""
    from datetime import date as _date_mod, datetime, timezone
    state_dir = tmp_path / "state"
    state_dir.mkdir()
    cfg = _config("alpha", ["A"], owner="owner@example.com")
    cfg["autobook"] = {"enabled": True}

    # Freeze "now" to 2026-06-01 14:00 UTC (= 07:00 Pacific) so we control
    # the 3-hour lead-time window deterministically. Freeze the date too so
    # the slot stays inside the no-fee window.
    fake_now = datetime(2026, 6, 1, 14, 0, tzinfo=timezone.utc)
    monkeypatch.setattr(autobook, "datetime", _FakeDatetime(fake_now))
    monkeypatch.setattr(autobook, "date", _FakeDate(_date_mod(2026, 6, 1)))

    # 08:00 Pacific = +1h from now (too soon), 11:00 Pacific = +4h (eligible).
    rows = [
        {"date": "2026-06-01", "time": "08:00"},
        {"date": "2026-06-01", "time": "11:00"},
    ]
    client = StubClient(by_target={"A": rows})

    monkeypatch.setattr(runner.notify, "send_email", lambda **kw: None)
    autobook_calls: list[dict] = []
    monkeypatch.setattr(runner.notify, "send_autobook_email",
                        lambda **kw: autobook_calls.append(kw))

    budget = autobook.Budget({"date": "", "slots": []}, "owner@example.com")
    smtp = runner.SmtpCreds(user="u", password="p")
    runner.run_check_set(clients={"foreup": client}, cfg=cfg, state_path=state_dir / "alpha.json",
                         set_name="alpha", dry_run=False, smtp=smtp,
                         autobook_budget=budget)

    assert len(autobook_calls) == 1
    assert autobook_calls[0]["slot"].time == "11:00"


class _FakeDatetime:
    """Patch target for autobook.datetime so we can freeze datetime.now()."""
    def __init__(self, now):
        self._now = now
    def __call__(self, *a, **kw):
        from datetime import datetime as real
        return real(*a, **kw)
    def now(self, tz=None):
        return self._now if tz is None else self._now.astimezone(tz)
    def fromisoformat(self, s):
        from datetime import datetime as real
        return real.fromisoformat(s)


def test_autobook_torrey_requires_49h_lead_time(tmp_path, monkeypatch):
    """Torrey slots need 49h lead time; Balboa stays on the 3h default."""
    from datetime import date as _date_mod, datetime, timezone
    state_dir = tmp_path / "state"
    state_dir.mkdir()
    cfg = _config("alpha", ["Torrey Pines North", "Balboa Park 18"],
                  owner="owner@example.com")
    cfg["autobook"] = {"enabled": True}

    # Freeze now = 2026-06-01 14:00 UTC (07:00 Pacific 06-01).
    fake_now = datetime(2026, 6, 1, 14, 0, tzinfo=timezone.utc)
    monkeypatch.setattr(autobook, "datetime", _FakeDatetime(fake_now))
    monkeypatch.setattr(autobook, "date", _FakeDate(_date_mod(2026, 6, 1)))

    # Torrey @ 2026-06-02 09:00 PT = ~26h out -> below 49h threshold, skip.
    # Torrey @ 2026-06-03 09:00 PT = ~50h out -> eligible.
    # Balboa @ 2026-06-01 11:00 PT = ~4h out -> above 3h threshold, eligible.
    torrey_rows = [
        {"date": "2026-06-02", "time": "09:00"},   # too soon for Torrey
        {"date": "2026-06-03", "time": "09:00"},   # eligible
    ]
    balboa_rows = [
        {"date": "2026-06-01", "time": "11:00"},   # eligible (Balboa, >3h)
    ]
    client = StubClient(by_target={
        "Torrey Pines North": torrey_rows,
        "Balboa Park 18": balboa_rows,
    })

    monkeypatch.setattr(runner.notify, "send_email", lambda **kw: None)
    autobook_calls: list[dict] = []
    monkeypatch.setattr(runner.notify, "send_autobook_email",
                        lambda **kw: autobook_calls.append(kw))

    budget = autobook.Budget({"date": "", "slots": []}, "owner@example.com")
    smtp = runner.SmtpCreds(user="u", password="p")
    runner.run_check_set(clients={"foreup": client}, cfg=cfg, state_path=state_dir / "alpha.json",
                         set_name="alpha", dry_run=False, smtp=smtp,
                         autobook_budget=budget)

    # Earliest eligible across all matches wins — that's the Balboa 6/1 11am.
    assert len(autobook_calls) == 1
    assert autobook_calls[0]["slot"].target == "Balboa Park 18"
    assert autobook_calls[0]["slot"].date == "2026-06-01"


def test_autobook_skips_slot_with_advanced_fee(tmp_path, monkeypatch):
    """A slot whose ForeUp booking_fee flag is truthy is skipped."""
    from datetime import date, datetime, timezone
    state_dir = tmp_path / "state"
    state_dir.mkdir()
    cfg = _config("alpha", ["A"], owner="owner@example.com")
    cfg["autobook"] = {"enabled": True}

    fake_now = datetime(2026, 6, 1, 16, 0, tzinfo=timezone.utc)
    monkeypatch.setattr(autobook, "datetime", _FakeDatetime(fake_now))
    monkeypatch.setattr(autobook, "date", _FakeDate(date(2026, 6, 1)))

    # The runner reads booking_fee from each slot directly — no calendar
    # math involved — so we set it explicitly here. The first slot is in
    # the fee window (skip); the second is no-fee (eligible).
    rows = [
        {"date": "2026-06-08", "time": "08:00", "booking_fee": 32.0},
        {"date": "2026-06-07", "time": "08:00", "booking_fee": None},
    ]
    client = StubClient(by_target={"A": rows})

    monkeypatch.setattr(runner.notify, "send_email", lambda **kw: None)
    autobook_calls: list[dict] = []
    monkeypatch.setattr(runner.notify, "send_autobook_email",
                        lambda **kw: autobook_calls.append(kw))

    budget = autobook.Budget({"date": "", "slots": []}, "owner@example.com")
    smtp = runner.SmtpCreds(user="u", password="p")
    runner.run_check_set(clients={"foreup": client}, cfg=cfg, state_path=state_dir / "alpha.json",
                         set_name="alpha", dry_run=False, smtp=smtp,
                         autobook_budget=budget)

    assert len(autobook_calls) == 1
    assert autobook_calls[0]["slot"].date == "2026-06-07"
    assert autobook_calls[0]["slot"].booking_fee is None


class _FakeDate:
    """Patch target for autobook.date so date.today() is deterministic."""
    def __init__(self, today):
        self._today = today
    def today(self):
        return self._today
    def fromisoformat(self, s):
        from datetime import date as real
        return real.fromisoformat(s)


def test_autobook_skips_when_owner_isnt_runner_account(tmp_path, monkeypatch):
    """Subscriber-owned configs must NOT autobook on the runner's account."""
    from datetime import date as _date_mod, datetime, timezone
    state_dir = tmp_path / "state"
    state_dir.mkdir()
    cfg = _config("alpha", ["A"], owner="someone-else@example.com")
    cfg["autobook"] = {"enabled": True}

    fake_now = datetime(2026, 5, 30, 12, 0, tzinfo=timezone.utc)
    monkeypatch.setattr(autobook, "datetime", _FakeDatetime(fake_now))
    monkeypatch.setattr(autobook, "date", _FakeDate(_date_mod(2026, 5, 30)))

    rows = [{"date": "2026-06-01", "time": "08:00"}]
    client = StubClient(by_target={"A": rows})

    monkeypatch.setattr(runner.notify, "send_email", lambda **kw: None)
    autobook_calls: list[dict] = []
    monkeypatch.setattr(runner.notify, "send_autobook_email",
                        lambda **kw: autobook_calls.append(kw))

    budget = autobook.Budget({"date": "", "slots": []}, "runner@example.com")
    smtp = runner.SmtpCreds(user="u", password="p")
    runner.run_check_set(clients={"foreup": client}, cfg=cfg, state_path=state_dir / "alpha.json",
                         set_name="alpha", dry_run=False, smtp=smtp,
                         autobook_budget=budget)

    assert autobook_calls == []
    assert budget.available() is True


def test_snapshot_records_matches_disabled_and_errors(tmp_path, monkeypatch):
    broken = {"id": "broken-set", "name": "broken-set", "owner": "x@y", "enabled": True, "targets": []}
    configs = [_config("ok-set", ["A"]), _config("disabled-set", ["B"], enabled=False), broken]

    rows = [{"date": "2026-06-01", "time": "08:00"}]
    stub = StubClient(by_target={"A": rows})
    monkeypatch.setenv("SDGOLF_USERNAME", "x")
    monkeypatch.setenv("SDGOLF_PASSWORD", "x")
    monkeypatch.setattr(main_mod, "ForeUpClient", lambda: stub)

    snap_path = tmp_path / "snapshot.json"
    main_mod.main(tmp_path / "state", configs=configs, dry_run=True, snapshot_path=snap_path)
    payload = json.loads(snap_path.read_text())

    assert "generated_at" in payload
    sets = payload["sets"]
    assert sets["ok-set"]["enabled"] is True
    assert sets["ok-set"]["name"] == "ok-set"
    assert sets["ok-set"]["owner"] == "owner@example.com"
    assert len(sets["ok-set"]["matches"]) == 1
    assert sets["ok-set"]["matches"][0]["target"] == "A"
    assert sets["disabled-set"]["enabled"] is False
    assert sets["disabled-set"]["matches"] == []
    assert "error" in sets["broken-set"]


def test_auto_booking_class_flips_at_7pm_pacific(monkeypatch):
    """Horizon = today+6 before 7pm Pacific, today+7 at/after.

    Today is Tue 6/2 Pacific in this fixture, so today+6=Mon 6/8 and
    today+7=Tue 6/9. The flip happens exactly at 19:00 Pacific.
    """
    from datetime import datetime
    from zoneinfo import ZoneInfo
    from sdgolf_monitor.client import Target
    from sdgolf_monitor.runner import _resolve_target_for_date

    pac = ZoneInfo("America/Los_Angeles")
    t = Target(name="Balboa Park 18", teesheet_id=1470, provider="foreup")

    monkeypatch.setattr(
        "sdgolf_monitor.runner.datetime",
        _FakeDatetime(datetime(2026, 6, 2, 18, 59, tzinfo=pac)),
    )
    assert _resolve_target_for_date(t, "2026-06-08").booking_class == 929
    assert _resolve_target_for_date(t, "2026-06-09").booking_class == 51735

    monkeypatch.setattr(
        "sdgolf_monitor.runner.datetime",
        _FakeDatetime(datetime(2026, 6, 2, 19, 0, tzinfo=pac)),
    )
    assert _resolve_target_for_date(t, "2026-06-09").booking_class == 929
    assert _resolve_target_for_date(t, "2026-06-10").booking_class == 51735


def test_auto_booking_class_respects_explicit_value():
    """If booking_class is already set, the runner doesn't touch it."""
    from sdgolf_monitor.client import Target
    from sdgolf_monitor.runner import _resolve_target_for_date

    t = Target(name="X", teesheet_id=1470, booking_class=49924, provider="foreup")
    assert _resolve_target_for_date(t, "2026-06-09").booking_class == 49924


def test_runner_forwards_recipient_away_to_notify(tmp_path, monkeypatch):
    """run_check_set passes the worker's recipient_away map through to notify."""
    sent: list[dict] = []
    monkeypatch.setattr(runner.notify, "send_email", lambda **kw: sent.append(kw))

    cfg = _config("alpha", ["A"], owner="owner@example.com")
    cfg["recipient_away"] = {"owner@example.com": ["2026-06-01"]}

    client = StubClient(by_target={"A": [{"date": "2026-06-01", "time": "08:00"}]})
    smtp = runner.SmtpCreds(user="u", password="p")
    runner.run_check_set(
        clients={"foreup": client}, cfg=cfg, state_path=tmp_path / "alpha.json",
        set_name="alpha", dry_run=False, smtp=smtp,
    )
    assert len(sent) == 1
    assert sent[0]["recipient_away"] == {"owner@example.com": {"2026-06-01"}}


def test_runner_omits_recipient_away_when_unset(tmp_path, monkeypatch):
    """No recipient_away on the config -> notify gets None (fast path)."""
    sent: list[dict] = []
    monkeypatch.setattr(runner.notify, "send_email", lambda **kw: sent.append(kw))

    cfg = _config("alpha", ["A"], owner="owner@example.com")
    client = StubClient(by_target={"A": [{"date": "2026-06-01", "time": "08:00"}]})
    smtp = runner.SmtpCreds(user="u", password="p")
    runner.run_check_set(
        clients={"foreup": client}, cfg=cfg, state_path=tmp_path / "alpha.json",
        set_name="alpha", dry_run=False, smtp=smtp,
    )
    assert sent[0]["recipient_away"] is None


def test_caching_client_dedupes_identical_calls():
    """Same (target, date, holes) -> one underlying call regardless of repeats."""
    from sdgolf_monitor.client import Target
    inner = StubClient(by_target={"A": [{"date": "2026-06-06", "time": "08:00"}]})
    cached = runner.CachingClient(inner)
    target = Target(name="A", teesheet_id=1470, booking_class=929, provider="foreup")

    cached.get_times(target, "2026-06-06", holes=18)
    cached.get_times(target, "2026-06-06", holes=18)
    cached.get_times(target, "2026-06-06", holes=18)

    assert len(inner.calls) == 1
    assert cached.hits == 2
    assert cached.misses == 1


def test_caching_client_distinguishes_by_holes():
    """Different holes values bypass the cache."""
    from sdgolf_monitor.client import Target
    inner = StubClient(by_target={"A": [{"date": "2026-06-06", "time": "08:00"}]})
    cached = runner.CachingClient(inner)
    target = Target(name="A", teesheet_id=1470, booking_class=929, provider="foreup")

    cached.get_times(target, "2026-06-06", holes=18)
    cached.get_times(target, "2026-06-06", holes="all")

    assert len(inner.calls) == 2
    assert cached.misses == 2


def test_target_horizon_drops_far_future_dates(monkeypatch):
    """TeeItUp targets only see dates within 14 days of today (Pacific)."""
    from datetime import datetime
    from zoneinfo import ZoneInfo

    pac = ZoneInfo("America/Los_Angeles")
    fake = datetime(2026, 6, 1, 10, 0, tzinfo=pac)
    monkeypatch.setattr("sdgolf_monitor.runner.datetime", _FakeDatetime(fake))

    h = runner._target_horizon_date("teeitup")
    assert h.isoformat() == "2026-06-15"  # 2026-06-01 + 14 days
    h2 = runner._target_horizon_date("foreup")
    assert h2.isoformat() == "2026-08-30"  # 2026-06-01 + 90 days


def test_auto_booking_class_skips_teeitup():
    """TeeItUp targets have no booking class concept; pass through unchanged."""
    from sdgolf_monitor.client import Target
    from sdgolf_monitor.runner import _resolve_target_for_date

    t = Target(name="Coronado", provider="teeitup", facility_id=10985, alias="x")
    out = _resolve_target_for_date(t, "2026-06-09")
    assert out is t
    assert out.booking_class is None
