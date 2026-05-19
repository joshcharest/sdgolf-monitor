"""Email notification via Gmail SMTP."""

from __future__ import annotations

import smtplib
from datetime import date, datetime
from email.message import EmailMessage
from html import escape as html_escape

from .client import TeeTime


# Course name -> ForeUp teesheet (schedule) id. Used to construct booking
# deep-links per match. Mirrors ui/schema.js TEESHEETS. Keep in sync.
_TEESHEET_IDS = {
    "Balboa Park 18":     1470,
    "Balboa Park 9":      1490,
    "Torrey Pines North": 1468,
    "Torrey Pines South": 1487,
}


def _booking_url(target: str, date_iso: str) -> str | None:
    """ForeUp deep-link for one slot, or None if we can't construct one.

    Booking class 929 = resident 0-7 day; 51735 = resident 8-90 day. Decide
    based on the slot's date, not the API's booking_fee flag (which is
    unreliable for Torrey under 929).
    """
    ts_id = _TEESHEET_IDS.get(target)
    if not ts_id:
        return None
    try:
        slot = date.fromisoformat(date_iso)
        is_advanced = (slot - date.today()).days >= 8
    except ValueError:
        return None
    booking_class = 51735 if is_advanced else 929
    base = f"https://foreupsoftware.com/index.php/booking/19348/{booking_class}"
    parts = date_iso.split("-")
    y, mo, d = parts
    return f"{base}?date={mo}-{d}-{y}&schedule_id={ts_id}#/teetimes"


def send_email(
    *,
    smtp_user: str,
    smtp_password: str,
    to_addrs: list[str],
    set_name: str,
    new_times: list[TeeTime],
) -> None:
    """Send a digest email for one check set's new matches.

    The ``set_name`` is tagged into the subject so Gmail filters can route each
    check set's notifications independently. ``to_addrs`` is a list because each
    check set has an owner plus optional subscribers; they all get the same
    digest in one send.

    Raises smtplib.SMTPException on transport failure.
    """
    if not new_times or not to_addrs:
        return
    msg = EmailMessage()
    msg["From"] = smtp_user
    msg["To"] = ", ".join(to_addrs)
    msg["Subject"] = _subject(set_name, new_times)
    msg.set_content(_plaintext(new_times))
    msg.add_alternative(_html(new_times), subtype="html")

    with smtplib.SMTP_SSL("smtp.gmail.com", 465, timeout=20) as smtp:
        smtp.login(smtp_user, smtp_password)
        smtp.send_message(msg, to_addrs=to_addrs)


def _subject(set_name: str, new_times: list[TeeTime]) -> str:
    targets = sorted({t.target for t in new_times})
    return f"[sdgolf:{set_name}] {len(new_times)} tee time(s) — {', '.join(targets)}"


def _plaintext(new_times: list[TeeTime]) -> str:
    lines = ["New tee times matching your filter:\n"]
    for tt in sorted(new_times, key=lambda t: (t.date, t.time, t.target)):
        fee = f"${tt.green_fee:.0f}" if tt.green_fee is not None else "?"
        bf = f" (+${tt.booking_fee:.0f} booking fee)" if tt.booking_fee else ""
        lines.append(
            f"  {tt.date} {tt.time}  {tt.target}  "
            f"{tt.available_spots} spots  {tt.holes}h  {fee}{bf}"
        )
        url = _booking_url(tt.target, tt.date)
        if url:
            lines.append(f"    {url}")
    lines.append(f"\nfetched {datetime.now().isoformat(timespec='seconds')}")
    return "\n".join(lines)


def _html(new_times: list[TeeTime]) -> str:
    rows = []
    for tt in sorted(new_times, key=lambda t: (t.date, t.time, t.target)):
        fee = f"${tt.green_fee:.0f}" if tt.green_fee is not None else "?"
        bf = f"+${tt.booking_fee:.0f}" if tt.booking_fee else ""
        url = _booking_url(tt.target, tt.date)
        time_cell = (
            f'<a href="{html_escape(url, quote=True)}">{html_escape(tt.time)}</a>'
            if url else html_escape(tt.time)
        )
        rows.append(
            f"<tr><td>{html_escape(tt.date)}</td><td>{time_cell}</td>"
            f"<td>{html_escape(tt.target)}</td>"
            f"<td>{tt.available_spots}</td><td>{tt.holes}h</td>"
            f"<td>{html_escape(fee)} {html_escape(bf)}</td></tr>"
        )
    return (
        "<table style='border-collapse:collapse' cellpadding='6'>"
        "<thead><tr style='background:#f0f0f0'>"
        "<th>Date</th><th>Time</th><th>Course</th><th>Spots</th><th>Holes</th><th>Fee</th>"
        "</tr></thead><tbody>"
        + "".join(rows)
        + "</tbody></table>"
    )
