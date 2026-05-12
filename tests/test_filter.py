from datetime import date

import pytest

from sdgolf_monitor.client import TeeTime
from sdgolf_monitor.filter import Filter, Window, date_range, parse_weekdays, resolve_date


def tt(date="2026-06-06", time="08:00", spots=4, holes=18, fee=50.0):
    return TeeTime(
        target="Balboa", date=date, time=time,
        available_spots=spots, holes=holes, green_fee=fee, booking_fee=None,
    )


def test_window_time_bounds_inclusive():
    w = Window("07:00", "11:00")
    assert w.matches("2026-06-06", "07:00")
    assert w.matches("2026-06-06", "11:00")
    assert not w.matches("2026-06-06", "06:59")
    assert not w.matches("2026-06-06", "11:01")


def test_window_weekday_filter():
    sat_sun = parse_weekdays(["sat", "sun"])
    w = Window("07:00", "11:00", weekdays=sat_sun)
    assert w.matches("2026-06-06", "08:00")          # saturday
    assert w.matches("2026-06-07", "08:00")          # sunday
    assert not w.matches("2026-06-05", "08:00")      # friday


def test_filter_min_players():
    f = Filter(min_players=3, max_green_fee=None, holes=18,
               windows=(Window("06:00", "20:00"),))
    assert f.matches(tt(spots=3))
    assert f.matches(tt(spots=4))
    assert not f.matches(tt(spots=2))


def test_filter_max_green_fee():
    f = Filter(min_players=1, max_green_fee=100, holes=18,
               windows=(Window("06:00", "20:00"),))
    assert f.matches(tt(fee=99))
    assert f.matches(tt(fee=100))
    assert not f.matches(tt(fee=101))


def test_filter_holes_must_match():
    f = Filter(min_players=1, max_green_fee=None, holes=18,
               windows=(Window("06:00", "20:00"),))
    assert f.matches(tt(holes=18))
    assert not f.matches(tt(holes=9))


def test_filter_multiple_windows_or():
    f = Filter(min_players=1, max_green_fee=None, holes=18,
               windows=(Window("07:00", "09:00"), Window("17:00", "19:00")))
    assert f.matches(tt(time="08:00"))
    assert f.matches(tt(time="18:00"))
    assert not f.matches(tt(time="12:00"))


def test_date_range_inclusive():
    assert date_range("2026-06-01", "2026-06-03") == [
        "2026-06-01", "2026-06-02", "2026-06-03",
    ]


def test_state_key_unique_per_target_date_time_holes():
    a = tt(time="08:00")
    b = tt(time="08:30")
    assert a.key != b.key


def test_resolve_date_iso_and_relative():
    today = date(2026, 5, 12)
    assert resolve_date("2026-06-01", today) == date(2026, 6, 1)
    assert resolve_date("today", today) == today
    assert resolve_date("today+0", today) == today
    assert resolve_date("today+7", today) == date(2026, 5, 19)
    assert resolve_date("today-1", today) == date(2026, 5, 11)
    assert resolve_date("TODAY + 90", today) == date(2026, 8, 10)


def test_resolve_date_rejects_garbage():
    with pytest.raises(ValueError):
        resolve_date("yesterday")


def test_date_range_accepts_relative():
    today = date(2026, 5, 12)
    r = date_range("today", "today+2", today=today)
    assert r == ["2026-05-12", "2026-05-13", "2026-05-14"]


def test_date_range_end_before_start_errors():
    with pytest.raises(ValueError):
        date_range("today+5", "today", today=date(2026, 5, 12))
