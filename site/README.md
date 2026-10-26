# telium.chat

The website for Telium — a landing page and a directory of community homeservers with
open registration. It lives here, beside the server and the client it describes, so a
protocol change and the page explaining it can land in one commit.

Two pages, no framework runtime, no analytics, no third-party requests. Astro with static
output; the handful of interactive parts are vanilla TypeScript that enhances markup the
build already rendered.

```sh
cd site
bun install
bun run dev          # http://localhost:4321
bun run build        # → dist/
```

## Layout

Paths below are relative to this directory.

```
registry/     servers.json, schema.json — the directory, one entry per homeserver
data/         status.json, probe-history.json — written by CI, read at build time
scripts/      probe.mjs, recommendation generation/signing, registry validation,
              check-no-third-party.mjs, og.mjs, capture/
src/
  config.ts   every outbound URL, in one place
  styles/     global.css — design tokens copied from the client
  lib/        servers.ts (registry + probe merge), icon.ts (build-time Lucide inlining)
  components/ the page sections and the server table
  pages/      index.astro, servers.astro, 404.astro
```

| Command | |
|---|---|
| `bun run validate` | Check `registry/servers.json`. Runs on every pull request. |
| `bun run probe` | Poll every listed homeserver and rewrite `data/`. Runs hourly in CI. |
| `bun run recommendations:keygen` | Generate a new Ed25519 feed signing seed and matching public pin. |
| `bun run recommendations:check` | Evaluate the current registry/probe data without publishing. |
| `bun run test:recommendations` | Test eligibility, signatures, signing-pin consistency and feed construction. |
| `bun run recommendations:write` | Write the signed account-home recommendation feed; requires the signing seed and matching public pin. |
| `bun run check` | Prove the built site loads nothing third-party. Runs on deploy. |
| `bun run capture` | Rebuild the client screenshots. |
| `bun run og` | Rebuild `public/og.png`. |

## Adding a homeserver

Open a pull request against `registry/servers.json` — see
[`registry/README.md`](./registry/README.md). Curation is a diff anyone can read.

## How the directory gets its numbers

Telium has no server directory of its own. No route, table or config key anywhere in the
reference server enumerates peers. What every deployment does answer, unauthenticated, is
`/.well-known/telium/server` and `/_telium/v1/capabilities`, and between them they carry
most of what the table shows. So each column has a different and stated provenance:

| Column | Where it comes from |
|---|---|
| Name, description, region | The registry. Operator-supplied. |
| Accounts | The registry, as a band. Nothing in Telium exposes a count, so it is self-declared and labelled as such on the page. |
| Registration, version, roles, features, upload limit | Probed hourly from the server's own endpoints. |
| Recommendation eligibility | The public registry plus the same hourly measured status used by the signed recommendation generator. |
| Uptime (30d) | Our record of those probes — honestly "reachable from a GitHub runner", which the page says. |
| Latency | Measured in your browser when you open the page. |

`scripts/probe.mjs` writes `data/status.json` and appends to `data/probe-history.json`,
commits both, and asks the deploy workflow to rebuild. Uptime is withheld until there are
at least 24 samples; a "100%" computed from two probes is a worse answer than no answer.
The first observed probe timestamp is also retained so a new endpoint cannot backdate its
registry entry and skip the automatic-recommendation maturation period.

Latency is the one figure that cannot be honest if measured centrally, so it runs client
side: `fetch` to each server's `/_telium/v1/health`, falling back to `mode: 'no-cors'` and
reading `duration` off the `PerformanceResourceTiming` entry, which stays exposed for
opaque responses. Three samples per server, and the **minimum** is reported — a queued
packet inflates a sample, but nothing makes one arrive faster than the real path allows.
Failures render `—`, never a guess.

This means every listed server sees your IP address when browser latency probing is on. The
page says so and offers a toggle remembered in `localStorage`. Automatic signup selection
does **not** perform those browser probes; it selects locally from the signed catalogue and
contacts only the chosen account home.

## Account-home recommendation feed

Directory membership alone never enrolls a server into beginner signup referrals. A server
has to opt in in the public registry and independently advertise live acceptance. The
recommendation generator then applies the mechanical health, protocol, identity-domain,
HTTPS API, observed-age and uptime gates documented in
[`../docs/distributed-onboarding.md`](../docs/distributed-onboarding.md).

