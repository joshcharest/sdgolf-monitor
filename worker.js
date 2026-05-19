// Cloudflare Worker entry. Responsibilities:
//   - GET  /api/snapshot                       latest tee-time snapshot from KV
//   - POST /api/dispatch                       trigger an immediate monitor run
//   - POST /api/auth/signup                    create account (gated by INVITE_CODE)
//   - POST /api/auth/login                     exchange email+password -> session
//   - POST /api/auth/logout                    clear session cookie
//   - GET  /api/me                             return signed-in user or 401
//   - GET  /api/configs                        list all configs (auth required)
//   - POST /api/configs                        create config (auth, owner=session)
//   - PUT  /api/configs/:id                    update (auth + ownership check)
//   - DEL  /api/configs/:id                    delete (auth + ownership check)
//   - POST /api/configs/:id/subscribe          add session email to subscribers
//   - POST /api/configs/:id/unsubscribe        remove session email
//   - GET  /api/internal/configs               runner-only (Bearer RUNNER_SECRET)
//   - everything else                          static assets in ui/
//   - scheduled cron                           dispatch the GH monitor workflow

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    if (pathname === "/api/snapshot") return handleSnapshot(env);
    if (pathname === "/api/dispatch" && method === "POST") {
      const ok = await dispatchMonitor(env);
      return new Response(null, { status: ok ? 204 : 502 });
    }
    if (pathname === "/api/auth/signup" && method === "POST") return handleSignup(request, env);
    if (pathname === "/api/auth/login"  && method === "POST") return handleLogin(request, env);
    if (pathname === "/api/auth/logout" && method === "POST") return handleLogout();
    if (pathname === "/api/me"          && method === "GET")  return handleMe(request, env);

    if (pathname === "/api/internal/configs" && method === "GET") return handleInternalConfigs(request, env);
    if (pathname === "/api/internal/pending" && method === "GET") return handleInternalPending(request, env);
    const pendingMatch = pathname.match(/^\/api\/internal\/pending\/([a-z0-9-]{1,128})$/);
    if (pendingMatch && method === "DELETE") return handleInternalPendingDelete(request, env, pendingMatch[1]);

    if (pathname === "/api/bug-report" && method === "POST") return handleBugReport(request, env);
    if (pathname === "/api/internal/bugs" && method === "GET") return handleInternalBugs(request, env);
    const bugMatch = pathname.match(/^\/api\/internal\/bugs\/([a-z0-9-]{1,128})$/);
    if (bugMatch && method === "DELETE") return handleInternalBugDelete(request, env, bugMatch[1]);

    if (pathname === "/api/admin/emails" && method === "GET") return handleAdminListEmails(request, env);
    if (pathname === "/api/admin/emails" && method === "PUT") return handleAdminPutEmails(request, env);
    if (pathname === "/api/admin/users"  && method === "GET") return handleAdminListUsers(request, env);
    const userResetMatch = pathname.match(/^\/api\/admin\/users\/([^/]+)$/);
    if (userResetMatch && method === "DELETE") return handleAdminResetUser(request, env, decodeURIComponent(userResetMatch[1]));

    if (pathname === "/api/configs" && method === "GET")  return handleListConfigs(request, env);
    if (pathname === "/api/configs" && method === "POST") return handleCreateConfig(request, env);

    if (pathname === "/api/unsubscribe" && method === "GET")  return handleUnsubscribeGet(request, env);
    if (pathname === "/api/unsubscribe" && method === "POST") return handleUnsubscribePost(request, env);

    const configMatch = pathname.match(/^\/api\/configs\/([a-z0-9-]{1,128})(?:\/(subscribe|unsubscribe))?$/);
    if (configMatch) {
      const [, id, action] = configMatch;
      if (!action && method === "PUT")    return handleUpdateConfig(request, env, id);
      if (!action && method === "DELETE") return handleDeleteConfig(request, env, id);
      if (action === "subscribe"   && method === "POST") return handleSubscribe(request, env, id, true);
      if (action === "unsubscribe" && method === "POST") return handleSubscribe(request, env, id, false);
    }

    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(dispatchMonitor(env));
  },
};

