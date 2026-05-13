"""Email notification via Gmail SMTP."""

from __future__ import annotations

import smtplib
from datetime import datetime
from email.message import EmailMessage

from .client import TeeTime


def send_email(
    *,
    smtp_user: str,
    smtp_password: str,
    to_addr: str,
    set_name: str,
    new_times: list[TeeTime],
) -> None:
    """Send a digest email for one check set's new matches.

    The ``set_name`` is tagged into the subject so Gmail filters can route each
    check set's notifications independently.

    Raises smtplib.SMTPException on transport failure.
    """
    if not new_times:
        return
    msg = EmailMessage()
    msg["From"] = smtp_user
    msg["To"] = to_addr
    msg["Subject"] = _subject(set_name, new_times)
    msg.set_content(_plaintext(new_times))
    msg.add_alternative(_html(new_times), subtype="html")

    with smtplib.SMTP_SSL("smtp.gmail.com", 465, timeout=20) as smtp:
        smtp.login(smtp_user, smtp_password)
        smtp.send_message(msg)


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
    lines.append(f"\nfetched {datetime.now().isoformat(timespec='seconds')}")
    return "\n".join(lines)


def _html(new_times: list[TeeTime]) -> str:
    rows = []
    for tt in sorted(new_times, key=lambda t: (t.date, t.time, t.target)):
        fee = f"${tt.green_fee:.0f}" if tt.green_fee is not None else "?"
        bf = f"+${tt.booking_fee:.0f}" if tt.booking_fee else ""
        rows.append(
            f"<tr><td>{tt.date}</td><td>{tt.time}</td><td>{tt.target}</td>"
            f"<td>{tt.available_spots}</td><td>{tt.holes}h</td><td>{fee} {bf}</td></tr>"
        )
    return (
        "<table style='border-collapse:collapse' cellpadding='6'>"
        "<thead><tr style='background:#f0f0f0'>"
        "<th>Date</th><th>Time</th><th>Course</th><th>Spots</th><th>Holes</th><th>Fee</th>"
        "</tr></thead><tbody>"
        + "".join(rows)
        + "</tbody></table>"
    )
