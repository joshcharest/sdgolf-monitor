# sdgolf-monitor

Polls San Diego golf tee sheets — City courses (Balboa Park 9/18, Torrey
Pines N/S via ForeUp), Coronado (via TeeItUp), the Navy MWR courses
(Admiral Baker N/S via WebTrac), and Encinitas Ranch prepaid
resales (via the Golf District marketplace) — on a schedule and emails
you when a new slot matching your filter shows up. Designed to run as a
GitHub Actions cron job — no servers, no AWS, no browser.

A web UI for managing check sets is also published to GitHub Pages.

## How it works

1. **One ForeUp login per cron run**, JWT captured from the SPA's auth call.
2. **Every YAML under `configs/`** is treated as one "check set" — its own
   targets, date range, time windows, and filter criteria.
3. **For each check set**, the runner fetches tee times across the date
   range, filters to matches, diffs against `state/<set-name>.json`, and
   emails a digest if there's anything new. State lives in the GitHub
   Actions cache (keyed `state-*`) so dedup persists across runs without
   polluting git history.
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
4. **Host the UI on Cloudflare Pages** (free, supports private repos):
   1. Visit https://dash.cloudflare.com/ → Workers &amp; Pages → Create →
      Pages → Connect to Git.
   2. Authorize Cloudflare to read this repo only.
   3. Create project. **Build settings**: framework preset = *None*,
      build command = leave empty, build output directory = `ui`.
   4. Deploy. The UI is then served at
      `https://sdgolf-monitor.pages.dev/`. Cloudflare auto-redeploys
      on every push to `main` that touches `ui/**`.

   The UI never leaves the Cloudflare CDN; nothing in your repo becomes
   public. The UI talks directly to `api.github.com` from your browser
   using a PAT you paste in once (saved to localStorage).

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
  - { name: "Coronado (3-14d)", provider: teeitup,
      facility_id: 10985, alias: coronado-gc-3-14-be }
  - { name: "Admiral Baker North", provider: webtrac, secondarycode: 28 }
  - { name: "Encinitas Ranch (resale)", provider: golfdistrict,
      course_id: 3f755992-90e0-11ef-9af2-6a003139847e }
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
- The Navy courses (WebTrac) have no JSON API — the monitor scrapes the
  server-rendered search results table, so a portal redesign would break
  it. No prices are published in search results (Navy green fees depend
  on patron category), so fee filters don't apply to those courses.
- Encinitas Ranch is covered via the **Golf District resale marketplace**
  (`provider: golfdistrict`) — the prepaid tee times other golfers list
  for resale (second-hand only; the course's own first-hand inventory is
  filtered out as noise). Golf District has no green-fee translation; the
  `pricePerGolfer` shown is the actual resale price.
- The **primary** JC Golf / CPS.golf tee sheet (Encinitas, The Crossings,
  Rancho Bernardo Inn, Twin Oaks) is **not** reachable — that booking API
  sits behind a Cloudflare *browser-integrity* challenge that returns
  `403 cf-mitigated: challenge` to any non-browser HTTP client (confirmed
  from both datacenter and residential IPs, so it's not an IP block).
  Only the resale marketplace above (a separate, Vercel-hosted system) is
  accessible headlessly.
- Monitoring only — this does not book tee times. Booking requires
  card-on-file and a captcha flow that isn't worth automating.
