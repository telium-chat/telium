# telium-sfu — understand, install, run, and verify

`telium-sfu` is the **media relay** for Telium voice/video. It is a *dumb
regional pipe*: the guild server (`telium-server`) decides who may do what and
signs a short-lived join token; `telium-sfu` verifies that token, mints a LiveKit
access token, and translates guild moderation commands into LiveKit RoomService
calls. The actual WebRTC, forwarding, and embedded TURN are done by a
`livekit-server` process that `telium-sfu` **spawns** (or attaches to).

This document is in order: first *what it is and how it scales*, then *how to
build and run it*, then *how to prove it actually works against a real
`livekit-server`*.

> **Just want to run it?** On Ubuntu/Debian, the easiest path is now the
> installer/dashboard below. The manual [self-service.md](./self-service.md)
> guide is still available for custom deployments.

## One-command installer + dashboard

From a Telium checkout:

```sh
sudo bash sfu/install.sh
```

The installer installs nginx, Certbot, LiveKit, build dependencies, the
`telium-sfu` systemd service, and a narrowly-scoped privileged helper. It then
prints a one-time setup URL. Open it in a browser to:

1. create the SFU admin password;
2. enter the SFU domain and LiveKit signaling domain;
3. choose public/private SFU mode and optionally configure a trusted origin;
4. have nginx + Let's Encrypt configured automatically;
5. restart into the finished deployment.

After setup, the dashboard lives at
`https://<your-sfu-domain>/admin`. The SFU API is served from the same domain,
while LiveKit signaling uses the separate HTTPS hostname. WebRTC media remains
direct on TCP 7881, UDP 3478, and UDP 50000-60000.

The dashboard deliberately does **not** run as root. The installer creates a
dedicated `telium-sfu` user and gives it permission to invoke only the
root-owned nginx/Certbot helper.

### Managing a private SFU whitelist

Open `https://<your-sfu-domain>/admin/trust` (or click **Trusted servers** in
the dashboard). Enter another Telium server's `server_name`, such as
`chat.example.com`, and click **Discover & whitelist**.

The SFU resolves that server through Telium federation discovery, verifies its
self-signed key document, persists the resolved API endpoint in `sfu.toml`,
and swaps the new trust set into memory immediately. No SFU/LiveKit restart is
required and active calls are left alone. Removing an entry is live as well:
new sessions and control commands from that server stop being accepted while
already-issued LiveKit sessions are not forcibly disconnected.

---

## Quickstart — server + SFU + web in a few commands

This is the self-serve path any operator follows. It assumes you have a built
`telium-server` and the `livekit-server` binary on `PATH` (see §4 for the binary
install). **No key copy-paste is required**: the SFU discovers the guild
server's signing key over HTTP. One SFU can back many guilds (§2).

**1. Guild server** — generate a starter config and point a voice region at the SFU:

```sh
cd server
cargo run --release --bin telium-server -- init   # writes server/telium.toml
cd ..
```

Open `server/telium.toml` and add a voice region (see §8 for the full voice
block):

```toml
[voice]
enabled = true
default_region = "local"

[[voice.regions]]
name = "local"
sfu = "http://127.0.0.1:7890"      # <-- telium-sfu's bind address
turn = "127.0.0.1:3478"
```

```sh
cd server
cargo run --release --bin telium-server -- serve   # reads server/telium.toml
```

**2. SFU** (it spawns `livekit-server` for you):

```sh
cd sfu
./target/release/telium-sfu init --config sfu.toml   # writes defaults
# then edit sfu.toml — add ONE trust origin (discovery does the rest):
```

```toml
[[trust.origins]]
server_name = "localhost"                  # your server's `server_name`
discovery_url = "http://127.0.0.1:8448"    # where its /_telium/v1/keys lives
```

```sh
./target/release/telium-sfu serve --config sfu.toml
# -> telium-sfu up ; livekit-server spawned ; GET /health -> {"ok":true}
```

