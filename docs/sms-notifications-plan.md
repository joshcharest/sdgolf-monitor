# SMS notifications — implementation plan

**Date:** July 10, 2026
**Status:** Direction approved 2026-07-10 — SMS via Twilio toll-free; free alternatives (Telegram bot, PWA web push, Pushover, native app) evaluated and declined. Open questions in §10 still pending.
**Owner:** Josh (sdgolfmonitor@gmail.com)
**Audience:** Josh + the coding agent implementing it. All `file:line` references were verified against `main` @ `5155167` on 2026-07-10.

---

## 1. Goal & background

Tee times at popular San Diego courses get sniped within minutes of appearing. The monitor already finds new slots on a ~5-minute cadence and emails subscribers, but email routinely isn't *seen* for 10–60 minutes — the alert works, the human misses it. The fix is lockscreen visibility: a text message lands with a buzz, instantly.

**SMS is added alongside email, never replacing it:**

- **Email stays the authoritative, at-least-once channel.** It carries the full digest, unsubscribe links, and owner Book links, and keeps its retry-next-tick semantics untouched.
- **SMS is a strictly opt-in, best-effort accelerator** — a one-segment ping ("new tee time, here's the link") for users who explicitly enroll a phone number. If SMS fails, is unconfigured, or a user never opts in, behavior is exactly today's.
- **Scope: one message type.** Only the new-tee-time digest (the only latency-critical send, `runner.py:139`) gets SMS, plus the single compliance-required opt-in verification text. Welcome, subscribe/create confirmations, bug reports, and autobook notices stay email-only — none is time-sensitive, and every SMS costs real money.

Scale reality check: a handful of friends, low tens of alert emails/day, all recipients in San Diego, current infra cost ~$0/month. The design below is the smallest diff that is compliant, observable, and safe — no queues, no webhooks, no shorteners, no SDKs.

---

## 2. Provider decision

**Pick: Twilio, toll-free number ($2.15/mo), with free toll-free verification filed as `businessType=SOLE_PROPRIETOR`.**

Why this route (all facts as of 2026-07-10 unless noted):