The output is a static, expiring Ed25519-signed document at:

```text
/.well-known/telium/account-home-recommendations.json
```

There is no per-signup assignment API. Clients verify a pinned public key and make the
weighted/operator-capped choice locally. The catalogue host can still observe ordinary
HTTP requests for the static document, but it never receives the client's random choice or
a request naming the selected homeserver. Independent distributors can mirror the exact
signed document and point their builds at that mirror without gaining signing authority.

### Creating the production signing key

Run this **once in a secure local shell**:

```sh
cd site
npm run recommendations:keygen
```

It prints three values:

- `TELIUM_RECOMMENDATION_SIGNING_KEY` — **secret** 32-byte Ed25519 seed encoded as base64url. Store it as a GitHub Actions secret (or equivalent deployment secret). Never commit it.
- `TELIUM_RECOMMENDATION_PUBLIC_KEY` — public base64url Ed25519 key. Store it as a repository/deployment variable and pin it into production client builds.
- `TELIUM_RECOMMENDATION_KEY_ID` — public identifier for that key. Store it as a repository/deployment variable.

The GitHub workflows expect these names:

```text
secret: TELIUM_RECOMMENDATION_SIGNING_KEY
variable: TELIUM_RECOMMENDATION_PUBLIC_KEY
variable: TELIUM_RECOMMENDATION_KEY_ID
variable: RECOMMENDATIONS_ENABLED=true
optional variable: TELIUM_RECOMMENDATION_URL
```

`site.yml` reads the signing secret only while producing the static signed feed. Before it
writes anything, the generator derives the public key from that secret and requires it to
match `TELIUM_RECOMMENDATION_PUBLIC_KEY`. A stale or mistyped client pin therefore fails the
publish instead of producing a catalogue that production clients cannot verify.

Linux AppImage and Android builds read only public configuration. They expose
`TELIUM_RECOMMENDATION_PUBLIC_KEY` to Vite as `VITE_TELIUM_RECOMMENDATION_PUBLIC_KEY`, and
optionally expose `TELIUM_RECOMMENDATION_URL` as `VITE_TELIUM_RECOMMENDATION_URL`. With no
URL override, the client uses the canonical `telium.chat` path above.

For a separately deployed browser build, pass the same non-secret public pin explicitly.
A mirror is optional:

```sh
cd web
VITE_TELIUM_RECOMMENDATION_PUBLIC_KEY='<public key>' \
VITE_TELIUM_RECOMMENDATION_URL='https://mirror.example/.well-known/telium/account-home-recommendations.json' \
npm run build
```

If `VITE_TELIUM_RECOMMENDATION_URL` is omitted, the canonical project catalogue is used.
Do not fetch the verification key from the same endpoint as the signed feed at runtime;
that would turn a compromised catalogue origin into its own trust anchor and defeat the
point of signing.

Until the public key is pinned and `RECOMMENDATIONS_ENABLED` is enabled, clients fail closed
to explicit homeserver choice. Existing directory operators are never auto-enrolled.

### Rotation

Generate a new pair, deploy client builds that trust the new public key, then switch the
publisher signing key. Do not discard the old signing seed until old production clients are
outside their supported window, or use an intentional multi-key transition design first.
The current v1 client pins one public key, so an instantaneous key replacement would make
older builds reject newly signed feeds and fall back to manual account-home selection.

## Design

The site does not invent a visual language. `src/styles/global.css` takes its tokens
verbatim from [`../web/src/index.css`](../web/src/index.css) — the same oklch neutrals, the
same logo-kit amethyst accent, the same radii and easing — and the client's signature of
borders rather than shadows carries over. Three deliberate divergences: a larger type
scale, because a page meant to be read is not a chat client's UI density; a theme that
follows `prefers-color-scheme` by default with an explicit toggle, set by a blocking inline
script so there is no flash; and a darker light-mode amber, because here that token is
small text rather than an icon tint.

Fonts are IBM Plex Sans and IBM Plex Mono, self-hosted through Fontsource. That is not a
preference. The client's own comment explains it — a federated client that phones a third
party on every page load leaks which server you are using — and the site repeats the claim
in its footer, so `bun run check` enforces it: any absolute URL in the build that would
make the browser reach a host we do not control fails the deploy.

