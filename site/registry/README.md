# Adding your homeserver

The directory at [telium.chat/servers](https://telium.chat/servers) is this folder. There
is no approval queue and no database — an entry lands as a pull request against
`servers.json` (the [wizard](https://telium.chat/list) files it for you), and when it
merges the site rebuilds with your server in it.

## What you supply, and what you don't

`servers.json` holds only the facts and preferences a machine cannot determine for you:

| Field | Why it's here |
|---|---|
| `domain` | The Telium domain — the part after the colon in `@you:domain`. |
| `name` | What you call the server. |
| `description` | One sentence: who runs it and who it's for. |
| `region` | Where it physically is, plus a code the table sorts on. |
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
# Or GET https://<domain>/telium.txt, then GET <pointed-api>/.well-known/telium/server
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
2. **Reachable over HTTPS** using either the existing `https://<domain>/.well-known/telium/server`
   document or a one-line `https://<domain>/telium.txt` file pointing to an HTTPS Telium
   subdomain. The probe fetches the full live discovery document from that backend and
   checks its account domain. A server the probe cannot reach shows as unreachable.
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

## Relays (SFUs) are a separate directory, with the same rules

Voice and video calls scale past a handful of participants by routing through a relay — a
`telium-sfu`. Relays are listed in `site/registry/sfus.json`, validated by
`scripts/validate-sfus.mjs`, and probed hourly by `scripts/probe-sfus.mjs`, which writes
`data/sfu-status.json` and `data/sfu-probe-history.json`. The rules mirror the servers'
directory:

**What you supply, and what you don't.** The relay's HTTPS origin, a name, one sentence,
a region, your operator contact, and a capacity band for your uplink (`<100m`, `100m`,
`1g`, `10g`). Everything a probe can see — reachability, uptime, load, whether the relay
is accepting — is measured hourly and never declared. Your relay's admission ceilings
live in its own `sfu.toml` (`[limits]`), not here.

**Requirements.** The relay must run `telium-sfu` reachable at the listed HTTPS origin
(browsers probe it from a secure page, so `http://` is not listable), answer `GET
/health`, and be listable by its own operator — list only a relay you run. List only
your own relay's origin; you cannot volunteer somebody else's bandwidth.

**Public mode.** For a relay to be useful to guilds at all it must accept guilds it has
never met: set `[trust] public = true` in its `sfu.toml`. It verifies every guild server
by fetching that server's own published keys, so a public relay needs no per-guild
configuration — but it is carrying strangers' traffic, and the dashboard's per-guild
usage view and block list are how you keep that sane. A relay on a metered connection
should also set a transfer budget there.

**Automatic use is opt-in, twice.** Being listed does not volunteer your relay to carry
strangers' calls automatically. Guilds route through a listed relay on their own only
when a guild owner chooses Automatic mode, and the feed a server fetches includes only
relays that opted in publicly in the registry entry:

```json
"feed": { "opt_in": true }
```

Omit `feed` or use `"opt_in": false` to remain directory-only: shown on the website,
addable by hand by any guild owner, never suggested to automatic mode.

The feed generator then applies mechanical gates before a relay enters the signed
document: reachable, HTTPS, enough probe samples, above the published uptime threshold,
fresh probes, and the same double age check as the servers' directory — the registry's
`added` date must be old enough, and the observed probe history must independently agree.
A new operator cannot backdate their way into carrying automatic traffic. The criteria
travel inside the signed feed, so they are visible to every subscriber and the publisher
can tighten them as the directory matures.

**Weight** (1–3, default 1) damps automatic selection — a heavily-proven relay with real
headroom may run 2 or 3. It is a damping factor, never a share quota: no relay is
everyone's default, and a full relay is routed around regardless of its weight.

Calls through a listed relay are end-to-end encrypted; the relay forwards ciphertext and
sees only connection metadata. Relaying is real bandwidth cost — list a relay you are
willing to keep fed.

## One-time maintainer setup for the listing wizard

The GitHub issue forms and `registry-pr.yml` workflow are picked up from
`main`, so merge the wizard before testing real submissions.

1. [Create the `directory` label](https://github.com/telium-chat/telium/labels/new)
   if it does not already exist. GitHub does not create labels referenced in
   issue-form templates.
2. In **Settings → Actions → General → Workflow permissions**, enable
   **Allow GitHub Actions to create and approve pull requests**. Otherwise the
   built-in `GITHUB_TOKEN` cannot create the listing PR.
3. By default, GitHub holds CI runs on PRs created by `GITHUB_TOKEN` until a
   maintainer approves them via **Approve workflows to run** on the PR. To have
   these checks start automatically, add a repository Actions secret named
   `REGISTRY_BOT_TOKEN`: use a fine-grained personal access token from a
   maintainer account with access restricted to this repository and **Contents:
   read/write**, **Pull requests: read/write**, and **Issues: read/write**.
   Do not put the token in the issue, registry JSON, or source code. The PR
   creation step uses this secret if present and falls back to `GITHUB_TOKEN`
   otherwise. Revoke/rotate it if exposed or when no longer needed.

The bot validates the proposed JSON before opening a PR in either mode. A
human must still review the submitted operator details and decide whether to
merge the listing. The ownership checkbox is an attestation, not proof of
control of a hostname or SFU.

## Opening the pull request

The easy way: [telium.chat/list](https://telium.chat/list). It probes your server from the
browser, asks only for the fields below, builds a schema-perfect entry, and files a
prefilled listing issue. Automation turns that issue into a one-entry pull request
(`site/scripts/registry-issue.mjs` rebuilds the entry from an allowlist, stamps the
`added` date, and runs this same validator), CI probes your server again on the PR, and a
maintainer merges. The wizard is a convenience layer over this section, not a replacement
for it — everything it produces lands here as an ordinary public commit.

Doing it by hand is equally welcome:

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
  "operator": {
    "name": "Example Collective",
    "contact": "https://example.org/contact"
  },
  "recommendations": { "opt_in": true },
  "added": "2026-08-19"
}
```

`region.label` must read `City, CC`, where `CC` is the two-letter country code. The
[wizard](https://telium.chat/list) builds it from a country dropdown so it cannot be
mistyped, and the validator rejects a label whose country does not fit `region.code`.

`region.code` must be one of: `af-south`, `ap-east`, `ap-south`, `ap-southeast`,
`eu-central`, `eu-north`, `eu-west`, `me-central`, `na-central`, `na-east`, `na-west`,
`oc-southeast`, `sa-east`. It follows from the country (the wizard asks only for the US and Canada,
which span three); see [`regions.mjs`](../src/lib/regions.mjs). It is a proximity bucket, not a
claim about your provider.

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
discovery first — Telium has a `sunset` field, and the directory renders it as a badge
on your row, so people relying on you find out from the page they'd look at anyway. Same
for `moved_to` if you're changing domains. Then remove yourself once nobody is left.

## If a listing is a problem

Open an issue. Entries come out for the reasons you would expect — the domain stopped
being a Telium server, the contact goes nowhere, the server is being used to attack
people — and the removal happens in the same public PR anyone can read. What the directory
will not do is arbitrate community disputes; it lists servers, not the people on them.
