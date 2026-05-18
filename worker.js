// Cloudflare Worker entry. Responsibilities:
//   - GET  /api/snapshot -> return the latest tee-time snapshot from KV
//   - POST /api/dispatch -> trigger an immediate monitor run on demand
//                           (used by the UI right after a config save so the
//                           snapshot reflects the change in ~30s)
//   - everything else    -> fall through to the static assets in ui/
//   - scheduled cron     -> dispatch the GitHub monitor workflow on time
//                           (GH's own schedule trigger drifts by hours; this
//                           path uses workflow_dispatch which fires on demand)

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/snapshot") {
      return handleSnapshot(env);
    }
    if (url.pathname === "/api/dispatch" && request.method === "POST") {
      const ok = await dispatchMonitor(env);
      return new Response(null, { status: ok ? 204 : 502 });
    }
    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(dispatchMonitor(env));
  },
};

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

async function handleSnapshot(env) {
  if (!env.SNAPSHOT_KV) {
    return json({ generated_at: null, sets: {}, error: "SNAPSHOT_KV binding not configured" }, 503);
  }
  const value = await env.SNAPSHOT_KV.get("snapshot");
  if (!value) {
    return json({ generated_at: null, sets: {} });
  }
  return new Response(value, {
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}