**3. Web client** — either let the guild server serve the built client
(`[web] dir = "../web/dist"` in the server config, then open
`http://127.0.0.1:8448`), or run it live:

```sh
cd web && bun install && bun run dev   # open the printed localhost URL
```

**4. In the browser**

1. Register an account (registration is open in the example config).
2. Create a guild, then create a **voice** channel in it.
3. Open the voice channel — `VoiceView` joins the SFU region instead of meshing.
4. From a second browser profile/account, join the same channel: you hear each other.
5. Server-mute yourself from the first account and confirm the audio drops for the
   other *even if you try to unmute* — that is ingress enforcement (§12).

That is the whole loop. The sections below explain each piece and the multi-guild
/ failover model in depth.

---

## 1. Architecture in one picture

```
  guild server (telium-server)                 telium-sfu (this crate)
  ───────────────────────────                 ────────────────────────
  voice/join ──signs join token──▶  POST /session ──▶ verify sig ──▶ mint LiveKit JWT
  moderation ──signs command─────▶  POST /control ──▶ verify sig ──▶ LiveKit RoomService Twirp
                                               │
                                               └── spawns / supervises ──▶ livekit-server
                                                                        │
  web client (livekit-client) ── connect(ws url + JWT) ──────────────▶  WebRTC media

  One SFU can serve MANY guilds and MANY regions (see §2).
```

Key facts:

- **The SFU is stateless about guilds.** It holds no membership data. It only
  trusts the guild server to have minted a valid, signed token for a channel the
  user is actually in (that authorization lives in `telium-server`).
- **`/session` is called by the client** (after it gets a join token from the
  guild server). **`/control` is called only by the guild server** (moderation).
- **`/health` is polled by the guild server** to decide region failover.
- **The bitrate ceiling is the SFU's, not the guild's.** Every join token
  carries the guild's `max_bitrate`; `/session` refuses a token without a
  positive one, clamps it to `[limits].max_bitrate`, records it per
  participant, stamps it on the LiveKit token as the `telium.max_bitrate`
  attribute, and returns it to the client, which sizes its encoders and
  simulcast ladder to fit. A background sweep mutes video tracks whose
  declared layers add up to more (§15 has the exact enforcement boundary).
- **A viewer's quality choice reaches the media plane.** The guild's `watch`
  command carries `auto|low|medium|high`; the SFU records it per
  (viewer, streamer) and pushes it to the viewer as a LiveKit data message
  on topic `telium.watch`, and the client asks LiveKit for that simulcast
  layer (`setVideoQuality`), so a `low` viewer is forwarded the low layer.

---

## 2. Multi-guild / multi-region model (one SFU, many tenants)

A single `telium-sfu` process is designed to be shared across an entire
federation. Two mechanisms make that safe:

### 2a. Trust is a *list* of origins

Each guild server registers its own Ed25519 key in `[[trust.origins]]`:

```toml
[[trust.origins]]
server_name = "guild-a.example"     # must equal that server's `server_name`
key_id      = "ed25519:abc123"      # from `telium-server keys`
public_key_b64 = "BASE64=="         # from `telium-server keys`

[[trust.origins]]
server_name = "guild-b.example"     # a second guild, same SFU
key_id      = "ed25519:def456"
public_key_b64 = "BASE64=="
```

Every `/session` and `/control` request is verified against this map, keyed by
the token's `origin`/`key_id`. To add a guild you append an origin — **no code
change, no extra processes**.

### 2b. Rooms are namespaced by guild

The LiveKit room for a call is `telium_{guild}_{channel}`. Channel IDs are
already globally-unique ULIDs, so rooms never collide; pinning the guild means a
token minted by guild A for a channel id it shouldn't know can *never* land in
guild B's room. This is what lets one SFU host many guilds without cross-tenant
leaks.

### 2c. Regions / failover

The guild server can list several `voice.regions` all pointing at the *same* SFU
URL (or different ones). `/health` is polled per region; an unhealthy region is
failed over automatically. So "one SFU" also means "one regional media plane
behind N region names."