// ---------- existing: snapshot + dispatch ---------------------------------

async function handleSnapshot(env) {
  if (!env.SNAPSHOT_KV) {
    return json({ generated_at: null, sets: {}, error: "SNAPSHOT_KV binding not configured" }, 503);
  }
  const value = await env.SNAPSHOT_KV.get("snapshot");
  if (!value) return json({ generated_at: null, sets: {} });
  return new Response(value, {
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

async function dispatchMonitor(env) {
  if (!env.GH_DISPATCH_TOKEN) {
    console.error("GH_DISPATCH_TOKEN not configured — skipping dispatch");
    return false;
  }
  const resp = await fetch(
    "https://api.github.com/repos/joshcharest/sdgolf-monitor/actions/workflows/monitor.yml/dispatches",
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.GH_DISPATCH_TOKEN}`,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "sdgolf-monitor-cron",
      },
      body: JSON.stringify({ ref: "main" }),
    },
  );
  if (resp.status !== 204) {
    console.error("dispatch failed:", resp.status, await resp.text());
    return false;
  }
  console.log("dispatched monitor workflow");
  return true;
}

// ---------- auth ----------------------------------------------------------

const COOKIE_NAME = "sdgolf_session";
const SESSION_TTL_SEC = 30 * 24 * 60 * 60;  // 30 days
// 600k iter is OWASP 2023, but Cloudflare Workers Free has a hard 10ms CPU
// budget per request and ~600k blows past it. 100k fits with margin and the
// pepper does most of the heavy lifting against offline cracking anyway.
const PBKDF2_ITERATIONS = 100_000;
const PASSWORD_HASH_VERSION = 2;  // v1 = no pepper; v2 = pepper-prefixed input

async function handleSignup(request, env) {
  if (!authSecretsReady(env)) return json({ error: "auth not configured" }, 503);
  const body = await safeJson(request);
  const email = normaliseEmail(body?.email);
  const password = typeof body?.password === "string" ? body.password : "";
  if (!email || !password) return json({ error: "email and password required" }, 400);
  if (password.length < 8) return json({ error: "password must be at least 8 characters" }, 400);
  if (!await emailIsAllowed(email, env)) {
    return json({ error: "this email is not on the allow list — ask the admin to add it" }, 403);
  }
  if (await env.SNAPSHOT_KV.get(`user:${email}`)) {
    return json({ error: "account already exists" }, 409);
  }
  const stored = await hashPassword(password, env);
  await env.SNAPSHOT_KV.put(`user:${email}`, JSON.stringify({
    ...stored,
    created_at: new Date().toISOString(),
  }));
  return sessionResponse(email, env, 201);
}

async function emailIsAllowed(email, env) {
  const list = await readAllowedEmails(env);
  return list.includes(email);
}

// KV is the source of truth once the admin has saved a list. The
// ALLOWED_EMAILS secret is used only as the initial bootstrap value
// for the very first signup before any admin write has happened.
async function readAllowedEmails(env) {
  if (env.SNAPSHOT_KV) {
    const kvJson = await env.SNAPSHOT_KV.get("allowed_emails");
    if (kvJson) {
      try {
        const list = JSON.parse(kvJson);
        if (Array.isArray(list)) {
          return list.map(e => String(e).trim().toLowerCase()).filter(Boolean);
        }
      } catch { /* fall through */ }
    }
  }
  return (env.ALLOWED_EMAILS || "")
    .split(",")
    .map(e => e.trim().toLowerCase())
    .filter(Boolean);
}

function adminEmails(env) {
  // Comma-separated email list for admin privileges. Hardcoded default lets
  // the maintainer manage things without yet another Worker secret.
  const raw = env.ADMIN_EMAILS || "sdgolfmonitor@gmail.com";
  return raw.split(",").map(e => e.trim().toLowerCase()).filter(Boolean);
}

function isAdminSession(session, env) {
  return Boolean(session) && adminEmails(env).includes(session.email);
}

async function requireAdmin(request, env) {
  const session = await getSession(request, env);
  if (!session) return json({ error: "not signed in" }, 401);
  if (!isAdminSession(session, env)) return json({ error: "forbidden" }, 403);
  return session;
}

async function handleAdminListEmails(request, env) {
  const session = await requireAdmin(request, env);
  if (session instanceof Response) return session;
  return json({ emails: await readAllowedEmails(env) });
}

async function handleAdminPutEmails(request, env) {
  const session = await requireAdmin(request, env);
  if (session instanceof Response) return session;
  const body = await safeJson(request);
  if (!body || !Array.isArray(body.emails)) {
    return json({ error: "expected { emails: [string, ...] }" }, 400);
  }
  const cleaned = body.emails
    .map(e => String(e).trim().toLowerCase())
    .filter(e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
  const admins = new Set(adminEmails(env));
  // Always keep admins on the list so a save can't lock the admin out.
  const final = [...new Set([...admins, ...cleaned])].sort();

  // Anyone dropped from the previous list (and not an admin) gets their
  // user record deleted, which kills their session on the next API call
  // and prevents them from re-logging-in.
  const previous = new Set(await readAllowedEmails(env));
  const removed = [...previous].filter(e => !final.includes(e) && !admins.has(e));
  for (const email of removed) {
    await env.SNAPSHOT_KV.delete(`user:${email}`);
  }

  await env.SNAPSHOT_KV.put("allowed_emails", JSON.stringify(final));
  return json({ emails: final, removed });
}

async function handleAdminListUsers(request, env) {
  const session = await requireAdmin(request, env);
  if (session instanceof Response) return session;
  const emails = [];
  let cursor;
  do {
    const page = await env.SNAPSHOT_KV.list({ prefix: "user:", cursor });
    for (const k of page.keys) emails.push(k.name.slice("user:".length));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  emails.sort();
  return json({ emails });
}

async function handleAdminResetUser(request, env, email) {
  const session = await requireAdmin(request, env);
  if (session instanceof Response) return session;
  const normalised = normaliseEmail(email);
  if (!normalised) return json({ error: "email required" }, 400);
  await env.SNAPSHOT_KV.delete(`user:${normalised}`);
  return new Response(null, { status: 204 });
}

async function handleLogin(request, env) {
  if (!authSecretsReady(env)) return json({ error: "auth not configured" }, 503);
  const body = await safeJson(request);
  const email = normaliseEmail(body?.email);
  const password = typeof body?.password === "string" ? body.password : "";
  if (!email || !password) return json({ error: "email and password required" }, 400);
  const userJson = await env.SNAPSHOT_KV.get(`user:${email}`);
  if (!userJson) return json({ error: "invalid credentials" }, 401);
  const user = JSON.parse(userJson);
  if (!await verifyPassword(password, user, env)) {
    return json({ error: "invalid credentials" }, 401);
  }
  // No auto-upgrade: running pbkdf2 a second time in the same request
  // exceeds the Workers Free 10ms CPU budget and returns 500. v1 records
  // (no pepper) remain valid for verification; new signups are v2.
  return sessionResponse(email, env, 200);
}

function handleLogout() {
  return new Response(null, {
    status: 204,
    headers: { "Set-Cookie": cookieHeader(COOKIE_NAME, "", 0) },
  });
}

async function handleMe(request, env) {
  const session = await getSession(request, env);
  if (!session) return json({ error: "not signed in" }, 401);
  return json({ email: session.email, is_admin: isAdminSession(session, env) });
}

function authSecretsReady(env) {
  return Boolean(env.SNAPSHOT_KV && env.SESSION_SECRET && env.ALLOWED_EMAILS && env.PASSWORD_PEPPER);
}

async function getSession(request, env) {
  if (!env.SESSION_SECRET) return null;
  const token = readCookie(request, COOKIE_NAME);
  if (!token) return null;
  const payload = await verifySession(token, env.SESSION_SECRET);
  if (!payload) return null;
  // Re-verify the user record still exists in KV — admins can revoke a user
  // by removing them from the allow list, which deletes user:<email>.
  // Without this check, a stolen-cookie or removed-user would keep working
  // until the cookie's 30-day expiry.
  if (!env.SNAPSHOT_KV) return null;
  const userRec = await env.SNAPSHOT_KV.get(`user:${payload.email}`);
  if (!userRec) return null;
  return payload;
}

async function sessionResponse(email, env, status) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SEC;
  const token = await signSession({ email, exp }, env.SESSION_SECRET);
  const is_admin = adminEmails(env).includes(email);
  return new Response(JSON.stringify({ email, is_admin }), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": cookieHeader(COOKIE_NAME, token, SESSION_TTL_SEC),
    },
  });
}

// ---------- configs CRUD ---------------------------------------------------

async function handleListConfigs(request, env) {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  const configs = await loadAllConfigs(env);
  return json(configs);
}

async function handleCreateConfig(request, env) {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  const body = await safeJson(request);
  const err = validateConfigPayload(body);
  if (err) return json({ error: err }, 400);
  const id = `${slugify(body.name)}-${randomIdSuffix()}`;
  const now = new Date().toISOString();
  const config = buildConfig({}, body, {
    id,
    owner: session.email,
    subscribers: [],
    created_at: now,
    updated_at: now,
  });
  await env.SNAPSHOT_KV.put(`config:${id}`, JSON.stringify(config));
  await indexAdd(env, "configs_index", "config:", id);
  await stampPendingConfirmation(env, "create", session.email, id);
  return json(config, 201);
}

async function handleUpdateConfig(request, env, id) {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  const existing = await readConfig(env, id);
  if (!existing) return json({ error: "not found" }, 404);
  if (existing.owner !== session.email) return json({ error: "forbidden" }, 403);
  const body = await safeJson(request);
  const err = validateConfigPayload(body);
  if (err) return json({ error: err }, 400);
  const updated = buildConfig(existing, body, {
    id: existing.id,
    owner: existing.owner,                            // owner is immutable
    subscribers: existing.subscribers || [],          // can't edit subscribers via PUT
    created_at: existing.created_at,
    updated_at: new Date().toISOString(),
  });
  await env.SNAPSHOT_KV.put(`config:${id}`, JSON.stringify(updated));
  return json(updated);
}

async function handleDeleteConfig(request, env, id) {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  const existing = await readConfig(env, id);
  if (!existing) return json({ error: "not found" }, 404);
  if (existing.owner !== session.email) return json({ error: "forbidden" }, 403);
  await env.SNAPSHOT_KV.delete(`config:${id}`);
  await indexRemove(env, "configs_index", "config:", id);
  return new Response(null, { status: 204 });
}

async function handleSubscribe(request, env, id, subscribing) {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  const existing = await readConfig(env, id);
  if (!existing) return json({ error: "not found" }, 404);
  const wasSubscribed = (existing.subscribers || []).includes(session.email);
  const subs = new Set(existing.subscribers || []);
  if (subscribing) subs.add(session.email); else subs.delete(session.email);
  // The owner is implicitly always notified; never let them subscribe themselves.
  subs.delete(existing.owner);
  existing.subscribers = [...subs];
  existing.updated_at = new Date().toISOString();
  await env.SNAPSHOT_KV.put(`config:${id}`, JSON.stringify(existing));
  // Only stamp a confirmation for *new* subscriptions (not re-clicks or unsubscribes).
  if (subscribing && !wasSubscribed && session.email !== existing.owner) {
    await stampPendingConfirmation(env, "subscribe", session.email, id);
  }
  return json(existing);
}

// Email unsubscribe split into GET (confirm page, no side effect) and POST
// (actually unsubscribes). Splitting matters because some email clients and
// corporate link scanners (Outlook Safe Links, antivirus prefetchers) issue
// GETs against URLs in messages to scan them for malware — a GET-driven
// unsubscribe would let those scanners silently opt people out. The
// confirmation page submits a POST so a real human has to click.
//
// The List-Unsubscribe-Post header in the email tells Gmail / Apple Mail
// the URL accepts a one-click POST directly, so users hitting the client's
// built-in Unsubscribe button never see the confirm page. (RFC 8058.)
async function handleUnsubscribeGet(request, env) {
  const url = new URL(request.url);
  const token = url.searchParams.get("t") || "";
  if (!env.RUNNER_SECRET) return unsubPage("Unsubscribe is not configured on this deployment.", 503);
  const payload = await verifyUnsubscribeToken(token, env.RUNNER_SECRET);
  if (!payload) return unsubPage("This unsubscribe link is invalid or has expired.", 400);

  const cfg = await readConfig(env, payload.config_id);
  if (!cfg) return unsubPage("This check set no longer exists — nothing to unsubscribe from.", 404);

  if (payload.email === cfg.owner) {
    return unsubPage(
      `You own <strong>${escapeHtml(cfg.name)}</strong>, so you receive its emails automatically. ` +
      `To stop them, sign in and delete the check set.`,
      200,
    );
  }
  return unsubConfirmPage(token, payload.email, cfg.name);
}

async function handleUnsubscribePost(request, env) {
  const url = new URL(request.url);
  // Token can come from the query string (header-driven one-click) or the
  // form body (confirm-page submit). Accept either.
  let token = url.searchParams.get("t") || "";
  if (!token) {
    const ct = request.headers.get("content-type") || "";
    if (ct.includes("application/x-www-form-urlencoded")) {
      try {
        const form = await request.formData();
        token = String(form.get("t") || "");
      } catch { /* ignore */ }
    }
  }
  if (!env.RUNNER_SECRET) return unsubPage("Unsubscribe is not configured on this deployment.", 503);
  const payload = await verifyUnsubscribeToken(token, env.RUNNER_SECRET);
  if (!payload) return unsubPage("This unsubscribe link is invalid or has expired.", 400);

  const cfg = await readConfig(env, payload.config_id);
  if (!cfg) return unsubPage("This check set no longer exists — nothing to unsubscribe from.", 404);

  if (payload.email === cfg.owner) {
    return unsubPage(
      `You own <strong>${escapeHtml(cfg.name)}</strong>, so you receive its emails automatically. ` +
      `To stop them, sign in and delete the check set.`,
      200,
    );
  }
  const subs = new Set(cfg.subscribers || []);
  if (subs.delete(payload.email)) {
    cfg.subscribers = [...subs];
    cfg.updated_at = new Date().toISOString();
    await env.SNAPSHOT_KV.put(`config:${cfg.id}`, JSON.stringify(cfg));
  }
  return unsubPage(
    `Unsubscribed <strong>${escapeHtml(payload.email)}</strong> from <strong>${escapeHtml(cfg.name)}</strong>. ` +
    `You will no longer receive new-tee-time emails for this check set.`,
    200,
  );
}

function unsubConfirmPage(token, email, setName) {
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>Unsubscribe — sdgolf</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body { font-family: -apple-system, system-ui, sans-serif; max-width: 520px; margin: 80px auto; padding: 0 20px; color: #222; line-height: 1.5; }
  .card { background: #fff; border: 1px solid #e5e5e5; border-radius: 8px; padding: 28px; }
  a { color: #1565c0; }
  h1 { font-size: 18px; margin: 0 0 12px 0; }
  button { background: #1565c0; color: #fff; border: 0; padding: 10px 20px; border-radius: 6px; font-size: 14px; cursor: pointer; }
  button:hover { background: #0d47a1; }
</style></head>
<body><div class="card">
  <h1>sdgolf</h1>
  <p>Unsubscribe <strong>${escapeHtml(email)}</strong> from <strong>${escapeHtml(setName)}</strong>?</p>
  <form method="POST" action="/api/unsubscribe">
    <input type="hidden" name="t" value="${escapeHtml(token)}">
    <button type="submit">Unsubscribe</button>
  </form>
  <p><a href="/">Back to sdgolf</a></p>
</div></body></html>`;
  return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

async function verifyUnsubscribeToken(token, secret) {
  const dot = token.lastIndexOf(".");
  if (dot < 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = await hmacSha256(secret, body);
  if (!constantTimeEqStr(sig, expected)) return null;
  let payload;
  try { payload = JSON.parse(b64urlDecodeStr(body)); } catch { return null; }
  if (typeof payload.exp !== "number" || payload.exp < Math.floor(Date.now() / 1000)) return null;
  if (typeof payload.email !== "string") return null;
  if (typeof payload.config_id !== "string") return null;
  return payload;
}

function unsubPage(message, status) {
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>Unsubscribe — sdgolf</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body { font-family: -apple-system, system-ui, sans-serif; max-width: 520px; margin: 80px auto; padding: 0 20px; color: #222; line-height: 1.5; }
  .card { background: #fff; border: 1px solid #e5e5e5; border-radius: 8px; padding: 28px; }
  a { color: #1565c0; }
  h1 { font-size: 18px; margin: 0 0 12px 0; }
</style></head>
<body><div class="card"><h1>sdgolf</h1><p>${message}</p><p><a href="/">Back to sdgolf</a></p></div></body></html>`;
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

async function handleInternalConfigs(request, env) {
  if (!checkRunnerSecret(request, env)) return json({ error: "forbidden" }, 403);
  const configs = await loadAllConfigs(env);
  return json(configs);
}

async function handleInternalPending(request, env) {
  if (!checkRunnerSecret(request, env)) return json({ error: "forbidden" }, 403);
  const ids = await loadIndex(env, "pending_index", "pending:");
  const values = await Promise.all(ids.map(id => env.SNAPSHOT_KV.get(`pending:${id}`)));
  const out = [];
  for (let i = 0; i < ids.length; i++) {
    const v = values[i];
    if (!v) continue;
    try { out.push({ key: `pending:${ids[i]}`, ...JSON.parse(v) }); } catch { /* skip */ }
  }
  return json(out);
}

async function handleInternalPendingDelete(request, env, id) {
  if (!checkRunnerSecret(request, env)) return json({ error: "forbidden" }, 403);
  await env.SNAPSHOT_KV.delete(`pending:${id}`);
  await indexRemove(env, "pending_index", "pending:", id);
  return new Response(null, { status: 204 });
}

function checkRunnerSecret(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const provided = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  return Boolean(env.RUNNER_SECRET) && constantTimeEqStr(provided, env.RUNNER_SECRET);
}

async function handleBugReport(request, env) {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  const body = await safeJson(request);
  const description = typeof body?.description === "string" ? body.description.trim() : "";
  if (!description) return json({ error: "description required" }, 400);
  // Cap field sizes so a malicious payload can't blow up KV. KV values can
  // be up to 25 MiB but we don't need anything close to that.
  const trim = (s, n) => typeof s === "string" ? s.slice(0, n) : "";
  const id = `${Date.now().toString(36)}-${randomIdSuffix()}`;
  const record = {
    id,
    email: session.email,
    description: trim(description, 8000),
    view: trim(body?.view, 200),
    user_agent: trim(body?.user_agent, 400),
    url: trim(body?.url, 500),
    logs: Array.isArray(body?.logs) ? body.logs.slice(-100) : [],
    ts: new Date().toISOString(),
  };
  await env.SNAPSHOT_KV.put(`bug:${id}`, JSON.stringify(record));
  await indexAdd(env, "bug_index", "bug:", id);
  return json({ id }, 201);
}

async function handleInternalBugs(request, env) {
  if (!checkRunnerSecret(request, env)) return json({ error: "forbidden" }, 403);
  const ids = await loadIndex(env, "bug_index", "bug:");
  const values = await Promise.all(ids.map(id => env.SNAPSHOT_KV.get(`bug:${id}`)));
  const out = [];
  for (let i = 0; i < ids.length; i++) {
    const v = values[i];
    if (!v) continue;
    try { out.push({ key: `bug:${ids[i]}`, ...JSON.parse(v) }); } catch { /* skip */ }
  }
  return json(out);
}

async function handleInternalBugDelete(request, env, id) {
  if (!checkRunnerSecret(request, env)) return json({ error: "forbidden" }, 403);
  await env.SNAPSHOT_KV.delete(`bug:${id}`);
  await indexRemove(env, "bug_index", "bug:", id);
  return new Response(null, { status: 204 });
}

async function stampPendingConfirmation(env, action, email, configId) {
  const id = `${Date.now().toString(36)}-${randomIdSuffix()}`;
  const record = { id, action, email, config_id: configId, ts: new Date().toISOString() };
  await env.SNAPSHOT_KV.put(`pending:${id}`, JSON.stringify(record));
  await indexAdd(env, "pending_index", "pending:", id);
}

async function requireSession(request, env) {
  const session = await getSession(request, env);
  if (!session) return json({ error: "not signed in" }, 401);
  return session;
}

async function readConfig(env, id) {
  if (!/^[a-z0-9-]{1,128}$/.test(id)) return null;
  const v = await env.SNAPSHOT_KV.get(`config:${id}`);
  return v ? JSON.parse(v) : null;
}

async function loadAllConfigs(env) {
  const ids = await loadIndex(env, "configs_index", "config:");
  const values = await Promise.all(ids.map(id => env.SNAPSHOT_KV.get(`config:${id}`)));
  const out = [];
  for (const v of values) if (v) out.push(JSON.parse(v));
  return out;
}

// Maintain a JSON index per prefix so reads don't need KV list operations.
// Lists count against a small daily free-tier quota (1k/day); reads have a
// huge one (100k). Lazy bootstrap: first read of a missing index does a
// one-time list to populate it, so this is safe to roll out without a
// migration script.
async function loadIndex(env, indexKey, listPrefix) {
  const cached = await env.SNAPSHOT_KV.get(indexKey);
  if (cached) {
    try {
      const arr = JSON.parse(cached);
      if (Array.isArray(arr)) return arr;
    } catch { /* fall through to rebuild */ }
  }
  const ids = [];
  let cursor;
  do {
    const page = await env.SNAPSHOT_KV.list({ prefix: listPrefix, cursor });
    for (const k of page.keys) ids.push(k.name.slice(listPrefix.length));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  await env.SNAPSHOT_KV.put(indexKey, JSON.stringify(ids));
  return ids;
}

async function indexAdd(env, indexKey, listPrefix, id) {
  const ids = await loadIndex(env, indexKey, listPrefix);
  if (ids.includes(id)) return;
  ids.push(id);
  await env.SNAPSHOT_KV.put(indexKey, JSON.stringify(ids));
}

async function indexRemove(env, indexKey, listPrefix, id) {
  const ids = await loadIndex(env, indexKey, listPrefix);
  const next = ids.filter(x => x !== id);
  if (next.length === ids.length) return;
  await env.SNAPSHOT_KV.put(indexKey, JSON.stringify(next));
}

function buildConfig(existing, body, overrides) {
  return {
    name: typeof body.name === "string" ? body.name : existing.name,
    enabled: body.enabled !== undefined ? Boolean(body.enabled) : (existing.enabled ?? true),
    targets: Array.isArray(body.targets) ? body.targets : (existing.targets || []),
    dates: body.dates && typeof body.dates === "object" ? body.dates : (existing.dates || {}),
    filter: body.filter && typeof body.filter === "object" ? body.filter : (existing.filter || {}),
    ...overrides,
  };
}

function validateConfigPayload(body) {
  if (!body || typeof body !== "object") return "invalid body";
  if (!body.name || typeof body.name !== "string") return "name required";
  if (!Array.isArray(body.targets) || body.targets.length === 0) return "at least one target required";
  if (!body.dates || typeof body.dates !== "object") return "dates required";
  if (!body.filter || typeof body.filter !== "object") return "filter required";
  return null;
}

function slugify(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "set";
}

function randomIdSuffix() {
  const bytes = crypto.getRandomValues(new Uint8Array(2));
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

// ---------- crypto helpers -------------------------------------------------

async function hashPassword(password, env) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await pbkdf2(password + env.PASSWORD_PEPPER, salt, PBKDF2_ITERATIONS);
  return {
    version: PASSWORD_HASH_VERSION,
    hash: b64encode(bits),
    salt: b64encode(salt),
    iterations: PBKDF2_ITERATIONS,
  };
}

async function verifyPassword(password, stored, env) {
  if (!stored?.hash || !stored?.salt || !stored?.iterations) return false;
  const salt = b64decode(stored.salt);
  // v2 records were hashed as (password + pepper). v1 (no version field) used
  // password alone. Keep both verification paths so existing users keep
  // working until they next log in and get auto-upgraded.
  const input = stored.version === 2 ? password + env.PASSWORD_PEPPER : password;
  const bits = await pbkdf2(input, salt, stored.iterations);
  return constantTimeEqBytes(bits, b64decode(stored.hash));
}


async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    key,
    256,
  );
  return new Uint8Array(bits);
}

async function signSession(payload, secret) {
  const body = b64urlEncodeStr(JSON.stringify(payload));
  const sig = await hmacSha256(secret, body);
  return `${body}.${sig}`;
}

async function verifySession(token, secret) {
  const dot = token.lastIndexOf(".");
  if (dot < 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = await hmacSha256(secret, body);
  if (!constantTimeEqStr(sig, expected)) return null;
  let payload;
  try { payload = JSON.parse(b64urlDecodeStr(body)); } catch { return null; }
  if (typeof payload.exp !== "number" || payload.exp < Math.floor(Date.now() / 1000)) return null;
  if (typeof payload.email !== "string") return null;
  return payload;
}

async function hmacSha256(secret, data) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return b64urlEncodeBytes(new Uint8Array(sig));
}

function constantTimeEqBytes(a, b) {
  if (a.byteLength !== b.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < a.byteLength; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function constantTimeEqStr(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---------- cookie + json helpers -----------------------------------------

function readCookie(request, name) {
  const cookie = request.headers.get("Cookie") || "";
  const m = cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return m ? decodeURIComponent(m[1]) : null;
}

function cookieHeader(name, value, maxAgeSec) {
  const parts = [`${name}=${encodeURIComponent(value)}`, "Path=/", "HttpOnly", "Secure", "SameSite=Lax"];
  if (maxAgeSec === 0) parts.push("Max-Age=0");
  else if (maxAgeSec) parts.push(`Max-Age=${maxAgeSec}`);
  return parts.join("; ");
}

async function safeJson(request) {
  try { return await request.json(); } catch { return null; }
}

function normaliseEmail(s) {
  if (typeof s !== "string") return "";
  const trimmed = s.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed) ? trimmed : "";
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

// ---------- base64 helpers ------------------------------------------------

function b64encode(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function b64decode(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlEncodeBytes(bytes) {
  return b64encode(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlEncodeStr(s) {
  return b64urlEncodeBytes(new TextEncoder().encode(s));
}

function b64urlDecodeStr(s) {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(s.length + (4 - (s.length % 4)) % 4, "=");
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
