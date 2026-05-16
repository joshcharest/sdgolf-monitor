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

  // Load all configs in parallel
  const loaded = await Promise.all(items.map(async (it) => {
    const name = it.name.replace(/\.yaml$/, "");
    try {
      const data = await loadConfig(name);
      CACHE.set(name, data);
      return { name, ...data };
    } catch (e) {
      return { name, error: e.message };
    }
  }));

  for (const item of loaded.sort((a, b) => a.name.localeCompare(b.name))) {
    cardsEl.appendChild(renderCard(item));
  }
}

function renderCard({ name, cfg, error }) {
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

  const targets = (cfg.targets || []).map(t => t.name).join(", ");
  article.querySelector(".card-targets").textContent = `Targets: ${targets || "(none)"}`;
  const d = cfg.dates || {};
  article.querySelector(".card-dates").textContent = `Dates: ${d.start || "?"} → ${d.end || "?"}`;
  const f = cfg.filter || {};
  const windowsSummary = (f.windows || []).map(w => `${w.start}-${w.end}`).join(", ") || "(any time)";
  const holesSummary = Array.isArray(f.holes) ? f.holes.join("+") : (f.holes || 18);
  article.querySelector(".card-filter").textContent = `${holesSummary}h • ≥${f.min_players || 1}p • ${windowsSummary}`;

  article.querySelector(".edit-btn").addEventListener("click", () => renderEdit(name));
  return node;
}

function renderEdit(existingName) {
  const isNew = !existingName;
  const cached = existingName ? CACHE.get(existingName) : null;
  const cfg = cached?.cfg || {
    enabled: true,
    targets: [],
    dates: { start: "today", end: "today+90" },
    filter: { holes: 18, min_players: 2, max_green_fee: null, windows: [{ start: "07:00", end: "11:00", weekdays: ["sat", "sun"] }] },
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
  form.elements["max-fee"].value = cfg.filter?.max_green_fee ?? "";

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
  const customTargets = targets.filter(t => !knownIds.has(t.teesheet_id));

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

  // Custom targets (rare — teesheet ids not in TEESHEETS)
  const customList = document.getElementById("custom-targets-list");
  const customDetails = customList.closest("details");
  for (const t of customTargets) customList.appendChild(buildCustomTargetRow(t));
  if (customTargets.length > 0) customDetails.open = true;
  document.getElementById("add-custom-target").addEventListener("click", () => {
    customList.appendChild(buildCustomTargetRow({ name: "", teesheet_id: "" }));
  });
}

function buildCustomTargetRow(t) {
  const node = document.getElementById("custom-target-row").content.cloneNode(true);
  node.querySelector(".ct-name").value = t.name || "";
  node.querySelector(".ct-id").value = t.teesheet_id ?? "";
  node.querySelector(".ct-del").addEventListener("click", (e) => e.target.closest(".custom-target-row").remove());
  return node;
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
  for (const row of form.querySelectorAll("#custom-targets-list .custom-target-row")) {
    const name = row.querySelector(".ct-name").value.trim();
    const idRaw = row.querySelector(".ct-id").value.trim();
    if (!name && !idRaw) continue;
    const teesheet_id = parseInt(idRaw, 10);
    if (!name || !Number.isFinite(teesheet_id)) {
      throw new Error("Each custom course needs a name and a numeric teesheet id");
    }
    targets.push({ name, teesheet_id, booking_class });
  }
  if (targets.length === 0) throw new Error("Select at least one course (or add a custom course)");

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

  const maxFeeRaw = form.elements["max-fee"].value.trim();
  const cfg = {
    enabled: form.elements["enabled"].checked,
    targets,
    dates: { start: dateStart, end: dateEnd },
    filter: {
      holes: readHoles(form),
      min_players: parseInt(form.elements["min-players"].value, 10),
      max_green_fee: maxFeeRaw === "" ? null : Number(maxFeeRaw),
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
