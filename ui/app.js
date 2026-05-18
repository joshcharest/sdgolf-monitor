// sdgolf-monitor UI — static SPA editing configs/*.yaml via the GitHub REST API.
//
// One module, no framework, no build step. State held in module-level vars;
// views rendered by cloning <template> elements.

import { REPO_OWNER, REPO_NAME, REPO_BRANCH, TEESHEETS, BOOKING_CLASSES } from "./schema.js";

const PAT_KEY = "sdgolf-monitor.gh-pat";
const ROOT = document.getElementById("root");
const NEW_BTN = document.getElementById("new-btn");
const SIGNOUT_BTN = document.getElementById("signout-btn");
const TOAST = document.getElementById("toast");

// In-memory cache of configs we've loaded this session: name → { sha, cfg, yaml }
const CACHE = new Map();
let TOKEN = localStorage.getItem(PAT_KEY) || null;

// ----- Toast -------------------------------------------------------------

let toastTimer = null;
function toast(msg, kind = "info") {
  TOAST.textContent = msg;
  TOAST.className = kind === "error" ? "error" : "";
  TOAST.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { TOAST.hidden = true; }, kind === "error" ? 6000 : 3000);
}

// ----- GitHub API --------------------------------------------------------

async function gh(method, path, body) {
  const url = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}${path}`;
  const headers = {
    "Authorization": `Bearer ${TOKEN}`,
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (body) headers["Content-Type"] = "application/json";
  const resp = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (!resp.ok) {
    const text = await resp.text();
    const err = new Error(`${method} ${path} → HTTP ${resp.status}`);
    err.status = resp.status;
    err.body = text;
    throw err;
  }
  if (resp.status === 204) return null;
  return resp.json();
}

async function listConfigs() {
  const items = await gh("GET", `/contents/configs?ref=${REPO_BRANCH}`);
  return items.filter(it => it.type === "file" && it.name.endsWith(".yaml"));
}

async function loadConfig(name) {
  const data = await gh("GET", `/contents/configs/${encodeURIComponent(name)}.yaml?ref=${REPO_BRANCH}`);
  // GitHub returns base64-encoded content with newlines.
  const text = atob(data.content.replace(/\n/g, ""));
  const cfg = jsyaml.load(text);
  return { sha: data.sha, cfg, yaml: text };
}

async function saveConfig(name, cfg, sha) {
  const yamlText = jsyaml.dump(cfg, { lineWidth: -1, noCompatMode: true });
  const body = {
    message: `${sha ? "update" : "create"} configs/${name}.yaml via UI`,
    content: btoa(unescape(encodeURIComponent(yamlText))),  // utf-8 → base64
    branch: REPO_BRANCH,
  };
  if (sha) body.sha = sha;
  const resp = await gh("PUT", `/contents/configs/${encodeURIComponent(name)}.yaml`, body);
  return { sha: resp.content.sha, yaml: yamlText };
}

async function deleteConfig(name, sha) {
  await gh("DELETE", `/contents/configs/${encodeURIComponent(name)}.yaml`, {
    message: `delete configs/${name}.yaml via UI`,
    sha,
    branch: REPO_BRANCH,
  });
}

// ----- Views -------------------------------------------------------------

function setNav({ showNew = false } = {}) {
  NEW_BTN.hidden = !showNew;
  SIGNOUT_BTN.hidden = !TOKEN;
}

function renderAuth() {
  ROOT.innerHTML = "";
  const view = document.getElementById("auth-view").content.cloneNode(true);
  ROOT.appendChild(view);
  setNav({ showNew: false });

  const form = document.getElementById("auth-form");
  const err = document.getElementById("auth-error");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    err.hidden = true;
    const pat = document.getElementById("pat-input").value.trim();
    if (!pat) return;
    TOKEN = pat;
    try {
      // Validate by listing the repo root.
      await gh("GET", `/contents/?ref=${REPO_BRANCH}`);
      localStorage.setItem(PAT_KEY, pat);
      toast("Signed in");
      renderList();
    } catch (e) {
      TOKEN = null;
      err.textContent = `Token check failed: ${e.message}. Verify the token has Contents read/write on this repo.`;
      err.hidden = false;
    }
  });
}

async function renderList() {
  ROOT.innerHTML = "<p class='loading'>Loading check sets…</p>";
  setNav({ showNew: true });

  let items;
  try {
    items = await listConfigs();
  } catch (e) {
    if (e.status === 401 || e.status === 403) {
      localStorage.removeItem(PAT_KEY);
      TOKEN = null;
      return renderAuth();
    }
    if (e.status === 404) {
      items = [];  // configs/ may not exist yet
    } else {
      ROOT.innerHTML = `<p class='error'>Failed to list configs: ${e.message}</p>`;
      return;
    }
  }

  const view = document.getElementById("list-view").content.cloneNode(true);
  ROOT.innerHTML = "";
  ROOT.appendChild(view);

  const cardsEl = document.getElementById("cards");
  const emptyEl = document.getElementById("cards-empty");
  if (items.length === 0) {
    emptyEl.hidden = false;
    return;
  }

  // Load configs and the snapshot in parallel — the snapshot is "nice to
  // have" and shouldn't block the card list if KV isn't wired up yet.
  const [loaded, snapshot] = await Promise.all([
    Promise.all(items.map(async (it) => {
      const name = it.name.replace(/\.yaml$/, "");
      try {
        const data = await loadConfig(name);
        CACHE.set(name, data);
        return { name, ...data };
      } catch (e) {
        return { name, error: e.message };
      }
    })),
    loadSnapshot(),
  ]);

  renderSnapshotMeta(snapshot);
  const setsBySet = snapshot?.sets || {};
  for (const item of loaded.sort((a, b) => a.name.localeCompare(b.name))) {
    cardsEl.appendChild(renderCard(item, setsBySet[item.name]));
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
  meta.textContent = `Tee times updated ${relativeTime(snapshot.generated_at)} (${snapshot.generated_at})`;
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

function renderCard({ name, cfg, error }, snapshotEntry) {
  const node = document.getElementById("card").content.cloneNode(true);
  const article = node.querySelector("article");
  article.querySelector(".card-name").textContent = name;
  if (error) {
    article.querySelector(".card-desc").textContent = `(failed to load: ${error})`;
    return node;
  }
  const enabled = cfg.enabled !== false;
  if (!enabled) article.classList.add("disabled");
  const toggle = article.querySelector(".enabled-toggle");
  toggle.checked = enabled;
  toggle.addEventListener("change", async () => {
    const cached = CACHE.get(name);
    if (!cached) return;
    const newCfg = { ...cached.cfg, enabled: toggle.checked };
    try {
      const { sha, yaml } = await saveConfig(name, newCfg, cached.sha);
      CACHE.set(name, { sha, cfg: newCfg, yaml });
      article.classList.toggle("disabled", !toggle.checked);
      toast(`${name}: ${toggle.checked ? "enabled" : "disabled"}`);
    } catch (e) {
      toggle.checked = !toggle.checked;  // revert
      toast(`Could not toggle: ${e.message}`, "error");
    }
  });

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
  const holesStr = (Array.isArray(f.holes) ? f.holes.join(" + ") : (f.holes ?? 18)) + "h";
  const playersStr = `≥${f.min_players ?? 1}p`;
  const windowsStr = (f.windows || []).map(w => `${fmt12h(w.start)}–${fmt12h(w.end)}`).join(" · ") || "any time";
  article.querySelector(".card-filter").textContent = `${holesStr} · ${playersStr} · ${windowsStr}`;

  renderCardMatches(article, snapshotEntry);

  article.querySelector(".edit-btn").addEventListener("click", () => renderEdit(name));
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
    return;
  }
  summary.textContent = `${matches.length} match${matches.length === 1 ? "" : "es"}`;
  summary.classList.add("hit");

  // Sort by date then time. Show the first MAX; the rest are revealed on
  // demand via a "Show N more" button so cards stay compact by default.
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
  // Each match is an <a> wrapping a two-row layout: primary (time + course)
  // on top, secondary (players/holes/fee/BF) below dimmer. Clicking opens the
  // ForeUp booking page in a new tab.
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

  const fee = m.green_fee == null ? null : `$${Math.round(m.green_fee)}`;
  const bf = m.booking_fee ? "BF" : null;
  const metaParts = [`${m.available_spots}p`, `${m.holes}h`, fee, bf].filter(Boolean);
  const meta = document.createElement("div");
  meta.className = "match-meta";
  meta.textContent = metaParts.join(" · ");

  link.append(primary, meta);
  li.append(link);
  return li;
}

// ForeUp deep-link: pass date + schedule_id as query params so the SPA can
// preselect on load. SD City Golf facility id = 19348, booking class 929
// is the resident 0-7-day class (no booking fee).
function bookingUrl(m) {
  const ts = TEESHEETS.find(t => t.label === m.target);
  const base = "https://foreupsoftware.com/index.php/booking/19348/929";
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

// "YYYY-MM-DD" -> "Mon 5/25". Non-ISO inputs (e.g. "today+8") pass through.
function formatDate(spec) {
  if (typeof spec !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(spec)) return spec;
  const [y, m, d] = spec.split("-").map(Number);
  const dow = DOW[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${dow} ${m}/${d}`;
}

