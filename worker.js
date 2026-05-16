// Cloudflare Worker entry. Two responsibilities:
//   - GET /api/snapshot -> return the latest tee-time snapshot from KV
//   - everything else  -> fall through to the static assets in ui/

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/snapshot") {
      return handleSnapshot(env);
    }
    return env.ASSETS.fetch(request);
  },
};

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
