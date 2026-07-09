"""Tests for the WebTrac results-page parser.

The HTTP layer is exercised in dry-run runs; here we lock in the
HTML-to-TeeTime conversion (12h->24h, MM/DD/YYYY->ISO, holes label,
Open Slots as available_spots) against markup captured from the live
portal in 2026-07, plus the deep-link URL shape notify.py embeds.
"""

from __future__ import annotations

from sdgolf_monitor.webtrac import (
    _holes_from_label,
    _parse_results,
    _to_24h,
    booking_url,
)


def _row(time="4:09 pm", date="07/12/2026", holes="18 (Front)",
         course="Admiral Baker North", open_slots="1"):
    """One results row, structured exactly like the live portal's markup."""
    return f"""<tr >
<td class="button-cell button-cell--cart" data-title=""><a class="button success cart-button" href="https://myffr.navyaims.com/navywest/webtrac/web/addtocart.html?Module=GR&GRFMIDList=1341264136">Add To Cart</a></td>
<td class="label-cell" data-title="Time"> {time}</td>
<td class="label-cell" data-title="Date">{date}</td>
<td class="label-cell" data-title="Holes">{holes}</td>
<td class="label-cell" data-title="Course">{course}</td>
<td class="label-cell" data-title="Open Slots">{open_slots}</td>
<td class="label-cell" data-title="Available Slots"><span class="nowrap itemstatus itemstatus--available">Available</span></td>
</tr>"""


def _page(*rows):
    header = ("<tr><th></th><th>Time</th><th>Date</th><th>Holes</th>"
              "<th>Course</th><th>Open Slots</th><th>Available Slots</th></tr>")
    return (
        '<html><body><form id="grwebsearch">'
        '<table class="table" data-tablecollapse="show" id="grwebsearch_output_table"  >'
        + header + "".join(rows) + "</table></form></body></html>"
    )


def test_parses_row_fields():
    tts = _parse_results(_page(_row()), "Admiral Baker North")
    assert len(tts) == 1
    tt = tts[0]
    assert tt.target == "Admiral Baker North"
    assert tt.date == "2026-07-12"
    assert tt.time == "16:09"
    assert tt.holes == 18
    assert tt.available_spots == 1
    assert tt.green_fee is None
    assert tt.booking_fee is None


def test_header_row_is_skipped():
    tts = _parse_results(_page(_row(), _row(time="6:06 am", open_slots="4")), "ABN")
    assert [t.time for t in tts] == ["16:09", "06:06"]
    assert tts[1].available_spots == 4


def test_no_table_means_no_results():
    # "No results" (and an invalid query) re-render the search form
    # without the output table.
    assert _parse_results("<html><form id='grwebsearch'></form></html>", "ABN") == []


def test_12h_conversion_edges():
    assert _to_24h("6:06 am") == "06:06"
    assert _to_24h("12:42 pm") == "12:42"   # noon hour stays 12
    assert _to_24h("12:05 am") == "00:05"   # midnight hour wraps to 00
    assert _to_24h("11:57 pm") == "23:57"
    assert _to_24h("garbage") is None


def test_holes_label_variants():
    assert _holes_from_label("18 (Front)") == 18
    assert _holes_from_label("9 (Back)") == 9
    assert _holes_from_label("weird") == 18  # default rather than crash


def test_booking_url_lands_on_results_for_date():
    url = booking_url(28, "2026-07-12")
    assert url.startswith("https://myffr.navyaims.com/navywest/webtrac/web/search.html?")
    assert "Action=Start" in url
    assert "secondarycode=28" in url
    assert "begindate=07%2F12%2F2026" in url
    assert "module=GR" in url


def test_booking_url_survives_bad_date():
    url = booking_url(28, "not-a-date")
    assert "begindate" not in url
    assert "secondarycode=28" in url
