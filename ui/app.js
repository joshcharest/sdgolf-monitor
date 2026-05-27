// sdgolf-monitor UI — static SPA that talks to the Cloudflare Worker.
//
// One module, no framework, no build step. State held in module-level vars;
// views rendered by cloning <template> elements. Auth is an HttpOnly session
// cookie set by the Worker on login/signup, so no tokens live in localStorage.

import { TEESHEETS } from "./schema.js";

const ROOT = document.getElementById("root");
const NEW_BTN = document.getElementById("new-btn");
const AWAY_BTN = document.getElementById("away-btn");
const HELP_BTN = document.getElementById("help-btn");
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
let USER_AWAY = new Set(); // dates the signed-in user marked away; hides matches
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
const apiGetAway        = ()             => api("GET",    "/api/me/away");
const apiPutAway        = (dates)        => api("PUT",    "/api/me/away", { dates });

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
  AWAY_BTN.hidden = !(USER && showNew);
  HELP_BTN.hidden = !(USER && showNew);
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

  // Away dates filter matches on every visible card. Same dates the runner
  // uses to suppress my own emails — kept in sync via openAwayCalendar.
  try {
    const { dates } = await apiGetAway();
    USER_AWAY = new Set(Array.isArray(dates) ? dates : []);
  } catch { USER_AWAY = new Set(); }

  for (const cfg of configs) CACHE.set(cfg.id, cfg);

  // Wire tabs once after the view is mounted.
  for (const tab of document.querySelectorAll(".list-tab")) {
    tab.addEventListener("click", () => {
      LIST_FILTER = tab.dataset.filter;
      renderTabCards(configs, setsById);
    });
  }

  renderTabCards(configs, setsById);

  // First visit per user: auto-open the tour. Skipping or finishing
  // sets the localStorage flag so it doesn't re-open later.
  if (USER?.email && !localStorage.getItem(`tour_seen:${USER.email}`)) {
    setTimeout(() => startTour(), 400);
  }
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
      // Skip the round-trip when nothing actually moved. Compare against
      // the previously persisted order rather than re-deriving the "old"
      // visible order from the (already-mutated) DOM.
      if (ids.join("|") === USER_ORDER.join("|")) return;
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
  const nameEl = article.querySelector(".card-name");
  nameEl.textContent = cfg.name;
  nameEl.title = cfg.name;  // full name on hover when CSS truncates with ellipsis
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
  const allMatches = entry.matches || [];
  const matches = USER_AWAY.size
    ? allMatches.filter(m => !USER_AWAY.has(m.date))
    : allMatches;
  const hidden = allMatches.length - matches.length;
  if (matches.length === 0) {
    summary.textContent = hidden ? `0 shown · ${hidden} on away day${hidden === 1 ? "" : "s"}` : "0 matches";
    summary.classList.add("dim");
    const li = document.createElement("li");
    li.className = "none";
    li.textContent = hidden ? "All matches fall on away days" : "None";
    list.appendChild(li);
    wrapper.hidden = false;
    return;
  }
  const base = `${matches.length} match${matches.length === 1 ? "" : "es"}`;
  summary.textContent = hidden ? `${base} · ${hidden} hidden by away` : base;
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

  // TeeItUp slots aren't bookable through the worker (no auth/captcha
  // automation); fall back to the link-only UX for those courses.
  const isTeeItUp = TEESHEETS.find(t => t.label === m.target)?.provider === "teeitup";
  if (onBook && !isTeeItUp) {
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
  if (ts?.provider === "teeitup") {
    const params = new URLSearchParams({
      course: String(ts.facility_id),
      holes: String(m.holes ?? 18),
      max: "999999",
    });
    if (/^\d{4}-\d{2}-\d{2}$/.test(m.date)) params.set("date", m.date);
    return `https://${ts.alias}.book.teeitup.com/?${params.toString()}`;
  }
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
    applyWeekdayConstraints(form);
  });
  // Apply the initial weekday constraint once the rows are in place — date
  // inputs have been set up by this point so the range resolves correctly.
  applyWeekdayConstraints(form);

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
  // Targets carry either teesheet_id (ForeUp) or facility_id (TeeItUp);
  // TEESHEETS.id is reused for both, so look at both.
  const selectedIds = new Set(
    targets.map(t => t.teesheet_id ?? t.facility_id).filter(id => knownIds.has(id))
  );

  const grid = document.getElementById("courses-grid");
  for (const ts of TEESHEETS) {
    const node = document.getElementById("course-option").content.cloneNode(true);
    const cb = node.querySelector("input");
    cb.value = ts.id;
    cb.checked = selectedIds.has(ts.id);
    node.querySelector(".course-label").textContent = ts.label;
    grid.appendChild(node);
  }
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
  const reapply = () => applyWeekdayConstraints(form);
  modeSel.addEventListener("change", () => { applyDateMode(modeSel, relativeInput, specificInput); reapply(); });
  // Both inputs may participate even when hidden — listen on both so any
  // edit refreshes the weekday constraint immediately.
  for (const input of [relativeInput, specificInput]) {
    input.addEventListener("input", reapply);
    input.addEventListener("change", reapply);
  }
}

