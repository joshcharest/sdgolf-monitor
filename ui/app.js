// sdgolf-monitor UI — static SPA that talks to the Cloudflare Worker.
//
// One module, no framework, no build step. State held in module-level vars;
// views rendered by cloning <template> elements. Auth is an HttpOnly session
// cookie set by the Worker on login/signup, so no tokens live in localStorage.

import { TEESHEETS, BOOKING_CLASSES } from "./schema.js";

const ROOT = document.getElementById("root");
const NEW_BTN = document.getElementById("new-btn");
const ADMIN_BTN = document.getElementById("admin-btn");
const SIGNOUT_BTN = document.getElementById("signout-btn");
const USER_BADGE = document.getElementById("user-badge");
const TOAST = document.getElementById("toast");
const BUG_FAB = document.getElementById("bug-fab");

// Ring buffer of recent client-side log entries (errors, warnings, uncaught
// exceptions, unhandled promise rejections). Attached to bug reports so we
// get some forensic context with each submission.
const LOG_BUFFER = [];
const LOG_BUFFER_MAX = 100;

function captureLog(level, args) {
  try {
    const msg = Array.from(args).map(a => {
      if (a instanceof Error) return `${a.name}: ${a.message}\n${a.stack || ""}`;
      if (typeof a === "object") { try { return JSON.stringify(a); } catch { return String(a); } }
      return String(a);
    }).join(" ");
    LOG_BUFFER.push({ ts: new Date().toISOString(), level, msg });
    if (LOG_BUFFER.length > LOG_BUFFER_MAX) LOG_BUFFER.shift();
  } catch { /* swallow */ }
}

const _origError = console.error;
console.error = function(...args) { captureLog("error", args); _origError.apply(console, args); };
const _origWarn = console.warn;
console.warn  = function(...args) { captureLog("warn",  args); _origWarn.apply(console,  args); };
window.addEventListener("error", (e) => captureLog("uncaught", [e.message, `${e.filename}:${e.lineno}:${e.colno}`]));
window.addEventListener("unhandledrejection", (e) => captureLog("unhandled-promise", [String(e.reason)]));

// In-memory cache of configs we've loaded this session: id → cfg object
const CACHE = new Map();
let USER = null;  // { email } once signed in
let LIST_FILTER = "mine";  // "mine" | "others" — persists across renderList calls
let USER_ORDER = [];       // per-user ordering for "mine" tab; refreshed in renderList
let CURRENT_VIEW = "boot";  // updated on each render — included in bug reports

// ----- Toast -------------------------------------------------------------

let toastTimer = null;
function toast(msg, kind = "info") {
  TOAST.textContent = msg;
  TOAST.className = kind === "error" ? "error" : "";
  TOAST.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { TOAST.hidden = true; }, kind === "error" ? 6000 : 3000);
}

// ----- API ---------------------------------------------------------------

async function api(method, path, body) {
  const opts = {
    method,
    credentials: "same-origin",  // include cookies
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  };
  const resp = await fetch(path, opts);
  if (!resp.ok) {
    let parsed = {};
    try { parsed = await resp.json(); } catch { /* ignore */ }
    const err = new Error(parsed.error || `${method} ${path} → HTTP ${resp.status}`);
    err.status = resp.status;
    throw err;
  }
  if (resp.status === 204) return null;
  return resp.json();
}

const apiMe        = ()                  => api("GET",    "/api/me");
const apiLogin     = (email, password)   => api("POST",   "/api/auth/login",  { email, password });
const apiSignup    = (email, password)   => api("POST",   "/api/auth/signup", { email, password });
const apiLogout    = ()                  => api("POST",   "/api/auth/logout");
const apiListConfigs   = ()              => api("GET",    "/api/configs");
const apiCreateConfig  = (cfg)           => api("POST",   "/api/configs", cfg);
const apiUpdateConfig  = (id, cfg)       => api("PUT",    `/api/configs/${id}`, cfg);
const apiDeleteConfig  = (id)            => api("DELETE", `/api/configs/${id}`);
const apiSubscribe     = (id)            => api("POST",   `/api/configs/${id}/subscribe`);
const apiUnsubscribe   = (id)            => api("POST",   `/api/configs/${id}/unsubscribe`);
const apiAdminGetEmails = ()             => api("GET",    "/api/admin/emails");
const apiAdminPutEmails = (emails)       => api("PUT",    "/api/admin/emails", { emails });
const apiAdminGetUsers  = ()             => api("GET",    "/api/admin/users");
const apiAdminResetUser = (email)        => api("DELETE", `/api/admin/users/${encodeURIComponent(email)}`);
const apiBugReport      = (payload)      => api("POST",   "/api/bug-report", payload);
const apiBookNow        = (payload)      => api("POST",   "/api/book/now", payload);
const apiGetUserOrder   = ()             => api("GET",    "/api/me/order");
const apiPutUserOrder   = (order)        => api("PUT",    "/api/me/order", { order });

// Fire-and-forget: tell the Worker to dispatch the monitor workflow right
// now so the snapshot reflects this config mutation within ~30s instead of
// waiting up to 5 minutes for the next cron tick.
function triggerDispatch() {
  fetch("/api/dispatch", { method: "POST" })
    .then(r => { if (!r.ok) console.warn(`/api/dispatch ${r.status}`); })
    .catch(e => console.warn("/api/dispatch", e));
}

// ----- Views -------------------------------------------------------------

function setNav({ showNew = false } = {}) {
  NEW_BTN.hidden = !showNew;
  ADMIN_BTN.hidden = !(USER && USER.is_admin && showNew);
  SIGNOUT_BTN.hidden = !USER;
  USER_BADGE.hidden = !USER;
  BUG_FAB.hidden = !USER;
  if (USER) USER_BADGE.textContent = USER.email;
}