**Bottom line:** yes — one `telium-sfu` binary backs many guilds and many
regions. That is the whole point of a regional media pipe in a federated chat.

---

## 3. Repository layout

```
telium/
├── telium-protocol/   # shared Ed25519 sign/verify — MUST sit next to sfu/
├── server/            # telium-server (the guild host; already exists)
├── sfu/               # telium-sfu (this crate)
└── web/               # the reference web client (React + livekit-client)
```

`sfu/Cargo.toml` points at `../telium-protocol`, so keep the directories
siblings — don't move `sfu/` without moving `telium-protocol/` too.

---

## 4. Prerequisites & installing `livekit-server`

- **Rust** (stable, recent) — `cargo` to build.
- **`livekit-server`** binary. In `spawn` mode `telium-sfu` runs
  `livekit-server --config livekit.yaml`. It must be reachable when launched, so
  put it on your `PATH`, drop it in this `sfu/` directory (auto-detected as
  `./livekit-server`), or set `binary = "/abs/path"` in the SFU config. (If it's
  in the current directory but not on `PATH`, `export PATH="$PWD:$PATH"`.)
- **Node ≥ 18** to run the web client.
- A built **`telium-server`** with its `telium.toml` (the voice host).

### Install `livekit-server` (prebuilt binary — recommended)

The release asset is named `livekit_<version>_linux_amd64.tar.gz`:

```sh
tag=$(gh api repos/livekit/livekit/releases/latest --jq '.tag_name')
v=${tag#v}
curl -sL -o livekit-server.tar.gz \
  "https://github.com/livekit/livekit/releases/download/${tag}/livekit_${v}_linux_amd64.tar.gz"
tar xzf livekit-server.tar.gz
./livekit-server --version          # expect something like: livekit-server version 1.13.5
```

Or build from source (needs Go): `go install github.com/livekit/livekit/cmd/livekit-server@latest`.

### Install `lk` (the LiveKit CLI — the headless test client)

The CLI lives in the **`livekit-cli`** repo and its asset is named `lk_…`
**not** `livekit-cli_…` (easy to get wrong):

```sh
ctag=$(gh api repos/livekit/livekit-cli/releases/latest --jq '.tag_name')
cv=${ctag#v}
curl -sL -o lk.tar.gz \
  "https://github.com/livekit/livekit-cli/releases/download/${ctag}/lk_${cv}_linux_amd64.tar.gz"
tar xzf lk.tar.gz
./lk --version
```

`lk` is how we run a *real* participant headlessly (the browser `livekit-client`
SDK needs WebRTC and cannot run under Node — see §10).

---

## 5. Build the SFU

```sh
cd sfu
cargo build --release        # binary at target/release/telium-sfu
cargo test                   # 10 tests, no external services required
```

`cargo test` includes a **mock-LiveKit integration test** that proves a signed
control command is translated into the correct LiveKit RoomService Twirp call
over real HTTP. It does **not** exercise a real `livekit-server` — that is §10,
which is why both exist.

---

## 6. Get the guild server's public key

`telium-sfu` must trust the key the guild server signs join tokens with:

```sh
cd server
cargo run --release --bin telium-server -- keys   # reads server/telium.toml
# prints:  ed25519:<id>   <base64 public key>   valid <from>..<until>
```

You need the **`key_id`** and the **`public_key_b64`** for the SFU's trust
block. (Alternatively, set `discovery = true` + `discovery_url` on the origin
and `telium-sfu` fetches the keys itself — see §14.)

---

## 7. Write `sfu/sfu.toml`

```sh
./target/release/telium-sfu init --config sfu.toml   # writes defaults, then edit
```