function applyDateMode(modeSel, relativeInput, specificInput) {
  const isSpecific = modeSel.value === "specific";
  relativeInput.hidden = isSpecific;
  specificInput.hidden = !isSpecific;
}

// Compute which weekday names actually appear in the date range, returning
// null when the range either spans 7+ days (all weekdays possible) or can't
// be resolved (invalid input). null means "no constraint — leave all on".
function weekdaysInRange(start, end) {
  if (!start || !end || start > end) return null;
  const days = Math.round((end - start) / 86400000) + 1;
  if (days >= 7) return null;
  const wd = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  const out = new Set();
  for (let i = 0; i < days; i++) {
    const d = new Date(start.getTime() + i * 86400000);
    out.add(wd[d.getUTCDay()]);
  }
  return out;
}

function applyWeekdayConstraints(form) {
  if (!form) return;
  const [start, end] = readFormDateRange(form);
  const allowed = weekdaysInRange(start, end);
  for (const row of form.querySelectorAll(".window-row")) {
    for (const cb of row.querySelectorAll(".weekdays input")) {
      const ok = !allowed || allowed.has(cb.value);
      cb.disabled = !ok;
      if (!ok) cb.checked = false;
      const label = cb.closest("label");
      if (label) label.classList.toggle("wd-disabled", !ok);
    }
  }
}

function buildWindowRow(w) {
  const node = document.getElementById("window-row").content.cloneNode(true);
  const row = node.querySelector(".window-row");
  row.querySelector(".w-start").value = w.start || "07:00";
  row.querySelector(".w-end").value = w.end || "11:00";
  const wd = new Set(w.weekdays || []);
  for (const cb of row.querySelectorAll(".weekdays input")) {
    cb.checked = wd.has(cb.value);
  }
  // Per-window include/exclude lists ride along as JSON on the row's
  // dataset until readForm serializes them back; the calendar popup
  // is the only thing that mutates these.
  row.dataset.includeDates = JSON.stringify(Array.isArray(w.include_dates) ? w.include_dates : []);
  row.dataset.excludeDates = JSON.stringify(Array.isArray(w.exclude_dates) ? w.exclude_dates : []);
  row.querySelector(".w-cal").addEventListener("click", () => openWindowCalendar(row));
  row.querySelector(".w-del").addEventListener("click", (e) => e.target.closest(".window-row").remove());
  updateCalBadge(row);
  return node;
}

function updateCalBadge(row) {
  const inc = JSON.parse(row.dataset.includeDates || "[]").length;
  const exc = JSON.parse(row.dataset.excludeDates || "[]").length;
  const btn = row.querySelector(".w-cal");
  const count = inc + exc;
  // Only the count span is mutated; the SVG icon stays intact.
  btn.querySelector(".w-cal-count").textContent = count ? String(count) : "";
  btn.classList.toggle("active", count > 0);
}

// ----- Window date-override calendar ------------------------------------
//
// A click cycles a day through {default rule, override}. For days that
// would match by weekday, the override is "exclude"; for days that
// wouldn't, the override is "include". Clicking an overridden day
// reverts it to the default rule. Out-of-range days (outside the
// config's date span) are unclickable.

const WEEKDAY_TO_DOW = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