function renderAuth() {
  USER = null;
  CACHE.clear();
  CURRENT_VIEW = "auth";
  ROOT.innerHTML = "";
  const view = document.getElementById("auth-view").content.cloneNode(true);
  ROOT.appendChild(view);
  setNav({ showNew: false });

  const loginForm = document.getElementById("login-form");
  const signupForm = document.getElementById("signup-form");
  const err = document.getElementById("auth-error");

  for (const tab of document.querySelectorAll(".auth-tab")) {
    tab.addEventListener("click", () => {
      for (const t of document.querySelectorAll(".auth-tab")) t.classList.remove("active");
      tab.classList.add("active");
      const which = tab.dataset.tab;
      loginForm.hidden = which !== "login";
      signupForm.hidden = which !== "signup";
      err.hidden = true;
    });
  }

  loginForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    err.hidden = true;
    const fd = new FormData(loginForm);
    try {
      const r = await apiLogin(fd.get("email").trim().toLowerCase(), fd.get("password"));
      USER = r;
      toast(`Signed in as ${r.email}`);
      renderList();
    } catch (e2) {
      err.textContent = e2.message;
      err.hidden = false;
    }
  });

  signupForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    err.hidden = true;
    const fd = new FormData(signupForm);
    try {
      const r = await apiSignup(
        fd.get("email").trim().toLowerCase(),
        fd.get("password"),
      );
      USER = r;
      toast(`Welcome, ${r.email}`);
      renderList();
    } catch (e2) {
      err.textContent = e2.message;
      err.hidden = false;
    }
  });
}

async function renderList() {
  CURRENT_VIEW = "list";
  ROOT.innerHTML = "<p class='loading'>Loading subscriptions…</p>";
  setNav({ showNew: true });

  let configs;
  try {
    configs = await apiListConfigs();
  } catch (e) {
    if (e.status === 401) return renderAuth();
    ROOT.innerHTML = `<p class='error'>Failed to load subscriptions: ${e.message}</p>`;
    return;
  }

  const view = document.getElementById("list-view").content.cloneNode(true);
  ROOT.innerHTML = "";
  ROOT.appendChild(view);

  const snapshot = await loadSnapshot();
  renderSnapshotMeta(snapshot);
  renderBookings(snapshot?.reservations);
  const setsById = snapshot?.sets || {};

  // Load the user's preferred ordering; absent or stale ids fall through to
  // the alpha bucket below in sortMine.
  try {
    const { order } = await apiGetUserOrder();
    USER_ORDER = Array.isArray(order) ? order : [];
  } catch { USER_ORDER = []; }

  for (const cfg of configs) CACHE.set(cfg.id, cfg);

  // Wire tabs once after the view is mounted.
  for (const tab of document.querySelectorAll(".list-tab")) {
    tab.addEventListener("click", () => {
      LIST_FILTER = tab.dataset.filter;
      renderTabCards(configs, setsById);
    });
  }

  renderTabCards(configs, setsById);
}

function renderTabCards(configs, setsById) {
  const mine = configs.filter(c => c.owner === USER.email);
  const others = configs.filter(c => c.owner !== USER.email);

  // Update tab labels with counts; mark the active one.
  const mineTab = document.querySelector('.list-tab[data-filter="mine"]');
  const othersTab = document.querySelector('.list-tab[data-filter="others"]');
  mineTab.textContent = `My subscriptions (${mine.length})`;
  othersTab.textContent = `Other subscriptions (${others.length})`;
  mineTab.classList.toggle("active", LIST_FILTER === "mine");
  othersTab.classList.toggle("active", LIST_FILTER === "others");

  const visible = LIST_FILTER === "mine"
    ? sortMine(mine)
    : others.slice().sort((a, b) => a.name.localeCompare(b.name));

  const cardsEl = document.getElementById("cards");
  cardsEl.innerHTML = "";
  for (const cfg of visible) cardsEl.appendChild(renderCard(cfg, setsById[cfg.id]));

  // Drag-reorder only applies to the "mine" tab, since the order is
  // per-user and there's no notion of ordering subscriptions you don't own.
  if (LIST_FILTER === "mine" && visible.length > 1) {
    enableReorder(cardsEl);
  }

  const emptyEl = document.getElementById("cards-empty");
  if (visible.length === 0) {
    emptyEl.textContent = LIST_FILTER === "mine"
      ? "No subscriptions yet — click ＋ New subscription to create one."
      : "No one else has shared a subscription yet.";
    emptyEl.hidden = false;
  } else {
    emptyEl.hidden = true;
  }
}

// Apply the stored ordering for "mine": configs present in USER_ORDER come
// first in that order, anything else (newly created, never reordered) gets
// alpha-sorted at the end. Avoids the "I made a new sub and it jumped to
// the top because it isn't in the saved list" surprise.
function sortMine(configs) {
  const orderIdx = new Map(USER_ORDER.map((id, i) => [id, i]));
  const ordered = [];
  const rest = [];
  for (const cfg of configs) {
    if (orderIdx.has(cfg.id)) ordered.push(cfg);
    else rest.push(cfg);
  }
  ordered.sort((a, b) => orderIdx.get(a.id) - orderIdx.get(b.id));
  rest.sort((a, b) => a.name.localeCompare(b.name));
  return [...ordered, ...rest];
}

