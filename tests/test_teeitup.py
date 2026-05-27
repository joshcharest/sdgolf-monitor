"""Tests for the TeeItUp record parser.

The HTTP layer is exercised in dry-run runs; here we just lock in the
record-to-TeeTime conversion (UTC->Pacific, cents->dollars, maxPlayers
as available_spots, holes filter).
"""

from __future__ import annotations

from sdgolf_monitor.teeitup import _record_to_teetime


def _record(time="2026-06-06T22:30:00.000Z", holes=18, fee_cents=5400,
            booked=3, max_players=1):
    return {
        "teetime": time,
        "bookedPlayers": booked,
        "maxPlayers": max_players,
        "rates": [{"holes": holes, "greenFeeCart": fee_cents}],
    }


def test_record_converts_utc_to_pacific():
    # 22:30Z on 2026-06-06 = 15:30 PDT (UTC-7) same day
    tt = _record_to_teetime(_record(), "Coronado")
    assert tt is not None
    assert tt.date == "2026-06-06"
    assert tt.time == "15:30"
    assert tt.target == "Coronado"


def test_record_converts_cents_to_dollars():
    tt = _record_to_teetime(_record(fee_cents=5400), "Coronado")
    assert tt.green_fee == 54.0


def test_record_uses_max_players_as_available_spots():
    tt = _record_to_teetime(_record(max_players=2), "Coronado")
    assert tt.available_spots == 2


def test_record_carries_holes_from_rate():
    tt = _record_to_teetime(_record(holes=9), "Coronado")
    assert tt.holes == 9


def test_record_returns_none_on_bad_time():
    assert _record_to_teetime({"teetime": "not-a-date", "rates": []}, "Coronado") is None
    assert _record_to_teetime({"rates": []}, "Coronado") is None
