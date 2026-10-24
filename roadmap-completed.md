# Telium Completed Roadmap

This file archives roadmap promises that are complete enough to stop appearing as active work in [`roadmap.md`](roadmap.md).

Archive baseline: `64c06234513c14b5a82a6865a43c189e08e2c4bd` on `main` (2026-09-15).

This is not a changelog. It records the major plan promises that were audited as complete, plus implementation notes useful to future maintainers and agents.

---

# Migration, portability, and continuity

## Account migration carries the user's portable life

Completed account migration work includes:

- contacts/friends, including accepted, pending, and blocked states;
- vault ciphertext without the old homeserver escrow key;
- pending DM forwarding state where the destination is the conversation sequencer;
- allowlisted synced client state;
- sealed history backup ciphertext;
- user-uploaded media under a bounded transfer budget;
- background fetching of omitted media;
- per-object import outcomes so only landed media is forwarded;
- federated guild membership registry and move notices;
- migration warnings on every device;
- recovery-email cancellation flow;
- guided destination handoff so users do not normally copy an import code manually.

The migration flow remains protected by reauthentication, a device signature, a cooling-off window, and cancellation.

## Guild migration preserves identity

Guild migration preserves the guild's immutable ID and, in the normal case, the IDs for roles, channels, emoji, stickers, messages, threads, reactions, and related objects.

IDs embedded in message text and payloads are kept valid. In the exceptional case where the destination already has archived rows using those IDs, import renumbers the related object graph consistently and rewrites references through one mapping.

**Status: complete.**

## Guild migration round-trips the current schema

Migration bundle v2 exports full rows and imports the intersection understood by the destination schema, preventing the bundle definition from silently drifting every time a guild table gains a column.

The migration test discovers guild-owned tables from the live schema and compares exported/imported state column by column.

Covered state includes, among other things:

- channels and threads;
- forum configuration;
- roles and permissions;
- emoji and stickers;
- messages and `author_signature`;
- reactions and pins;
- read state and mentions;
- follows and invites;
- AutoMod and gates;
- screening answers and held messages;
- federation/domain rules;
- voice regions;
- audit logs.

**Status: complete.**

## Guild migration carries on-disk state

Two filesystem-backed classes of state move with a guild:

- cold archived message segments;
- emoji/sticker media bytes.

Cold segments are rehydrated as ordinary messages at the destination so the destination can apply its own archival horizon.

Expression bytes are hash-verified before import.

**Status: complete.**

## Cross-version migration conformance suite

`server/tests/conformance.rs` imports frozen account and guild bundles from reference versions, validates the imported state, moves the imported entity onward again, and validates the second hop.

Fixtures live under `server/tests/fixtures/migration/`.

`server/scripts/freeze-migration-bundles.sh` freezes new reference shapes.

CI runs the compatibility suite in `.github/workflows/migration-conformance.yml`.

**Status: complete.**

## Profile accent color survives account migration

`accent_color` is exported and restored at the destination.

**Status: complete.**

## Guided migration handoff for accounts and guilds

The source opens a short-lived single-use handoff naming the destination. The destination creates and delivers the claim back to the source over a signed server-to-server request. The source verifies subject, destination, owner, and handoff secret before scheduling the ordinary protected migration.

The manual claim/import-code path remains a fallback.

**Status: complete.**

## Domain relocation

A server can move from one domain to another while cryptographically carrying its identity forward.

The relocation record is:

- signed by the old server identity;
- signed by a successor key for the new domain;
- applied only once the new domain independently publishes the successor key.

Peers remap references transactionally and resolve old IDs/names forward to the new domain. The relocating server performs the same remap locally and can serve old-domain discovery/relocation information during the transition.

See [`docs/relocation.md`](docs/relocation.md).

**Status: complete.**

## Warm standby / fallback

A standby can:

- bootstrap from a primary snapshot;
- stream database updates over signed server-to-server transport;
- expose read-only standby state;
- be discovered by clients as a fallback;
- be promoted by an operator;
- propagate a signed promotion record;
- cause a recovered stale primary to self-demote.

Failing back later is intentionally an operator procedure: pair in the reverse direction, let the old primary catch up, then promote it.