// Native HTML5 drag-and-drop. Each card becomes draggable; the dragover
// handler reorders the DOM live so the user sees the new position before
// committing. Persistence happens on dragend so we react to *any* end of
// drag (including ESC / drop outside) — `drop` would miss the dropped-on-
// nothing case and leave the DOM out of sync with the backend.
function enableReorder(container) {
  let dragged = null;
  for (const card of container.querySelectorAll(".check-card")) {
    card.draggable = true;
    card.addEventListener("dragstart", (e) => {
      dragged = card;
      card.classList.add("dragging");
      // dataTransfer.setData is required for drop to fire in some browsers.
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", card.dataset.cfgId || "");
    });
    card.addEventListener("dragend", async () => {
      card.classList.remove("dragging");
      dragged = null;
      const ids = [...container.querySelectorAll(".check-card")]
        .map(c => c.dataset.cfgId)
        .filter(Boolean);
      // The visible "mine" list can be a subset of USER_ORDER if not every
      // owned config has been ordered yet — diff against ids that were
      // actually shown so we don't false-positive an unchanged drag.
      const shown = ids.join("|");
      const wasShown = [...USER_ORDER, ...ids.filter(i => !USER_ORDER.includes(i))]
        .filter(i => ids.includes(i)).join("|");
      if (shown === wasShown) return;
      const prev = USER_ORDER.slice();
      USER_ORDER = ids;
      try {
        await apiPutUserOrder(ids);
      } catch (e) {
        USER_ORDER = prev;
        toast(`Could not save order: ${e.message}`, "error");
        renderList();
      }
    });
    card.addEventListener("dragover", (e) => {
      if (!dragged || dragged === card) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const r = card.getBoundingClientRect();
      const after = (e.clientY - r.top) > r.height / 2;
      card.parentNode.insertBefore(dragged, after ? card.nextSibling : card);
    });
    card.addEventListener("drop", (e) => { e.preventDefault(); });
  }
}