## Screenshots

`bun run capture` is reproducible rather than hand-made. It starts the reference server
against **a scratch SQLite database in `.capture/`** — never `../server/telium.db` — seeds
six accounts, a guild, channels and a real conversation, opens genuine gateway WebSocket
connections so presence in the member list is actual presence rather than a mock, and
shoots both themes at 1440×900 and DPR 2.

It builds nothing itself, so it needs a debug build of the server and a built client first.
From the repository root:

```sh
(cd server && cargo build)
(cd web && bun install --frozen-lockfile && bun run build)
(cd site && bun run capture)
```

## Deploying

**telium.chat is served by the portal Worker, not by GitHub Pages.** `.github/workflows/site.yml`
builds the portal artifact and deploys it — worker and assets together — on every push to
`main`, once three repository settings exist:

```sh
gh variable set PORTAL_ENABLED --body true      # gates the portal build and deploy
gh variable set CLOUDFLARE_ACCOUNT_ID --body <account id>
gh secret set CLOUDFLARE_API_TOKEN              # Workers Scripts Edit, same account as the zone
```

`wrangler.jsonc` attaches `telium.chat` as a custom domain, so the first deploy moves the
hostname's DNS to the Worker — whatever serves the domain at that moment stops. The
workers.dev preview URL is switched off, so there is exactly one name serving this content.
To deploy by hand instead of by push: `npm run build:portal && npx wrangler deploy` from
this directory.

The workflow also validates the registry, tests/checks recommendation generation, and runs
the third-party request check before any of that. The separate Pages publish in the same
workflow stays off; it is a marketing-only fallback (no app routes, so its "Open Telium"
button is a 404) for a domain that is not carrying the client, and must not be pointed at
telium.chat.

`src/config.ts` holds every outbound URL. **No canonical domain is committed anywhere else
in this repository** — every host in the code and the specs is a placeholder — so
`telium.chat` is the intended domain, following from the `telium-chat` org, not a confirmed
one. Change it there and in `astro.config.mjs` and the site follows.

## The portal build

The same domain also carries the web client: invite links minted anywhere on the network
point at `telium.chat/invite/<code>@<server>`, and the client answers its own routes here
rather than on a separate origin. Whoever opens one runs this site's copy of the client
instead of a page served by whatever server minted the link, which is the point — a guild
server's operator otherwise chooses the HTML behind its own invite.

`bun run build:portal` builds the client (`../web`) and the site and merges them into
`dist-portal/`, which `wrangler deploy` publishes with `worker.ts`:

- `/channels`, `/invite`, `/u` and `/login` (with their subpaths) answer with `app.html` —
  the client's index.html under a name the site does not use, stamped with a
  `<meta name="telium-portal">` marker the client reads to know a bare invite code names
  no server.
- everything else serves the site as built; an unknown path gets the site's 404.
- every response carries the client's security headers, mirrored from
  `server/src/security_headers.rs`.

Locally, `bun run preview:portal` serves `dist-portal` with those same rules at
http://localhost:8787 (`PORT` overrides), and `npx wrangler dev` runs the production
worker against it.

To exercise the signup recommender locally without the production key,
`node scripts/local-test-feed.mjs https://your-server.example "Name"` mints an
ephemeral key, writes a signed feed naming that server into `public/.well-known/`
(gitignored — the production feed is written by `recommendations:write` at deploy
time), and pins the matching public key into `web/.env.local`. Then rebuild and
preview as above; "Create an account" will offer the server you named. Delete the
two files to return to the dormant recommender.

The merge is byte-checked where both builds ship the same public file (brand marks,
favicons): a difference fails the build rather than one build quietly serving the other's
asset. The client's service worker is rewritten to precache and fall back to `app.html`,
so an offline visitor at an app route gets the app and never the homepage.

Homeservers mint portal-form links because `web.invite_portal` in the server config
defaults to `https://telium.chat`; an operator can name a different portal — this build,
run anywhere, is a portal — or set `self` to keep links on their own domain.

## Licence

Apache-2.0, matching the project.