See [`docs/warm-standby.md`](docs/warm-standby.md).

**Status: complete.**

## Encrypted off-box backup and restore

Scheduled backup creates a single authenticated encrypted archive containing:

- a consistent SQLite snapshot;
- cold-storage segments;
- media objects except refetchable caches.

The format uses chunked AES-256-GCM and an authenticated manifest.

Backups can be copied to S3-compatible storage with retention on both local and remote copies.

Operator tooling includes:

- key generation;
- backup now;
- list;
- verify;
- one-command restore from local or `s3://latest`.

CI performs a real backup/upload/delete/restore flow against MinIO.

See [`docs/backup.md`](docs/backup.md).

**Status: complete.**

---

# Identity, sync, and account state

## Client sync store is sealed

Sync values are sealed on the device using AES-256-GCM under a key derived from the account recovery keyring.

The envelope is versioned, binds the sync key name as associated data, identifies the key ID, carries a monotonic per-key counter, and pads small values.

The server stores opaque envelopes and refuses plaintext once an account's sync store is sealed.

See [`docs/sync-encryption.md`](docs/sync-encryption.md).

**Status: complete.**

## Saved stickers sync across devices

Saved sticker references sync through the sealed account store and appear in the picker when the relevant guild expression can be resolved.

**Status: complete.**

## Drafts sync across devices

Channel and conversation drafts sync as sealed `drafts.v2` values, merged per target with dated tombstones for clearing.

Writes are debounced so the sync pattern is not a keystroke log.

Legacy plaintext `drafts.v1` is not migrated.

**Status: complete.**

---

# Guilds, expressions, media, and gateway basics

## Server-side expression normalization

Guild emoji and sticker uploads cross a normalization boundary before storage.

Implemented behavior includes:

- format sniffing from bytes;
- PNG/APNG, GIF, WebP, and JPEG input;
- SVG/unsupported format rejection;
- dimension and decoded-pixel limits;
- deterministic downscaling without upscaling;
- deterministic re-encoding;
- metadata stripping;
- animation frame/duration/delay limits;
- output-size enforcement;
- screening before and after normalization.

See [`docs/media.md`](docs/media.md).

**Status: complete.**

## Curated media-origin feed resolution

A guild can subscribe to a signed media-origin feed by pinning the curator's Ed25519 key.

The server:

- fetches through a bounded SSRF-safe path;
- verifies against the pinned curator key;
- caches the last good copy;
- refuses serial rollback;
- refuses same-serial equivocation;
- applies expiry so stale allows lapse while stale blocks remain restrictive;
- resolves feed policy below operator policy and literal guild rules.

See [`docs/media.md`](docs/media.md).

**Status: complete for feed resolution.**

## Signed media-origin registry ecosystem

The feed format and its resolution (above) grew the three things that made it an ecosystem rather than a single subscription mechanism.

**Curator discovery.** A server publishes the curators it knows of as a signed directory at `/_telium/v1/media/curators`, and follows directories other servers publish, pinned by key, through the same SSRF-safe fetcher and the same forward-only serial discipline. Moderators see the merged list in the gates pane. A directory suggests and decides nothing: pinning a key is still the moderator's explicit act, and nothing read out of a directory reaches the origin-policy tables. An expired directory stops pointing anywhere, since a stale suggestion shown as current is the one thing a directory can get wrong.

**Curator key rotation.** A feed can carry a `rollover` naming the curator's next key, signed by the key in force. Subscribers keep the pinned key as an immutable anchor and walk forward along a chain of predecessor-signed rollovers: forward-only rotation numbers, no two successors under one number, one-way retirement of superseded keys, and a document verified against the announced successor only when it fails signature verification against the active key alone. A subscriber that misses the overlap window fails closed — the held copy lapses, allows go, blocks stay — until a human re-pins. Publishers rotate through `POST /_telium/v1/admin/media/curator-key/rotate`, which keeps signing under the old key for the overlap.

