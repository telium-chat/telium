# Adding your homeserver

The directory at [telium.chat/servers](https://telium.chat/servers) is this folder. There
is no application form, no approval queue and no database — you open a pull request against
`servers.json`, and when it merges the site rebuilds with your server in it.

## What you supply, and what you don't

`servers.json` holds only the facts and preferences a machine cannot determine for you:

| Field | Why it's here |
|---|---|
| `domain` | The Telium domain — the part after the colon in `@you:domain`. |
| `name` | What you call the server. |
| `description` | One sentence: who runs it and who it's for. |
| `region` | Where it physically is, plus a code the table sorts on. |
| `size_band` | Roughly how many accounts. Nothing in Telium exposes a count, so this is yours to declare. |
| `operator` | Who to contact. |
| `recommendations` | Optional explicit consent to be considered for automatic beginner account-home referrals. |
| `added` | The day the entry was opened. This is transparent registry metadata, not proof of recommendation age. |

Everything else on that page — whether registration is open, your protocol and server
version, which of the three roles you run, your feature flags, your maximum upload size,
whether you have announced a move or a sunset, and whether the running server currently
accepts automatic referrals — is read from your server every hour by
[`scripts/probe.mjs`](../scripts/probe.mjs), from the two endpoints every Telium
deployment already answers:

```
GET https://<domain>/.well-known/telium/server
GET <api>/_telium/v1/capabilities
```

Nothing self-declared appears in a column that a probe could fill. Uptime is our own
30-day record of those probes. Latency is measured in each visitor's browser, against your
server, and never touches this file.

The practical consequence: **you cannot list a closed server as open.** The page reads
`registration_open` off your own `/capabilities` response, and if it says `false` your row
appears filtered out of the default view. Change the setting on your server, not here.

## Requirements

1. **Open registration.** The directory exists so a stranger has somewhere to go. If your
   server needs an invite, it belongs in your community's own links, not here.
2. **Reachable over HTTPS** at `https://<domain>/.well-known/telium/server`, with a
   certificate that validates. A server the probe cannot reach shows as unreachable, which
   helps nobody.
3. **A contact that reaches a person** — an `https://` page or a `mailto:` address that is
   read. This is how anyone reports abuse originating on your server.
4. **You run it.** List your own server. Don't list someone else's.

There is no rule about size, uptime, funding, moderation policy or how long you have been
running merely to appear in the directory. The table shows what is measurably true and
lets people choose.

## Automatic account-home recommendations are opt-in

Being in the directory does **not** volunteer your server to receive automatic beginner
signups. Those referrals can create real storage, abuse-handling and support load, so
Telium requires consent in two independent places.

First, opt in publicly in your registry entry:

```json
"recommendations": { "opt_in": true }
```

Omit `recommendations` or use `"opt_in": false` to remain directory-only.

Second, the running homeserver must advertise that it currently accepts referrals through
`/_telium/v1/capabilities`. The server-side configuration controls that live signal and a
small bounded referral weight. Turning it off takes effect at the next directory probe;
you do not need another registry pull request just to pause growth.

The recommendation generator then applies additional mechanical gates: the server must be
reachable, open for registration, identity-capable, protocol-compatible, not moving or
sunsetting, backed by enough probe samples, and above the published uptime threshold. Its
reported identity domain must match the registry entry and the probed API origin must be
HTTPS.

New servers also have to **age in through observed probe history**. The initial rule is
seven days of observation. The registry's `added` date must also be old enough, but it is
not trusted on its own: backdating that field cannot make a newly observed endpoint enter
the beginner recommendation pool early.

Referral weight is clamped, so declaring more capacity cannot let one server monopolize
automatic signup traffic.

This is intentionally stricter than being listed. Recommendation means **eligible for the
beginner flow under published criteria**, not an endorsement or guarantee by Telium.

## Opening the pull request

1. Fork this repository and add your entry to `site/registry/servers.json`.
2. Keep the file sorted by domain, with `telium.chat` first. The validator enforces this so
   two operators adding themselves the same week never conflict over row order.
3. Run the validator and recommendation tests:

   ```sh
   cd site
   bun install
   bun run validate
   bun run test:recommendations
   bun run recommendations:check
   ```

   They check the same rules CI does and report problems in plain language.
4. Open the PR. CI runs the validator; the scheduled directory probe checks your live
   server state after changes merge.

An entry looks like this:

```json
{
  "domain": "chat.example.org",
  "name": "Example Chat",
  "description": "General-purpose homeserver for the Example community, open registration.",
  "region": { "label": "Frankfurt, DE", "code": "eu-central" },
  "size_band": "100-1k",
  "operator": {
    "name": "Example Collective",
    "contact": "https://example.org/contact"
  },
  "recommendations": { "opt_in": true },
  "added": "2026-08-19"
}
```

`region.code` must be one of: `af-south`, `ap-east`, `ap-south`, `ap-southeast`,
`eu-central`, `eu-north`, `eu-west`, `me-central`, `na-central`, `na-east`, `na-west`,
`oc-southeast`, `sa-east`. Pick the one nearest your hardware — it is a sort key, not a
claim about your provider.

`size_band` must be one of: `<100`, `100-1k`, `1k-10k`, `10k+`. The page labels it as
self-reported, because it is. An honest band is more useful to a reader than a flattering
one.

[`schema.json`](./schema.json) is the same rules in JSON Schema form, for editors that
offer completion.

## Keeping the entry accurate

Your row updates itself. Version bumps, a role you turn on, a feature flag you enable, a
change to your upload limit or live referral state — the hourly probe picks it all up
without a PR.

Open one when the self-declared half drifts: you cross into a new size band, move to
different hardware, hand the server to someone else, or want to permanently enter/leave
the automatic recommendation pool.

## Leaving

Delete your entry and open a PR; it comes out at the next build, and its probe history is
dropped on the next run.

If you're shutting the server down rather than just leaving the list, announce it in your
`.well-known` first — Telium has a `sunset` field, and the directory renders it as a badge
on your row, so people relying on you find out from the page they'd look at anyway. Same
for `moved_to` if you're changing domains. Then remove yourself once nobody is left.

## If a listing is a problem

Open an issue. Entries come out for the reasons you would expect — the domain stopped
being a Telium server, the contact goes nowhere, the server is being used to attack
people — and the removal happens in the same public PR anyone can read. What the directory
will not do is arbitrate community disputes; it lists servers, not the people on them.