```toml
bind = "127.0.0.1:7890"          # the URL the guild server AND clients use

[livekit]
mode = "Spawn"                   # "Spawn" launches livekit-server; "External" attaches
url = "http://127.0.0.1:7880"   # LiveKit RoomService / signal port
api_key = ""                     # leave empty -> telium-sfu generates one
api_secret = ""                  # leave empty -> telium-sfu generates one
binary = "livekit-server"        # on PATH, or an absolute path
config_dir = "."                 # where generated livekit.yaml is written

[livekit.rtc]
port_range_start = 50000
port_range_end = 60000
tcp_port = 7881
use_external_ip = false

[livekit.turn]
enabled = true
udp_port = 3478

[livekit.room]
empty_timeout = 300
max_participants = 0             # 0 = unlimited

[limits]
max_bitrate = 8000000            # per-participant publish ceiling (bps); join tokens are clamped to it
enforce = true                   # mute video tracks declared over the ceiling (see §15)
poll_interval_secs = 15          # how often the sweep lists each active room

[trust]
discovery = false
cache_ttl_secs = 86400

[[trust.origins]]
server_name = "your.server.name"           # MUST equal telium-server's `server_name`
discovery_url = "https://your.server.name"  # SFU fetches + self-verifies its key; recommended
# --- OR pin a key (no discovery round-trip) --- from `telium-server keys`
# key_id = "ed25519:abc123"
# public_key_b64 = "BASE64=="
```

> **Ports:** `7890` is `telium-sfu` itself; `7880` is LiveKit's API/signal;
> `7881`/`50000-60000` are LiveKit media; `3478` is embedded TURN. Open the media
> range and TURN if clients are on other networks.

> In `spawn` mode the SFU writes `livekit.yaml` (with `keys: { api_key: api_secret }`)
> and launches `livekit-server`. The `/session` token it mints uses those same
> keys, so the client's token is always valid for that LiveKit.

---

## 8. Point the guild server at the SFU

In the **`telium-server`** `telium.toml` (the file written by `telium-server init`),
enable voice with a region whose `sfu` is the `telium-sfu` URL:

```toml
[voice]
enabled = true
default_region = "local"
token_ttl_secs = 120
stun_servers = ["stun:stun.l.google.com:19302"]
mesh_max_participants = 8

[[voice.regions]]
name = "local"
sfu = "http://127.0.0.1:7890"    # <-- telium-sfu's bind address
turn = "127.0.0.1:3478"
pubkey_hint = "ed25519:abc123"
```

When a channel's region resolves to a region with a non-empty `sfu`, the server
issues `mode: "sfu"` join tokens; otherwise it falls back to mesh.

---

## 9. Run everything

Terminal 1 — guild server (from the `server/` directory):

```sh
cd server
cargo run --release --bin telium-server -- serve   # reads server/telium.toml
```

Terminal 2 — the SFU (this spawns `livekit-server` for you):

```sh
cd sfu
./target/release/telium-sfu serve --config sfu.toml
# -> "telium-sfu up"
# -> "generated livekit.yaml"  (Spawn mode)
# -> livekit-server logs follow
```

Check health (what the guild server polls for failover):

```sh
curl http://127.0.0.1:7890/health
# {"ok":true}
```

If `ok` is `false`, `livekit-server` isn't up — check the binary is reachable and
the ports are free (see §15).

---

## 10. Real end-to-end test (against the actual `livekit-server`)

The headless `cargo test` (§5) uses a *mock* LiveKit and cannot validate the
real server (auth format, room creation, actually dropping a participant). This
section proves the full chain against the real binary you installed in §4.

We use a small helper, `sfu/examples/e2e.rs`, and the `lk` CLI as a real
participant.

### Step 1 — start the SFU (spawn mode)

Already running from §9, or:

```sh
./target/release/telium-sfu serve --config sfu.toml
```

### Step 2 — mint a join token via the SFU

```sh
cargo run --example e2e -- session
# prints: URL=ws://127.0.0.1:7880
#         TOKEN=eyJ...          (a LiveKit JWT minted by the SFU)
#         ROOM=telium_<guild>_<channel>
```

(You can override the SFU address with `SFU_URL=http://127.0.0.1:7890 cargo run --example e2e -- session`.)

