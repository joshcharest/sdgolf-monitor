# sdgolf-monitor

Polls the City of San Diego golf tee-time API (Balboa Park 9/18, Torrey Pines
N/S) on a schedule and emails you when a new slot matching your filter shows
up. Designed to run as a GitHub Actions cron job — no servers, no AWS, no
browser.

A web UI for managing check sets is also published to GitHub Pages.

## How it works

1. **One ForeUp login per cron run**, JWT captured from the SPA's auth call.
2. **Every YAML under `configs/`** is treated as one "check set" — its own
   targets, date range, time windows, and filter criteria.
3. **For each check set**, the runner fetches tee times across the date
   range, filters to matches, diffs against `state/<set-name>.json`, and
   emails a digest if there's anything new. State is committed back to the
   repo so dedup persists across runs.
4. **Email subjects are tagged** `[sdgolf:<set-name>]` so Gmail filters can
   route each check set independently.

## Setup

1. **Generate a Gmail App Password** (Account → Security → 2FA → App
   passwords) — use this, not your real password.
2. **Add repo secrets** in
   Settings → Secrets and variables → Actions:

   | Secret | Value |
   |---|---|
   | `SDGOLF_USERNAME` | your sdgolf.com login |
   | `SDGOLF_PASSWORD` | your sdgolf.com password |
   | `GMAIL_USERNAME` | sender email address |
   | `GMAIL_APP_PASSWORD` | 16-char Gmail app password |
   | `NOTIFY_TO` | where alerts go |

3. **Enable Actions** — the `monitor` workflow runs every 5 minutes.
4. **Enable GitHub Pages** — Settings → Pages → Source: **GitHub Actions**.
   The `pages` workflow publishes `ui/` to
   `https://<owner>.github.io/sdgolf-monitor/` whenever `ui/**` changes.

## Managing check sets

### Via the web UI (recommended)

1. Open the published Pages URL.
2. First visit: paste a fine-grained personal access token scoped to this
   single repo with **Contents: read & write**. Saved to localStorage; only
   sent to `api.github.com`.
3. Each YAML in `configs/` shows as a card. Toggle enabled, click to edit,
   or "＋ New check set" to create one. Save commits the YAML back to `main`
   directly.

### Via direct YAML editing

`configs/<name>.yaml`:

```yaml
enabled: true
description: "Optional one-liner shown in the UI"
targets:
  - { name: "Balboa Park 18 (≤7d)", teesheet_id: 1470, booking_class: 929 }
  - { name: "Torrey Pines North",   teesheet_id: 1468, booking_class: 51735 }
dates:
  start: today          # also accepts ISO dates like 2026-06-01
  end: today+90
filter:
  holes: 18             # 9 or 18
  min_players: 2
  max_green_fee: null   # number or null (no cap)
  windows:
    - { start: "07:00", end: "11:00", weekdays: [sat, sun] }
    - { start: "15:00", end: "18:30", weekdays: [mon, tue, wed, thu, fri] }
```

The filename (without `.yaml`) is the set name used in logs and the email
subject. Lowercase + hyphens recommended.

### Discovering your booking classes

```bash
SDGOLF_USERNAME=... SDGOLF_PASSWORD=... \
  python -m sdgolf_monitor.discover
```

Prints each teesheet's slot count under each of your account's booking
classes, for both 9- and 18-hole rounds. Teesheet IDs: Balboa 18 = 1470,
Balboa 9 = 1490, Torrey N = 1468, Torrey S = 1487.

## Local dry-run

```bash
pip install -e .
SDGOLF_USERNAME=... SDGOLF_PASSWORD=... \
  python -m sdgolf_monitor.main --dry-run
```

`--dry-run` skips email and never writes state, so you can iterate on
filter rules without burning notifications. Each set is logged independently
with its name in brackets.

## Tests

```bash
pip install -e ".[dev]"
pytest
```

## Caveats

- ForeUp's API is undocumented and could change. The integration relies on
  the JWT + `Api-Key: no_limits` shape the SPA uses today.
- The booking-class IDs and pricing are San Diego-specific. Other ForeUp
  courses would need their own discovery run.
- Monitoring only — this does not book tee times. Booking requires
  card-on-file and a captcha flow that isn't worth automating.