function toIsoDate(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function resolveDateSpec(spec) {
  if (typeof spec !== "string") return null;
  const s = spec.trim();
  const rel = /^today(?:\s*\+\s*(\d+))?$/i.exec(s);
  if (rel) {
    const now = new Date();
    const d = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
    d.setUTCDate(d.getUTCDate() + (rel[1] ? parseInt(rel[1], 10) : 0));
    return d;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const [y, mo, d] = s.split("-").map(Number);
    return new Date(Date.UTC(y, mo - 1, d));
  }
  return null;
}

function readFormDateRange(form) {
  const readOne = (which) => {
    const mode = form.elements[`date-${which}-mode`].value;
    return mode === "specific"
      ? form.elements[`date-${which}-specific`].value
      : form.elements[`date-${which}-relative`].value;
  };
  return [resolveDateSpec(readOne("start")), resolveDateSpec(readOne("end"))];
}

function openWindowCalendar(row) {
  const form = row.closest("form");
  const [start, end] = readFormDateRange(form);
  if (!start || !end || start > end) {
    toast("Set a valid date range first", "error");
    return;
  }
  const weekdays = new Set(
    [...row.querySelectorAll(".weekdays input:checked")]
      .map(cb => WEEKDAY_TO_DOW[cb.value])
  );
  const includes = new Set(JSON.parse(row.dataset.includeDates || "[]"));
  const excludes = new Set(JSON.parse(row.dataset.excludeDates || "[]"));

  // Drop stored overrides that have fallen outside the current range —
  // they'd be invisible in the calendar but still emitted from readForm.
  const startIso = toIsoDate(start), endIso = toIsoDate(end);
  for (const set of [includes, excludes]) {
    for (const iso of [...set]) if (iso < startIso || iso > endIso) set.delete(iso);
  }

  let cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  const endMonth = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));

  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  const modal = document.createElement("section");
  modal.className = "card modal cal-modal";
  backdrop.appendChild(modal);

  const close = () => backdrop.remove();
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });

  function isMatchByWeekday(dow) {
    return weekdays.size === 0 || weekdays.has(dow);
  }

  function dayClass(iso, dow, inRange) {
    if (!inRange) return "oor";
    if (excludes.has(iso)) return "ex";
    if (includes.has(iso)) return "in";
    return isMatchByWeekday(dow) ? "match" : "skip";
  }

  function toggleDay(iso, dow) {
    if (excludes.has(iso)) excludes.delete(iso);
    else if (includes.has(iso)) includes.delete(iso);
    else if (isMatchByWeekday(dow)) excludes.add(iso);
    else includes.add(iso);
  }

  function render() {
    modal.innerHTML = "";
    const header = document.createElement("header");
    header.className = "cal-header";
    const prev = document.createElement("button");
    prev.type = "button"; prev.textContent = "‹";
    prev.disabled = cursor <= new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
    prev.addEventListener("click", () => {
      cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() - 1, 1));
      render();
    });
    const next = document.createElement("button");
    next.type = "button"; next.textContent = "›";
    next.disabled = cursor >= endMonth;
    next.addEventListener("click", () => {
      cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
      render();
    });
    const title = document.createElement("h3");
    title.textContent = cursor.toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
    header.append(prev, title, next);
    modal.appendChild(header);

    const grid = document.createElement("div");
    grid.className = "cal-grid";
    for (const wd of ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]) {
      const h = document.createElement("div");
      h.className = "cal-wd"; h.textContent = wd;
      grid.appendChild(h);
    }
    // Pad leading blanks so the 1st sits under its weekday column.
    const firstDow = cursor.getUTCDay();
    for (let i = 0; i < firstDow; i++) grid.appendChild(Object.assign(document.createElement("div"), { className: "cal-day cal-empty" }));
    const monthEnd = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 0));
    for (let day = 1; day <= monthEnd.getUTCDate(); day++) {
      const d = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth(), day));
      const iso = toIsoDate(d);
      const dow = d.getUTCDay();
      const inRange = iso >= startIso && iso <= endIso;
      const cell = document.createElement("button");
      cell.type = "button";
      cell.className = `cal-day cal-${dayClass(iso, dow, inRange)}`;
      cell.textContent = String(day);
      cell.disabled = !inRange;
      if (inRange) {
        cell.addEventListener("click", () => {
          toggleDay(iso, dow);
          cell.className = `cal-day cal-${dayClass(iso, dow, true)}`;
        });
      }
      grid.appendChild(cell);
    }
    modal.appendChild(grid);

    const legend = document.createElement("div");
    legend.className = "cal-legend";
    legend.innerHTML = `
      <span><i class="cal-sw cal-match"></i>matches</span>
      <span><i class="cal-sw cal-skip"></i>skipped</span>
      <span><i class="cal-sw cal-in"></i>included</span>
      <span><i class="cal-sw cal-ex"></i>excluded</span>
    `;
    modal.appendChild(legend);

    const footer = document.createElement("footer");
    footer.className = "edit-footer";
    const done = document.createElement("button");
    done.type = "button"; done.className = "primary"; done.textContent = "Done";
    done.addEventListener("click", () => {
      row.dataset.includeDates = JSON.stringify([...includes].sort());
      row.dataset.excludeDates = JSON.stringify([...excludes].sort());
      updateCalBadge(row);
      close();
    });
    const cancel = document.createElement("button");
    cancel.type = "button"; cancel.textContent = "Cancel";
    cancel.addEventListener("click", close);
    const clear = document.createElement("button");
    clear.type = "button"; clear.textContent = "Clear overrides";
    clear.addEventListener("click", () => {
      includes.clear(); excludes.clear();
      render();
    });
    footer.append(done, cancel, clear);
    modal.appendChild(footer);
  }

  render();
  document.body.appendChild(backdrop);
}