### Step 3 — join the room as a real LiveKit participant with `lk`

```sh
./lk room join \
  --url http://127.0.0.1:7880 \
  --api-key <api_key> --api-secret <api_secret> \
  --room telium_<guild>_<channel> \
  --identity u1 --publish-demo --yes
```

Use the same `api_key`/`api_secret` configured in `sfu.toml` (or the
auto-generated ones from `livekit.yaml`). `lk` connects to the real LiveKit and
publishes a demo track — exactly the path the web client uses.

### Step 4 — issue a signed control command; watch LiveKit obey it

In another shell, tell the SFU to disconnect that participant:

```sh
cargo run --example e2e -- control u1 disconnect
# CONTROL status=200 OK
```

The `lk` process in Step 3 should show `disconnected from room` and exit. You can
also try `control u1 mute` (maps to LiveKit `MutePublishedTrack`) and see the
track get muted. This proves **M2** (token mint accepted by real LiveKit) and
**M3** (control translation actually drives the real LiveKit RoomService).

> **Why `lk` and not the browser SDK here?** `livekit-client` (the web SDK) needs
> a WebRTC implementation, which Node does not provide headlessly. `lk` is a
> native client and is the right tool for server-side/CI verification. The web
> client itself is the real browser path (§11).

### Step 5 — confirm the room is empty

```sh
./lk room list --url http://127.0.0.1:7880 --api-key <k> --api-secret <s> --yes
# Participants: 0
```

---

## 11. Run the web client

```sh
cd web
bun install
bun run dev          # prints a local URL, e.g. http://localhost:5173
```

Open it, sign in to the guild that hosts the voice channel, and open a voice
channel. `VoiceView` will:

1. `POST /channels/{id}/voice/join` → server returns `voice_server` with
   `mode: "sfu"`, an `endpoint`, and a `token`.
2. Spend the token at `POST {endpoint}/session` → receives a LiveKit `url` +
   `token`.
3. Connect to LiveKit via `livekit-client` and publish your mic.

---

## 12. Manual browser test plan

Do this with **two browser profiles / two accounts** in the same guild + channel.

**Join & audio**
- [ ] Account A joins the voice channel; `ServerNotice` shows the SFU region
      (not the old "no SFU implementation" warning).
- [ ] Account B joins the same channel. Both hear each other.
- [ ] Each tile shows a "speaking" ring while talking.

**Mute / deafen (ingress enforcement)**
- [ ] A mutes self → B stops hearing A. A still hears B.
- [ ] A deafens self → A hears nobody; A's own mic is also muted.
- [ ] As a **moderator**, server-mute A (guild UI) → A's audio drops for
      everyone *even if A tries to unmute* (the `speak` flag is absent from the
      token, so `microphone` is absent from LiveKit's `canPublishSources`
      grant — enforced at ingress).