async function loadSnapshot() {
  try {
    const resp = await fetch("/api/snapshot", { cache: "no-store" });
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
}

// Upcoming bookings come from the runner's authenticated ForeUp session, so
// they only apply to whichever account the runner logs in as. Show them
// only to admins — non-admin viewers would see someone else's tee times
// and that'd be confusing.
function renderBookings(reservations) {
  const section = document.getElementById("bookings-section");
  if (!section) return;
  const list = section.querySelector(".bookings-list");
  const count = section.querySelector(".bookings-count");
  list.innerHTML = "";
  if (!USER?.is_admin || !Array.isArray(reservations) || reservations.length === 0) {
    section.hidden = true;
    return;
  }
  count.textContent = `(${reservations.length})`;
  for (const r of reservations) {
    const li = document.createElement("li");
    li.className = "booking-row";
    li.append(
      mkSpan("booking-when", `${formatDate(r.date)} · ${fmt12h(r.time)}`),
      mkSpan("booking-course", r.course),
      mkSpan("booking-meta", `${r.players}p · ${r.holes}h`),
    );
    list.appendChild(li);
  }
  section.hidden = false;
}

function renderSnapshotMeta(snapshot) {
  const meta = document.getElementById("snapshot-meta");
  if (!meta) return;
  if (!snapshot?.generated_at) {
    meta.textContent = "No snapshot yet — waiting for first cron run";
    return;
  }
  meta.textContent = `Tee times updated ${relativeTime(snapshot.generated_at)} · ${fmtClock(snapshot.generated_at)}`;
}

function fmtClock(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function relativeTime(iso) {
  const then = new Date(iso).getTime();
  const sec = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} hr ago`;
  return `${Math.round(hr / 24)} d ago`;
}

function renderCard(cfg, snapshotEntry) {
  const node = document.getElementById("card").content.cloneNode(true);
  const article = node.querySelector("article");
  article.dataset.cfgId = cfg.id;
  article.querySelector(".card-name").textContent = cfg.name;
  const ownerEl = article.querySelector(".card-owner");
  ownerEl.textContent = cfg.owner === USER.email ? "yours" : `by ${cfg.owner}`;
  ownerEl.classList.toggle("mine", cfg.owner === USER.email);

  const enabled = cfg.enabled !== false;
  if (!enabled) article.classList.add("disabled");

  // Non-owners get a read-only badge when autobook is on; owners get the
  // segmented Off/Alert/Auto control wired up below.
  const isOwner = cfg.owner === USER.email;
  if (!isOwner && cfg.autobook?.enabled) {
    article.querySelector(".card-autobook-badge").hidden = false;
  }
  const editBtn = article.querySelector(".edit-btn");
  const subscribeBtn = article.querySelector(".subscribe-btn");
  const modeGroup = article.querySelector(".card-mode");

  if (isOwner) {
    editBtn.hidden = false;
    editBtn.addEventListener("click", () => renderEdit(cfg.id));
    setupModeControl(article, modeGroup, cfg);
  } else {
    subscribeBtn.hidden = false;
    const subscribed = (cfg.subscribers || []).includes(USER.email);
    subscribeBtn.textContent = subscribed ? "Unsubscribe" : "Subscribe";
    subscribeBtn.classList.toggle("subscribed", subscribed);
    subscribeBtn.addEventListener("click", async () => {
      subscribeBtn.disabled = true;
      try {
        const updated = (subscribed ? await apiUnsubscribe(cfg.id) : await apiSubscribe(cfg.id));
        CACHE.set(cfg.id, updated);
        toast(subscribed ? `Unsubscribed from ${cfg.name}` : `Subscribed to ${cfg.name}`);
        renderList();
      } catch (e) {
        toast(`Could not ${subscribed ? "unsubscribe" : "subscribe"}: ${e.message}`, "error");
        subscribeBtn.disabled = false;
      }
    });
  }

  // Each course on its own line — no truncation, no wrapping mid-name.
  const targetsEl = article.querySelector(".card-targets");
  const targets = cfg.targets || [];
  targetsEl.replaceChildren(
    ...(targets.length ? targets : [{ name: "(none)" }]).map(t => {
      const div = document.createElement("div");
      div.textContent = t.name;
      return div;
    })
  );

  const d = cfg.dates || {};
  const start = formatDate(d.start) || "?";
  const end = formatDate(d.end) || "?";
  article.querySelector(".card-dates").textContent = start === end ? start : `${start} – ${end}`;

  const f = cfg.filter || {};
  const holesStr = String(Array.isArray(f.holes) ? f.holes.join(" + ") : (f.holes ?? 18));
  const playersStr = `≥${f.min_players ?? 1}p`;
  const windowsStr = (f.windows || []).map(w => `${fmt12h(w.start)}–${fmt12h(w.end)}`).join(" · ") || "any time";
  article.querySelector(".card-filter").textContent = `${holesStr} · ${playersStr} · ${windowsStr}`;

  renderCardMatches(article, cfg, snapshotEntry);
  return node;
}

// Three-state segmented control for the card header: Off / Alert / Auto.
// Maps to (enabled, autobook.enabled) so a single click expresses the user
// intent without forcing them to reason about two toggles. The Auto pill is
// admin-only; non-admins see just Off / Alert.
function setupModeControl(article, group, cfg) {
  group.hidden = false;
  const autoBtn = group.querySelector('[data-mode="auto"]');
  if (USER?.is_admin) autoBtn.hidden = false;

  const currentMode = () => {
    if (cfg.enabled === false) return "off";
    return cfg.autobook?.enabled ? "auto" : "alert";
  };
  const paint = (mode) => {
    for (const btn of group.querySelectorAll(".seg")) {
      btn.classList.toggle("active", btn.dataset.mode === mode);
    }
    article.classList.toggle("disabled", mode === "off");
  };
  paint(currentMode());

  group.addEventListener("click", async (e) => {
    const btn = e.target.closest(".seg");
    if (!btn || btn.hidden || btn.disabled) return;
    const mode = btn.dataset.mode;
    const prev = currentMode();
    if (prev === mode) return;
    paint(mode);  // optimistic
    for (const b of group.querySelectorAll(".seg")) b.disabled = true;
    const cached = CACHE.get(cfg.id) || cfg;
    const next = {
      ...cached,
      enabled: mode !== "off",
      autobook: { enabled: mode === "auto" },
    };
    try {
      const saved = await apiUpdateConfig(cfg.id, next);
      CACHE.set(saved.id, saved);
      // Mutate the cfg the closure captured so re-clicks use fresh state.
      cfg.enabled = saved.enabled;
      cfg.autobook = saved.autobook;
      triggerDispatch();
      toast(`${cfg.name}: ${MODE_LABEL[mode]}`);
    } catch (err) {
      paint(prev);
      toast(`Could not change mode: ${err.message}`, "error");
    } finally {
      for (const b of group.querySelectorAll(".seg")) b.disabled = false;
    }
  });
}

const MODE_LABEL = { off: "off", alert: "alerts on", auto: "auto-book on" };

function renderCardMatches(article, cfg, entry) {
  const wrapper = article.querySelector(".card-matches");
  const summary = article.querySelector(".card-matches-summary");
  const list = article.querySelector(".card-matches-list");

  if (!entry) {
    summary.textContent = "no data yet";
    summary.classList.add("dim");
    return;
  }
  if (entry.error) {
    summary.textContent = `error: ${entry.error}`;
    summary.classList.add("err");
    return;
  }
  if (entry.enabled === false) {
    summary.textContent = "disabled";
    summary.classList.add("dim");
    return;
  }
  const matches = entry.matches || [];
  if (matches.length === 0) {
    summary.textContent = "0 matches";
    summary.classList.add("dim");
    const li = document.createElement("li");
    li.className = "none";
    li.textContent = "None";
    list.appendChild(li);
    wrapper.hidden = false;
    return;
  }
  summary.textContent = `${matches.length} match${matches.length === 1 ? "" : "es"}`;
  summary.classList.add("hit");

  // Group by course, then by date. Each day starts collapsed; clicking the
  // day row expands the times inline.
  const grouped = new Map();
  for (const m of matches) {
    if (!grouped.has(m.target)) grouped.set(m.target, new Map());
    const byDate = grouped.get(m.target);
    if (!byDate.has(m.date)) byDate.set(m.date, []);
    byDate.get(m.date).push(m);
  }
  for (const byDate of grouped.values()) {
    for (const arr of byDate.values()) arr.sort((a, b) => a.time.localeCompare(b.time));
  }

  // Per-slot "Book" button only for admins on their own configs — same
  // gating as the worker's /api/book/now endpoint, so showing it elsewhere
  // would render a broken control.
  const onBook = (USER?.is_admin && cfg.owner === USER.email)
    ? async (m) => apiBookNow({
        config_id: cfg.id,
        target: m.target,
        date: m.date,
        time: m.time,
        holes: m.holes,
        players: Math.max(1, Math.min(4, m.available_spots || 4)),
      })
    : null;

  const sortedCourses = [...grouped.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (const [course, byDate] of sortedCourses) {
    const header = document.createElement("li");
    header.className = "match-course-header";
    header.textContent = course;
    list.appendChild(header);

    const sortedDates = [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    for (const [date, dateMatches] of sortedDates) {
      list.appendChild(buildDayRow(date, dateMatches, onBook));
    }
  }
  wrapper.hidden = false;
}

function buildDayRow(date, dayMatches, onBook) {
  const li = document.createElement("li");
  li.className = "match-day-row";

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "match-day-toggle";
  toggle.append(
    mkSpan("match-day-label", `${formatDate(date)} · ${dayMatches.length} time${dayMatches.length === 1 ? "" : "s"}`),
    mkSpan("match-day-chevron", "▶"),
  );

  const times = document.createElement("ul");
  times.className = "match-times-list";
  times.hidden = true;
  for (const m of dayMatches) times.appendChild(buildTimeLi(m, onBook));

  toggle.addEventListener("click", () => {
    const expanded = !times.hidden;
    times.hidden = expanded;
    toggle.classList.toggle("expanded", !expanded);
    toggle.querySelector(".match-day-chevron").textContent = expanded ? "▶" : "▼";
  });

  li.append(toggle, times);
  return li;
}

function buildTimeLi(m, onBook) {
  const li = document.createElement("li");

  const row = document.createElement("div");
  row.className = "match-row";

  const link = document.createElement("a");
  link.className = "match-link match-time";
  link.href = bookingUrl(m);
  link.target = "_blank";
  link.rel = "noopener";

  const primary = document.createElement("div");
  primary.className = "match-time-primary";
  primary.append(mkSpan("match-when", fmt12h(m.time)));

  const rate = residentRate(m.target, m.green_fee);
  const fee = rate == null ? null : `$${rate % 1 === 0 ? rate : rate.toFixed(2)}`;
  let bf = null;
  if (hasAdvancedBookingFee(m)) {
    const amount = ADVANCED_BOOKING_FEE[m.target];
    bf = amount != null ? `+ $${amount} Advanced Booking Fee` : "+ Advanced Booking Fee";
  }
  const money = [fee, bf].filter(Boolean).join(" ");
  const metaParts = [`${m.available_spots}p`, `${m.holes}`, money].filter(Boolean);
  const meta = document.createElement("div");
  meta.className = "match-meta";
  meta.textContent = metaParts.join(" · ");

  link.append(primary, meta);
  row.appendChild(link);

  if (onBook) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "match-book-btn";
    btn.textContent = "Book";
    btn.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!confirm(`Book ${fmt12h(m.time)} at ${m.target}?`)) return;
      btn.disabled = true;
      btn.textContent = "Booking…";
      try {
        const result = await onBook(m);
        btn.textContent = result?.dry_run ? "Booked (dry)" : "Booked";
        toast(result?.dry_run
          ? `Booked ${fmt12h(m.time)} ${m.target} (dry run)`
          : `Booked ${fmt12h(m.time)} ${m.target}`);
      } catch (err) {
        btn.disabled = false;
        btn.textContent = "Book";
        toast(`Book failed: ${err.message}`, "error");
      }
    });
    row.appendChild(btn);
  }

  li.appendChild(row);
  return li;
}

function bookingUrl(m) {
  const ts = TEESHEETS.find(t => t.label === m.target);
  const bookingClass = m.booking_fee ? 51735 : 929;
  const facility = ts?.facility ?? 19348;
  const base = `https://foreupsoftware.com/index.php/booking/${facility}/${bookingClass}`;
  if (!ts || !/^\d{4}-\d{2}-\d{2}$/.test(m.date)) return `${base}#/teetimes`;
  const [y, mo, d] = m.date.split("-");
  return `${base}?date=${mo}-${d}-${y}&schedule_id=${ts.id}#/teetimes`;
}

function mkSpan(cls, text) {
  const s = document.createElement("span");
  s.className = cls;
  s.textContent = text;
  return s;
}

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function formatDate(spec) {
  if (typeof spec !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(spec)) return spec;
  const [y, m, d] = spec.split("-").map(Number);
  const dow = DOW[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${dow} ${m}/${d}`;
}

// Map ForeUp's published (non-resident) green-fee to the SD City Resident
// equivalent, per course. Source: sandiegocitygolf.com rate cards (2026).
const RATE_MAP = {
  "Balboa Park 18": {
    56.50: 39.50,   // weekday 18
    71:    49,      // weekend 18
    34:    25,      // weekday 18 twilight
    43:    30,      // weekend 18 twilight
    39:    35,      // weekday 18 junior
    25.50: 18,      // weekday 9
    32:    24,      // weekend 9
    19.50: 17,      // weekday 9 junior
  },
  "Balboa Park 9": {
    25.50: 18, 32: 24, 19.50: 17,
  },
  "Torrey Pines South": {
    258: 73, 180: 73, 156: 44, 322: 90, 194: 54,
  },
  "Torrey Pines North": {
    163: 51, 114: 51, 97: 33, 204: 68, 123: 39,
  },
};

function residentRate(target, nonResident) {
  if (typeof nonResident !== "number") return null;
  return RATE_MAP[target]?.[nonResident] ?? null;
}

const ADVANCED_BOOKING_FEE = {
  "Balboa Park 18":     10,
  "Balboa Park 9":      10,
  "Torrey Pines South": 32,
  "Torrey Pines North": 32,
};

function hasAdvancedBookingFee(m) {
  if (typeof m.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(m.date)) {
    return Boolean(m.booking_fee);
  }
  const [y, mo, d] = m.date.split("-").map(Number);
  const slot = Date.UTC(y, mo - 1, d);
  const today = new Date();
  const todayUtc = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  const days = Math.round((slot - todayUtc) / 86400000);
  return days >= 8;
}

function fmt12h(t) {
  if (typeof t !== "string") return t;
  const m = t.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return t;
  let h = parseInt(m[1], 10);
  const min = m[2];
  const period = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return min === "00" ? `${h} ${period}` : `${h}:${min} ${period}`;
}

// ----- Edit view ---------------------------------------------------------

function renderEdit(existingId) {
  const cached = existingId ? CACHE.get(existingId) : null;
  if (existingId && !cached) {
    toast("Could not find that subscription", "error");
    return renderList();
  }
  if (cached && cached.owner !== USER.email) {
    toast("You can only edit your own subscriptions", "error");
    return renderList();
  }

  const cfg = cached || {
    enabled: true,
    targets: [],
    dates: { start: "today", end: "today+90" },
    filter: { holes: 18, min_players: 2, windows: [{ start: "07:00", end: "11:00", weekdays: ["sat", "sun"] }] },
  };

  CURRENT_VIEW = existingId ? `edit:${existingId}` : "edit:new";
  ROOT.innerHTML = "";
  const view = document.getElementById("edit-view").content.cloneNode(true);
  ROOT.appendChild(view);
  setNav({ showNew: false });

  const isNew = !existingId;
  document.getElementById("edit-title").textContent = isNew ? "New subscription" : `Edit ${cfg.name}`;

  const form = document.getElementById("edit-form");
  form.elements["name"].value = cfg.name || "";
  form.elements["enabled"].checked = cfg.enabled !== false;
  form.elements["holes"].value = holesToSelectValue(cfg.filter?.holes);
  form.elements["min-players"].value = cfg.filter?.min_players ?? 2;

  setupTargets(cfg.targets || []);
  setupDateInput(form, "start", cfg.dates?.start || "today");
  setupDateInput(form, "end", cfg.dates?.end || "today+90");

  const windowsList = document.getElementById("windows-list");
  for (const w of cfg.filter?.windows || []) windowsList.appendChild(buildWindowRow(w));
  document.getElementById("add-window").addEventListener("click", () => {
    windowsList.appendChild(buildWindowRow({ start: "07:00", end: "11:00", weekdays: [] }));
  });

  if (USER?.is_admin) {
    const ab = document.getElementById("autobook-fieldset");
    ab.hidden = false;
    form.elements["autobook-enabled"].checked = Boolean(cfg.autobook?.enabled);
  }

  document.getElementById("cancel-btn").addEventListener("click", () => renderList());

  const deleteBtn = document.getElementById("delete-btn");
  if (!isNew) {
    deleteBtn.hidden = false;
    deleteBtn.addEventListener("click", async () => {
      if (!confirm(`Delete subscription "${cfg.name}"?`)) return;
      try {
        await apiDeleteConfig(existingId);
        CACHE.delete(existingId);
        triggerDispatch();
        toast(`Deleted ${cfg.name}`);
        renderList();
      } catch (e) {
        toast(`Delete failed: ${e.message}`, "error");
      }
    });
  }

  const errEl = document.getElementById("edit-error");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errEl.hidden = true;
    const submitBtn = form.querySelector("button[type=submit]");
    try {
      const newCfg = readForm(form);
      submitBtn.disabled = true;
      submitBtn.textContent = "Saving…";
      const saved = isNew
        ? await apiCreateConfig(newCfg)
        : await apiUpdateConfig(existingId, newCfg);
      CACHE.set(saved.id, saved);
      triggerDispatch();
      toast(`Saved ${saved.name}`);
      renderList();
    } catch (e2) {
      errEl.textContent = `Save failed: ${e2.message}`;
      errEl.hidden = false;
      submitBtn.disabled = false;
      submitBtn.textContent = "Save";
    }
  });
}

function setupTargets(targets) {
  const knownIds = new Set(TEESHEETS.map(ts => ts.id));
  const selectedIds = new Set(targets.map(t => t.teesheet_id).filter(id => knownIds.has(id)));

  const grid = document.getElementById("courses-grid");
  for (const ts of TEESHEETS) {
    const node = document.getElementById("course-option").content.cloneNode(true);
    const cb = node.querySelector("input");
    cb.value = ts.id;
    cb.checked = selectedIds.has(ts.id);
    node.querySelector(".course-label").textContent = ts.label;
    grid.appendChild(node);
  }

  const bcCounts = new Map();
  for (const t of targets) bcCounts.set(t.booking_class, (bcCounts.get(t.booking_class) || 0) + 1);
  const dominantBc = [...bcCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 929;
  if (bcCounts.size > 1) {
    toast("Note: this set had mixed booking classes; the most common one is selected for all courses", "info");
  }

  const bcSel = document.getElementById("booking-class");
  for (const bc of BOOKING_CLASSES) {
    const opt = document.createElement("option");
    opt.value = bc.id; opt.textContent = bc.label;
    bcSel.appendChild(opt);
  }
  bcSel.appendChild(Object.assign(document.createElement("option"), { value: "custom", textContent: "Custom…" }));
  const bcCustom = document.getElementById("booking-class-custom");
  if (BOOKING_CLASSES.some(bc => bc.id === dominantBc)) {
    bcSel.value = String(dominantBc);
  } else {
    bcSel.value = "custom"; bcCustom.value = dominantBc; bcCustom.hidden = false;
  }
  bcSel.addEventListener("change", () => { bcCustom.hidden = bcSel.value !== "custom"; });
}

function setupDateInput(form, which, spec) {
  const modeSel = form.elements[`date-${which}-mode`];
  const relativeInput = form.elements[`date-${which}-relative`];
  const specificInput = form.elements[`date-${which}-specific`];

  const isIso = /^\d{4}-\d{2}-\d{2}$/.test(spec);
  if (isIso) {
    modeSel.value = "specific";
    specificInput.value = spec;
  } else {
    modeSel.value = "relative";
    relativeInput.value = spec || (which === "start" ? "today" : "today+90");
  }
  applyDateMode(modeSel, relativeInput, specificInput);
  modeSel.addEventListener("change", () => applyDateMode(modeSel, relativeInput, specificInput));
}

function applyDateMode(modeSel, relativeInput, specificInput) {
  const isSpecific = modeSel.value === "specific";
  relativeInput.hidden = isSpecific;
  specificInput.hidden = !isSpecific;
}

function buildWindowRow(w) {
  const node = document.getElementById("window-row").content.cloneNode(true);
  node.querySelector(".w-start").value = w.start || "07:00";
  node.querySelector(".w-end").value = w.end || "11:00";
  const wd = new Set(w.weekdays || []);
  for (const cb of node.querySelectorAll(".weekdays input")) {
    cb.checked = wd.has(cb.value);
  }
  node.querySelector(".w-del").addEventListener("click", (e) => e.target.closest(".window-row").remove());
  return node;
}

function readForm(form) {
  const bcSel = form.querySelector("#booking-class");
  const booking_class = bcSel.value === "custom"
    ? parseInt(form.querySelector("#booking-class-custom").value, 10)
    : parseInt(bcSel.value, 10);
  if (!Number.isFinite(booking_class)) throw new Error("Booking class is required");

  const targets = [];
  for (const cb of form.querySelectorAll('input[name="course"]:checked')) {
    const id = parseInt(cb.value, 10);
    const meta = TEESHEETS.find(ts => ts.id === id);
    targets.push({ name: meta.label, teesheet_id: id, booking_class });
  }
  if (targets.length === 0) throw new Error("Select at least one course");

  const windows = [];
  for (const row of form.querySelectorAll("#windows-list .window-row")) {
    const start = row.querySelector(".w-start").value;
    const end = row.querySelector(".w-end").value;
    if (!start || !end) continue;
    if (start >= end) throw new Error(`Window ${start}–${end}: end must be after start (use 24h time, e.g. 16:00 for 4 PM)`);
    const weekdays = [...row.querySelectorAll(".weekdays input:checked")].map(cb => cb.value);
    const w = { start, end };
    if (weekdays.length > 0) w.weekdays = weekdays;
    windows.push(w);
  }
  if (windows.length === 0) throw new Error("At least one time window is required");

  const dateStart = readDateSpec(form, "start");
  const dateEnd = readDateSpec(form, "end");

  const name = form.elements["name"].value.trim();
  if (!name) throw new Error("Name is required");

  const out = {
    name,
    enabled: form.elements["enabled"].checked,
    targets,
    dates: { start: dateStart, end: dateEnd },
    filter: {
      holes: readHoles(form),
      min_players: parseInt(form.elements["min-players"].value, 10),
      windows,
    },
  };
  // Only admins see the fieldset, so only admins can submit a value. The
  // worker also enforces this on the server, so a tampered request still
  // won't persist autobook for non-admins.
  if (USER?.is_admin) {
    out.autobook = { enabled: form.elements["autobook-enabled"].checked };
  }
  return out;
}

function readHoles(form) {
  const v = form.elements["holes"].value;
  if (v === "both") return [9, 18];
  return parseInt(v, 10);
}

function holesToSelectValue(holes) {
  if (Array.isArray(holes)) {
    const set = new Set(holes.map(h => parseInt(h, 10)));
    if (set.has(9) && set.has(18)) return "both";
    if (set.has(9)) return "9";
    return "18";
  }
  return String(holes ?? 18);
}

function readDateSpec(form, which) {
  const mode = form.elements[`date-${which}-mode`].value;
  if (mode === "specific") {
    const v = form.elements[`date-${which}-specific`].value;
    if (!v) throw new Error(`${which === "start" ? "Start" : "End"} date is required`);
    return v;
  }
  const v = form.elements[`date-${which}-relative`].value.trim();
  if (!v) throw new Error(`${which === "start" ? "Start" : "End"} date is required`);
  if (!/^today(\s*\+\s*\d+)?$/i.test(v)) {
    throw new Error(`${which === "start" ? "Start" : "End"} date '${v}' must be "today" or "today+N"`);
  }
  return v;
}

// ----- Admin view --------------------------------------------------------

async function renderAdmin() {
  if (!USER?.is_admin) return renderList();
  CURRENT_VIEW = "admin";
  ROOT.innerHTML = "<p class='loading'>Loading allowed users…</p>";
  setNav({ showNew: false });

  ROOT.innerHTML = "";
  const view = document.getElementById("admin-view").content.cloneNode(true);
  ROOT.appendChild(view);

  document.getElementById("admin-back").addEventListener("click", () => renderList());

  const addForm = document.getElementById("admin-add-form");
  addForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = addForm.elements["email"];
    const email = (input.value || "").trim().toLowerCase();
    if (!email) return;
    const submitBtn = addForm.querySelector("button[type=submit]");
    submitBtn.disabled = true;
    try {
      const { allowed } = await loadAdminData();
      if (allowed.includes(email)) {
        toast(`${email} is already allowed`);
        input.value = "";
        return;
      }
      await apiAdminPutEmails([...allowed, email]);
      input.value = "";
      toast(`Added ${email}`);
      await refreshAdminList();
    } catch (e2) {
      toast(`Add failed: ${e2.message}`, "error");
    } finally {
      submitBtn.disabled = false;
    }
  });

  await refreshAdminList();
}

async function loadAdminData() {
  const [allowedResp, usersResp] = await Promise.all([apiAdminGetEmails(), apiAdminGetUsers()]);
  return { allowed: allowedResp.emails || [], users: usersResp.emails || [] };
}

async function refreshAdminList() {
  const list = document.getElementById("admin-users-list");
  const empty = document.getElementById("admin-users-empty");
  const err = document.getElementById("admin-error");
  if (!list) return;
  err.hidden = true;
  list.innerHTML = "";
  let allowed, users;
  try {
    ({ allowed, users } = await loadAdminData());
  } catch (e) {
    if (e.status === 401) return renderAuth();
    if (e.status === 403) { toast("Admin access only", "error"); return renderList(); }
    err.textContent = `Failed to load: ${e.message}`;
    err.hidden = false;
    return;
  }

  const union = [...new Set([...allowed, ...users])].sort();
  if (union.length === 0) { empty.hidden = false; return; }
  empty.hidden = true;

  const userSet = new Set(users);
  const allowedSet = new Set(allowed);

  for (const email of union) {
    const li = document.createElement("li");
    li.className = "admin-user-row";

    const main = document.createElement("div");
    main.className = "admin-user-main";

    const span = document.createElement("span");
    span.className = "admin-user-email";
    span.textContent = email;
    main.appendChild(span);

    const badges = document.createElement("div");
    badges.className = "admin-user-badges";
    if (userSet.has(email)) {
      const b = document.createElement("span");
      b.className = "badge badge-account";
      b.textContent = "account";
      badges.appendChild(b);
    } else if (allowedSet.has(email)) {
      const b = document.createElement("span");
      b.className = "badge badge-pending";
      b.textContent = "no account yet";
      badges.appendChild(b);
    }
    if (!allowedSet.has(email)) {
      const b = document.createElement("span");
      b.className = "badge badge-orphan";
      b.textContent = "not on allowlist";
      badges.appendChild(b);
    }
    if (email === USER?.email) {
      const b = document.createElement("span");
      b.className = "badge badge-you";
      b.textContent = "you";
      badges.appendChild(b);
    }
    main.appendChild(badges);

    li.appendChild(main);

    const actions = document.createElement("div");
    actions.className = "admin-user-actions";

    if (userSet.has(email) && email !== USER?.email) {
      const reset = document.createElement("button");
      reset.type = "button";
      reset.className = "danger";
      reset.textContent = "Reset password";
      reset.addEventListener("click", async () => {
        if (!confirm(`Reset password for ${email}? They'll need to sign up again to set a new one.`)) return;
        reset.disabled = true;
        reset.textContent = "Resetting…";
        try {
          await apiAdminResetUser(email);
          toast(`Reset ${email}`);
          await refreshAdminList();
        } catch (e2) {
          reset.disabled = false;
          reset.textContent = "Reset password";
          toast(`Failed: ${e2.message}`, "error");
        }
      });
      actions.appendChild(reset);
    }

    if (allowedSet.has(email) && email !== USER?.email) {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "danger";
      remove.textContent = "Remove";
      remove.addEventListener("click", async () => {
        const had = userSet.has(email);
        const msg = had
          ? `Remove ${email} from the allowlist and sign them out? Their existing account will also be deleted.`
          : `Remove ${email} from the allowlist?`;
        if (!confirm(msg)) return;
        remove.disabled = true;
        remove.textContent = "Removing…";
        try {
          await apiAdminPutEmails(allowed.filter(e => e !== email));
          toast(`Removed ${email}`);
          await refreshAdminList();
        } catch (e2) {
          remove.disabled = false;
          remove.textContent = "Remove";
          toast(`Failed: ${e2.message}`, "error");
        }
      });
      actions.appendChild(remove);
    }

    li.appendChild(actions);
    list.appendChild(li);
  }
}

