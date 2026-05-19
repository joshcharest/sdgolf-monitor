// sdgolf-monitor UI — static SPA that talks to the Cloudflare Worker.
//
// One module, no framework, no build step. State held in module-level vars;
// views rendered by cloning <template> elements. Auth is an HttpOnly session
// cookie set by the Worker on login/signup, so no tokens live in localStorage.

import { TEESHEETS, BOOKING_CLASSES } from "./schema.js";

const ROOT = document.getElementById("root");
const NEW_BTN = document.getElementById("new-btn");
const SIGNOUT_BTN = document.getElementById("signout-btn");
const USER_BADGE = document.getElementById("user-badge");
const TOAST = document.getElementById("toast");

// In-memory cache of configs we've loaded this session: id → cfg object
const CACHE = new Map();
let USER = null;  // { email } once signed in

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
const apiSignup    = (email, password, c) => api("POST",  "/api/auth/signup", { email, password, invite_code: c });
const apiLogout    = ()                  => api("POST",   "/api/auth/logout");
const apiListConfigs   = ()              => api("GET",    "/api/configs");
const apiCreateConfig  = (cfg)           => api("POST",   "/api/configs", cfg);
const apiUpdateConfig  = (id, cfg)       => api("PUT",    `/api/configs/${id}`, cfg);
const apiDeleteConfig  = (id)            => api("DELETE", `/api/configs/${id}`);
const apiSubscribe     = (id)            => api("POST",   `/api/configs/${id}/subscribe`);
const apiUnsubscribe   = (id)            => api("POST",   `/api/configs/${id}/unsubscribe`);

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
  SIGNOUT_BTN.hidden = !USER;
  USER_BADGE.hidden = !USER;
  if (USER) USER_BADGE.textContent = USER.email;
}

function renderAuth() {
  USER = null;
  CACHE.clear();
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
        fd.get("invite_code").trim(),
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
  ROOT.innerHTML = "<p class='loading'>Loading check sets…</p>";
  setNav({ showNew: true });

  let configs;
  try {
    configs = await apiListConfigs();
  } catch (e) {
    if (e.status === 401) return renderAuth();
    ROOT.innerHTML = `<p class='error'>Failed to list configs: ${e.message}</p>`;
    return;
  }

  const view = document.getElementById("list-view").content.cloneNode(true);
  ROOT.innerHTML = "";
  ROOT.appendChild(view);

  const cardsEl = document.getElementById("cards");
  const emptyEl = document.getElementById("cards-empty");

  const snapshot = await loadSnapshot();
  renderSnapshotMeta(snapshot);
  const setsById = snapshot?.sets || {};

  for (const cfg of configs) CACHE.set(cfg.id, cfg);

  if (configs.length === 0) {
    emptyEl.hidden = false;
    return;
  }

  configs.sort((a, b) => a.name.localeCompare(b.name));
  for (const cfg of configs) {
    cardsEl.appendChild(renderCard(cfg, setsById[cfg.id]));
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
  article.querySelector(".card-name").textContent = cfg.name;
  const ownerEl = article.querySelector(".card-owner");
  ownerEl.textContent = cfg.owner === USER.email ? "yours" : `by ${cfg.owner}`;
  ownerEl.classList.toggle("mine", cfg.owner === USER.email);

  const enabled = cfg.enabled !== false;
  if (!enabled) article.classList.add("disabled");

  const isOwner = cfg.owner === USER.email;
  const editBtn = article.querySelector(".edit-btn");
  const subscribeBtn = article.querySelector(".subscribe-btn");
  const toggleLabel = article.querySelector(".toggle");
  const toggle = article.querySelector(".enabled-toggle");

  if (isOwner) {
    editBtn.hidden = false;
    toggleLabel.hidden = false;
    toggle.checked = enabled;
    editBtn.addEventListener("click", () => renderEdit(cfg.id));
    toggle.addEventListener("change", async () => {
      const cached = CACHE.get(cfg.id);
      if (!cached) return;
      const next = { ...cached, enabled: toggle.checked };
      try {
        const saved = await apiUpdateConfig(cfg.id, next);
        CACHE.set(cfg.id, saved);
        article.classList.toggle("disabled", !toggle.checked);
        triggerDispatch();
        toast(`${cfg.name}: ${toggle.checked ? "enabled" : "disabled"}`);
      } catch (e) {
        toggle.checked = !toggle.checked;  // revert
        toast(`Could not toggle: ${e.message}`, "error");
      }
    });
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

  renderCardMatches(article, snapshotEntry);
  return node;
}

function renderCardMatches(article, entry) {
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

  const sorted = matches.slice().sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  const MAX = 8;
  for (const m of sorted.slice(0, MAX)) list.appendChild(buildMatchLi(m));
  if (sorted.length > MAX) {
    const moreLi = document.createElement("li");
    moreLi.className = "more";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "show-more";
    const remaining = sorted.length - MAX;
    btn.textContent = `Show ${remaining} more`;
    btn.addEventListener("click", () => {
      moreLi.remove();
      for (const m of sorted.slice(MAX)) list.appendChild(buildMatchLi(m));
    });
    moreLi.appendChild(btn);
    list.appendChild(moreLi);
  }
  wrapper.hidden = false;
}

function buildMatchLi(m) {
  const li = document.createElement("li");

  const link = document.createElement("a");
  link.className = "match-link";
  link.href = bookingUrl(m);
  link.target = "_blank";
  link.rel = "noopener";

  const primary = document.createElement("div");
  primary.className = "match-primary";
  primary.append(
    mkSpan("match-when", `${formatDate(m.date)} · ${fmt12h(m.time)}`),
    document.createTextNode(" "),
    mkSpan("match-where", m.target),
  );

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
  li.append(link);
  return li;
}

function bookingUrl(m) {
  const ts = TEESHEETS.find(t => t.label === m.target);
  const bookingClass = m.booking_fee ? 51735 : 929;
  const base = `https://foreupsoftware.com/index.php/booking/19348/${bookingClass}`;
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
    toast("Could not find that check set", "error");
    return renderList();
  }
  if (cached && cached.owner !== USER.email) {
    toast("You can only edit your own check sets", "error");
    return renderList();
  }

  const cfg = cached || {
    enabled: true,
    targets: [],
    dates: { start: "today", end: "today+90" },
    filter: { holes: 18, min_players: 2, windows: [{ start: "07:00", end: "11:00", weekdays: ["sat", "sun"] }] },
  };

  ROOT.innerHTML = "";
  const view = document.getElementById("edit-view").content.cloneNode(true);
  ROOT.appendChild(view);
  setNav({ showNew: false });

  const isNew = !existingId;
  document.getElementById("edit-title").textContent = isNew ? "New check set" : `Edit ${cfg.name}`;

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

  document.getElementById("cancel-btn").addEventListener("click", () => renderList());

  const deleteBtn = document.getElementById("delete-btn");
  if (!isNew) {
    deleteBtn.hidden = false;
    deleteBtn.addEventListener("click", async () => {
      if (!confirm(`Delete check set "${cfg.name}"?`)) return;
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

  return {
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

// ----- Boot --------------------------------------------------------------

NEW_BTN.addEventListener("click", () => renderEdit(null));
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
