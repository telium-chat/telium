# telium-sfu — self-service setup

The short, no-fluff path to running a Telium SFU (the voice/video media relay).
For the full architecture, signature model, and troubleshooting depth, see
[README.md](./README.md). This file is only the steps.

A Telium voice deployment is three pieces:

| Piece            | What it is                         | You run it |
|------------------|------------------------------------|------------|
| `telium-server`  | the guild host (auth, rooms, signs tokens) | yes |
| `telium-sfu`     | the media relay (this repo)        | yes        |
| `livekit-server` | the WebRTC engine `telium-sfu` drives | auto-spawned for you |

**You do not copy any keys by hand.** The SFU discovers the guild server's
signing key over HTTP. One SFU can back many guilds.

---

## 0. Prerequisites

- **Rust** (stable) — to build `telium-sfu` and `telium-server`.
- **Node ≥ 18** — to run the web client.
- **`livekit-server`** binary — the only external binary you need. It must be
  reachable when the SFU launches it, which means **one** of:
  - on your `PATH`, **or**
  - sitting in this `sfu/` directory next to the SFU binary (the SFU auto-detects
    `./livekit-server`), **or**
  - an absolute path set via `binary = "/abs/path"` in `sfu.toml`.

  If it's in the current directory but not on `PATH`, the quickest fix is
  `export PATH="$PWD:$PATH"` before running the SFU.

  ```sh
  tag=$(gh api repos/livekit/livekit/releases/latest --jq '.tag_name')
  v=${tag#v}
  curl -sL -o livekit-server.tar.gz \
    "https://github.com/livekit/livekit/releases/download/${tag}/livekit_${v}_linux_amd64.tar.gz"
  tar xzf livekit-server.tar.gz
  ./livekit-server --version     # e.g. livekit-server version 1.13.5
  ```

- A built **`telium-server`** with its `telium.toml` (the voice host).

---

## 1. Build

Each crate builds on its own — there is **no** `Cargo.toml` at the repo root,
so run `cargo` from inside each crate's directory. (The guild server is built in
step 2, when you run its `init` command.)

```sh
# SFU (from its own crate dir)
cd sfu
cargo build --release --bin telium-sfu
cd ..
```

(`telium-protocol/` must stay next to `sfu/` and `server/` — it's a path
dependency of both.)

---

## 2. Point your guild server at the SFU

Generate a starter config with the server's own `init` command (run from the
`server/` directory — this also builds the server), then add a voice region that
points at the SFU:

```sh
cd server
cargo run --release --bin telium-server -- init   # writes server/telium.toml
cd ..
```

Open `server/telium.toml` and add a voice region:

```toml
[voice]
enabled = true
default_region = "local"

[[voice.regions]]
name = "local"
sfu = "http://127.0.0.1:7890"   # <-- the SFU's bind address (step 3)
turn = "127.0.0.1:3478"
```

That `sfu` URL is the only wiring the guild server needs. A channel in a region
with an `sfu` set uses the SFU; otherwise it falls back to mesh.

---

## 3. Configure the SFU

```sh
cd sfu
./target/release/telium-sfu init --config sfu.toml   # writes defaults, then edit
```

Tell the SFU which guild server(s) it may serve. Because `discovery = true`,
you only give it the guild server's **domain** — it fetches the key itself:

```toml
bind = "127.0.0.1:7890"

[trust]
discovery = true
public = false                # see "Optional: public SFU" below

[[trust.origins]]
server_name = "localhost"                       # your server's `server_name`
discovery_url = "http://127.0.0.1:8448"         # where its /_telium/v1/keys lives
```

> **`localhost` uses an explicit `discovery_url`** because it isn't a real domain
> the SFU can look up by itself. A real, internet-facing guild server is
> zero-config (the SFU discovers it from its domain's well-known URL).

That `localhost`/`127.0.0.1:8448` must match your `telium-server`'s `server_name`
and bind address. To serve more guilds, add more `[[trust.origins]]` blocks.

---

## 4. Run it

**Terminal 1 — guild server** (from the `server/` directory):
```sh
cd server
cargo run --release --bin telium-server -- serve   # reads server/telium.toml
```

**Terminal 2 — the SFU** (it spawns `livekit-server` for you):
```sh
cd sfu
./target/release/telium-sfu serve --config sfu.toml
# -> "telium-sfu up"
# -> "generated livekit.yaml"
# -> livekit-server logs follow
```

**Check health** (this is what the guild server polls for failover):
```sh
curl http://127.0.0.1:7890/health
# {"ok":true}
```

If `ok` is `false`, `livekit-server` isn't up — check the binary is on `PATH`
and the ports (7880/7881) are free.

---

## 5. Web client + browser test

Build/run the reference client:

```sh
cd web
bun install
bun run dev            # prints a local URL, e.g. http://localhost:5173
```

Or have `telium-server` serve the built client: set `[web] dir = "../web/dist"`
in the server config and open `http://127.0.0.1:8448`.

**In the browser:**
1. Register an account (open in the example config).
2. Create a guild, then create a **voice** channel in it.
3. Open the voice channel — it joins the SFU region (not mesh).
4. From a second browser profile/account, join the same channel: you hear each other.
5. Server-mute yourself from the first account — the audio drops for the other
   *even if you try to unmute* (enforced at the SFU). That proves it works.

---

## Optional: public SFU (let anyone use it)

If you want to *offer* a free public SFU — so any guild admin can just paste your
SFU's domain into their guild with no key exchange — set:

```toml
[trust]
discovery = true
public = true            # discover + trust ANY guild that publishes keys
```

The SFU discovers each new guild by its domain via the standard federation
well-known URL, verifies its key, and serves it. Guilds stay isolated because
rooms are namespaced by the verified origin. (Real domains only — `localhost`
still uses an explicit `discovery_url` as above.)

---

## Guild owners can add their own SFUs too

The steps above put a server-provided SFU pool in front of everyone. A **guild
owner** (or any admin with *Manage Server*) can additionally register their own
SFU from the web client — no server config edit required:

- **Guild Settings → Voice / SFU** lists the server pool plus any custom regions
  the guild has added, with a live health indicator. There they can add an SFU by
  URL, make it the guild default, or remove it.
- A **voice channel** can be pinned to a specific region at creation time (the
  region dropdown). Channels left on *Auto* use the guild default, then the
  server default.

The same trust rule applies from the guild's side: a **public** SFU accepts the
guild automatically (it discovers the guild by domain), while a **private** SFU
must first be configured to trust the guild (add the guild as a trusted origin in
that SFU's `sfu.toml`, or run a public one).

## Quick troubleshooting

- **`/health` is `{"ok":false}`** — `livekit-server` not reachable. Check it's on
  `PATH` (or set `binary = "/abs/path"`), ports 7880/7881 free.
- **`/session` 403 "bad signature"** — the `[[trust.origins]]` `server_name` /
  `discovery_url` don't match the guild server. Make sure the guild's
  `server_name` equals the origin you listed, and that `discovery_url` points at
  the guild's `/_telium/v1/keys`.
- **Client connects but no audio** — browser mic permission, or open UDP media
  range + TURN (`3478`) for cross-network clients.
- **Build can't find `telium-protocol`** — keep `telium-protocol/` next to `sfu/`.

That's the whole loop. See [README.md](./README.md) for the deep dive
(architecture, multi-guild model, real end-to-end test with the `lk` CLI, and
the full endpoint reference).