// "08:00" -> "8 AM"; "16:30" -> "4:30 PM"; "12:00" -> "12 PM".
// Round-hour times drop the ":00" for compactness.
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


function renderEdit(existingName) {
  const isNew = !existingName;
  const cached = existingName ? CACHE.get(existingName) : null;
  const cfg = cached?.cfg || {
    enabled: true,
    targets: [],
    dates: { start: "today", end: "today+90" },
    filter: { holes: 18, min_players: 2, windows: [{ start: "07:00", end: "11:00", weekdays: ["sat", "sun"] }] },
  };

  ROOT.innerHTML = "";
  const view = document.getElementById("edit-view").content.cloneNode(true);
  ROOT.appendChild(view);
  setNav({ showNew: false });

  document.getElementById("edit-title").textContent = isNew ? "New check set" : `Edit ${existingName}`;

  const form = document.getElementById("edit-form");
  form.elements["name"].value = existingName || "";
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
      if (!confirm(`Delete check set "${existingName}"? This commits a deletion to the repo.`)) return;
      try {
        await deleteConfig(existingName, cached.sha);
        CACHE.delete(existingName);
        toast(`Deleted ${existingName}`);
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
      const newName = form.elements["name"].value.trim();
      if (!newName) throw new Error("Name is required");
      const isRename = !isNew && newName !== existingName;
      submitBtn.disabled = true;
      submitBtn.textContent = "Saving…";

      if (isRename) {
        if (!confirm(
          `Rename "${existingName}" → "${newName}"?\n\n` +
          `This commits a new file and deletes the old one. ` +
          `Dedup state will reset, so the next run treats this as a first run and won't email.`
        )) {
          submitBtn.disabled = false;
          submitBtn.textContent = "Save";
          return;
        }
        // Create-not-clobber: PUT without sha fails (422) if the target exists.
        const created = await saveConfig(newName, newCfg, null);
        try {
          await deleteConfig(existingName, cached.sha);
        } catch (e) {
          // New file is up but old file is still there. Don't silently lose this.
          throw new Error(`Renamed to ${newName} but failed to delete ${existingName}: ${e.message}. Delete it manually.`);
        }
        CACHE.delete(existingName);
        CACHE.set(newName, { sha: created.sha, cfg: newCfg, yaml: created.yaml });
        toast(`Renamed ${existingName} → ${newName}`);
      } else {
        const name = isNew ? newName : existingName;
        const { sha, yaml } = await saveConfig(name, newCfg, cached?.sha);
        CACHE.set(name, { sha, cfg: newCfg, yaml });
        toast(`Saved ${name}`);
      }
      renderList();
    } catch (e) {
      errEl.textContent = `Save failed: ${e.message}`;
      errEl.hidden = false;
      submitBtn.disabled = false;
      submitBtn.textContent = "Save";
    }
  });
}

