// Cloudflare Worker entry. Responsibilities:
//   - GET  /api/snapshot       -> return the latest tee-time snapshot from KV
//   - POST /api/dispatch       -> trigger an immediate monitor run on demand
//   - POST /api/auth/signup    -> create a user account (gated by INVITE_CODE)
//   - POST /api/auth/login     -> exchange email+password for a session cookie
//   - POST /api/auth/logout    -> clear the session cookie
//   - GET  /api/me             -> return the signed-in user, or 401
//   - everything else          -> fall through to the static assets in ui/
//   - scheduled cron           -> dispatch the GitHub monitor workflow on time

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
const PBKDF2_ITERATIONS = 100_000;

async function handleSignup(request, env) {
  if (!authSecretsReady(env)) return json({ error: "auth not configured" }, 503);
  const body = await safeJson(request);
  const email = normaliseEmail(body?.email);
  const password = typeof body?.password === "string" ? body.password : "";
  const inviteCode = typeof body?.invite_code === "string" ? body.invite_code : "";
  if (!email || !password) return json({ error: "email and password required" }, 400);
  if (password.length < 8) return json({ error: "password must be at least 8 characters" }, 400);
  if (!constantTimeEqStr(inviteCode, env.INVITE_CODE)) {
    return json({ error: "invalid invite code" }, 403);
  }
  if (await env.SNAPSHOT_KV.get(`user:${email}`)) {
    return json({ error: "account already exists" }, 409);
  }
  const stored = await hashPassword(password);
  await env.SNAPSHOT_KV.put(`user:${email}`, JSON.stringify({
    ...stored,
    created_at: new Date().toISOString(),
  }));
  return sessionResponse(email, env, 201);
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
  if (!await verifyPassword(password, user)) {
    return json({ error: "invalid credentials" }, 401);
  }
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
  return json({ email: session.email });
}

function authSecretsReady(env) {
  return Boolean(env.SNAPSHOT_KV && env.SESSION_SECRET && env.INVITE_CODE);
}

async function getSession(request, env) {
  if (!env.SESSION_SECRET) return null;
  const token = readCookie(request, COOKIE_NAME);
  if (!token) return null;
  return await verifySession(token, env.SESSION_SECRET);
}

async function sessionResponse(email, env, status) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SEC;
  const token = await signSession({ email, exp }, env.SESSION_SECRET);
  return new Response(JSON.stringify({ email }), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": cookieHeader(COOKIE_NAME, token, SESSION_TTL_SEC),
    },
  });
}

// ---------- crypto helpers -------------------------------------------------

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return {
    hash: b64encode(bits),
    salt: b64encode(salt),
    iterations: PBKDF2_ITERATIONS,
  };
}

async function verifyPassword(password, stored) {
  if (!stored?.hash || !stored?.salt || !stored?.iterations) return false;
  const salt = b64decode(stored.salt);
  const bits = await pbkdf2(password, salt, stored.iterations);
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