**Screenshare / watch (the SFU's reason to exist)**
- [ ] A clicks **Share screen**. A's `streaming` flag flips on.
- [ ] B sees a **Watch** button on A's tile; clicking it subscribes B to A's
      screen. A 30-person channel costs one forward per watcher, not 30.
- [ ] B clicks **Stop watching** → subscription ends.

**Resilience**
- [ ] Kill `livekit-server` → `/health` goes `{"ok":false}`; the guild server
      records the region unhealthy and (with other regions) fails over.
- [ ] Restart `telium-sfu` → it respawns `livekit-server` and serves `/health`
      `{"ok":true}` again.
- [ ] Rejoin after the token's 2-minute TTL → the client refetches a fresh token
      automatically (a `VOICE_SERVER_UPDATE` with `reconnect` is pushed).

---

## 13. External mode (bring your own LiveKit)

If you already run LiveKit separately, set `mode = "External"` and put its real
`url` / `api_key` / `api_secret` in `[livekit]`. `telium-sfu` then only does
auth + control and never touches the process:

```toml
[livekit]
mode = "External"
url = "http://10.0.0.5:7880"
api_key = "your-livekit-api-key"
api_secret = "your-livekit-api-secret"
```

---

## 14. Key discovery (optional)

Instead of pasting keys, let `telium-sfu` fetch them from the guild server:

```toml
[trust]
discovery = true

[[trust.origins]]
server_name = "your.server.name"
discovery_url = "https://your.server.name"   # GET {discovery_url}/_telium/v1/keys
```

The response is self-signed by the origin's current key, so `telium-sfu` verifies
it *before* trusting the keys inside — the same trust model the rest of the
federation uses.

---

## Public SFUs (optional, host's choice)

A normal SFU only serves the origins you list in `[[trust.origins]]`. A **public**
SFU serves *anyone*: a guild admin pastes its domain into their guild's voice
region and it just works — no list, no key exchange. This is what makes a
"free public SFU" possible.

```toml
[trust]
discovery = true
public = true          # discover + trust ANY guild that publishes keys
```

When `public = true` and a token arrives from an origin the SFU has never seen,
the SFU resolves that `origin` (a `server_name`, i.e. a domain) through the same
federation well-known discovery the clients use:

```
GET https://{origin}/.well-known/telium/server  →  api base
GET {api}/_telium/v1/keys                       →  self-signed key doc (verified)
```

The token's signature is then checked against that key — **real verification,
just no pre-arranged trust**. Discovered origins are cached and periodically
re-fetched, so key rotation is followed automatically.

**Isolation is preserved.** LiveKit rooms are namespaced by the *verified*
`origin`: `telium_{origin}_{guild}_{channel}` (each part escaped, so names never
collide). So guild A and guild B sharing the
same public SFU get `telium_A_*` and `telium_B_*` rooms and can never see each
other's media, and a rogue guild can't name itself into another's room (a token
claiming `guild:"victim"` but signed as origin `attacker` produces
`telium_attacker_victim_*`, which victim's members never join). What `public`
*does* share is the media server's bandwidth/CPU — the host's tradeoff for
offering a free relay, the same as running a public TURN/STUN or Matrix media
server.

**Public discovery is HTTPS-only, to public addresses only.** The origin comes
from an unauthenticated request, so the SFU checks that it is a bare host, that
every resolved address is public, pins that address, follows no redirects, caps
the body, and looks up each origin at most once per five minutes.

**Caveat: auto-discovery needs a real, public domain.** `localhost`, internal
hostnames and private addresses need an explicit `discovery_url` (operator
config, so plaintext and private are allowed):

```toml
[[trust.origins]]
server_name = "localhost"
discovery_url = "http://127.0.0.1:8448"   # explicit, for local/dev
```

So: real federated deployments are zero-config; localhost stays one line.

---

## 15. Endpoints (for reference)

| Method & path   | Auth                     | Purpose                                        |
|-----------------|--------------------------|------------------------------------------------|
| `GET  /`        | none                     | `{ "service": "telium-sfu" }`                  |
| `GET  /health`  | none (guild polls)       | `{ "ok": <TCP probe of LiveKit> }`             |
| `POST /session` | guild-signed join token  | verify → clamp `max_bitrate` → mint LiveKit JWT → `{url, token, room, max_bitrate}` |
| `POST /control` | guild-signed command     | translate to LiveKit RoomService calls         |

`/session` returns `400 token must carry a positive max_bitrate` for a join
token without one. `max_bitrate` in the response is the guild's figure clamped
to `[limits].max_bitrate`; the same number is on the LiveKit token as the
participant attribute `telium.max_bitrate` (a participant cannot change its
own attributes without `canUpdateOwnMetadata`, which the SFU never grants).

The `/control` command `{"command":"subscribe","viewer":..,"streamer":..,"quality":..}`
accepts exactly `auto|low|medium|high` for `quality` (absent means `auto`;
anything else is a 400 before LiveKit is touched). It subscribes the viewer to
the streamer's screen tracks (`UpdateSubscriptions`, which carries no quality
of its own) and then, whether or not a screen is published yet, sends the
viewer a reliable data message on topic `telium.watch` with
`{"streamer": .., "quality": ..}`. The web client turns that into
`RemoteTrackPublication.setVideoQuality` on the screen video, so the layer
LiveKit forwards is the one asked for (`low`/`medium`/`high` map to LiveKit's
`LOW`/`MEDIUM`/`HIGH` layers; `auto` asks for the top layer and lets adaptive
stream trim it to the element). `unsubscribe` clears the recorded choice.