// ----- Global "Away" calendar -------------------------------------------
//
// Per-user list of dates this user is unavailable. The runner still scans
// these dates (for other recipients) but skips emailing this user for
// any slot on a date in their away list.

async function openAwayCalendar() {
  let dates;
  try {
    const resp = await apiGetAway();
    dates = new Set(Array.isArray(resp.dates) ? resp.dates : []);
  } catch (e) {
    toast(`Could not load away dates: ${e.message}`, "error");
    return;
  }

  // Open at today's month; allow navigation forward freely, backward a bit
  // for fixing past entries. The server caps the persisted list at 1000.
  const now = new Date();
  const todayUtc = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  let cursor = new Date(Date.UTC(now.getFullYear(), now.getMonth(), 1));
  const lowerBound = new Date(Date.UTC(now.getFullYear(), now.getMonth() - 1, 1));

  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  const modal = document.createElement("section");
  modal.className = "card modal cal-modal";
  backdrop.appendChild(modal);

  const close = () => backdrop.remove();
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });

  function dayClass(iso, isPast) {
    if (dates.has(iso)) return "ex";
    return isPast ? "skip" : "match";
  }

  function render() {
    modal.innerHTML = "";

    const intro = document.createElement("p");
    intro.className = "hint";
    intro.style.marginTop = "0";
    intro.textContent = "Click a date to mark yourself away — no email alerts for any of your subscriptions on that day.";
    modal.appendChild(intro);

    const header = document.createElement("header");
    header.className = "cal-header";
    const prev = document.createElement("button");
    prev.type = "button"; prev.textContent = "‹";
    prev.disabled = cursor <= lowerBound;
    prev.addEventListener("click", () => {
      cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() - 1, 1));
      render();
    });
    const next = document.createElement("button");
    next.type = "button"; next.textContent = "›";
    next.addEventListener("click", () => {
      cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
      render();
    });
    const title = document.createElement("h3");
    title.textContent = cursor.toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
    header.append(prev, title, next);
    modal.appendChild(header);

    const grid = document.createElement("div");
    grid.className = "cal-grid";
    for (const wd of ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]) {
      const h = document.createElement("div");
      h.className = "cal-wd"; h.textContent = wd;
      grid.appendChild(h);
    }
    const firstDow = cursor.getUTCDay();
    for (let i = 0; i < firstDow; i++) grid.appendChild(Object.assign(document.createElement("div"), { className: "cal-day cal-empty" }));
    const monthEnd = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 0));
    for (let day = 1; day <= monthEnd.getUTCDate(); day++) {
      const d = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth(), day));
      const iso = toIsoDate(d);
      const isPast = d < todayUtc;
      const cell = document.createElement("button");
      cell.type = "button";
      cell.className = `cal-day cal-${dayClass(iso, isPast)}`;
      cell.textContent = String(day);
      cell.addEventListener("click", () => {
        if (dates.has(iso)) dates.delete(iso);
        else dates.add(iso);
        cell.className = `cal-day cal-${dayClass(iso, isPast)}`;
      });
      grid.appendChild(cell);
    }
    modal.appendChild(grid);

    const legend = document.createElement("div");
    legend.className = "cal-legend";
    legend.innerHTML = `
      <span><i class="cal-sw cal-match"></i>available</span>
      <span><i class="cal-sw cal-ex"></i>away</span>
    `;
    modal.appendChild(legend);

    const footer = document.createElement("footer");
    footer.className = "edit-footer";
    const done = document.createElement("button");
    done.type = "button"; done.className = "primary"; done.textContent = "Save";
    done.addEventListener("click", async () => {
      done.disabled = true; done.textContent = "Saving…";
      try {
        // Drop dates that have already passed — they only inflate the
        // record over time, the runner ignores them anyway.
        const todayIso = toIsoDate(todayUtc);
        const future = [...dates].filter(d => d >= todayIso).sort();
        await apiPutAway(future);
        USER_AWAY = new Set(future);
        close();
        toast(future.length ? `Saved ${future.length} away day(s)` : "Away calendar cleared");
        // Re-render the list so cards reflect the new away filter
        // without waiting for the next snapshot tick.
        if (CURRENT_VIEW === "list") renderList();
      } catch (e) {
        done.disabled = false; done.textContent = "Save";
        toast(`Save failed: ${e.message}`, "error");
      }
    });
    const cancel = document.createElement("button");
    cancel.type = "button"; cancel.textContent = "Cancel";
    cancel.addEventListener("click", close);
    footer.append(done, cancel);
    modal.appendChild(footer);
  }

  render();
  document.body.appendChild(backdrop);
}

