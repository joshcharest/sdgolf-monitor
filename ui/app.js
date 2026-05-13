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

  article.querySelector(".card-desc").textContent = cfg.description || "";

  const targets = (cfg.targets || []).map(t => t.name).join(", ");
  article.querySelector(".card-targets").textContent = `Targets: ${targets || "(none)"}`;
  const d = cfg.dates || {};
  article.querySelector(".card-dates").textContent = `Dates: ${d.start || "?"} → ${d.end || "?"}`;
  const f = cfg.filter || {};
  const windowsSummary = (f.windows || []).map(w => `${w.start}-${w.end}`).join(", ") || "(any time)";
  article.querySelector(".card-filter").textContent = `${f.holes || 18}h • ≥${f.min_players || 1}p • ${windowsSummary}`;

  article.querySelector(".edit-btn").addEventListener("click", () => renderEdit(name));
  return node;
}

function renderEdit(existingName) {
  const isNew = !existingName;
  const cached = existingName ? CACHE.get(existingName) : null;
  const cfg = cached?.cfg || {
    enabled: true,
    description: "",
    targets: [{ name: "", teesheet_id: 1470, booking_class: 929 }],
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
  if (existingName) form.elements["name"].disabled = true;
  form.elements["enabled"].checked = cfg.enabled !== false;
  form.elements["description"].value = cfg.description || "";
  form.elements["date-start"].value = cfg.dates?.start || "today";
  form.elements["date-end"].value = cfg.dates?.end || "today+90";
  form.elements["holes"].value = String(cfg.filter?.holes ?? 18);
  form.elements["min-players"].value = cfg.filter?.min_players ?? 2;
  form.elements["max-fee"].value = cfg.filter?.max_green_fee ?? "";

  const targetsList = document.getElementById("targets-list");
  for (const t of cfg.targets || []) targetsList.appendChild(buildTargetRow(t));
  document.getElementById("add-target").addEventListener("click", () => {
    targetsList.appendChild(buildTargetRow({ name: "", teesheet_id: 1470, booking_class: 929 }));
  });

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
    try {
      const newCfg = readForm(form);
      const name = isNew ? form.elements["name"].value : existingName;
      const submitBtn = form.querySelector("button[type=submit]");
      submitBtn.disabled = true;
      submitBtn.textContent = "Saving…";
      const { sha, yaml } = await saveConfig(name, newCfg, cached?.sha);
      CACHE.set(name, { sha, cfg: newCfg, yaml });
      toast(`Saved ${name}`);
      renderList();
    } catch (e) {
      errEl.textContent = `Save failed: ${e.message}`;
      errEl.hidden = false;
      const submitBtn = form.querySelector("button[type=submit]");
      submitBtn.disabled = false;
      submitBtn.textContent = "Save";
    }
  });
}

function buildTargetRow(t) {
  const node = document.getElementById("target-row").content.cloneNode(true);
  const sheetSel = node.querySelector(".t-teesheet");
  const sheetCustom = node.querySelector(".t-teesheet-custom");
  for (const ts of TEESHEETS) {
    const opt = document.createElement("option");
    opt.value = ts.id; opt.textContent = ts.label;
    sheetSel.appendChild(opt);
  }
  const customSheet = document.createElement("option");
  customSheet.value = "custom"; customSheet.textContent = "Custom…";
  sheetSel.appendChild(customSheet);

  const classSel = node.querySelector(".t-class");
  const classCustom = node.querySelector(".t-class-custom");
  for (const bc of BOOKING_CLASSES) {
    const opt = document.createElement("option");
    opt.value = bc.id; opt.textContent = bc.label;
    classSel.appendChild(opt);
  }
  const customClass = document.createElement("option");
  customClass.value = "custom"; customClass.textContent = "Custom…";
  classSel.appendChild(customClass);

  node.querySelector(".t-name").value = t.name || "";
  if (TEESHEETS.some(ts => ts.id === t.teesheet_id)) {
    sheetSel.value = String(t.teesheet_id);
  } else if (t.teesheet_id != null) {
    sheetSel.value = "custom"; sheetCustom.value = t.teesheet_id; sheetCustom.hidden = false;
  }
  if (BOOKING_CLASSES.some(bc => bc.id === t.booking_class)) {
    classSel.value = String(t.booking_class);
  } else if (t.booking_class != null) {
    classSel.value = "custom"; classCustom.value = t.booking_class; classCustom.hidden = false;
  }
  sheetSel.addEventListener("change", () => { sheetCustom.hidden = sheetSel.value !== "custom"; });
  classSel.addEventListener("change", () => { classCustom.hidden = classSel.value !== "custom"; });

  node.querySelector(".t-del").addEventListener("click", (e) => e.target.closest(".target-row").remove());
  return node;
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
  const targets = [];
  for (const row of document.querySelectorAll("#targets-list .target-row")) {
    const name = row.querySelector(".t-name").value.trim();
    if (!name) continue;
    const sheetSel = row.querySelector(".t-teesheet");
    const teesheet_id = sheetSel.value === "custom"
      ? parseInt(row.querySelector(".t-teesheet-custom").value, 10)
      : parseInt(sheetSel.value, 10);
    const classSel = row.querySelector(".t-class");
    const booking_class = classSel.value === "custom"
      ? parseInt(row.querySelector(".t-class-custom").value, 10)
      : parseInt(classSel.value, 10);
    if (!Number.isFinite(teesheet_id) || !Number.isFinite(booking_class)) {
      throw new Error(`Target "${name}" has an invalid teesheet or booking class`);
    }
    targets.push({ name, teesheet_id, booking_class });
  }
  if (targets.length === 0) throw new Error("at least one target is required");

  const windows = [];
  for (const row of document.querySelectorAll("#windows-list .window-row")) {
    const start = row.querySelector(".w-start").value;
    const end = row.querySelector(".w-end").value;
    if (!start || !end) continue;
    const weekdays = [...row.querySelectorAll(".weekdays input:checked")].map(cb => cb.value);
    const w = { start, end };
    if (weekdays.length > 0) w.weekdays = weekdays;
    windows.push(w);
  }
  if (windows.length === 0) throw new Error("at least one time window is required");

  const maxFeeRaw = form.elements["max-fee"].value.trim();
  const cfg = {
    enabled: form.elements["enabled"].checked,
    description: form.elements["description"].value.trim() || undefined,
    targets,
    dates: {
      start: form.elements["date-start"].value.trim(),
      end: form.elements["date-end"].value.trim(),
    },
    filter: {
      holes: parseInt(form.elements["holes"].value, 10),
      min_players: parseInt(form.elements["min-players"].value, 10),
      max_green_fee: maxFeeRaw === "" ? null : Number(maxFeeRaw),
      windows,
    },
  };
  if (!cfg.description) delete cfg.description;
  return cfg;
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
