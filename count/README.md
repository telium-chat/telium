# The deployment counter

The endpoint behind the server's `[usage]` config section: telium-server
installations that leave `usage.report = true` (the default) POST once a day
carrying exactly

```json
{ "id": "a random id minted once per server", "users": 41 }
```

and this worker keeps one KV row per id and answers one question: how many
servers are there, and how many people use them in total.

## What is stored, and what is not

- One KV row per reporting server, key `server:<id>`, value carrying the user
  count, with a 35-day sliding expiry refreshed on every ping. A server that
  stops reporting is counted for 35 more days, so the totals honestly mean
  "servers heard from in the last month" — a census of the living, not of
  every install ever run.
- **No IP addresses.** No request logs, ever: `wrangler tail` stays off in
  production, and no log push, analytics binding or observability hook is
  added to this worker. An IP that is never written down is an IP that was
  never collected.
- The `id` is random, minted by the server on first report (`util::ulid()`),
  and is not derived from the server's name, domain, or federation key. The
  collector cannot connect a row to a deployment it could name. The numbers
  are aggregate and honor-system: a modified server can report anything, so
  treat the totals as a floor, not a census.

This is the collector half of a promise worded on the server side
(`server/src/usage.rs`, `docs/privacy.md`): two numbers, nothing else. The
worker refuses any ping with fields other than `id` and `users`, which keeps
this half of the promise enforced even if the server half ever drifts.

## Reading the numbers

```sh
curl -H "Authorization: Bearer $STATS_TOKEN" https://count.telium.chat/stats
```

```json
{ "servers": 137, "users": 48210 }
```

Without the token the endpoint answers 404 like every other path. The token
is set once with `wrangler secret put STATS_TOKEN`.

## Deploying

```sh
cd count
wrangler secret put STATS_TOKEN      # a long random string; this is the only key to the totals
wrangler deploy                      # then bind the count.telium.chat route in the dashboard
```

The `COUNT` namespace id in `wrangler.jsonc` is the project's own. A fork deploying
its own collector runs `wrangler kv namespace create COUNT` and swaps in its id.

## Tests

```sh
node --test test/
```

The validation and aggregation live in `src/validate.js`, free of any
Cloudflare API, so the promise is testable with nothing but node.