// ----- Interactive tour -------------------------------------------------
//
// Step-by-step walkthrough triggered by the Help button, and auto-opened
// once per user on first sign-in. Each step optionally targets a real DOM
// element; the overlay dims everything else, the highlight outlines the
// target, and the tip floats next to it. Steps with `condition: () =>
// false` are filtered out so the tour skips admin/bug rows for users that
// don't have them.

function buildTourSteps() {
  return [
    {
      view: "list",
      title: "Welcome to sdgolf-monitor",
      body: "Tee-time alerts for the SD city courses (Balboa, Torrey Pines) and Coronado. Quick tour — under a minute.",
    },
    {
      view: "list",
      selector: "#new-btn",
      title: "Create a check set",
      body: "<b>+ New subscription</b> defines what to watch — courses, dates, and time windows. Hit Next to peek inside the editor.",
    },
    {
      view: "edit",
      title: "Inside the editor",
      body: "Three sections coming up: <b>Courses</b>, <b>Date range</b>, and <b>Time windows</b>.",
    },
    {
      view: "edit",
      selector: "#courses-fs",
      title: "Courses",
      body: "Tick any combination — at least one is required.",
    },
    {
      view: "edit",
      selector: "#dates-fs",
      title: "Date range",
      body: "Each side is either <b>Relative</b> (e.g. <code>today</code>, <code>today+30</code>) or <b>Specific</b> (a fixed calendar date).",
    },
    {
      view: "edit",
      selector: "#windows-fs",
      title: "Time windows",
      body: "Each row is a time band + weekday filter. <b>+ Add window</b> stacks multiple bands. Click the <b>calendar icon</b> to override specific days — green-in extras, red-out skips.",
    },
    {
      view: "list",
      selector: ".list-tabs",
      title: "Mine vs. others",
      body: "<b>My subscriptions</b> are yours to edit. <b>Other subscriptions</b> are everyone else's — Subscribe to one to share its alerts.",
    },
    {
      view: "list",
      tab: "others",
      selector: ".check-card",
      title: "A subscription card",
      body: "Shows current matches under that subscription's filter. Click a date row to expand the tee times. On <b>your own cards</b>, click to edit or drag to reorder; on <b>others'</b>, click <b>Subscribe</b>.",
    },
    {
      view: "list",
      selector: "#away-btn",
      title: "Going on vacation?",
      body: "<b>Away</b> opens a calendar. Mark dates you're out and matches on those days won't email you or appear on your dashboard.",
    },
    {
      view: "list",
      selector: "#bug-fab",
      title: "Spotted something broken?",
      body: "The <b>!</b> button sends a bug report — your current view and email are attached automatically.",
      condition: () => {
        const el = document.querySelector("#bug-fab");
        return el && !el.hidden;
      },
    },
    {
      view: "list",
      selector: "#admin-btn",
      title: "Admin panel",
      body: "Manage who can sign up. Adding an email sends them a welcome with the signup link.",
      condition: () => USER?.is_admin,
    },
    {
      view: "list",
      selector: "#help-btn",
      title: "Tour anytime",
      body: "Click <b>?</b> any time to take the tour again.",
    },
  ].filter(s => !s.condition || s.condition());
}