function setupTargets(targets) {
  const knownIds = new Set(TEESHEETS.map(ts => ts.id));
  const selectedIds = new Set(targets.map(t => t.teesheet_id).filter(id => knownIds.has(id)));

  // Course checkboxes
  const grid = document.getElementById("courses-grid");
  for (const ts of TEESHEETS) {
    const node = document.getElementById("course-option").content.cloneNode(true);
    const cb = node.querySelector("input");
    cb.value = ts.id;
    cb.checked = selectedIds.has(ts.id);
    node.querySelector(".course-label").textContent = ts.label;
    grid.appendChild(node);
  }

  // Booking class: shared across all targets in this set. Pick from the
  // first target if any; otherwise default to 929 (the common case).
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

// Date spec: either "today", "today±N", or an ISO YYYY-MM-DD string.
// Renders a mode select + two inputs (text for relative, date for specific)
// and toggles visibility.
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
  // Booking class — shared across all targets in this set.
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

  const cfg = {
    enabled: form.elements["enabled"].checked,
    targets,
    dates: { start: dateStart, end: dateEnd },
    filter: {
      holes: readHoles(form),
      min_players: parseInt(form.elements["min-players"].value, 10),
      windows,
    },
  };
  return cfg;
}

// "18" / "9" / "both" → 18 / 9 / [9, 18]. The select stores the raw value.
function readHoles(form) {
  const v = form.elements["holes"].value;
  if (v === "both") return [9, 18];
  return parseInt(v, 10);
}

// YAML holes value → matching <select> option. Accepts int (18/9), list
// (treated as Both if it contains both 9 and 18), or missing.
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
  if (!/^today(\s*[+-]\s*\d+)?$/i.test(v)) {
    throw new Error(`${which === "start" ? "Start" : "End"} date '${v}' must be "today", "today+N", or "today-N"`);
  }
  return v;
}

// ----- Boot --------------------------------------------------------------

NEW_BTN.addEventListener("click", () => renderEdit(null));
SIGNOUT_BTN.addEventListener("click", () => {
  if (!confirm("Sign out? Your access token will be removed from this browser.")) return;
  localStorage.removeItem(PAT_KEY);
  TOKEN = null;
  CACHE.clear();
  renderAuth();
});

if (TOKEN) {
  renderList();
} else {
  renderAuth();
}
