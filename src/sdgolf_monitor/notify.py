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


# Map ForeUp's published (non-resident) green-fee to the SD City Resident
# equivalent, per course. Source: sandiegocitygolf.com rate cards (2026).
# Mirror of ui/app.js RATE_MAP — keep in sync.
_RATE_MAP = {
    "Balboa Park 18": {
        56.50: 39.50,   # weekday 18
        71:    49,      # weekend 18
        34:    25,      # weekday 18 twilight
        43:    30,      # weekend 18 twilight
        39:    35,      # weekday 18 junior
        25.50: 18,      # weekday 9
        32:    24,      # weekend 9
        19.50: 17,      # weekday 9 junior
    },
    "Balboa Park 9":  {25.50: 18, 32: 24, 19.50: 17},
    "Torrey Pines South": {258: 73, 180: 73, 156: 44, 322: 90, 194: 54},
    "Torrey Pines North": {163: 51, 114: 51, 97: 33, 204: 68, 123: 39},
}

_ADVANCED_BOOKING_FEE = {
    "Balboa Park 18":     10,
    "Balboa Park 9":      10,
    "Torrey Pines South": 32,
    "Torrey Pines North": 32,
}


def _resident_rate(target: str, non_resident: float | None) -> float | None:
    if non_resident is None:
        return None
    return _RATE_MAP.get(target, {}).get(non_resident)


def _has_advanced_fee(date_iso: str) -> bool:
    try:
        slot = date.fromisoformat(date_iso)
        return (slot - date.today()).days >= 8
    except ValueError:
        return False


def _fmt_money(amount: float) -> str:
    return f"${amount:g}" if amount == int(amount) else f"${amount:.2f}"


def _fee_text(target: str, non_resident: float | None, date_iso: str) -> str:
    rate = _resident_rate(target, non_resident)
    base = _fmt_money(rate) if rate is not None else "?"
    if not _has_advanced_fee(date_iso):
        return base
    abf = _ADVANCED_BOOKING_FEE.get(target)
    return f"{base} + ${abf} Advanced Booking Fee" if abf is not None else f"{base} + Advanced Booking Fee"


def _fmt_date(spec: str) -> str:
    try:
        d = date.fromisoformat(spec)
        return f"{d.strftime('%a')} {d.month}/{d.day}"
    except ValueError:
        return spec


def send_confirmation_email(
    *,
    smtp_user: str,
    smtp_password: str,
    to_addr: str,
    action: str,                      # "create" or "subscribe"
    cfg: dict,
    current_matches: list[dict] | None = None,
) -> None:
    """Send a one-shot informational email when someone creates / subscribes.

    Lists the check-set parameters so the recipient sees what's been set up,
    plus a snapshot of currently-matching tee times (which they'd otherwise
    miss since the cron's dedup state already considers them 'seen').

    No opt-in or click-to-confirm — purely informational.
    """
    set_name = cfg.get("name", "(unnamed)")
    verb = "created" if action == "create" else "subscribed to"
    msg = EmailMessage()
    msg["From"] = smtp_user
    msg["To"] = to_addr
    msg["Subject"] = f"[sdgolf:{set_name}] You {verb} {set_name}"
    msg.set_content(_confirmation_plaintext(verb, cfg, current_matches or []))
    msg.add_alternative(_confirmation_html(verb, cfg, current_matches or []), subtype="html")
    with smtplib.SMTP_SSL("smtp.gmail.com", 465, timeout=20) as smtp:
        smtp.login(smtp_user, smtp_password)
        smtp.send_message(msg)


def _params_lines(cfg: dict) -> list[tuple[str, str]]:
    """Return [(label, value), ...] for the check-set parameter summary."""
    targets = ", ".join(t.get("name", "?") for t in cfg.get("targets", []))
    dates = cfg.get("dates") or {}
    date_range = f"{dates.get('start', '?')} → {dates.get('end', '?')}"
    f = cfg.get("filter") or {}
    holes = f.get("holes", "?")
    holes_str = " + ".join(str(h) for h in holes) if isinstance(holes, list) else str(holes)
    min_p = f.get("min_players", 1)
    windows = ", ".join(f"{_fmt_12h(w.get('start', '?'))}–{_fmt_12h(w.get('end', '?'))}" for w in (f.get("windows") or [])) or "any time"
    return [
        ("Courses", targets or "(none)"),
        ("Dates", date_range),
        ("Holes", holes_str),
        ("Min players", str(min_p)),
        ("Windows", windows),
        ("Owner", cfg.get("owner", "?")),
    ]


