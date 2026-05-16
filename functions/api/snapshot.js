// Cloudflare Pages Function: serves the latest snapshot from KV.
//
// The monitor cron PUTs `snapshot` into the SNAPSHOT_KV namespace at the
// end of every run. The browser fetches this endpoint on home page load
// to show "current valid tee times" per check set without ever talking
// to ForeUp directly. KV bindings are configured in the Pages dashboard
// (Settings → Functions → KV namespace bindings → `SNAPSHOT_KV`).

export async function onRequestGet({ env }) {
  if (!env.SNAPSHOT_KV) {
    return json({
      generated_at: null,
      sets: {},
      error: "SNAPSHOT_KV binding not configured",
    }, 503);
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
