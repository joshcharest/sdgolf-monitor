"""Tests for email booking deep-links."""

from __future__ import annotations

from sdgolf_monitor import notify


def test_from_header_defaults_to_smtp_user(monkeypatch):
    monkeypatch.delenv("GMAIL_FROM_ADDRESS", raising=False)
    assert notify._from_header("personal@gmail.com") == "SDGolf Monitor <personal@gmail.com>"


def test_from_header_honors_override(monkeypatch):
    monkeypatch.setenv("GMAIL_FROM_ADDRESS", "sdgolfmonitor@gmail.com")
    assert notify._from_header("personal@gmail.com") == "SDGolf Monitor <sdgolfmonitor@gmail.com>"


def test_from_header_blank_override_falls_back(monkeypatch):
    # An unset repo secret reaches the workflow env as an empty string.
    monkeypatch.setenv("GMAIL_FROM_ADDRESS", "  ")
    assert notify._from_header("personal@gmail.com") == "SDGolf Monitor <personal@gmail.com>"


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


def test_fee_text_golfdistrict_tags_resales():
    target = "Encinitas Ranch (Golf District)"
    assert notify._fee_text(target, 154.0, None, True) == "$154 (resale)"
    assert notify._fee_text(target, 143.0, None, False) == "$143"
    assert notify._fee_text(target, None, None, True) == "(resale)"


def test_html_tags_golfdistrict_resale():
    from sdgolf_monitor.client import TeeTime

    tt = TeeTime(
        target="Encinitas Ranch (Golf District)", date="2026-07-24", time="13:03",
        available_spots=1, holes=18, green_fee=154.0, booking_fee=None, resale=True,
    )
    html = notify._html([tt])
    assert "jcresorts.golfdistrict.com" in html
    assert "(resale)" in html
