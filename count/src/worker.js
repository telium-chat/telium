//! The deployment counter. See ../README.md for what is stored and why.
//!
//!   POST /ping  -- `{id, users}`; upserts one KV row with a sliding TTL.
//!   GET /stats  -- the aggregate, for whoever holds STATS_TOKEN. Nobody else.
//!
//! Request logging is never enabled on this worker. The only thing an access
//! log would add to the picture is a history of IP addresses, which is the
//! one thing this whole design exists not to collect.

import { aggregate, TTL_DAYS, validatePing } from "./validate.js";

// A legal ping is a fraction of this; the limit exists so a confused client
// cannot park megabytes in a worker's memory.
const PING_BODY_LIMIT = 1024;

function json(data, status = 200) {
  return new Response(JSON.stringify(data) + "\n", {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/ping") {
      const text = await request.text();
      if (text.length > PING_BODY_LIMIT) return json({ error: "too large" }, 413);
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        return json({ error: "not JSON" }, 400);
      }
      const ping = validatePing(parsed);
      if (!ping) return json({ error: "a ping is {id, users}" }, 400);
      // The value is the existence marker; the count travels in the metadata,
      // because KV list() returns metadata and never values, and /stats must
      // stay one list call rather than one read per server.
      await env.COUNT.put(`server:${ping.id}`, "1", {
        metadata: { users: ping.users },
        expirationTtl: TTL_DAYS * 24 * 60 * 60,
      });
      return new Response(null, { status: 204 });
    }

    if (request.method === "GET" && url.pathname === "/stats") {
      const expected = env.STATS_TOKEN ?? "";
      const got = (request.headers.get("authorization") ?? "").replace(/^Bearer /, "");
      // One answer for "no token" and "wrong token" alike, and a 404 rather
      // than a 401, so a probe does not even learn that a stats endpoint is
      // what lives here.
      if (expected === "" || got !== expected) return json({ error: "not found" }, 404);
      const rows = [];
      let cursor;
      do {
        const page = await env.COUNT.list({ prefix: "server:", cursor });
        for (const key of page.keys) rows.push({ users: key.metadata?.users });
        cursor = page.list_complete ? undefined : page.cursor;
      } while (cursor !== undefined);
      return json(aggregate(rows));
    }

    return json({ error: "not found" }, 404);
  },
};
