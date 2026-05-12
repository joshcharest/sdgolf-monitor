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
    new_times: list[TeeTime],
) -> None:
    """Send a single digest email covering all newly-seen tee times.

    Raises smtplib.SMTPException on transport failure (caller decides whether to
    fall back to leaving state unmarked so the slots re-notify next run).
    """
    if not new_times:
        return
    msg = EmailMessage()
    msg["From"] = smtp_user
    msg["To"] = to_addr
    msg["Subject"] = _subject(new_times)
    msg.set_content(_plaintext(new_times))
    msg.add_alternative(_html(new_times), subtype="html")

    with smtplib.SMTP_SSL("smtp.gmail.com", 465, timeout=20) as smtp:
        smtp.login(smtp_user, smtp_password)
        smtp.send_message(msg)


def _subject(new_times: list[TeeTime]) -> str:
    targets = sorted({t.target for t in new_times})
    return f"[sdgolf] {len(new_times)} tee time(s) — {', '.join(targets)}"


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
