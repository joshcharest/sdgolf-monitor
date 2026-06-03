"""Tests for email booking deep-links."""

from __future__ import annotations

from sdgolf_monitor import notify


def test_booking_url_teeitup_coronado():
    url = notify._booking_url("Coronado (3-14d)", "2026-06-06")
    assert url == (
        "https://coronado-gc-3-14-be.book.teeitup.com/"
        "?course=10985&max=999999&date=2026-06-06"
    )


def test_booking_url_teeitup_omits_bad_date():
    # "all"/garbage dates (never a real slot date) must not reach the URL.
    url = notify._booking_url("Coronado (3-14d)", "all")
    assert url == "https://coronado-gc-3-14-be.book.teeitup.com/?course=10985&max=999999"


def test_booking_url_foreup_still_works():
    url = notify._booking_url("Balboa Park 18", "2026-06-06")
    assert url.startswith("https://foreupsoftware.com/index.php/booking/19348/929")
    assert "schedule_id=1470" in url


def test_booking_url_unknown_target_is_none():
    assert notify._booking_url("Mystery Links", "2026-06-06") is None


def test_html_links_coronado_time():
    from sdgolf_monitor.client import TeeTime

    tt = TeeTime(
        target="Coronado (3-14d)", date="2026-06-06", time="08:30",
        available_spots=4, holes=18, green_fee=40.0, booking_fee=None,
    )
    html = notify._html([tt])
    assert "coronado-gc-3-14-be.book.teeitup.com" in html