- **$0 one-time fees.** Toll-free verification is free; no TCR brand/campaign/vetting charges, no monthly campaign fee. The only upfront cash is a ~$20 account top-up to exit trial mode (becomes message credit).
- **No EIN needed — with a caveat.** Twilio began requiring a Business Registration Number (EIN) on new toll-free verifications in early 2026, but its changelog carves out filers *genuinely without one*: "If you don't have an EIN (for example, if you're a sole proprietor with no employees), you can indicate that it's not available." (Twilio changelog, verified against the primary source 2026-07-10.) That fits Josh exactly. Note it is a no-EIN carve-out with extra vetting, **not** a blanket sole-proprietor exemption — industry sources (Bandwidth/Telgorithm) call EIN-less approval "not guaranteed" — which is the schedule risk, mitigated by the fallback below.
- **Zero inbound code required for compliance.** Twilio auto-handles STOP/STOPALL/UNSUBSCRIBE/CANCEL/END/QUIT (+ REVOKE/OPTOUT, added 2025-05-13 per FCC ruling) at the carrier level on toll-free numbers; post-STOP sends fail synchronously with catchable error 21610 (uncharged). HELP gets a console-configured auto-response.
- **No SDK.** Sending is one form-encoded Basic-auth POST — `requests` from Python (already a dependency), plain `fetch` from the Worker (Cloudflare's own documented pattern).
- **All-in cost ≈ $5.75–6.05/month** at ~300 single-segment messages (~10/day). Detail in §9.

**Fallback (same code, different From number):** Twilio A2P 10DLC Sole Proprietor on the same account — ~$19–20.50 one-time ($4–4.50 brand + $15 campaign vetting + $1 T-Mobile activation), $2/mo campaign + $1.15/mo local number, OTP to Josh's mobile, 1–4 weeks approval. Only the `TWILIO_FROM_NUMBER` secret changes.

### Routes considered (facts as of July 2026)

| Route | One-time | Monthly @ ~300 msgs | Registration friction | Verdict |
|---|---|---|---|---|
| **Twilio toll-free + Sole Prop verification** | $0 (+$20 credit load) | **~$5.75–6.05** | TFV free, up to ~10 business days; filers genuinely without an EIN may declare it unavailable (extra vetting) | **PICKED** |
| Twilio 10DLC Sole Prop | ~$19–20.50 | ~$7 | TCR brand + campaign, OTP to personal mobile, 1–4 weeks | Fallback — identical code |
| Telnyx 10DLC Sole Prop | ~$19.50 | ~$5.20 | Self-serve since 2026-02-04; last-4 SSN + OTP; campaign vetting; $15 resubmission fee | ~$1/mo cheaper, more registration risk + a TCR campaign to babysit forever |
| Surge (surge.app) Hobby | $0 | ~$7–9 | White-glove registration, 1–2 business days | Fine plan B; young company |
| Textbelt (shared hosted pool) | $0 | ~$18 (@~$0.06/msg entry rate) | **None** | The no-registration escape hatch; self-described best-effort delivery — wrong for time-critical alerts |
| AWS SNS / End User Messaging | — | — | 10DLC brand requires EIN; new toll-free needs BRN since 2026-01-01; SMS sandbox exit via support case | Effectively closed to EIN-less individuals |
| Plivo | — | — | Sole-prop/Starter registrations **paused** (2025) | Not viable without an EIN |
| ClickSend | $20 min top-up | ~$6–9 @ $0.02–0.03/msg | Still requires your own registered TFN/10DLC | Same friction as Telnyx at 3–4× the price |
| Carrier email-to-SMS gateways | $0 | $0 | — | **Dead.** AT&T shut down 2025-06-17; T-Mobile silently dead since late 2024; Verizon degraded, hard sunset 2027-03-31. Do not build on this. |
| Push alternatives (Telegram bot / PWA web push / Pushover) | $0 / $0 / $4.99 per user one-time | $0 | No carrier registration, but each friend must install an app or complete an iOS Add-to-Home-Screen ritual | Not SMS — real SMS is the only zero-recipient-setup channel. Telegram/web push remain good *future* complementary channels; ntfy disqualified (documented iOS delivery delays as of mid-2026). |

---

## 3. Architecture

**Principle: the runner decides and sends alerts; the Worker owns enrollment; nobody polls a queue for the time-critical path.**

```
 Cloudflare Worker cron (*/5) ──dispatch──► GitHub Actions: python -m sdgolf_monitor.main
                                                 │
   GET /api/internal/configs                     │  per check set (runner.py):
   + recipient_away + recipient_sms  ◄───────────┤    fetch → filter → diff (state/)
   (active, verified phones only)                │    1) notify.send_email ──Gmail SMTP──► inboxes   [authoritative; may raise → set retries]
                                                 │    2) sms_queue.enqueue(...)                      [in-memory; cannot raise]
                                                 │    state.save                                     [unchanged invariant]
                                                 │
                                                 │  after all sets (main.py):
                                                 │    sms_queue.flush() ── ≤1 coalesced msg/person ──► POST api.twilio.com …/Messages.json ──► phones
                                                 │      8/tick cap · 21610/21211 catch · NEVER raises
                                                 │    POST /api/internal/sms-optout ──► Worker flips sms:<email> to stopped
                                                 │    outcomes → snapshot; ≥3 consecutive failures → admin email (existing send_bug_report)
                                                 ▼
 Browser (ui/) ── PUT /api/me/sms ──► Worker: validate + store consent ── fetch ──► Twilio: OTP text (synchronous)
               ── POST /api/me/sms/verify ──► status=active   (only 'active' records ever reach the runner)

 Recipient texts STOP ──► Twilio carrier-level block (automatic, instant) ──► next runner send → error 21610 → optout POST → KV
```

### Where sends happen

| Send | Sent by | Why |
|---|---|---|
| New-tee-time alert SMS | **Python runner**, direct Twilio REST POST, immediately after the email for the same tick | Alerts are *discovered* in the runner; routing through the Worker's polled outbox pattern would add up to 5 minutes — defeats the entire point |
| Opt-in OTP verification text | **Worker**, synchronous `fetch` inside `PUT /api/me/sms` | Enrollment UX needs the code in seconds, and possession must be proven *before* any alert can target the number; modeled on `dispatchMonitor` (worker.js:103–127) |

### Inbound STOP / status webhooks

**None in v1 — deliberately.** The compliance floor is provider-side: Twilio blocks all FCC STOP keywords at the carrier edge automatically, and subsequent sends fail with error 21610 (uncharged). The runner catches 21610 (and 21211 invalid-number) and POSTs `/api/internal/sms-optout` so KV and the UI reflect reality within one tick. HELP is Twilio's console-configured auto-response with Josh's contact email.

If a webhook is ever wanted (instant KV mirroring of STOP, delivery-status callbacks), it lands as `POST /webhooks/twilio/sms` routed ahead of the ASSETS fallback (worker.js:82), parsing form bodies like `handleUnsubscribePost` (worker.js:546–552), validating `X-Twilio-Signature` with an HMAC-SHA1 variant of `hmacSha256` (worker.js:1194–1204), resolving sender via the `phone:<e164>` reverse key (which v1 already writes). Nothing in v1 blocks that addition.

### Secrets placement

| Secret | GitHub Actions (monitor.yml env, lines 40–54) | wrangler secret | Why |
|---|---|---|---|
| `TWILIO_ACCOUNT_SID` | ✅ | ✅ | Runner sends alerts; Worker sends the OTP text |
| `TWILIO_AUTH_TOKEN` | ✅ | ✅ | same — dual-homed exactly like `RUNNER_SECRET` already is; rotation is a documented two-step |
| `TWILIO_FROM_NUMBER` | ✅ | ✅ | same |

Rules: all three are **optional everywhere** — read with `os.environ.get` / `env.X ?? skip` (the `GH_DISPATCH_TOKEN` graceful-degradation pattern, worker.js:104–107). They are **never** added to `authSecretsReady` (worker.js:394–396): a missing SMS secret degrades to email-only and can never 503 login/signup.

### Failure & fallback behavior

- **Email first, always.** An SMTP failure still propagates → per-set catch at main.py:161–168 → state unsaved → whole set retries next tick, SMS never attempted for that set. Unchanged from today.
- **SMS never raises.** Enqueue is a dict append (cannot raise); flush wraps every per-recipient send in try/except (clone of the autobook guard, runner.py:174–176). A failed SMS is **dropped, not retried** — the email already delivered the same alert. This protects the map's #1 gotcha: anything raising between diff and `state.save` (runner.py:178) re-fires every *email* next tick.
- **Missing secrets ⇒ channel off**, run byte-identical to today (one `sms channel disabled (no TWILIO_* secrets)` log line). **Kill switch:** delete the `TWILIO_AUTH_TOKEN` Actions secret — channel vanishes next tick.
- **Burst safety:** GitHub Actions cache eviction (monitor.yml:31–37) re-alerts every matching slot at once. Coalescing (≤1 text/person/tick) plus `MAX_SMS_PER_TICK = 8` caps the worst tick at ~$0.10; email carries the full list.
- **dry_run:** `run_check_set` returns at runner.py:129–131 before any send; `main.py` builds neither `SmtpCreds` nor `SmsCreds`. Zero SMS surface.

---

## 4. Data model (Workers KV, binding `SNAPSHOT_KV`)

### New key: `sms:<email>` (email lowercased via `normaliseEmail`; sibling-key pattern cloned from `away:<email>`, worker.js:381–383)

```jsonc
{
  "phone": "+16195551234",              // E.164, US-only; server-validated ^\+1\d{10}$
  "status": "pending" | "active" | "stopped" | "disabled",
  //          pending  = consented, OTP not yet entered — runner never sees it
  //          active   = verified — the ONLY status the runner receives
  //          stopped  = texted STOP (carrier-blocked) or number invalid
  //          disabled = turned off via UI, or admin removed the account
  "consent": {                          // TCPA/CTIA consent record — the reason this key is never deleted
    "ts": "2026-07-14T18:03:22Z",
    "ip": "…",                          // CF-Connecting-IP at PUT time
    "disclosure_version": "v1",         // pins the exact checkbox text shown
    "url": "https://sdgolf-monitor.joshcharest1.workers.dev/",
    "user_agent": "…"
  },
  "verify": {                           // present only while status=pending; cleared on activation
    "code_sha256": "…", "salt": "…",    // sha256(code+salt) via crypto.subtle — no PBKDF2 (10ms CPU budget)
    "expires": "…",                     // 10-minute TTL
    "attempts": 0,                      // ≤5 tries, then re-request
    "sends": { "date": "2026-07-14", "count": 1 }   // ≤3 OTP sends/day
  },
  "verified_at": "…",
  "opted_out_at": "…",
  "opt_out_reason": "stop_21610" | "invalid_21211" | "ui" | "admin",
  "history": [ { "event": "opt_in|verified|stop|invalid|ui_disable|admin_disable", "ts": "…" } ],  // capped at 50
  "created_at": "…", "updated_at": "…"
}
```

**Lifecycle:** written only by Worker handlers. **Never deleted** — on any opt-out the status flips and the record persists as the consent + revocation audit log (TCPA statute of limitations is 4 years; 5-year retention is the defensible floor — see §6). This deliberately extends the existing sibling-key-survives-account-deletion behavior, now as a documented feature disclosed in `privacy.html`.

### New key: `phone:<e164>` → `{ "email": "…" }`

Reverse lookup + uniqueness guard. Written at opt-in; `PUT /api/me/sms` returns **409** if the number is already claimed by a different email. **Deleted** on STOP, invalid-number, UI disable, and admin removal — routable PII never outlives use, and the number becomes re-enrollable. Also future-proofs an inbound webhook (phone→email resolution) without committing to one now.

### Extended: `GET /api/internal/configs` decoration (inside the existing recipients pass, worker.js:850–880)

Each config gains, exactly parallel to `recipient_away`:

```jsonc
"recipient_sms": {
  "friend@example.com": { "phone": "+16195551234" }
}
```

**`status === "active"` records only**, keyed by lowercased email (the strip/lower normalization invariant — worker.js:858–862 / runner.py:216 / notify.py:635). Pending, stopped, and disabled users simply never appear, so the runner *cannot* text an unverified or opted-out number even by bug. Shipping `{phone}` as an object (not a bare string) from day one avoids a later shape migration.

### Opt-in scope: per-user, NOT per-subscription — a deliberate decision

`cfg.subscribers` is a flat array of email strings consumed by the runner (`recipients_for`, runner.py:351–363), the UI, and `PUT /api/configs/:id` (which rebuilds records field-by-field and would silently drop new shapes — worker.js:449/471/495–500). Per-subscription channel prefs would force that migration across three consumers for zero friends-scale benefit. Per-set control already exists: **unsubscribing from a config stops both channels for that set** (SMS derives from the same recipients list), and away dates suppress both channels per day. A per-config SMS mute can be revisited later if anyone actually asks.

### Explicitly not added

No `sms_confirm` outbox queue (the Worker sends the OTP synchronously; the OTP text *is* the compliance confirmation text). No new `*_index` arrays (both new keys are only ever direct-lookup, so the KV list-quota workaround at worker.js:1049–1085 isn't needed). No changes to `config:<id>`, the snapshot key, or any HMAC token format (no new mint/verify mirror; `RUNNER_SECRET` rotation coupling does not grow).

---

## 5. Code changes by file

Each bullet ≈ one commit. Python has no new pip dependencies (`requests` and `zoneinfo` already available).

### `src/sdgolf_monitor/notify.py` — shared per-recipient filter (pure refactor, ships first)

- Extract the away filter from `send_email`'s loop (**verbatim notify.py:638–641**: `addr_norm` → `their_away` → `their_times`) into module-level `slots_for_recipient(addr, new_times, recipient_away) -> tuple[str, list[TeeTime]]`; call it from the loop. Zero behavior change; add a regression test asserting `send_email` output is byte-identical. This is the single piece of resolution email and SMS must share so away-suppression semantics can never drift between channels.
- No other changes. `sms.py` imports `_slot_subject_line` (notify.py:692–699) and `_booking_url` (notify.py:118–153) directly — same package, and it avoids creating keep-in-sync mirror #6 (the UI map's explicit warning).

### `src/sdgolf_monitor/sms.py` — NEW (~150 lines + tests), all logic unit-testable without network

- `SmsCreds` frozen dataclass (`account_sid`, `auth_token`, `from_number`) + `SmsCreds.from_env()` → `None` unless **all three** `TWILIO_*` vars are set.
- GSM-7 machinery: `gsm7_len()` counting septets (extension chars `[]{}~^|\€` cost 2), `_to_gsm7()` transliterating/stripping non-GSM chars from user-supplied set names — one emoji must never silently flip the message to 70-char UCS-2 segments at 2–3× cost. Composer output is ASCII-only by construction.
- `compose_alert(set_name, times, worker_url)` — single-set body: `SDGolf: {slot_line} (+N more) Txt STOP to end {booking_link}` using the earliest slot (same `min()` key as `_subject`, notify.py:685). **Degrade ladder** to guarantee ≤160 GSM-7: drop `" Txt STOP to end"` → drop `" (+N more)"` → swap the provider booking link for the short stable `WORKER_URL`. Belt-and-braces final truncate. No URL shortener — public shorteners are a carrier-filtering red flag.
- `compose_coalesced(entries, worker_url)` — multi-set body: `SDGolf: {N} new tee times across {M} alerts. {top slot_line} {link}`, same ladder.
- `SmsQueue` — in-memory per-tick collector: `enqueue(email, phone, set_name, times)` (dict append; cannot raise), `flush(creds, worker_url) -> Outcomes`. Flush coalesces per email (≤1 text/person/tick), applies the `MAX_SMS_PER_TICK = 8` global cap (module counter; each tick is a fresh process), and POSTs per recipient: `requests.post(f"https://api.twilio.com/2010-04-01/Accounts/{sid}/Messages.json", data={"To":…, "From":…, "Body":…}, auth=(sid, token), timeout=20)`. On HTTP 400, parse the error code: **21610 → outcome `stopped`**, **21211 → `invalid`**, else logged `error`. Every recipient wrapped in try/except; **flush never raises**. Returns `{sent, capped, stopped: [(email, reason)], invalid: […], errors}`.

### `src/sdgolf_monitor/runner.py` — enqueue at the seam

- `run_check_set` signature (runner.py:29–42): add `sms_queue: SmsQueue | None = None`.
- New `_recipient_sms_map(cfg)` beside `_recipient_away_set` (runner.py:205–219): parses `cfg["recipient_sms"]` (`{email: {phone}}`), `strip().lower()` keys, `None` when absent — identical normalization discipline.
- Inside the `else:` branch after `notify.send_email` returns (after runner.py:151, before autobook at :156 and `state.save` at :178): iterate the **same `recipients` list from :135** (pending-confirmation suppression from main.py:137–140 inherited for free); for each, look up the sms entry, compute `_, their_times = notify.slots_for_recipient(addr, new, recipient_away)`, and `sms_queue.enqueue(...)` when both exist. Pure dict mutation — an email-send exception means enqueue never ran; an enqueue can never disturb `state.save`.

### `src/sdgolf_monitor/main.py` — creds, flush, observability

- Beside `SmtpCreds` (main.py:64–69): `sms_creds = SmsCreds.from_env()` only when `not dry_run`; log **once** `sms channel enabled (from +1866…)` or `sms channel disabled (no TWILIO_* secrets)` — chronic absence must be visible (map gotcha: per-set failures are nearly invisible). Create `sms_queue = SmsQueue()` iff creds exist; thread into the `run_check_set` call (main.py:143–155).
- After the config loop, before the pending/bug/welcome drains (~main.py:170): `outcomes = sms_queue.flush(...)` inside try/except-log. For each `(email, reason)` in `stopped`/`invalid`: call new client fn `post_sms_optout(worker_url, runner_secret, email, reason)` (beside the fetch/consume pairs at main.py:260–330; POST, Bearer `RUNNER_SECRET`, 20s timeout, failure logged and dropped — next send just 21610s again).
- Write `snapshot["_sms"] = outcomes` counts; add a one-line guard in the UI snapshot reader to skip underscore-prefixed keys.
- Health alert: track consecutive-failure count in `state/sms_health.json` (same evictable state dir — eviction merely resets the counter). On crossing ≥3 consecutive failed attempts, send Josh an email via the **existing** `notify.send_bug_report` (admin_emails already in scope, main.py:453), max one/UTC-day, wrapped in try/except.

### `.github/workflows/monitor.yml` — 3 lines

- In the Run-monitor env block (lines 40–54), beside `GMAIL_APP_PASSWORD`: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` from Actions secrets. Absent secrets resolve to empty ⇒ channel off ⇒ safe to merge before registration clears.

### `worker.js` — enrollment, decoration, cleanup (each bullet a commit; all routes added before the ASSETS fallback at worker.js:82)

- `smsKey(email)` / `phoneKey(e164)` helpers (clone `awayKey`, worker.js:381–383) + `GET /api/me/sms` (session-gated via the `handleGetAway` pattern, worker.js:352–357): returns `{status, phone_masked}`.
- `PUT /api/me/sms` (`{phone, consent: true}`): normalize US phone → E.164 (strip punctuation; accept 10-digit or 1-prefixed; else 400); require `consent: true`; **409** if `phone:<e164>` maps to a different email; write `sms:<email>` `status=pending` with the full consent record (`CF-Connecting-IP`, `disclosure_version`, url, user_agent) + `phone:<e164>`; generate a 6-digit OTP (store `sha256(code+salt)` via `crypto.subtle` — no PBKDF2, respecting the 10ms CPU budget gotcha; 10-min expiry; ≤3 sends/day; ≤5 attempts) and send it via `sendSmsViaTwilio` (below). Re-PUT acts as resend (rate-limited) or phone change (resets to pending).
- `sendSmsViaTwilio(env, to, body)`: `fetch` POST to `…/Messages.json`, Basic auth via existing `b64encode` (worker.js:1255–1259), `URLSearchParams` body — Cloudflare's documented SDK-free pattern; **graceful skip-and-warn when `TWILIO_*` unset** (dispatchMonitor pattern, worker.js:104–107); **never added to `authSecretsReady`** (worker.js:394–396).
- `POST /api/me/sms/verify` (`{code}`): compare via `constantTimeEqStr` (worker.js:1213–1219) against the stored hash; enforce expiry/attempts; on match → `status=active`, `verified_at`, clear `verify`, history event.
- `DELETE /api/me/sms` ("Turn off texts"): `status=disabled`, `opt_out_reason:"ui"`, `opted_out_at`, history event; **delete `phone:<e164>`**; record retained.
- `POST /api/internal/sms-optout` (`{email, reason}`): gated by `checkRunnerSecret` (worker.js:951–955); read-mutate-put `sms:<email>` → `status=stopped` (mutation shape mirrors `handleUnsubscribePost`, worker.js:568–573); delete `phone:<e164>`.
- `handleInternalConfigs` (worker.js:850–880): in the existing `Promise.all` recipients pass that builds `awayByEmail`, also read `sms:<email>` per recipient; attach `cfg.recipient_sms = {email: {phone}}` for **active** records only, mirroring the `recipient_away` join at :869–878.
- PII cleanup (closes the orphaned-sibling-key gotcha for the new keys): allow-list removal (worker.js:227–231) and admin reset (worker.js:262–269) additionally flip `sms:<email>` to `disabled` (+`admin` reason, history event) and delete `phone:<e164>`.

### `ui/` — opt-in surface

- `ui/index.html`: "Texts" nav button beside Away (nav block :29–36); SMS modal `<template>` (four states below); away tooltip copy fix (:31).
- `ui/app.js`: API fns `apiGetSms/apiPutSms/apiVerifySms/apiDeleteSms` beside `apiGetAway/apiPutAway` (:102–103); module state `USER_SMS` beside `USER_AWAY` (:49), refreshed in `renderList` (:215–220); `openSmsModal` cloned from `openAwayCalendar` (:1228–1355); wire in `setNav` (:116–125); away-modal copy fix (:1265) — "no email alerts" → "no alerts (email or text)", since away days now suppress both channels.
- Modal states: **(A) not enrolled** — `type=tel` input, **unchecked** consent checkbox carrying the full disclosure (§6) + `/privacy.html` link, Save disabled until checked; **(B) pending** — 6-digit code input, rate-limited Resend, attempts-remaining copy; **(C) active** — masked number, "Turn off texts"; **(D) stopped** — banner: *"You texted STOP. Text START to +1-8XX-XXX-XXXX, then re-verify here."* (carrier-level opt-out cannot be cleared programmatically; a silent re-enable would 21610 forever).
- Client phone validation is one regex mirroring the server (acknowledged as the single new client/server mirror). **No SMS body preview anywhere in the UI** — composition stays Python-only (avoids keep-in-sync mirror #6).
- `ui/privacy.html` — NEW static page (existing ASSETS binding, no build step): what's collected (email, phone, consent timestamp/IP), purpose (tee-time alerts only), the load-bearing TFV sentence that **numbers are never shared with third parties for marketing**, retention statement (consent records kept ≥5 years, surviving account deletion), STOP/HELP instructions, contact email. Deferred polish (post-v1): tour step in `buildTourSteps` (:1366–1445), admin `sms` badge (:1878–1902).

### `tests/` — beside `tests/test_notify.py`

- `test_sms.py`: composer ≤160 GSM-7 for **every** course in the notify.py course tables with worst-case slots (`Wed 12/31 11:50 AM`, `(+99 more)`) and 25-char unicode set names; degrade-ladder order; septet extension-char costs; ASCII-only output; 21610/21211 parsing; coalescing (two sets → one body); `MAX_SMS_PER_TICK` cap; flush-never-raises with a raising transport.
- Extend `test_runner.py`/`test_notify.py`: `slots_for_recipient` extraction regression (send_email byte-identical); enqueue skipped on dry_run; enqueue never runs when `send_email` raises; empty-recipients tick enqueues nothing.

---

## 6. Opt-in & compliance checklist (per July 2026 research)

- [ ] **Consent tier — prior express consent (PEC) only.** Alerts are purely informational (tee-time facts + booking link, zero promotional content), so TCPA needs PEC, not written consent (Wipfli, 2026-04-28); the user typing their own number into the modal for this stated purpose is the qualifying act. **Message content must stay strictly informational forever** or the consent tier changes.
- [ ] **Consent capture:** UNCHECKED checkbox with disclosure naming the brand and terms: *"Text me new tee-time alerts from SDGolf Monitor. Message frequency varies. Msg & data rates may apply. Reply STOP to cancel, HELP for help."* + privacy-policy link. Save disabled until checked.
- [ ] **Verification (double opt-in / possession proof):** OTP text sent on enrollment — *"SDGolf Monitor: your code is 482913. Alerts for new tee times; freq varies. Msg&data rates may apply. Reply STOP to opt out, HELP for help."* (~139 GSM-7 chars — carries the CTIA-required first-message disclosures). Code entry flips `pending → active`; **the runner only ever sees `active`** — a typo'd digit can never subscribe a stranger. Not strictly required by TCPA/CTIA, but cheap insurance that also eases verification review.
- [ ] **Consent records:** timestamp, CF-Connecting-IP, user agent, `disclosure_version` pinning the exact checkbox text, form URL, phone, plus the full opt-out/verify event history — stored in `sms:<email>`, **retained ≥5 years** (TCPA SoL is 4 years; without records courts effectively presume non-compliance). Survives account deletion; disclosed in `privacy.html`.
- [ ] **STOP (revocation), four layers, none dependent on our uptime:** (1) Twilio carrier-level auto-handling of STOP/STOPALL/UNSUBSCRIBE/CANCEL/END/QUIT/REVOKE/OPTOUT (last two added 2025-05-13 per FCC) — instant, provider-guaranteed; (2) runner catches 21610 → `/api/internal/sms-optout` → KV truth within one tick; (3) "Turn off texts" in the modal; (4) existing HMAC email-unsubscribe removes the user from a config, stopping *both* channels for that set. All comfortably inside the FCC any-reasonable-means / 10-business-day rule (effective 2025-04-11).
- [ ] **HELP:** Twilio console auto-response with program name + sdgolfmonitor@gmail.com. Zero code.
- [ ] **Brand identification:** every message starts `SDGolf:` / `SDGolf Monitor:`; `Txt STOP to end` rides in alert bodies whenever the segment budget allows (it's the first ladder drop; the enrollment text always carries it).
- [ ] **US-only scope:** `+1` E.164 validation hardcoded (all recipients are San Diego friends) — keeps everything inside US TCPA/CTIA and toll-free verification scope.
- [ ] **Registration evidence coherence:** TFV submission uses the deployed opt-in modal URL + screenshot and `/privacy.html`, with sample messages **matching the real `compose_alert`/OTP strings** — the filing and the code describe the same system.
- [ ] **One phone per account** enforced via `phone:<e164>` (409 on conflict); routable reverse key deleted on every opt-out path.

---

## 7. Setup runbook

**Accounts & registration (start day one — this is the schedule long pole):**

1. Create a Twilio account (or reuse) at twilio.com; **upgrade immediately** with ~$20 balance (trial cannot send US SMS at all — unregistered/unverified sending is blocked with error 30034, and blocked attempts still bill; the $20 becomes message credit). *(as of 2026-07-10)*
2. Buy one **toll-free number** ($2.15/mo). Note it as `TWILIO_FROM_NUMBER` (E.164, `+18XX…`).
3. Deploy `ui/privacy.html` (tiny static commit) and screenshot the opt-in modal (a branch build is fine) — this is the opt-in evidence.
4. Submit **Toll-Free Verification** from the Twilio console: `businessType=SOLE_PROPRIETOR`, marking the EIN/BRN as not available (permitted for filers genuinely without one, per Twilio's changelog); business fields = Josh's personal details (explicitly allowed for hobbyists per Twilio docs); use case *"personal golf tee-time availability alerts to a small opt-in group of friends"*; opt-in flow description + modal screenshot + `https://sdgolf-monitor.joshcharest1.workers.dev/privacy.html`; sample messages = the real alert + OTP strings from §5/§6; message volume "under 500/month". **Free; approval up to ~10 business days.** *(as of 2026-07-10)*
5. In the console: confirm default opt-out handling is active (it is, automatically, on toll-free); set the **HELP auto-response** to include `sdgolfmonitor@gmail.com`; create a **usage trigger** alerting at **$15/month**.
6. **Fallback if TFV rejects** (EIN-less sole-prop approval is "not guaranteed" per Bandwidth/Telgorithm, 2026-01): file A2P 10DLC Sole Proprietor on the same account — brand $4–4.50 + campaign vetting $15 + $1 T-Mobile activation (one-time), $2/mo campaign, $1.15/mo local number, OTP verification to Josh's personal mobile, 1–4 weeks. Then swap `TWILIO_FROM_NUMBER`. No code change.

**Secrets (set only when verification approves — code merges safely before this):**

```bash
# GitHub Actions (runner alert path) — from the repo root
gh secret set TWILIO_ACCOUNT_SID    # paste ACxxxxxxxx…
gh secret set TWILIO_AUTH_TOKEN
gh secret set TWILIO_FROM_NUMBER    # +18XXXXXXXXX

# Cloudflare Worker (OTP verification-text path)
npx wrangler secret put TWILIO_ACCOUNT_SID
npx wrangler secret put TWILIO_AUTH_TOKEN
npx wrangler secret put TWILIO_FROM_NUMBER
```

No `wrangler.jsonc` edit (it has no `vars` block; all env values are secrets by convention). Rotation note: `TWILIO_AUTH_TOKEN` is dual-homed like `RUNNER_SECRET` — rotating it is a two-step (`gh secret set` + `wrangler secret put`); document in README.

---

## 8. Rollout phases

Each phase is independently shippable; every code phase merges **inert** (channel off until secrets exist).

**Phase 1 — Registration & first real text (zero product code; wall-clock ~1–2 weeks; start immediately).**
Runbook steps 1–5: account, top-up, toll-free number, `privacy.html` deployed, modal screenshot, TFV filed, HELP + usage trigger configured.
*Acceptance:* TFV status **Approved**; a manual send —
`curl -X POST "https://api.twilio.com/2010-04-01/Accounts/$SID/Messages.json" --data-urlencode "To=+1<josh>" --data-urlencode "From=$TWILIO_FROM_NUMBER" --data-urlencode "Body=SDGolf Monitor: test" -u "$SID:$AUTH_TOKEN"`
— **delivers a real SMS to Josh's phone**; texting STOP then re-sending returns error 21610; texting START restores delivery.

**Phase 2 — Shared-filter refactor (pure; ships any time).**
`notify.slots_for_recipient` extraction + regression tests.
*Acceptance:* existing test suite green; new test proves `send_email` behavior byte-identical; one production tick sends emails identically.

**Phase 3 — Worker + UI opt-in surface (independent of Twilio approval; OTP send no-ops gracefully until wrangler secrets exist).**
`/api/me/sms` GET/PUT/verify/DELETE, `sms:`/`phone:` keys with consent records, OTP flow, `/api/internal/sms-optout`, `recipient_sms` decoration, PII cleanup wiring, modal + nav + away-copy fix.
*Acceptance:* enroll round-trips to `pending` with full consent record (IP/ts/version) visible in KV; duplicate phone from a second account → 409; `curl` of `/api/internal/configs` with `RUNNER_SECRET` shows `recipient_sms` **only** for a manually-activated record, lowercased keys; disable deletes `phone:` and retains `sms:` with `opt_out_reason:"ui"`; admin removal flips to `disabled` + deletes `phone:`; login/signup/away/admin regression-free **with no Twilio secrets set**. Once Phase 1 approves and wrangler secrets are set: OTP text arrives <10 s after PUT; correct code flips the modal to active; wrong code ×5 locks until re-request.

**Phase 4 — Runner alert channel (inert until Actions secrets set).**
`sms.py`, queue + flush, runner enqueue, main.py wiring, snapshot `_sms` counts + UI underscore-skip guard, health email, `monitor.yml` env lines, full test additions.
*Acceptance:* with `TWILIO_*` unset, a full Actions run is byte-identical to today except one `sms channel disabled` log line; all §5 unit tests green; dry_run builds no creds and sends nothing.

**Phase 5 — Owner canary (Josh only; one secret write, no code).**
Set the three Actions secrets; Josh opts in via the modal.
*Acceptance:* on a real or seeded alert, SMS lands within seconds of the email for the same tick; Twilio console shows `numSegments=1`; booking link opens; **STOP drill** — text STOP → next attempted send logs 21610 → modal shows the stopped banner within one tick; text START + re-verify → delivery restored; breaking `TWILIO_AUTH_TOKEN` on purpose → emails unaffected, `error` outcomes in snapshot, admin health email after 3 consecutive failures.

**Phase 6 — Open to friends + first-month watch.**
Announce in the group; friends self-enroll (allow-list already gates accounts). Optional polish: tour step, admin `sms` badge.
*Acceptance:* each friend received exactly one OTP text and reached `active`; per-message cost in the Twilio console matches ~$0.012–0.013; one friend completes the full STOP → START drill; monthly spend within the §9 estimate.

---

## 9. Cost estimate (friends-scale: ~5 opted-in recipients, ~10 alert texts/day ≈ 300/month, all single-segment)

| Item | One-time | Monthly |
|---|---:|---:|
| Twilio account top-up (becomes message credit) | ~$20.00 | — |
| Toll-free verification | $0.00 | — |
| Toll-free number rental | — | $2.15 |
| Outbound SMS base, 300 × $0.0083 | — | $2.49 |
| Carrier pass-through, 300 × $0.0035–0.0045 (AT&T $0.0035; T-Mobile/Verizon $0.0045 — post-2026-01-19 rates) | — | $1.05–1.35 |
| Inbound replies (OTP entry is web, so just STOP/HELP/START) @ ~$0.0083 | — | ~$0.05 |
| **Total** | **~$20 (credit)** | **≈ $5.75–6.05** |

*(All prices from Twilio's US pricing page, fetched 2026-07-10.)* Guardrails: every message engineered to one GSM-7 segment (property-tested); worst-case burst tick capped at 8 messages ≈ $0.10; coalescing caps steady-state at ≤1 text/person/tick; $15/mo usage trigger emails Josh well before anything runs away. **Fallback route delta** (10DLC Sole Prop): +$19–20.50 one-time; monthly becomes ~$7 ($1.15 number + $2 campaign + same usage). Kill switch drops recurring cost to the $2.15 number floor; releasing the number reaches $0.

---

## 10. Risks & mitigations

| Risk | Mitigation |
|---|---|
| **TFV rejection/delay for EIN-less sole prop** — Twilio's changelog lets filers genuinely without an EIN mark it unavailable, but that path gets extra vetting; Bandwidth/Telgorithm report approval "not guaranteed" *(as of 2026-01)* | $0 sunk on rejection; same-code 10DLC SP fallback (runbook step 6); phases 2–4 merge inert regardless. Honest framing: **code this week; first friend-facing text in ~1–2 weeks** |
| **~2-week dead window** — no US SMS until verification (trial equally blocked, error 30034) | Phase order absorbs it: registration is Phase 1, code proceeds in parallel |
| **Silent SMS-channel failure** — SMS errors are deliberately swallowed; per-set errors already invisible (main.py:161–168; workflow reddens only if ALL sets fail) | Startup enabled/disabled log; `_sms` outcome counts in the snapshot; admin email via existing `send_bug_report` after 3 consecutive failures (≤1/day); $15 usage trigger catches the inverse (runaway spend) |
| **Actions cache eviction re-alert storm** (monitor.yml:31–37) — per-message billing meets a full re-alert burst | Coalescing (≤1/person/tick) + `MAX_SMS_PER_TICK=8` ⇒ worst tick ≈ $0.10; email carries the full list |
| **Duplicate SMS on partial failure** — email-then-crash before `state.save` re-fires both channels next tick (same at-least-once semantics email has today) | Accepted: rare, bounded to one duplicate per incident, pennies; a duplicate tee-time text is annoying, not harmful |
| **Carrier filtering of `workers.dev` links** | Direct provider booking links preferred (declared in TFV samples — lowest-risk option); ladder falls back to the stable WORKER_URL; escape hatches: custom domain, or link-less bodies ("details in email"). Watch delivery status in Phase 5 |
| **Phone PII lifecycle** — `sms:<email>` outlives account deletion | By design (5-yr TCPA consent retention), disclosed in `privacy.html`; the routable `phone:<e164>` key is deleted on every opt-out path; open question #3 offers a phone-nulling variant |
| **KV eventual consistency / 5-min tick lag on UI opt-out** | Carrier STOP is instant regardless; UI-toggle lag ≤1 tick, orders of magnitude inside the 10-business-day FCC bound |
| **Dual-homed Twilio creds rotation drift** | Exact precedent is `RUNNER_SECRET`; README documents the two-step rotation |
| **Mirror creep** | SMS composition lives only in `sms.py` (imports notify's helpers); phone regex is the single acknowledged client/server pair; **no SMS preview UI, ever** |
| **Copy-the-wrong-pattern hazard** | The unauthenticated `POST /api/dispatch` quirk (worker.js:26–29) must not be replicated: every new endpoint here is session-gated or `RUNNER_SECRET`-gated |

## Open questions for Josh

1. **Sole-prop filing comfort:** TFV uses your personal name + home address as the business identity. OK? And if TFV rejects, should the 10DLC SP fallback (~$19–20.50 one-time, OTP to your mobile) proceed automatically or wait for your go-ahead?
2. **PII retention:** keep the full phone number in `sms:<email>` ≥5 years post-deletion (strongest TCPA audit posture, as planned and disclosed), or null the phone on admin deletion and keep only the consent/opt-out event log?
3. **Spend guardrails:** is the alert-only $15/mo usage trigger + 8/tick cap enough, or do you want a hard monthly cap enforced by the runner (e.g. `SDGOLF_SMS_MONTHLY_CAP`)?
4. **Future message types:** stay digest-only, or add the autobook notice (owner-only) as the first SMS fast-follow?
5. **Custom domain:** pre-register one for booking-link fallback resilience, or wait for evidence of `workers.dev` filtering in Phase 5?