**Tier-2 picker from subscribed feeds.** `GET /_telium/v1/media/registry/feeds` (session-authenticated, because the answer depends on the account's guilds) returns the external hosts the account's guilds' feeds vouch for, with the curator metadata and who vouched. The account settings upload-host picker offers those alongside the home registry's own, labelled by voucher.

See [`docs/media.md`](docs/media.md).

**Status: complete.**

## Media/file fundamentals

The following audited capabilities are implemented and should not be reopened as missing without a new concrete defect:

- BLAKE3 content addressing;
- capability URLs;
- media vouchers;
- remote-origin fetch;
- cache TTL;
- purge propagation;
- upload scanning/hash lists;
- tier-2 origins;
- external provider adapters;
- embed proxy SSRF protections.

## Guild vanity addressing

A guild now has a human-readable address, `#gaming:guilds.example`, next to the immutable ULID it keeps for ever.

- **Reservation.** One name per guild and one guild per name, case-folded on the way in, held to the same conservative grammar as an account localpart, and refused for a short reserved list. The reserved words are the ones a reader would take as a claim about the *server* rather than a name a stranger picked, which is precisely what an address meant to be recognised on sight must not be able to say.
- **Canonical lookup over federation.** `GET /_telium/v1/guild-aliases/{alias}` is public, unauthenticated and signed, and gives exactly one of `active`, `moved` or `unknown`. `GET /_telium/v1/guild-addresses/resolve` follows a chain for a client.
- **Explicit opt-in and one live name.** New guilds have no vanity address. Enabling one in guild settings makes that one address a public preview/join path; changing or disabling it releases the old local name immediately.
- **Migration-time forwarding.** When a guild actually leaves a server, its live address becomes a forwarding pointer in the same transaction that writes the `moved` tombstone, with the destination read out of the tombstone's `new_server` (a guild id is a bare ULID and names no server). The current name travels in the export bundle and is re-adopted at the destination when free.

**The property that mattered.** An alias must never let one server speak for another's guild, and that is structural rather than a check: a redirect's destination is a hint, following it means asking that server the same question from scratch, resolution ends only on an `active` answer from the server holding the guild's own rows, and every answer is verified against the key published by the origin that was asked with its `host` field required to match. A forged redirect makes its author a signpost and nothing more. Chains are bounded by a visited set and six hops; a revisit is a `409`.

Covered by adversarial cross-server tests: a server claiming another's guild through three hand-written rows, an address that forwards in a circle, and an opt-in join test spanning two account homes that exercises enable, rename, reuse and disable.

Code: `server/src/vanity.rs`, `server/src/routes/guild.rs`, `server/src/migration.rs`. Docs: [federation.md](docs/federation.md).

**Status: complete.**

## External emoji entitlement

Both halves of the external-emoji bargain are now enforced server-side, where the emoji reference is resolved, rather than only in the UI.

- The **receiving** guild's `external_emoji` and the member's `USE_EXTERNAL_EMOJI` were already there.
- The **owning** guild now sets `emoji_export_policy` — `everyone` (the default and the old behaviour), `members`, or `role` with `emoji_export_role_id`, meaning that role or any above it. Boosters, staff and level gates are all that one rule once the guild has made a role for them, so there is no fourth policy.

Only the owning server can answer, because the roles and the membership are its rows; a server shown a foreign emoji asks `POST /_telium/v1/emoji/entitlement` over the signed channel and caches the verdict per `(origin, emoji, user)` for five minutes. An unreachable owner falls back to its last verdict for a day and then to allowing, so a peer going down does not silently become a ban. Two guilds on one server are still two guilds; an emoji inside its own guild is never gated.

Code: `server/src/emoji.rs`, gated in `server/src/routes/social.rs`.

**Status: complete.**

---

# Voice, video, and screensharing

## SFU bitrate budget is consumed end to end

Guild/SFU session creation requires a positive `max_bitrate`, clamps it to configured limits, records it for the participant, and returns the ceiling to the client.

The client applies the budget to microphone/share audio, camera, and screen encoders and sizes simulcast ladders inside that budget.

The SFU applies the strongest practical LiveKit OSS backstop available through RoomService: tracks declaring layers above the participant ceiling are muted until declared video fits.

See `sfu/README.md`.

**Status: complete within the available LiveKit enforcement boundary.**

## Viewer-selected simulcast quality

The quality vocabulary is shared in `telium-protocol`:

- `auto`;
- `low`;
- `medium`;
- `high`.

The guild validates it, the SFU stores it per viewer/streamer, the SFU sends it to the viewer, and the client applies it to the actual screen-share subscription with LiveKit video-quality selection.

**Status: complete.**

## Full screenshare model

### Semantic presets and content hints

The picker asks what is being shared rather than which numbers to use, and the answer drives the encoder:

- "A document or code" sets the `text` content hint (falling back to `detail`), `maintain-resolution`, and a ladder weighted towards the top rung;
- "A game or video" sets the `motion` content hint, `maintain-framerate`, and a ladder that funds the lower rungs at half the frame rate.

The two presets are bitrate-equivalent: they split the same screen slice of the publish ceiling differently rather than one being allowed more. The content hint is set on the capture track before publication, and is feature-detected by reading the property back, which is what the specification makes meaningful. The degradation preference reaches LiveKit as a publish option and a mesh sender through `RTCRtpSendParameters`, best-effort in both cases.

### Application/system audio

`getDisplayMedia` is asked for the share's own sound where the picker's toggle is on, with `systemAudio`/`windowAudio` hints for engines that implement them, and the audio travels as a second Opus track — a reserved mesh transceiver, or LiveKit's `ScreenShareAudio` source — never mixed into the microphone.

Capability is feature-detected through `suppressLocalAudioPlayback` in `getSupportedConstraints()` rather than guessed from a user agent, and the authoritative answer remains whether a track actually arrived: Chromium captures tab audio everywhere and whole-screen audio on Windows and ChromeOS, Firefox accepts the constraint and returns nothing, Safari captures none. A share with no sound still starts, and says why.

A viewer holds a separate level for a person's voice and for the sound of their screen, so a share can be turned down or muted without silencing the person sharing it.

### Client RTT-based SFU region selection

A client on `auto` probes the healthy regions the guild publishes — `GET /health`, no credentials, no referrer, no custom headers, at most four candidates over a two-second budget — and asks for the lowest measured round trip. The server remains the resolver; blocked, inconclusive, or too-close measurements produce no preference, which is the `auto` every join sent before.

See [`docs/guild-calls.md`](docs/guild-calls.md).

**Status: complete.**

---

# Direct messages and encrypted communication

## Direct, TURN-relayed, and SFU-routed DM/GC calls

The core call-mode promise is implemented:

- direct mesh;
- TURN-relayed peer-to-peer;
- SFU-routed calls;
- per-device privacy posture;
- strictest-posture resolution;
- per-conversation override;
- seamless mesh → SFU transition;
- conversation-specific SFU choice;
- end-to-end encrypted SFU media derived from the MLS group.

See [`docs/calls.md`](docs/calls.md).

The remaining control/test limitations are tracked in the active roadmap rather than reopening the core three-mode feature.

## MLS messaging fundamentals

The audited encrypted messaging base includes:

- KeyPackages;
- store-and-forward;
- sequencer ordering;
- MLS commits;
- re-anchoring;
- group chats;
- encrypted typing/read-receipt signals;
- recovery vault;
- device verification;
- group-promotion infrastructure.

## Delivery acknowledgement controls

The `DELIVERED` signal itself shipped earlier; what was missing was the sender's view of it and the receiver's ability to decline.

- **Per-device breakdown.** The Sent/Delivered/Read word opens a list of who acknowledged, on how many of their devices, and whether they have read it. Only self-reported state appears: a person who sends read receipts but not acknowledgements shows as read with no device count, and an older client's account-level mark shows as a delivery whose device was not stated.
- **A setting to decline.** Acknowledgements have their own switch beside read receipts and typing, per account with a per-conversation override. It defaults to on where read receipts default to off, because an acknowledgement says a device synced — which the sequencer already learns from that device fetching frames — while a read receipt says a person looked and when.
- **Reciprocal in fact.** An account that sends no acknowledgements keeps nobody else's either: they are dropped as they arrive rather than merely left undrawn, so the switch cannot buy a one-way view.
- **Absent, not negative.** Someone who declines is missing from the breakdown rather than shown as "not delivered", and one silent member keeps the message at `sent` rather than being rounded up to delivered. A negative row would publish the setting and would be a guess besides.

Code: `web/src/lib/mls.js` (`deliveryBreakdown`, the `applyAck` guard), `web/src/lib/store.js`, `web/src/views/chat/DeliveryDetails.jsx`. Docs: [dm-encryption.md](docs/dm-encryption.md).

**Status: complete.**

---

# Moderation and trust fundamentals

The following audited moderation features are implemented:

- bans;
- timeouts;
- slowmode;
- account/domain gates;
- screening;
- AutoMod keyword/regex/link rules;
- held messages;
- mention/flood controls;
- audit logs;
- federated reports;
- defederation;
- shared blocklist feed support;
- optional feed signature verification;
- media scanners/hash blocklists.

The optional-unsigned-feed hardening item remains in the active roadmap.

---

# Client architecture and platform work

The following audited client architecture is implemented:

- multiple server connections;
- per-server degraded state;
- reconnect/backoff;
- browser local snapshots / IndexedDB state;
- unified client-side state;
- Tauri desktop;
- Android Tauri target/build workflow;
- mobile navigation and tests;
- expression/GIF UX.

The web client's use of IndexedDB rather than literal client-side SQLite is treated as a technology substitution, not an unfinished behavioral promise.

---

# Federation and guild/client fundamentals

The following verified features were already implemented at the time of the audit and belong here rather than in the active roadmap:

- optional guild message `author_signature`;
- signed federation requests;
- federation key validity windows/cache;
- audience-bound identity assertions;
- periodic guild-session revalidation;
- profile versioning;
- guild-cached member essentials;
- lazy member-list ranges;
- gateway intents;
- presence/custom status/activity infrastructure;
- cross-server invite preview/join;
- AutoMod/gates/slowmode/held messages;
- federated abuse reports;
- guild SFU voice/video;
- server mute/deafen enforcement;
- TURN support for guild voice;
- explicit screenshare watchers;
- per-channel stream caps;
- custom per-guild SFU regions;
- SFU health checks and failover/reconnect;
- cold-history segmentation/page-in.

---

# Scaling a massive guild

## Cold storage's object-storage backend

Cold-history segments (`src/cold.rs`) could only be written to local disk. `archive.store` now selects between `"local"` (unchanged) and `"s3"`, configured under `[archive.s3]` in the same shape as `[backup.remote]`.

Rather than a second hand-rolled SigV4 client, the existing one built for the backup path (`src/backup/s3.rs`) grew two bytes-based methods, `put_bytes`/`get_bytes`, alongside the file-based ones `upload_file`/`download` already used for backup archives — cold segments are small enough to round-trip through memory rather than a temp file. `src/objectstore.rs` is the seam: an `ObjectStore` enum callers go through instead of `tokio::fs` directly, so the media origin (`routes/media.rs`) can grow the same switch later without a third implementation.

Verified against the in-repo fake-S3 test harness (`tests/backup.rs`) and, once, against a real MinIO instance via `server/compose.dev.yml` (`cold_storage_on_real_minio_round_trips`, `#[ignore]`d since CI has no bucket to talk to).

Out of scope here and still open in `roadmap.md`: Postgres, Scylla/Cassandra, and the distributed fanout bus.

**Status: complete.**

## Media's object-storage backend

Uploaded media (`src/routes/media.rs`) grew the same `media_store.store = "local" | "s3"` switch, through the same `ObjectStore` seam cold storage introduced. All hot-path filesystem calls in the media route, and the four other call sites that read/wrote media bytes directly (`src/migration.rs` x2, `src/migration/media.rs`, `src/routes/guild.rs`), go through `state.media_store` now.

Two things this backend does not carry over from the local one:

- `sweep_orphans`, the mtime-based directory-walk GC for bytes written but never claimed by a row, is local-filesystem-only and now returns early on an S3 backend. A bucket accumulates orphaned objects until a listing-based sweep is built; `sweep_expired` (deletes by row, not by directory) is unaffected and still runs.
- `touch`, the filetime restamp a migration import used to call when it found bytes already on disk mid-import, is gone rather than ported: the two call sites now just `put` unconditionally, which is idempotent for content-addressed storage and, on the local backend, still bumps the mtime `sweep_orphans` reads — the same effect `touch` had, without a backend-specific primitive.

Range reads (`Range: bytes=...`) needed a new `S3Client::get_bytes_range`, and exposed that the in-repo fake S3 test harness did not honor `Range` at all; it was taught to, since the alternative was a test that could not tell a working implementation from a broken one.

Verified against the fake-S3 harness and, once, against real MinIO (`media_on_real_minio_uploads_ranges_and_deletes`, `#[ignore]`d for the same reason as cold storage's).

**Status: complete.**

## Portable upsert syntax, ahead of a Postgres backend

Not the Postgres backend itself — that remains open in `roadmap.md`, and is a genuinely larger undertaking (a query-by-query audit across ~1,026 call sites, plus redesigns of the SQLite-trigger-based replication log and the FTS5 search table, neither of which has a mechanical translation to Postgres).

This is the one piece of that work that was low-risk and backend-agnostic on its own: the 20 non-replication `INSERT OR IGNORE`/`INSERT OR REPLACE` call sites (`memberships.rs`, `guildstore.rs`, `hosting.rs`, `routes/social.rs` x4, `routes/dm.rs`, `routes/guild.rs` x2, `routes/moderation.rs` x2, `routes/opaque.rs`, `federation/media_feeds.rs` x2, `migration.rs` x4 including one that generates SQL per-table at runtime, `migration/media.rs` x2) now use `INSERT ... ON CONFLICT DO NOTHING` or `ON CONFLICT (...) DO UPDATE SET ...`, which SQLite has supported since 3.24 and is the same syntax Postgres uses. No behavior change, verified by the existing SQLite integration test suite — this shipped as a plain refactor, not a Postgres-specific change, and a future Postgres cutover has twenty fewer call sites to rewrite.

`src/replicate.rs`'s own `INSERT OR REPLACE` (its dynamically-generated per-table replication log inserts) was deliberately left alone: it belongs to the trigger/rowid/`ATTACH DATABASE`-based replication design that needs a full Postgres-native redesign, not a syntax swap.

**Status: complete, as prep work — the Postgres backend itself is unaffected and still open.**

---

# Onboarding and guild hosting

## Managed guild-hosting marketplace

Choosing where a guild lives now has two real answers instead of one. The create-a-guild flow offers this server — self-hosted, unchanged — beside the managed providers an operator is willing to list, with each provider's prices, member/storage/media limits, regions and terms shown before anything is created.

Completed work includes:

- a signed provider catalogue (`telium.hosting_catalog`) on the existing signed-JSON envelope, verified only against the key the subscriber pinned, with the same rollback and equivocation rules as a media feed;
- subscription over the existing SSRF-safe feed fetcher — https only, internal addresses refused, pinned resolution, no redirects, size-capped — reused rather than reimplemented;
- publication, so an operator's curated list is itself a catalogue other operators can pin and subscribe to;
- pricing and limits per plan (integer minor units and a currency, member cap, storage, media quota, notes), bounded field by field and surfaced in the client;
- a managed-vs-self-hosted fork in "Create a guild" that ends at the provider's own signup page in a new tab;
- the guided guild handoff named on every screen where a host is chosen, so portability is stated before the decision rather than after regretting it.

Deliberately out of scope, and not an unfinished promise: no money moves through Telium, no payment credential is held anywhere in this repository, and no server creates an account at a provider. There is no route that creates a guild at a provider, and no ranking, review, or verification of a listed company.

**Status: complete.** See [`docs/hosting.md`](docs/hosting.md).

---

# Historical completed priority batches

These former active priorities are complete and intentionally no longer appear in `roadmap.md`:

1. make guild migration a true round trip;
2. carry the portable account state promised by migration;
3. build encrypted off-box backup and one-command restore;
4. enforce SFU bitrate budgets;
5. turn failover records into a usable warm standby;
6. add direct/relay/SFU DM and group-call modes;
7. make viewer quality select an actual simulcast layer;
8. resolve curated media feeds into guild policy;
9. normalize expression uploads;
10. encrypt the client sync store and sync drafts/saved stickers safely.

Future agents should treat this archive as evidence of completed roadmap scope, but should still reopen an item when a concrete regression, security flaw, or unmet end-to-end requirement is demonstrated.
