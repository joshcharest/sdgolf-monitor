# sdgolf-monitor

Polls the City of San Diego golf tee-time API (Balboa Park, Torrey Pines N/S)
on a schedule and emails you when a new slot matching your filter shows up.

Designed to run as a GitHub Actions cron job; no servers, no AWS, no browser.

## How it works

1. `client.py` logs into ForeUp with your sdgolf credentials, captures the JWT
   it hands back, and queries the public `/api/booking/times` endpoint per
   target (a `(course teesheet, booking class)` pair).
2. `filter.py` matches each tee time against your config (date range, time
   window per weekday, min players, max green fee).
3. `state.json` records which slots you've already been notified about so
   re-runs don't spam you. The GitHub Actions workflow commits the updated
   file back to the repo after each run — so the state is durable across
   runs and doubles as an audit trail.
4. `notify.py` emails a digest via Gmail SMTP when there is at least one
   newly-seen match.

## Setup

1. **Discover your booking class IDs.** After login ForeUp returns a list of
   classes your account is entitled to. Run:

   ```bash
   pip install -e .
   SDGOLF_USERNAME=you@example.com SDGOLF_PASSWORD=... \
     python -m sdgolf_monitor.discover
   ```

   It prints each teesheet's slot count under each class — pick the class
   that returns non-zero counts for your target date range. The teesheet IDs
   are: Balboa 18 = 1470, Balboa 9 = 1490, Torrey N = 1468, Torrey S = 1487.

2. **Edit `config.yaml`** with your targets, date range, and filter windows.

3. **Generate a Gmail App Password.** Account → Security → 2FA → App
   passwords. Use that, not your real password.

4. **Push to GitHub and add secrets** in the repo's
   Settings → Secrets and variables → Actions:

   | Secret | Value |
   |---|---|
   | `SDGOLF_USERNAME` | your sdgolf.com login |
   | `SDGOLF_PASSWORD` | your sdgolf.com password |
   | `GMAIL_USERNAME` | sender email address |
   | `GMAIL_APP_PASSWORD` | 16-char Gmail app password |
   | `NOTIFY_TO` | where to send alerts (can be same as sender) |

5. **Enable Actions.** The workflow runs every 5 minutes. You can also
   trigger a run manually from the Actions tab.

## Local dry-run

```bash
SDGOLF_USERNAME=... SDGOLF_PASSWORD=... \
  python -m sdgolf_monitor.main --dry-run
```

`--dry-run` skips the email send and never touches `state.json`, so you can
iterate on filter rules without burning notifications.

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
- This is for **monitoring availability only** — it does not book. Booking
  requires a card-on-file and a captcha flow that's not worth automating.