async function startTour() {
  if (!USER?.email) return;
  // Re-entrancy guard: ensureView → renderList during the tour would
  // otherwise re-trigger the first-visit auto-open and stack a second
  // overlay (with the old step 1 still visible behind the new tip).
  if (document.querySelector(".tour-overlay")) return;
  if (CURRENT_VIEW !== "list") {
    await renderList();
  }
  const steps = buildTourSteps();
  if (steps.length === 0) return;

  let idx = 0;
  const overlay = document.createElement("div");
  overlay.className = "tour-overlay";
  document.body.appendChild(overlay);

  function close(seen) {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
    window.removeEventListener("resize", reposition);
    window.removeEventListener("scroll", syncHighlight, true);
    if (seen) localStorage.setItem(`tour_seen:${USER.email}`, "1");
  }
  function onKey(e) {
    if (e.key === "Escape") close(true);
    else if (e.key === "ArrowRight" || e.key === "Enter") next();
    else if (e.key === "ArrowLeft") prev();
  }
  async function next() {
    idx++;
    if (idx >= steps.length) return close(true);
    await render();
  }
  async function prev() {
    if (idx > 0) idx--;
    await render();
  }
  function reposition() { render(); }

  // Lightweight scroll handler: just re-clamp the highlight rect to the
  // target's current viewport position. Without this, the highlight
  // stays pinned to its initial coords while the target scrolls away.
  function syncHighlight() {
    const hl = overlay.querySelector(".tour-highlight");
    const step = steps[idx];
    if (!hl || !step?.selector) return;
    const target = document.querySelector(step.selector);
    if (!target) return;
    const r = target.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    const isMobile = vw < 720;
    const SAFE = 12, TIP = 240;
    // Mirror the tip-side decision so the reserved zone stays on the
    // tip's side as the page scrolls.
    let tipAtTop = false;
    if (isMobile) {
      const cs = getComputedStyle(target);
      if (cs.position === "fixed") tipAtTop = (r.top + r.bottom) / 2 > vh / 2;
    }
    const topReserve = isMobile && tipAtTop ? TIP : SAFE;
    const bottomReserve = isMobile && !tipAtTop ? TIP : SAFE;
    const top = Math.max(topReserve, r.top - 6);
    const left = Math.max(SAFE, r.left - 6);
    const right = Math.min(vw - SAFE, r.right + 6);
    const bottom = Math.min(vh - bottomReserve, r.bottom + 6);
    hl.style.top = `${top}px`;
    hl.style.left = `${left}px`;
    hl.style.width = `${Math.max(0, right - left)}px`;
    hl.style.height = `${Math.max(0, bottom - top)}px`;
  }

  async function ensureView(view) {
    if (view === "edit" && !CURRENT_VIEW.startsWith("edit")) {
      renderEdit(null);
    } else if (view === "list" && CURRENT_VIEW !== "list") {
      await renderList();
    }
  }

  function ensureTab(tab) {
    if (!tab) return;
    const el = document.querySelector(`.list-tab[data-filter="${tab}"]`);
    if (el && !el.classList.contains("active")) el.click();
  }

  async function render() {
    const step = steps[idx];

    // Switch views BEFORE clearing the overlay — keeps the previous tip
    // visible during the await on renderList(), rather than flashing the
    // backdrop empty (which broke click targeting in the brief gap).
    if (step.view) await ensureView(step.view);
    if (step.tab) ensureTab(step.tab);

    overlay.innerHTML = "";

    let target = step.selector ? document.querySelector(step.selector) : null;
    const isMobile = window.innerWidth < 720;

    // Whether to bottom-pin the tip (default) or top-pin it. A target
    // already in the lower half of the viewport (e.g. the fixed bug FAB)
    // gets the tip up top so the FAB stays visible. Decided here so the
    // scroll step below knows which half to land the target in.
    const tipAtTop = (() => {
      if (!isMobile || !target) return false;
      const cs = getComputedStyle(target);
      const r = target.getBoundingClientRect();
      const centerY = (r.top + r.bottom) / 2;
      // Fixed targets keep their viewport position regardless of scroll.
      if (cs.position === "fixed") return centerY > window.innerHeight / 2;
      return false;
    })();

    if (target) {
      const cs = getComputedStyle(target);
      const isFixedTarget = cs.position === "fixed";
      if (!isFixedTarget) {
        const block = isMobile ? "start" : "center";
        try { target.scrollIntoView({ block, behavior: "instant" }); } catch { /* older browsers */ }
        if (isMobile) {
          // scrollIntoView ignores the sticky page header, so the target
          // ends up under it. Scroll the page down by the header height
          // plus a small inset so the highlight ring clears it cleanly.
          const header = document.querySelector("header");
          const headerH = header ? header.offsetHeight : 0;
          window.scrollBy({ top: -(headerH + 12), behavior: "instant" });
        }
      }
    }

    // Backdrop = click-to-close zone. When a target exists, the spotlight's
    // box-shadow handles the dimming so the backdrop stays transparent;
    // otherwise the backdrop itself dims the page for a centered tip.
    const backdrop = document.createElement("div");
    backdrop.className = "tour-backdrop";
    backdrop.style.background = target ? "transparent" : "rgba(0, 0, 0, 0.62)";
    backdrop.addEventListener("click", () => close(true));
    overlay.appendChild(backdrop);

    if (target) {
      const r = target.getBoundingClientRect();
      // Clamp the highlight to the viewport so a target taller than the
      // window doesn't draw a ring above or below the visible area.
      // On mobile reserve ~240px at whichever side the tip is pinned to
      // (bottom by default; top when the target sits in the lower half).
      const vw = window.innerWidth, vh = window.innerHeight;
      const SAFE = 12;
      const TIP = 240;
      const topReserve = isMobile && tipAtTop ? TIP : SAFE;
      const bottomReserve = isMobile && !tipAtTop ? TIP : SAFE;
      const top = Math.max(topReserve, r.top - 6);
      const left = Math.max(SAFE, r.left - 6);
      const right = Math.min(vw - SAFE, r.right + 6);
      const bottom = Math.min(vh - bottomReserve, r.bottom + 6);
      const hl = document.createElement("div");
      hl.className = "tour-highlight";
      hl.style.top = `${top}px`;
      hl.style.left = `${left}px`;
      hl.style.width = `${Math.max(0, right - left)}px`;
      hl.style.height = `${Math.max(0, bottom - top)}px`;
      overlay.appendChild(hl);
    }

    const tip = document.createElement("section");
    tip.className = "tour-tip";
    tip.innerHTML = `
      <div class="tour-step-count">Step ${idx + 1} of ${steps.length}</div>
      <h3>${step.title}</h3>
      <p>${step.body}</p>
      <footer class="tour-actions">
        <button type="button" class="tour-skip">Skip tour</button>
        <button type="button" class="tour-prev" ${idx === 0 ? "disabled" : ""}>Back</button>
        <button type="button" class="tour-next primary">${idx === steps.length - 1 ? "Done" : "Next"}</button>
      </footer>
    `;
    overlay.appendChild(tip);

    // Position the tip. On mobile, pin to the bottom so it never covers
    // the highlighted feature regardless of the target's size. On desktop,
    // try below/above/right/left/center near the target.
    const pad = 14;
    if (isMobile) {
      tip.style.left = `${pad}px`;
      tip.style.right = `${pad}px`;
      tip.style.width = "auto";
      tip.style.maxWidth = "none";
      if (tipAtTop) {
        tip.style.top = `${pad}px`;
        tip.style.bottom = "auto";
      } else {
        tip.style.bottom = `${pad}px`;
        tip.style.top = "auto";
      }
    } else {
      const tipRect = tip.getBoundingClientRect();
      const vw = window.innerWidth, vh = window.innerHeight;
      if (target) {
        const r = target.getBoundingClientRect();
        const fitsBelow = r.bottom + pad + tipRect.height <= vh - pad;
        const fitsAbove = r.top - pad - tipRect.height >= pad;
        const fitsRight = r.right + pad + tipRect.width <= vw - pad;
        const fitsLeft = r.left - pad - tipRect.width >= pad;

        let top, left;
        if (fitsBelow) {
          top = r.bottom + pad;
          left = r.left + r.width / 2 - tipRect.width / 2;
        } else if (fitsAbove) {
          top = r.top - tipRect.height - pad;
          left = r.left + r.width / 2 - tipRect.width / 2;
        } else if (fitsRight) {
          left = r.right + pad;
          top = r.top + r.height / 2 - tipRect.height / 2;
        } else if (fitsLeft) {
          left = r.left - tipRect.width - pad;
          top = r.top + r.height / 2 - tipRect.height / 2;
        } else {
          top = (vh - tipRect.height) / 2;
          left = (vw - tipRect.width) / 2;
        }
        tip.style.top = `${Math.max(pad, Math.min(top, vh - tipRect.height - pad))}px`;
        tip.style.left = `${Math.max(pad, Math.min(left, vw - tipRect.width - pad))}px`;
      } else {
        tip.style.top = `${Math.max(pad, (vh - tipRect.height) / 2)}px`;
        tip.style.left = `${Math.max(pad, (vw - tipRect.width) / 2)}px`;
      }
    }

    tip.querySelector(".tour-skip").addEventListener("click", () => close(true));
    tip.querySelector(".tour-prev").addEventListener("click", prev);
    tip.querySelector(".tour-next").addEventListener("click", next);
  }

  document.addEventListener("keydown", onKey);
  window.addEventListener("resize", reposition);
  // capture: true catches scroll events from any scrolling ancestor,
  // not just window — important when the page itself doesn't scroll
  // but an inner container does.
  window.addEventListener("scroll", syncHighlight, { passive: true, capture: true });
  await render();
}

