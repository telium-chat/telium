# SFU directory plan — public relays for guild calls

Status: in progress. Companion to UPLOADS_PLAN.md. Kept local.

## The problem

Guild voice/video calls connect everyone directly (mesh) and degrade past a handful of
participants. The fix — an SFU relay in the middle — currently requires an instance admin
to configure regions in TOML and a guild owner to already know they need one and have a
URL. Most never do.

## The design (agreed)

- **Phonebook on telium.chat**: public, PR-curated list of relays; hourly probe by one
  coordinated checker; measured facts only (uptime, load, accepting); declared
  connection-speed band; signed feed (Ed25519, serial + rollback/equivocation protection).
  Entries must prove themselves (observed age, uptime, fresh probes) before *automatic*
  mode will use them. The gates live in the feed's own `criteria` block, so the publisher
  can launch lenient and tighten later.
- **Every server fetches it automatically**: zero config; compile-time pinned key;
  `[voice.directory] enabled = false` is the kill switch; url/key overridable. If the
  phonebook is unreachable, servers keep last-known-good only while its signature is
  valid, never route through expired data, and fall back to mesh.
- **Three guild modes** (guild setting, default first):
  - **Automatic (default)**: when a call starts, pick one qualifying relay with spare
    capacity, closest to the joiners who start it; the whole call **pins** to it and late
    joiners follow. Load spreads across calls (weight damping + win-by-margin). Relay
    dies/fills mid-call → whole call fails over (existing machinery).
  - **Fixed list**: today's model — admin-curated `guild_voice_regions` with a starred
    default; browse cards to fill it from the phonebook.
  - **Direct only**: no third-party relay, ever.
- **Exit path**: a relay removed from the feed stops being suggested immediately;
  automatic mode migrates off it as the held list expires; fixed-list guilds see a
  "no longer listed" warning. Delisting disconnects; nothing stays half-trusted.
- **Operator control**: connection-speed band → rough call capacity used for admission;
  rolling transfer budget that stops *new* calls near the cap; per-caller bitrate cap
  (already exists). Relay dashboard shows per-guild usage + a block list.
- **No background polling of the phonebook by servers.** Division of labor:
  1. site checker probes hourly (eligibility + public page),
  2. the joining client probes candidates at call time (closeness, cached),
  3. the server health-checks only relays in active use (failover),
  4. one on-demand probe round when an owner opens the browse list.
- **Transparency**: one-time notice when automatic mode is active; persistent
  "carried by ⟨relay⟩" indicator in calls; load indicator in the manual picker;
  public page credits operators with real usage stats.
- Call content stays end-to-end encrypted in every relayed call; a relay sees only the
  envelope.

## Bootstrap / getting the list started

- Manual adds (fixed list, browse cards) are **instant** — gates only guard automatic
  mode, where no human made a choice.
- The publisher controls `criteria` in the signed feed: launch with relaxed gates
  (e.g. 1 observed day), tighten as the directory matures.
- List candidate relays now; the hourly checker accrues history from the moment an entry
  lands, so early entries age in before launch.

## Chunks

### 1. Protocol — feed format (`telium-protocol/src/sfu_directory.rs`)

- [x] Document types (`telium.sfu_directory` v1): publisher, serial, issued/expires,
      criteria, `sfus[]` entries (url, name, description, region, region_label,
      operator, contact, capacity_band, weight, pubkey_hint)
- [x] sign / verify (canonical JSON, integer-only numbers, strict Ed25519)
- [x] https-only URL validation, text bounds, capacity-band + weight bounds,
      duplicate-URL refusal, window + serial/rollback/equivocation checks
- [x] Unit tests (clone curator_directory's suite)

### 2. Chat server — fetch, hold, serve

- [x] Migration 0094: `sfu_directory` (0092/0093 were taken on main by the DM outbox work) + `sfu_directory_entries` (failure-history columns
      from day one)
- [x] `server/src/sfu_directory.rs` cloned from hosting.rs skeleton: refresh /
      fetch_verified / adopt / refresh_due / prune / statuses / Refusal
- [x] `[voice.directory]` config (enabled, url, key, refresh/retry/timeout/validity,
      max entries) + startup advisories + example TOML
- [x] Maintenance wiring next to hosting::refresh_due
- [x] `GET /_telium/v1/voice/directory` (GuildAuth): entries merged with on-demand
      health, "listed" state, stale flag
- [x] Admin pair `/_telium/v1/admin/sfu-directory[/refresh]` with audit
- [x] Capabilities: `calls.sfu_directory`

### 3. Chat server — guild modes + routing

- [x] Guild voice mode: automatic (default) / fixed / direct
- [x] resolve_region: explicit request > guild pinned default > server default >
      qualifying directory pick (spare capacity, weight, margin) > mesh; "direct only"
      skips directory
- [x] Call pinning: late joiners follow the call's pinned relay (day-one guard test
      first)
- [x] Add-time reachability probe: advisory only, seeds initial health row, returns
      `reachable`
- [x] Fixed-list rows backed by a directory URL that vanished → "no longer listed" flag
- [x] API tests: modes, directory endpoint, migration off delisted relays

### 4. Relay (`sfu/`)

- [x] `/health` reports load (rooms, participants, bandwidth forwarded) + `accepting`
- [x] Admission ceilings (max_rooms / max_participants) sized to the operator's link, per the example config
- [x] Rolling transfer budget with local persistence; near-cap → refuse new, flag
      "near cap"; existing calls untouched
- [x] Refuse gracefully when full (clear error; caller reroutes)
- [x] Dashboard: per-guild usage + block list

### 5. Web app

- [x] `api.voiceDirectory()` wrapper
- [x] VoicePane: mode selector (automatic/fixed/direct), directory browse cards with
      health/load, one-click add, "no longer listed" + "ask your admin" states
- [x] Empty-state explainer (mesh cap + CTAs) on mesh-only guilds
- [x] In-call: mesh banner (rare, genuine fallback), "carried by ⟨relay⟩" indicator,
      one-time automatic-mode notice
- [x] i18n strings (en + status check)

### 6. telium.chat (site)

- [x] `registry/sfus.json` + schema + README rules (public mode, HTTPS, own relay only,
      consent)
- [x] `validate-sfus.mjs` validator
- [x] `probe-sfus.mjs` hourly checker (health/load/accepting → status + history)
- [x] Signed feed generator (`sfu-directory-lib.mjs` / `sfu-directory.mjs`, keygen,
      local-test feed, node tests)
- [x] `/sfus` page + table + nav + URLS (per-guild usage stats live on the relay's own dashboard)
- [x] "Run your own" / get-listed docs

### 7. CI + housekeeping

- [x] validate-registry.yml, probe.yml, site.yml wiring; package.json scripts
- [x] Conformance/export: directory tables excluded from guild export (derived data)
- [x] End-to-end local walkthrough (fake signed feed → join → failover → delist)

## Out of scope (follow-ups)

- Phonebook for DM/conversation calls (`custom_sfu` picker)
- Reading `pubkey_hint` beyond pass-through
- Global per-operator traffic caps (no cross-server view; damping is per-call)

## Verification

- `cargo test` in telium-protocol + server; site validators + node tests; web build +
  i18n status.
- Local end-to-end: fresh guild in automatic pins a relay and late joiners follow;
  fixed-list guild uses exactly its pin; direct-only stays mesh; relay death moves the
  whole call; delisting migrates guilds off; full relay turns newcomers away.