def _confirmation_plaintext(verb: str, cfg: dict, matches: list[dict]) -> str:
    name = cfg.get("name", "(unnamed)")
    lines = [f"You {verb} {name}.", ""]
    lines.append("Parameters:")
    for label, value in _params_lines(cfg):
        lines.append(f"  {label}: {value}")
    lines.append("")
    if matches:
        plural = "match" if len(matches) == 1 else "matches"
        lines.append(f"Currently available ({len(matches)} {plural}):")
        for m in sorted(matches, key=lambda x: (x.get("date", ""), x.get("time", ""), x.get("target", ""))):
            line = (
                f"  {_fmt_date(m.get('date', '?'))}  {_fmt_12h(m.get('time', '?'))}  "
                f"{m.get('target', '?')}  {m.get('available_spots', '?')} spots  "
                f"{m.get('holes', '?')}  "
                f"{_fee_text(m.get('target', ''), m.get('green_fee'), m.get('date', ''))}"
            )
            lines.append(line)
            url = _booking_url(m.get("target", ""), m.get("date", ""))
            if url:
                lines.append(f"    {url}")
    else:
        lines.append("No tee times currently match this filter — you'll get an email as soon as one appears.")
    lines.append("")
    lines.append("You'll be emailed when new tee times appear that match these parameters.")
    return "\n".join(lines)


def _confirmation_html(verb: str, cfg: dict, matches: list[dict]) -> str:
    name = cfg.get("name", "(unnamed)")
    rows = []
    for label, value in _params_lines(cfg):
        rows.append(
            f"<tr><th style='text-align:left;padding:4px 12px 4px 0;color:#888'>{html_escape(label)}</th>"
            f"<td style='padding:4px 0'>{html_escape(value)}</td></tr>"
        )
    params_table = (
        "<table style='border-collapse:collapse;font-family:sans-serif;font-size:14px'>"
        + "".join(rows)
        + "</table>"
    )
    body = [
        f"<p>You {verb} <strong>{html_escape(name)}</strong>.</p>",
        "<h3 style='font-family:sans-serif;font-size:14px;margin-bottom:6px'>Parameters</h3>",
        params_table,
    ]
    if matches:
        plural = "match" if len(matches) == 1 else "matches"
        body.append(
            f"<h3 style='font-family:sans-serif;font-size:14px;margin-top:18px;margin-bottom:6px'>"
            f"Currently available ({len(matches)} {plural})</h3>"
        )
        body.append(_html(_match_dicts_as_objs(matches)))
    else:
        body.append("<p style='color:#666'>No tee times currently match this filter — you'll get an email as soon as one appears.</p>")
    body.append("<p style='color:#888;font-size:12px'>You'll be emailed when new tee times appear that match these parameters.</p>")
    return "<div style='font-family:sans-serif'>" + "".join(body) + "</div>"


def _match_dicts_as_objs(matches: list[dict]) -> list:
    """Wrap match dicts so _html() can read attribute-style."""
    class _M:
        def __init__(self, m): self.__dict__.update(m)
    return [_M(m) for m in matches]


def _fmt_12h(t: str) -> str:
    try:
        h_s, m_s = t.split(":")
        h = int(h_s); m = int(m_s)
    except (ValueError, AttributeError):
        return t
    period = "PM" if h >= 12 else "AM"
    h = h % 12 or 12
    return f"{h} {period}" if m == 0 else f"{h}:{m:02d} {period}"


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
        lines.append(
            f"  {_fmt_date(tt.date)}  {_fmt_12h(tt.time)}  {tt.target}  "
            f"{tt.available_spots} spots  {tt.holes}  "
            f"{_fee_text(tt.target, tt.green_fee, tt.date)}"
        )
        url = _booking_url(tt.target, tt.date)
        if url:
            lines.append(f"    {url}")
    lines.append(f"\nfetched {datetime.now().isoformat(timespec='seconds')}")
    return "\n".join(lines)


def _html(new_times: list[TeeTime]) -> str:
    rows = []
    for tt in sorted(new_times, key=lambda t: (t.date, t.time, t.target)):
        fee_text = _fee_text(tt.target, tt.green_fee, tt.date)
        time_str = _fmt_12h(tt.time)
        url = _booking_url(tt.target, tt.date)
        time_cell = (
            f'<a href="{html_escape(url, quote=True)}">{html_escape(time_str)}</a>'
            if url else html_escape(time_str)
        )
        rows.append(
            f"<tr><td>{html_escape(_fmt_date(tt.date))}</td><td>{time_cell}</td>"
            f"<td>{html_escape(tt.target)}</td>"
            f"<td>{tt.available_spots}</td><td>{tt.holes}</td>"
            f"<td>{html_escape(fee_text)}</td></tr>"
        )
    return (
        "<table style='border-collapse:collapse' cellpadding='6'>"
        "<thead><tr style='background:#f0f0f0'>"
        "<th>Date</th><th>Time</th><th>Course</th><th>Spots</th><th>Holes</th><th>Fee</th>"
        "</tr></thead><tbody>"
        + "".join(rows)
        + "</tbody></table>"
    )