### What the bitrate ceiling does and does not enforce

Checked against the LiveKit OSS sources: LiveKit has **no per-participant or
per-room publish bitrate limit**. `limit.bytes_per_sec` is a node-capacity
figure for the routing selector; `CreateRoom`, `UpdateParticipant` and
`ParticipantPermission` carry no bitrate; `UpdateSubscriptions` carries no
quality; RoomService exposes each track's *declared* per-layer `bitrate`
(what the publisher announced when it added the track), not a live rate.

So the ceiling is enforced in three places, and it is worth knowing which
does what:

1. **Client encoder caps (the real bound on the wire).** The web client takes
   the smallest of the guild's `max_bitrate`, the `/session` reply and the
   `telium.max_bitrate` attribute, splits it into an Opus budget for the
   microphone and share audio, a camera slice and a screen slice
   (`publishBudget` in `web/src/lib/screenShare.js`), and derives a simulcast
   ladder whose layers *add up* to at most the slice (`simulcastLadder`).
   Those become `RTCRtpEncodingParameters.maxBitrate` on every layer.
2. **SFU sweep (`[limits].enforce`).** Every `poll_interval_secs` the SFU lists
   each room it has minted a token for, sums the declared layer bitrates of
   every participant's unmuted video tracks, and mutes the largest tracks at
   the SFU (`MutePublishedTrack`) until what remains fits under that
   participant's ceiling. Muted tracks are logged with the room, identity and
   declared total. A participant LiveKit does not list is forgotten two
   minutes after its token was minted.
3. **LiveKit congestion control** on the subscriber side, as always.

What this cannot catch: a client that *declares* a small ladder and then
sends more than it declared. RoomService never sees the actual rate, so such
a publisher is bounded only by (1) on an honest client and by the room's
subscribers' bandwidth estimation on a dishonest one. Enforcing an actual
byte rate at the SFU needs a fork of `livekit-server` or its
per-track stats being exposed on RoomService, neither of which exists today.

---

## 16. Troubleshooting

- **`/health` is `{"ok":false}`** — `livekit-server` isn't reachable on the
  `[livekit].url` port. In Spawn mode check the binary is on `PATH`, sitting next
  to the SFU (auto-detected), or set `binary = "/abs/path"`; and that the ports
  are free. The SFU logs
  `generated livekit.yaml` right before launching it.
- **`/session` returns 403 "bad signature"** — the `[[trust.origins]]`
  `server_name`/`key_id`/`public_key_b64` don't match the token the guild server
  minted. Re-run `telium-server keys` and update `sfu.toml`.
- **`/control` returns 502 with a livekit 401** — the SFU↔LiveKit auth is wrong
  (this was fixed; the SFU now sends a per-room `Bearer` admin JWT). If you ever
  see it, ensure you are on a build that includes the `livekit.rs` auth fix and
  that `api_key`/`api_secret` match what LiveKit was started with.
- **Client connects but no audio** — browser autoplay/permission, or the mic is
  muted; check the "no mic" pill. For cross-network clients, open the UDP media
  range and TURN (`3478`).
- **`lk` says "invalid authorization token"** — you passed the wrong
  `api-key`/`api-secret` for *this* LiveKit (each `livekit.yaml` has its own
  generated keys unless you set them explicitly in `sfu.toml`).
- **Build can't find `telium-protocol`** — it's a path dependency; keep
  `telium-protocol/` next to `sfu/`.
```
