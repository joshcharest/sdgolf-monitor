// Cloudflare Worker entry. Three responsibilities:
//   - GET /api/snapshot -> return the latest tee-time snapshot from KV
//   - everything else   -> fall through to the static assets in ui/
//   - scheduled cron    -> dispatch the GitHub monitor workflow on time
//                          (GH's own schedule trigger drifts by hours; this
//                          path uses workflow_dispatch which fires on demand)

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/snapshot") {
      return handleSnapshot(env);
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
    return;
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
  } else {
    console.log("dispatched monitor workflow");
  }
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
