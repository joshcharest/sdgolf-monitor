"""Tests for the Golf District marketplace parser + filtering.

The HTTP layer is exercised in dry-run runs; here we lock in the
record-to-TeeTime conversion and the get_times filtering rules (both
listing kinds surface with resales flagged, exact-date, holes).
"""

from __future__ import annotations

from sdgolf_monitor.client import Target
from sdgolf_monitor.golfdistrict import (
    GolfDistrictClient,
    _record_to_teetime,
    booking_url,
)

COURSE = "3f755992-90e0-11ef-9af2-6a003139847e"


def _resale(date="2026-07-24T13:03:00", holes=18, price=154.0,
            listed=4, available=1):
    return {
        "numberOfHoles": holes, "includesCart": True, "isListed": True,
        "listedSlots": listed, "availableSlots": available,
        "date": date, "time": 1303, "pricePerGolfer": price,
        "firstOrSecondHandTeeTime": "SECOND_HAND",
    }


def _first_hand(date="2026-07-24T13:03:00", holes=18):
    # The course's own inventory — larger shape, no listedSlots.
    return {
        "numberOfHoles": holes, "includesCart": True, "isListed": False,
        "availableSlots": 4, "date": date, "time": 1303,
        "pricePerGolfer": 143.0, "firstOrSecondHandTeeTime": "FIRST_HAND",
    }


def _client(records):
    c = GolfDistrictClient()
    c._fetch_day = lambda course_id, date_iso: list(records)  # bypass HTTP
    return c


def _target():
    return Target(name="Encinitas Ranch (Golf District)", provider="golfdistrict",
                  course_id=COURSE)


# --- record parsing ---------------------------------------------------------

def test_record_maps_fields():
    tt = _record_to_teetime(_resale(), "Encinitas Ranch (Golf District)")
    assert tt is not None
    assert tt.target == "Encinitas Ranch (Golf District)"
    assert tt.date == "2026-07-24"
    assert tt.time == "13:03"       # course-local, from the ISO date field
    assert tt.holes == 18
    assert tt.available_spots == 1  # availableSlots, not listedSlots
    assert tt.green_fee == 154.0    # pricePerGolfer, shown as-is
    assert tt.booking_fee is None
    assert tt.resale is True


def test_record_first_hand_is_not_resale():
    tt = _record_to_teetime(_first_hand(), "X")
    assert tt is not None
    assert tt.resale is False
    assert tt.available_spots == 4
    assert tt.green_fee == 143.0


def test_resale_gets_its_own_dedup_key():
    # A golfer resale at the same tee time as a course listing is distinct
    # inventory — it must alert separately, so the keys must differ.
    resale = _record_to_teetime(_resale(), "X")
    first = _record_to_teetime(_first_hand(), "X")
    assert first.key == "X|2026-07-24|13:03|18"   # unchanged legacy shape
    assert resale.key == "X|2026-07-24|13:03|18|resale"


def test_record_available_spots_falls_back_to_listed():
    r = _resale(available=None)
    r.pop("availableSlots")
    tt = _record_to_teetime(r, "X")
    assert tt.available_spots == 4  # falls back to listedSlots


def test_record_bad_or_missing_date_is_none():
    assert _record_to_teetime({"date": "nope", "numberOfHoles": 18}, "X") is None
    assert _record_to_teetime({"numberOfHoles": 18}, "X") is None


def test_record_price_rounds_and_tolerates_junk():
    assert _record_to_teetime(_resale(price=154.00000000000003), "X").green_fee == 154.0
    assert _record_to_teetime(_resale(price=None), "X").green_fee is None


# --- get_times filtering ----------------------------------------------------

def test_get_times_includes_both_listing_kinds():
    recs = [_resale(), _first_hand(), _first_hand(date="2026-07-24T11:06:00")]
    out = _client(recs).get_times(_target(), "2026-07-24", holes="all")
    assert len(out) == 3
    assert sorted((t.time, t.resale) for t in out) == [
        ("11:06", False), ("13:03", False), ("13:03", True),
    ]


def test_get_times_drops_unknown_listing_kinds():
    # Parse defensively: a kind we haven't seen may have a different shape.
    odd = _resale()
    odd["firstOrSecondHandTeeTime"] = "THIRD_HAND"
    missing = _resale()
    del missing["firstOrSecondHandTeeTime"]
    out = _client([odd, missing, _resale()]).get_times(_target(), "2026-07-24", holes="all")
    assert len(out) == 1


def test_get_times_drops_neighbouring_dates():
    # A -7h correction can bleed a neighbour into the day's results; we keep
    # only the exact requested date.
    recs = [_resale(date="2026-07-24T13:03:00"), _resale(date="2026-07-25T08:00:00")]
    out = _client(recs).get_times(_target(), "2026-07-24", holes="all")
    assert [t.date for t in out] == ["2026-07-24"]


def test_get_times_holes_filter():
    recs = [_resale(holes=18), _resale(holes=9, date="2026-07-24T09:00:00")]
    both = _client(recs).get_times(_target(), "2026-07-24", holes="all")
    just18 = _client(recs).get_times(_target(), "2026-07-24", holes=18)
    assert len(both) == 2
    assert [t.holes for t in just18] == [18]


def test_get_times_requires_course_id():
    import pytest
    bad = Target(name="x", provider="golfdistrict", course_id=None)
    with pytest.raises(ValueError):
        _client([]).get_times(bad, "2026-07-24")


def test_booking_url_is_the_marketplace_page():
    assert booking_url(COURSE) == f"https://jcresorts.golfdistrict.com/{COURSE}"