function readForm(form) {
  // booking_class is intentionally omitted from emitted targets — the
  // runner picks the right ForeUp class (929 vs 51735) per-date based
  // on how far out the slot is, since the date alone determines it.
  const targets = [];
  for (const cb of form.querySelectorAll('input[name="course"]:checked')) {
    const id = parseInt(cb.value, 10);
    const meta = TEESHEETS.find(ts => ts.id === id);
    if (!meta) continue;
    if (meta.provider === "teeitup") {
      targets.push({
        name: meta.label,
        provider: "teeitup",
        facility_id: meta.facility_id,
        alias: meta.alias,
      });
    } else {
      targets.push({ name: meta.label, teesheet_id: id });
    }
  }
  if (targets.length === 0) throw new Error("Select at least one course");

  const windows = [];
  for (const row of form.querySelectorAll("#windows-list .window-row")) {
    const start = row.querySelector(".w-start").value;
    const end = row.querySelector(".w-end").value;
    if (!start || !end) continue;
    if (start >= end) throw new Error(`Window ${start}–${end}: end must be after start (use 24h time, e.g. 16:00 for 4 PM)`);
    const weekdays = [...row.querySelectorAll(".weekdays input:checked")].map(cb => cb.value);
    const includeDates = JSON.parse(row.dataset.includeDates || "[]");
    const excludeDates = JSON.parse(row.dataset.excludeDates || "[]");
    const w = { start, end };
    if (weekdays.length > 0) w.weekdays = weekdays;
    if (includeDates.length > 0) w.include_dates = includeDates;
    if (excludeDates.length > 0) w.exclude_dates = excludeDates;
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
AWAY_BTN.addEventListener("click", () => openAwayCalendar());
HELP_BTN.addEventListener("click", () => startTour());
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
