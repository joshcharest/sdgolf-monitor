# sdgolf-monitor

Polls San Diego golf tee sheets — City courses (Balboa Park 9/18, Torrey
Pines N/S via ForeUp), Coronado (via TeeItUp), the Navy MWR courses
(Admiral Baker N/S via WebTrac), and Encinitas Ranch prepaid tee times
and resales (via the Golf District marketplace) — on a schedule and emails
you when a new slot matching your filter shows up. Designed to run as a
GitHub Actions cron job — no servers, no AWS, no browser.

A web UI for managing check sets is served by the Cloudflare Worker at
https://sdgolf-monitor.joshcharest1.workers.dev/.

## How it works

1. **One ForeUp login per cron run**, JWT captured from the SPA's auth call.
2. **Every check set the Worker serves** (from Cloudflare KV) has its own
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

3. **Enable Actions** — a Worker cron dispatches the `monitor` workflow
   every 5 minutes, with a `schedule:` backstop every 30 minutes in case
   that dispatch breaks.
4. **Deploy the Worker**, which is both the API and the web host — the
   `assets` binding in `wrangler.jsonc` serves `ui/` straight from the
   Worker, so there is no separate Pages project:

   ```bash
   npx wrangler deploy
   ```

   Or run the `deploy` workflow from the Actions tab, which does the same
   thing with the repo's `CF_API_TOKEN` (needs "Workers Scripts: Edit").
   The UI is then served at
   `https://sdgolf-monitor.joshcharest1.workers.dev/`. Unlike the Actions
   secrets above, the Worker's secrets are set with
   `npx wrangler secret put <NAME>` — see "Worker secrets" below.

   This repo is public, so treat everything committed here as readable by
   anyone. Nothing sensitive lives in it: credentials are GitHub Actions
   secrets and Worker secrets (never committed, `.env` is gitignored), and
   all user data — accounts, check sets, SMS enrollments — lives in
   Cloudflare KV rather than in the tree.

   The browser only ever talks to this Worker's own `/api/*` endpoints —
   never to `api.github.com`. Auth is an HttpOnly session cookie the Worker
   sets on login/signup, so no tokens live in localStorage.

## Worker secrets

Set with `npx wrangler secret put <NAME>`; they take effect immediately, no
redeploy. Separate from the Actions secrets above — the runner and the
Worker each hold their own.

| Secret | Purpose |
|---|---|
| `GH_DISPATCH_TOKEN` | Fine-grained PAT (**Actions: read & write** on this repo) the cron uses to trigger `monitor.yml`. If it lapses, every check stops and the only symptom is silence — see "Caveats". |
| `SESSION_SECRET` | Signs the `sdgolf_session` cookie. |
| `PASSWORD_PEPPER` | Pepper mixed into PBKDF2 password hashes. |
| `ALLOWED_EMAILS` | Bootstrap signup allow list; once an admin saves a list, KV `allowed_emails` takes over. |
| `ADMIN_EMAILS` | Comma-separated admins (manage the allow list, autobook, bug reports). |
| `RUNNER_SECRET` | Bearer token for `/api/internal/*`, and the signing key for unsubscribe + one-click booking links. Must match the Actions secret of the same name. |
| `AUTOBOOK_OWNER_EMAIL` | App-side email of whoever owns the ForeUp account autobook would charge. |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_FROM_NUMBER` | Optional. Unset means SMS degrades to email-only; it never breaks auth. |

`INVITE_CODE` is still set on the deployment but nothing reads it — signup
is gated by the allow list. Safe to delete.

## Managing check sets

### Via the web UI (recommended)

1. Open the published UI URL.
2. First visit: sign up with an email + password. Signup is gated by an
   allow list — KV key `allowed_emails`, bootstrapped from the
   `ALLOWED_EMAILS` Worker secret and managed by admins after that — so an
   address the admin hasn't added gets a 403.
3. Each check set shows as a card. Toggle enabled, click to edit, or
   "＋ New check set" to create one. Save writes the config to Cloudflare KV
   (`config:<id>`) via the Worker's `/api/configs` endpoints; the monitor run
   reads them back from `/api/internal/configs`. Nothing is committed to the
   repo.

### Check-set schema

KV is the source of truth for check sets; the `configs/*.yaml` files are the
pre-KV originals, kept as readable examples of the field schema (the KV
records hold the same fields as JSON). Editing them does nothing — a run
reads only what the Worker serves. See `scripts/migrate_configs_to_kv.py`
for the one-shot YAML → KV migration.

```yaml
enabled: true
description: "Optional one-liner shown in the UI"
targets:
  - { name: "Balboa Park 18 (≤7d)", teesheet_id: 1470, booking_class: 929 }
  - { name: "Torrey Pines North",   teesheet_id: 1468, booking_class: 51735 }
  - { name: "Coronado (3-14d)", provider: teeitup,
      facility_id: 10985, alias: coronado-gc-3-14-be }
  - { name: "Admiral Baker North", provider: webtrac, secondarycode: 28 }
  - { name: "Encinitas Ranch (Golf District)", provider: golfdistrict,
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

In these files the filename (without `.yaml`) was the set name used in logs
and the email subject; KV records carry that as a `name` field instead.

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

- **The monitor fails silently.** Every layer degrades quietly: an expired
  `GH_DISPATCH_TOKEN`, a missed Worker cron, or a failing run all produce
  the same symptom — no email — which is indistinguishable from a day when
  no tee times opened up. This happened on 2026-08-16: the dispatch token
  hit its 90-day expiry and nothing ran for five hours. Two guards now
  exist: the `schedule:` backstop in `monitor.yml`, and the `heartbeat`
  workflow, which checks `/api/health` every 30 minutes and emails the
  admins when the published snapshot goes stale. Check liveness by hand
  with `curl <worker>/api/health` — it answers 503 when stale.
- ForeUp's API is undocumented and could change. The integration relies on
  the JWT + `Api-Key: no_limits` shape the SPA uses today.
- The booking-class IDs and pricing are San Diego-specific. Other ForeUp
  courses would need their own discovery run.
- The Navy courses (WebTrac) have no JSON API — the monitor scrapes the
  server-rendered search results table, so a portal redesign would break
  it. No prices are published in search results (Navy green fees depend
  on patron category), so fee filters don't apply to those courses.
- Encinitas Ranch is covered via the **Golf District marketplace**
  (`provider: golfdistrict`) — both the course's own prepaid listings and
  the tee times other golfers list for resale (the latter flagged "resale"
  in alerts and the UI). The course's first-hand side is sparse prepaid
  inventory (a few slots per day, typically nothing in the near term), not
  a full tee sheet. Golf District has no green-fee translation; the
  `pricePerGolfer` shown is the actual final price.
- The **primary** JC Golf / CPS.golf tee sheet (Encinitas, The Crossings,
  Rancho Bernardo Inn, Twin Oaks) is **not** reachable — that booking API
  sits behind a Cloudflare *browser-integrity* challenge that returns
  `403 cf-mitigated: challenge` to any non-browser HTTP client (confirmed
  from both datacenter and residential IPs, so it's not an IP block).
  Only the resale marketplace above (a separate, Vercel-hosted system) is
  accessible headlessly.
- Monitoring only — this does not book tee times. Booking requires
  card-on-file and a captcha flow that isn't worth automating.