// ----- Bug-report modal --------------------------------------------------

function openBugModal() {
  if (!USER) return;
  const node = document.getElementById("bug-modal").content.cloneNode(true);
  const backdrop = node.querySelector(".modal-backdrop");
  document.body.appendChild(node);
  const form = document.getElementById("bug-form");
  const err = document.getElementById("bug-error");
  const close = () => backdrop.remove();
  document.getElementById("bug-cancel").addEventListener("click", close);
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    err.hidden = true;
    const submitBtn = form.querySelector("button[type=submit]");
    submitBtn.disabled = true;
    submitBtn.textContent = "Sending…";
    const description = form.elements["description"].value.trim();
    if (!description) {
      err.textContent = "Description required";
      err.hidden = false;
      submitBtn.disabled = false;
      submitBtn.textContent = "Send";
      return;
    }
    try {
      await apiBugReport({
        description,
        view: CURRENT_VIEW,
        url: location.href,
        user_agent: navigator.userAgent,
        logs: LOG_BUFFER.slice(-50),
      });
      close();
      toast("Bug report sent. Thanks!");
    } catch (e2) {
      err.textContent = `Could not send: ${e2.message}`;
      err.hidden = false;
      submitBtn.disabled = false;
      submitBtn.textContent = "Send";
    }
  });
}

// ----- Boot --------------------------------------------------------------

NEW_BTN.addEventListener("click", () => renderEdit(null));
ADMIN_BTN.addEventListener("click", () => renderAdmin());
document.getElementById("brand-link").addEventListener("click", () => {
  if (USER) renderList();
});
BUG_FAB.addEventListener("click", () => openBugModal());
SIGNOUT_BTN.addEventListener("click", async () => {
  if (!confirm("Sign out?")) return;
  try { await apiLogout(); } catch { /* ignore */ }
  renderAuth();
});

(async () => {
  try {
    USER = await apiMe();
    renderList();
  } catch (e) {
    renderAuth();
  }
})();
