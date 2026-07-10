"""Email notification via Gmail SMTP."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import smtplib
import time
from datetime import date, datetime
from email.message import EmailMessage
from html import escape as html_escape

from .client import TeeTime
from .golfdistrict import booking_url as _golfdistrict_booking_url
from .webtrac import booking_url as _webtrac_booking_url

# 90 days is long enough that anyone who saved an old email can still click
# through, but short enough that a leaked URL eventually stops working.
_UNSUB_TTL_SEC = 90 * 24 * 60 * 60


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _unsubscribe_token(email: str, config_id: str, secret: str) -> str:
    """HMAC-signed `body.sig` token; verified by the worker's verifyUnsubscribeToken.

    Payload mirrors what the worker expects: {email, config_id, exp}. Both sides
    base64url-encode without padding and HMAC-SHA256 the encoded body.
    """
    payload = {"email": email, "config_id": config_id, "exp": int(time.time()) + _UNSUB_TTL_SEC}
    body = _b64url(json.dumps(payload, separators=(",", ":")).encode("utf-8"))
    sig = _b64url(hmac.new(secret.encode("utf-8"), body.encode("ascii"), hashlib.sha256).digest())
    return f"{body}.{sig}"


def _unsubscribe_url(worker_url: str | None, secret: str | None, email: str, config_id: str) -> str | None:
    if not worker_url or not secret or not email or not config_id:
        return None
    token = _unsubscribe_token(email, config_id, secret)
    return f"{worker_url.rstrip('/')}/api/unsubscribe?t={token}"


# Token TTL for the one-click "Book now" link in emails. Capped further by
# the worker's verifyBookToken (won't exceed the slot's tee-off time).
_BOOK_TTL_SEC = 7 * 24 * 60 * 60


def _book_token(slot: TeeTime, config_id: str, secret: str) -> str:
    """Mirror of worker.js mintBookToken. Keep the payload schema in sync."""
    payload = {
        "config_id": config_id,
        "target": slot.target,
        "date": slot.date,
        "time": slot.time,
        "holes": int(slot.holes),
        "players": max(1, min(4, int(slot.available_spots or 4))),
        "exp": int(time.time()) + _BOOK_TTL_SEC,
    }
    body = _b64url(json.dumps(payload, separators=(",", ":")).encode("utf-8"))
    sig = _b64url(hmac.new(secret.encode("utf-8"), body.encode("ascii"), hashlib.sha256).digest())
    return f"{body}.{sig}"


def _book_url(worker_url: str | None, secret: str | None, slot: TeeTime, config_id: str) -> str | None:
    if not worker_url or not secret or not config_id:
        return None
    token = _book_token(slot, config_id, secret)
    return f"{worker_url.rstrip('/')}/api/book?t={token}"


# Course name -> (ForeUp facility id, teesheet/schedule id). Used to construct
# booking deep-links per match. The facility id in the URL path determines
# which course the SPA loads — using Balboa's (19348) for a Torrey schedule
# lands the user on Balboa. Mirrors ui/schema.js TEESHEETS. Keep in sync.
_COURSE_IDS = {
    "Balboa Park 18":     (19348, 1470),
    "Balboa Park 9":      (19348, 1490),
    "Torrey Pines North": (19347, 1468),
    "Torrey Pines South": (19347, 1487),
}

# TeeItUp courses keyed by target name -> (course/facility id, alias subdomain).
# The booking SPA lives at ``<alias>.book.teeitup.com`` and takes the course id
# as its ``?course=`` param. Mirror of the teeitup entries in ui/schema.js
# TEESHEETS — keep in sync.
_TEEITUP_COURSES = {
    "Coronado (3-14d)": (10985, "coronado-gc-3-14-be"),
}

# WebTrac (Navy MWR) courses keyed by target name -> secondarycode. The
# search URL doubles as the booking deep-link — see webtrac.booking_url.
# Mirror of the webtrac entries in ui/schema.js TEESHEETS — keep in sync.
_WEBTRAC_COURSES = {
    "Admiral Baker North": 28,
    "Admiral Baker South": 29,
}

# Golf District resale courses keyed by target name -> course UUID. The
# marketplace page is the deep-link — see golfdistrict.booking_url. Mirror
# of the golfdistrict entries in ui/schema.js TEESHEETS — keep in sync.
_GOLFDISTRICT_COURSES = {
    "Encinitas Ranch (resale)": "3f755992-90e0-11ef-9af2-6a003139847e",
}


def _is_iso_date(s: str) -> bool:
    try:
        date.fromisoformat(s)
        return True
    except ValueError:
        return False


def _booking_url(target: str, date_iso: str) -> str | None:
    """Booking deep-link for one slot, or None if we can't construct one.

    TeeItUp courses (Coronado) link to their booking SPA, which lands on the
    given date with the price filter wide open. ForeUp courses link to the
    ForeUp SPA: booking class 929 = resident 0-7 day, 51735 = resident
    8-90 day, decided by the slot's date (not the API's booking_fee flag,
    which is unreliable for Torrey under 929).
    """
    teeitup = _TEEITUP_COURSES.get(target)
    if teeitup:
        course_id, alias = teeitup
        params = f"course={course_id}&max=999999"
        if _is_iso_date(date_iso):
            params += f"&date={date_iso}"
        return f"https://{alias}.book.teeitup.com/?{params}"
    webtrac_code = _WEBTRAC_COURSES.get(target)
    if webtrac_code is not None:
        return _webtrac_booking_url(webtrac_code, date_iso)
    gd_course = _GOLFDISTRICT_COURSES.get(target)
    if gd_course is not None:
        return _golfdistrict_booking_url(gd_course)
    ids = _COURSE_IDS.get(target)
    if not ids:
        return None
    facility_id, ts_id = ids
    try:
        slot = date.fromisoformat(date_iso)
        is_advanced = (slot - date.today()).days >= 8
    except ValueError:
        return None
    booking_class = 51735 if is_advanced else 929
    base = f"https://foreupsoftware.com/index.php/booking/{facility_id}/{booking_class}"
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


def _has_advanced_fee(booking_fee: float | None) -> bool:
    """Whether ForeUp said this slot charges the Advanced Booking Fee.

    Reads the per-slot flag (populated from ``booking_fee_required`` in the
    API response) so the display matches the booking class ForeUp would
    actually use — including the daily 7pm release boundary, where a slot's
    fee/no-fee status flips between runner ticks.
    """
    return bool(booking_fee)


def _fmt_money(amount: float) -> str:
    return f"${amount:g}" if amount == int(amount) else f"${amount:.2f}"


def _fee_text(target: str, non_resident: float | None, booking_fee: float | None) -> str:
    # WebTrac never publishes prices in search results (Navy green fees
    # depend on patron category), so show nothing rather than "?".
    if target in _WEBTRAC_COURSES:
        return ""
    # Golf District resale prices are the actual per-golfer resale price —
    # already final, not a non-resident rate to translate. Show as-is.
    if target in _GOLFDISTRICT_COURSES:
        return _fmt_money(non_resident) if non_resident is not None else ""
    rate = _resident_rate(target, non_resident)
    base = _fmt_money(rate) if rate is not None else "?"
    if not _has_advanced_fee(booking_fee):
        return base
    abf = _ADVANCED_BOOKING_FEE.get(target)
    return f"{base} + ${abf} Advanced Booking Fee" if abf is not None else f"{base} + Advanced Booking Fee"


def _fmt_date(spec: str) -> str:
    try:
        d = date.fromisoformat(spec)
        return f"{d.strftime('%a')} {d.month}/{d.day}"
    except ValueError:
        return spec


def send_autobook_email(
    *,
    smtp_user: str,
    smtp_password: str,
    to_addr: str,
    set_name: str,
    slot: TeeTime,
    players: int,
    dry_run: bool = True,
) -> None:
    """Email the owner that an auto-book fired for a single slot.

    Currently always dry-run — the body says "would book" and includes the
    booking URL so the owner can finish manually if they want. When real
    booking is wired up, ``dry_run=False`` should swap to a "booked" subject
    + confirmation number.
    """
    prefix = "AUTO-BOOK (dry run)" if dry_run else "AUTO-BOOK"
    msg = EmailMessage()
    msg["From"] = smtp_user
    msg["To"] = to_addr
    msg["Subject"] = (
        f"[sdgolf:{set_name}] {prefix} — {_fmt_date(slot.date)} {_fmt_12h(slot.time)} {slot.target}"
    )
    msg.set_content(_autobook_plaintext(set_name, slot, players, dry_run=dry_run))
    msg.add_alternative(_autobook_html(set_name, slot, players, dry_run=dry_run), subtype="html")
    with smtplib.SMTP_SSL("smtp.gmail.com", 465, timeout=20) as smtp:
        smtp.login(smtp_user, smtp_password)
        smtp.send_message(msg, to_addrs=[to_addr])


def _autobook_plaintext(set_name: str, slot: TeeTime, players: int, *, dry_run: bool) -> str:
    verb = "Would have booked" if dry_run else "Booked"
    fee = _fee_text(slot.target, slot.green_fee, slot.booking_fee)
    url = _booking_url(slot.target, slot.date) or "(no booking URL)"
    return "\n".join([
        f"{verb} this slot for subscription \"{set_name}\":",
        "",
        f"  {_fmt_date(slot.date)}  {_fmt_12h(slot.time)}  {slot.target}",
        f"  {players} player(s)  {slot.holes}  {fee}",
        "",
        f"Book: {url}",
        "",
        (
            "(Dry-run mode: no booking was actually placed. The real ForeUp POST "
            "isn't wired up yet — click the link above to finish booking manually.)"
            if dry_run else
            ""
        ),
    ]).rstrip() + "\n"


def _autobook_html(set_name: str, slot: TeeTime, players: int, *, dry_run: bool) -> str:
    verb = "Would have booked" if dry_run else "Booked"
    fee = _fee_text(slot.target, slot.green_fee, slot.booking_fee)
    url = _booking_url(slot.target, slot.date)
    when = f"{_fmt_date(slot.date)} {_fmt_12h(slot.time)}"
    link = (
        f'<a href="{html_escape(url, quote=True)}">Open in ForeUp</a>'
        if url else "(no booking URL)"
    )
    body = [
        f"<p>{html_escape(verb)} this slot for subscription <strong>{html_escape(set_name)}</strong>:</p>",
        f"<p style='font-family:monospace'>{html_escape(when)} &middot; "
        f"{html_escape(slot.target)} &middot; {players} player(s) &middot; "
        f"{slot.holes} holes &middot; {html_escape(fee)}</p>",
        f"<p>{link}</p>",
    ]
    if dry_run:
        body.append(
            "<p style='color:#666;font-size:12px'>Dry-run mode: no booking was "
            "actually placed. The real ForeUp POST isn't wired up yet — click "
            "the link above to finish booking manually.</p>"
        )
    return "<div style='font-family:sans-serif'>" + "".join(body) + "</div>"


def send_welcome_email(
    *,
    smtp_user: str,
    smtp_password: str,
    to_addr: str,
    signup_url: str,
) -> None:
    """One-shot welcome email when an admin adds a new allowed email.

    Tells them they've been authorized and links to the signup page.
    Subject is namespaced like the alert digests so Gmail filters can
    catch it.
    """
    if not to_addr:
        return
    msg = EmailMessage()
    msg["From"] = smtp_user
    msg["To"] = to_addr
    msg["Subject"] = "[sdgolf] You've been added to sdgolf-monitor"
    msg.set_content(_welcome_plaintext(signup_url))
    msg.add_alternative(_welcome_html(signup_url), subtype="html")
    with smtplib.SMTP_SSL("smtp.gmail.com", 465, timeout=20) as smtp:
        smtp.login(smtp_user, smtp_password)
        smtp.send_message(msg, to_addrs=[to_addr])


def _welcome_plaintext(signup_url: str) -> str:
    return (
        "You've been added to sdgolf-monitor — a tee-time monitor for San\n"
        "Diego city golf courses (Balboa, Torrey Pines) and Coronado.\n"
        "\n"
        f"Sign up here to set a password and subscribe to alerts:\n  {signup_url}\n"
        "\n"
        "After signing in, browse other people's subscriptions and click\n"
        "Subscribe to start getting their email alerts, or create your own\n"
        "with custom courses, dates, time windows, and weekday filters.\n"
    )


def _welcome_html(signup_url: str) -> str:
    href = (signup_url or "").replace('"', "&quot;")
    return (
        "<div style='font-family:sans-serif;max-width:560px'>"
        "<h2 style='margin:0 0 10px'>Welcome to sdgolf-monitor</h2>"
        "<p>You've been added to a tee-time monitor for San Diego city golf "
        "(Balboa, Torrey Pines) and Coronado.</p>"
        f"<p><a href=\"{href}\" "
        "style='display:inline-block;padding:10px 18px;background:#c9a96a;"
        "color:#0d1612;text-decoration:none;border-radius:6px;font-weight:600'>"
        "Sign up</a></p>"
        f"<p style='color:#666;font-size:12px'>Or paste this URL into your browser: "
        f"<code>{href}</code></p>"
        "<p style='color:#666;font-size:12px'>After signing in, subscribe to existing "
        "check sets or create your own with custom courses, dates, and time windows.</p>"
        "</div>"
    )


def send_bug_report(
    *,
    smtp_user: str,
    smtp_password: str,
    to_addrs: list[str],
    bug: dict,
) -> None:
    """Email a user-submitted bug report to the admin list."""
    if not to_addrs or not bug:
        return
    reporter = bug.get("email", "?")
    description = bug.get("description", "(none)")
    short_desc = description.splitlines()[0][:80] if description else "(none)"
    msg = EmailMessage()
    msg["From"] = smtp_user
    msg["To"] = ", ".join(to_addrs)
    msg["Subject"] = f"[sdgolf:bug] {reporter}: {short_desc}"
    msg.set_content(_bug_plaintext(bug))
    msg.add_alternative(_bug_html(bug), subtype="html")
    with smtplib.SMTP_SSL("smtp.gmail.com", 465, timeout=20) as smtp:
        smtp.login(smtp_user, smtp_password)
        smtp.send_message(msg, to_addrs=to_addrs)


def _bug_plaintext(b: dict) -> str:
    lines = [
        f"From:       {b.get('email', '?')}",
        f"Reported:   {b.get('ts', '?')}",
        f"View:       {b.get('view', '?')}",
        f"URL:        {b.get('url', '?')}",
        f"User agent: {b.get('user_agent', '?')}",
        "",
        "Description:",
        b.get("description", "(none)"),
        "",
        f"Recent client logs ({len(b.get('logs') or [])}):",
    ]
    for entry in b.get("logs") or []:
        ts = entry.get("ts", "?")
        level = entry.get("level", "?")
        msg = entry.get("msg", "")
        lines.append(f"  [{ts}] {level}: {msg}")
    return "\n".join(lines)


def _bug_html(b: dict) -> str:
    rows = []
    for label, value in [
        ("From", b.get("email", "?")),
        ("Reported", b.get("ts", "?")),
        ("View", b.get("view", "?")),
        ("URL", b.get("url", "?")),
        ("User agent", b.get("user_agent", "?")),
    ]:
        rows.append(
            f"<tr><th style='text-align:left;padding:4px 12px 4px 0;color:#888'>{html_escape(label)}</th>"
            f"<td style='padding:4px 0'>{html_escape(str(value))}</td></tr>"
        )
    log_rows = []
    for entry in b.get("logs") or []:
        log_rows.append(
            f"<tr><td style='padding:2px 8px;color:#888'>{html_escape(entry.get('ts', ''))}</td>"
            f"<td style='padding:2px 8px;font-weight:600'>{html_escape(entry.get('level', ''))}</td>"
            f"<td style='padding:2px 8px;font-family:monospace;white-space:pre-wrap'>"
            f"{html_escape(entry.get('msg', ''))}</td></tr>"
        )
    log_table = (
        "<table style='border-collapse:collapse;font-size:12px'>" + "".join(log_rows) + "</table>"
        if log_rows else "<p style='color:#666'>(no client logs)</p>"
    )
    return (
        "<div style='font-family:sans-serif'>"
        "<table style='border-collapse:collapse;font-size:14px'>"
        + "".join(rows) + "</table>"
        + "<h3 style='font-size:14px;margin-top:18px;margin-bottom:6px'>Description</h3>"
        + f"<pre style='font-family:monospace;white-space:pre-wrap'>{html_escape(b.get('description', '(none)'))}</pre>"
        + "<h3 style='font-size:14px;margin-top:18px;margin-bottom:6px'>Recent client logs</h3>"
        + log_table
        + "</div>"
    )


def send_confirmation_email(
    *,
    smtp_user: str,
    smtp_password: str,
    to_addr: str,
    action: str,                      # "create" or "subscribe"
    cfg: dict,
    current_matches: list[dict] | None = None,
    worker_url: str | None = None,
    unsubscribe_secret: str | None = None,
) -> None:
    """Send a one-shot informational email when someone creates / subscribes.

    Lists the check-set parameters so the recipient sees what's been set up,
    plus a snapshot of currently-matching tee times (which they'd otherwise
    miss since the cron's dedup state already considers them 'seen').

    For action="subscribe" we include a personalised unsubscribe link, so the
    recipient can back out immediately without logging in. Owners (action=
    "create") don't get one — they can delete the check set from the UI.

    No opt-in or click-to-confirm — purely informational.
    """
    set_name = cfg.get("name", "(unnamed)")
    verb = "created" if action == "create" else "subscribed to"
    unsub = (
        _unsubscribe_url(worker_url, unsubscribe_secret, to_addr, cfg.get("id", ""))
        if action == "subscribe" else None
    )
    msg = EmailMessage()
    msg["From"] = smtp_user
    msg["To"] = to_addr
    msg["Subject"] = f"[sdgolf:{set_name}] You {verb} {set_name}"
    _set_list_unsubscribe(msg, unsub)
    msg.set_content(_confirmation_plaintext(verb, cfg, current_matches or [], unsubscribe_url=unsub))
    msg.add_alternative(_confirmation_html(verb, cfg, current_matches or [], unsubscribe_url=unsub), subtype="html")
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


def _confirmation_plaintext(verb: str, cfg: dict, matches: list[dict], *, unsubscribe_url: str | None = None) -> str:
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
                f"{_fee_text(m.get('target', ''), m.get('green_fee'), m.get('booking_fee'))}"
            )
            lines.append(line)
            url = _booking_url(m.get("target", ""), m.get("date", ""))
            if url:
                lines.append(f"    {url}")
    else:
        lines.append("No tee times currently match this filter — you'll get an email as soon as one appears.")
    lines.append("")
    lines.append("You'll be emailed when new tee times appear that match these parameters.")
    if unsubscribe_url:
        lines.append("")
        lines.append(f"Unsubscribe: {unsubscribe_url}")
    return "\n".join(lines)


def _confirmation_html(verb: str, cfg: dict, matches: list[dict], *, unsubscribe_url: str | None = None) -> str:
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
    if unsubscribe_url:
        body.append(
            "<p style='color:#888;font-size:12px'>"
            f"<a href='{html_escape(unsubscribe_url, quote=True)}'>Unsubscribe</a> from "
            f"<strong>{html_escape(name)}</strong>."
            "</p>"
        )
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
    owner: str | None = None,
    config_id: str | None = None,
    worker_url: str | None = None,
    unsubscribe_secret: str | None = None,
    autobook_account_email: str | None = None,
    recipient_away: dict[str, set[str]] | None = None,
) -> None:
    """Send a digest email for one check set's new matches, one message per recipient.

    Each subscriber gets a personalised unsubscribe link bound to their email +
    this config; the owner gets the same digest with no unsub link (they own
    the set and can delete it from the UI). Sent as separate messages so each
    recipient only sees their own address and gets their own link.

    When ``autobook_account_email`` is set AND the recipient is the owner AND
    that owner matches the autobook account, the email also includes a per-slot
    one-click "Book" link (the worker enforces the same owner check on the
    redeem side, so the link is useless to anyone else).

    Raises smtplib.SMTPException on transport failure.
    """
    if not new_times or not to_addrs:
        return
    owner_norm = (owner or "").strip().lower()
    autobook_norm = (autobook_account_email or "").strip().lower()
    book_links_enabled = bool(autobook_norm) and owner_norm == autobook_norm and bool(config_id)
    book_urls = (
        {tt.key: _book_url(worker_url, unsubscribe_secret, tt, config_id) for tt in new_times}
        if book_links_enabled else None
    )
    away = recipient_away or {}
    with smtplib.SMTP_SSL("smtp.gmail.com", 465, timeout=20) as smtp:
        smtp.login(smtp_user, smtp_password)
        for addr in to_addrs:
            addr_norm = addr.strip().lower()
            # Drop slots on dates this recipient marked themselves away.
            # If everything got dropped, skip the recipient entirely.
            their_away = away.get(addr_norm) or set()
            their_times = [t for t in new_times if t.date not in their_away] if their_away else new_times
            if not their_times:
                continue
            is_owner = addr_norm == owner_norm
            unsub = None if is_owner else _unsubscribe_url(worker_url, unsubscribe_secret, addr, config_id or "")
            # Only the owner sees the "Book now" link — subscribers wouldn't be
            # able to redeem it anyway (worker checks owner-account match).
            urls_for_recipient = book_urls if is_owner else None
            msg = EmailMessage()
            msg["From"] = smtp_user
            msg["To"] = addr
            msg["Subject"] = _subject(set_name, their_times)
            _set_list_unsubscribe(msg, unsub)
            msg.set_content(_plaintext(
                their_times, set_name=set_name, unsubscribe_url=unsub,
                book_urls=urls_for_recipient,
            ))
            msg.add_alternative(_html(
                their_times, set_name=set_name, unsubscribe_url=unsub,
                book_urls=urls_for_recipient,
            ), subtype="html")
            smtp.send_message(msg, to_addrs=[addr])


def _set_list_unsubscribe(msg: EmailMessage, unsubscribe_url: str | None) -> None:
    """Add RFC 2369 + RFC 8058 unsubscribe headers so Gmail / Apple Mail show
    a native Unsubscribe button. List-Unsubscribe-Post tells the client the
    URL accepts a one-click POST — without it, clients fall back to opening
    the link as a GET (which our worker handles by showing a confirm page).
    """
    if not unsubscribe_url:
        return
    msg["List-Unsubscribe"] = f"<{unsubscribe_url}>"
    msg["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click"


def _subject(set_name: str, new_times: list[TeeTime]) -> str:
    """Headline the earliest matching slot in the format: date, dow, time, course.

    Old format put a generic "[sdgolf:set] N tee time(s)" prefix and listed
    courses — useful for inbox filtering but the actual booking info was
    buried. Lead with the most actionable slot so the subject line alone
    tells you whether to open the email.
    """
    if not new_times:
        return f"[sdgolf:{set_name}] no tee times"
    earliest = min(new_times, key=lambda t: (t.date, t.time, t.target))
    headline = _slot_subject_line(earliest)
    if len(new_times) == 1:
        return f"{set_name}: {headline}"
    return f"{set_name}: {headline} (+{len(new_times) - 1} more)"


def _slot_subject_line(tt: TeeTime) -> str:
    """Format: 'Sat 5/30 7:30 AM Balboa Park 18' — dow, date, time, course."""
    try:
        d = date.fromisoformat(tt.date)
        date_part = f"{d.strftime('%a')} {d.month}/{d.day}"
    except ValueError:
        date_part = tt.date
    return f"{date_part} {_fmt_12h(tt.time)} {tt.target}"


def _plaintext(
    new_times: list[TeeTime],
    *,
    set_name: str | None = None,
    unsubscribe_url: str | None = None,
    book_urls: dict[str, str | None] | None = None,
) -> str:
    lines = ["New tee times matching your filter:\n"]
    for tt in sorted(new_times, key=lambda t: (t.date, t.time, t.target)):
        lines.append(
            f"  {_fmt_date(tt.date)}  {_fmt_12h(tt.time)}  {tt.target}  "
            f"{tt.available_spots} spots  {tt.holes}  "
            f"{_fee_text(tt.target, tt.green_fee, tt.booking_fee)}"
        )
        url = _booking_url(tt.target, tt.date)
        if url:
            if tt.target in _TEEITUP_COURSES:
                vendor = "TeeItUp"
            elif tt.target in _WEBTRAC_COURSES:
                vendor = "WebTrac"
            elif tt.target in _GOLFDISTRICT_COURSES:
                vendor = "Golf District"
            else:
                vendor = "ForeUp"
            lines.append(f"    Open in {vendor}: {url}")
        book_url = (book_urls or {}).get(tt.key)
        if book_url:
            lines.append(f"    Book now (one click): {book_url}")
    lines.append(f"\nfetched {datetime.now().isoformat(timespec='seconds')}")
    if unsubscribe_url:
        label = f' "{set_name}"' if set_name else ""
        lines.append(f"\nUnsubscribe from{label}: {unsubscribe_url}")
    return "\n".join(lines)


def _html(
    new_times: list[TeeTime],
    *,
    set_name: str | None = None,
    unsubscribe_url: str | None = None,
    book_urls: dict[str, str | None] | None = None,
) -> str:
    rows = []
    show_book_col = bool(book_urls) and any(book_urls.values())
    for tt in sorted(new_times, key=lambda t: (t.date, t.time, t.target)):
        fee_text = _fee_text(tt.target, tt.green_fee, tt.booking_fee)
        time_str = _fmt_12h(tt.time)
        url = _booking_url(tt.target, tt.date)
        time_cell = (
            f'<a href="{html_escape(url, quote=True)}">{html_escape(time_str)}</a>'
            if url else html_escape(time_str)
        )
        book_cell = ""
        if show_book_col:
            burl = (book_urls or {}).get(tt.key)
            book_cell = (
                "<td>"
                + (
                    f"<a href='{html_escape(burl, quote=True)}' "
                    f"style='display:inline-block;background:#1565c0;color:#fff;"
                    f"text-decoration:none;padding:6px 12px;border-radius:4px;"
                    f"font-size:12px;font-weight:600'>Book</a>"
                    if burl else ""
                )
                + "</td>"
            )
        rows.append(
            f"<tr><td>{html_escape(_fmt_date(tt.date))}</td><td>{time_cell}</td>"
            f"<td>{html_escape(tt.target)}</td>"
            f"<td>{tt.available_spots}</td><td>{tt.holes}</td>"
            f"<td>{html_escape(fee_text)}</td>{book_cell}</tr>"
        )
    book_header = "<th>Book</th>" if show_book_col else ""
    table = (
        "<table style='border-collapse:collapse' cellpadding='6'>"
        "<thead><tr style='background:#f0f0f0'>"
        "<th>Date</th><th>Time</th><th>Course</th><th>Spots</th><th>Holes</th><th>Fee</th>"
        f"{book_header}"
        "</tr></thead><tbody>"
        + "".join(rows)
        + "</tbody></table>"
    )
    if not unsubscribe_url:
        return table
    label = f' "{html_escape(set_name)}"' if set_name else ""
    footer = (
        "<p style='margin-top:18px;color:#888;font-size:12px;font-family:sans-serif'>"
        f"<a href='{html_escape(unsubscribe_url, quote=True)}'>Unsubscribe</a> from{label}."
        "</p>"
    )
    return table + footer
