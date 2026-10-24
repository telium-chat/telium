# Telium Roadmap: Remaining Work

This document tracks only work that is not fully complete.

Completed roadmap items have been moved to [`roadmap-completed.md`](roadmap-completed.md).

Audit baseline: `64c06234513c14b5a82a6865a43c189e08e2c4bd` on `main` (2026-09-15).

A feature stays here if the plan promise is missing, partial, materially divergent, or still has substantive unfinished behavior. Completed implementation history belongs in `roadmap-completed.md`.

## Highest-priority remaining gaps

| Severity | Plan promise | Current state | Remaining work |
|---|---|---|---|
| **High** | Production scaling path | **Missing, partial start** | Postgres, Scylla/Cassandra, distributed fanout, stateless/multi-pod gateway architecture (cold storage and media both have an object-storage backend now) |
| **High** | Distributed onboarding rollout | **Implemented/rollout pending** | Production recommendation signing/pinning, key-continuity hardening, full-suite validation once CI runners execute |
| **High** | Federated/mobile push aggregation | **Missing/partial** | Guild → user's home notification relay, home aggregation/coalescing, APNs/FCM |
| **Low/optional** | OIDC/passkeys | **Missing** | Homeserver-local OIDC and passkey architecture |
| **Low/deferred** | MessagePack gateway framing | **Missing** | Negotiated binary framing, if distributed fanout makes it worthwhile |

---

# 1. Topology and addressing

Nothing remains open here. Guild vanity addressing was the last item; it is archived in `roadmap-completed.md`.

---

# 2. Identity, authentication, profiles, presence, sync

## Best-effort identity revocation delivery still has edge cases

The home server pushes signed account/device revocation notices to guild servers in the account's membership registry, with durable retry and status revalidation.

Remaining limitations:

- a guild server that never reached the membership registry learns only on periodic revalidation;
- push delivery gives up after twelve attempts and falls back to revalidation.

**Status: implemented, but not fully complete as a delivery mechanism.**

## Full profile fetch remains architecturally divergent

The plan says a client should fetch a remote user's current full profile directly from that user's homeserver.

The current client asks its own homeserver to resolve/fetch the remote profile.

**Status: functional architectural divergence.**

## OIDC and passkeys

OPAQUE password authentication is implemented, including migration of older accounts after one legacy login.

Still missing:

- OIDC,
- passkeys.

These are homeserver-local extensions and lower priority than protocol gaps.

**Status: optional architecture not implemented.**

---

# 3. Guilds, expressions, realtime gateway

## MessagePack gateway negotiation

Gateway v1 currently uses JSON and rejects binary frames.

The plan's negotiated MessagePack option is not implemented.

**Status: missing/deferred.**

---

# 4. Server-to-server protocol

The signed federation core is implemented well, but `plan-draft.md` should no longer be treated as an exhaustive protocol specification because the implementation now has more federation endpoints than the original list.

Remaining documentation task:

- keep canonical protocol definitions in the standalone protocol/API documentation;
- keep `plan-draft.md` explicitly historical.

**Status: documentation cleanup remains.**

---

# 5. Media and files

## Rich operator media-policy rules

Implemented:

- enable/disable/quota;
- allowlist/blocklist;
- profile carveout;
- per-file limits;
- preferred external origin.

Still missing as a general rule engine:

- paid-user rules;
- account-age rules;
- invitation-tree trust;
- staff-category rules;
- richer policy predicates.

**Status: functional basic policy; richer rules missing.**

## Archival rehosting of important attachments

The plan describes optional archival rehosting for important channels with uploader consent.

Current cold-storage support archives message history, not attachment objects.

**Status: missing.**

---

# 6. Direct messages and E2EE

## DM/GC calls: residual control and test gaps

Direct, TURN-relayed, and SFU-routed calls are implemented, including privacy postures, seamless mesh → SFU migration, conversation-specific SFUs, and E2EE SFU media.

Remaining limitations:

- a custom SFU receives no sequencer control commands such as kick/bitrate controls;
- SFUs still observe connection/timing/traffic metadata;
- relay posture cannot join if neither TURN nor an SFU is available;
- posture hellos authenticate to the MLS group, not one device;
- mesh → SFU and E2EE media paths lack automated browser coverage.

**Status: core modes implemented; residual gaps remain.**

## Recovery UX divergence

OPAQUE-backed one-password server-blind recovery, trusted-device recovery, encrypted history recovery, and an optional independent recovery passphrase are implemented.

The plan's BIP39-style recovery phrase UX is not.

**Status: functional recovery implemented; recovery-phrase UX diverges.**

## Group membership policy limitations

Signed membership policy lives in the MLS GroupContext and is enforced by clients and by the sequencer for declared changes.

Remaining limitations:

- a modified client can omit declaring a change to the sequencer; honest members still reject the commit;
- old clients cannot join groups using the extension;
- a policy cannot be added later to an existing open group.

**Status: implemented with compatibility/enforcement limits.**

---

# 7. Moderation, abuse, trust

The moderation stack is broadly complete.

Remaining hardening:

- shared blocklist feed public keys are optional, so an operator can still subscribe to an unsigned feed.

**Status: mostly complete; one trust-hardening item remains.**

---

# 8. Migration, failover, continuity

Most migration, backup, relocation, and warm-standby work is complete and archived in `roadmap-completed.md`.

## Federated membership migration edge cases

The membership registry and signed move notices are implemented.

Remaining edge cases:

- a guild server predating registry notices is only as current as the last client reconciliation;
- a guild server that never returns keeps membership under the old identity until rejoin.

**Status: implemented with stale/unreachable-peer edge cases.**

## Migrated media still has redirect-dependent references

Account media bytes move, omitted objects are fetched later, per-object landing is acknowledged, and ordinary message references are rewritten.

Remaining limitation:

- pointers inside encrypted DM payloads and already-cold message segments cannot be rewritten and depend on the old origin's redirect.

**Status: migration works; some historical references remain redirect-dependent.**

## Migration recovery-email verification

Migration alerts reach every device and can be sent to a recovery address.

Remaining:

- recovery addresses are not verified with a round-trip email;
- recovery addresses are not migrated to the destination.

**Status: alert flow implemented; address verification/portability missing.**

## Planned sunset follow-through

Shutdown/migration mode, registration closure, signed bundles, consented bulk moves, tombstones, and terminal read-only behavior are implemented.

Still missing from the broader shutdown story:

- importing a downloaded account bundle at another server;
- peers acting on a domain-wide `gone` tombstone.

**Status: server shutdown mode implemented; ecosystem follow-through remains.**

---

# 9. Scaling a massive guild

The small deployment path is real. The medium/large architecture remains the largest technical gap.

## Missing: Postgres backend

The server remains SQLite-centric: ~1,026 raw `sqlx::query`/`query_as`/`query_scalar` call sites across 47 files, all on SQLite's `?` placeholder syntax, no repository/trait abstraction. A real cutover needs a query-by-query audit, not a translation layer — `sqlx::Any` does not paper over placeholder syntax (`?` vs `$N`), so every call site needs touching regardless.

Two subsystems need redesigns rather than rewrites:

- `src/replicate.rs`'s write-ahead replication is built on SQLite triggers generated from `sqlite_master`/`pragma_table_info` introspection, `ATTACH DATABASE` snapshotting, and a `rowid` fallback key that is exposed in the replication wire format. None of that has a Postgres equivalent; this needs a Postgres-native design (logical replication, or triggers + LISTEN/NOTIFY).
- The `messages_fts` FTS5 virtual table (one table, one search endpoint in `routes/social.rs`) has no Postgres equivalent; needs `tsvector`/GIN with different tokenizer/ranking semantics, or an external search engine.

Done as low-risk prep, independent of backend selection: the 20 `INSERT OR IGNORE`/`INSERT OR REPLACE` call sites outside the replication subsystem now use `ON CONFLICT DO NOTHING`/`ON CONFLICT (...) DO UPDATE`, which is valid on both SQLite (3.24+) and Postgres — so this shipped as a plain refactor, verified against the existing SQLite test suite, not as a Postgres-specific change. See `roadmap-completed.md`.

Still SQLite-specific and out of scope of that prep: `PRAGMA`-based schema introspection in `relocation.rs` (4 sites), `json_each`/`json_extract` table-valued functions in `social.rs` (3 sites, attachment MIME filtering), one `AUTOINCREMENT` and one `WITHOUT ROWID` in already-shipped migration files (migration files are checksum-verified by `sqlx::migrate!` once applied — a Postgres migration set has to be a separate, parallel set of migrations, not edits to the SQLite ones).

## Missing: ScyllaDB/Cassandra message log

The large-guild message storage tier does not exist.

## Missing: distributed fanout bus

Current gateway fanout is in-process.

Still needed:

- NATS or Redis Streams (or equivalent);
- stateless gateway/fanout pods.

## Missing: serialize-once distributed fanout optimization

This depends on the distributed fanout architecture and any eventual MessagePack support.

**Status: production scale backend missing.**

---

# 10. Client architecture

Implemented client architecture includes multiple server connections, per-server degraded state, reconnect/backoff, browser local snapshots, unified client state, Electron desktop, Android work, and mobile UI/tests.

One intentional technology substitution remains:

- plan: client SQLite;
- web client: IndexedDB/browser storage.

The behavioral goal is substantially satisfied, so this is not a priority gap.

---

# 11. Onboarding non-technical users

## Distributed account-home selection

The distributed onboarding architecture is implemented in this work and documented in [`docs/distributed-onboarding.md`](docs/distributed-onboarding.md).

Implemented:

- explicit public registry opt-in plus independent live homeserver acceptance and bounded referral weight;
- mechanical eligibility from registration state, protocol compatibility, identity role, move/sunset state, operator contact, domain/API continuity, fresh probe history, independently observed age and measured uptime;
- signed/expiring Ed25519 recommendation feed with delegated HTTPS API origins;
- client-side pinned-key verification and still-valid signed-cache fallback;
- local cryptographically random weighted selection;
- operator-level anti-concentration so several domains under the same operator contact share one ceiling;
- beginner **Account home** card with Change / Browse all / Advanced paths;
- no candidate-home probing before selection and no implicit page-origin/project-server fallback;
- operator, region and recent-uptime disclosure;
- public directory recommendation status/reasons for operators;
- concise move-later education.

Remaining rollout/hardening:

- create and configure the production recommendation signing secret/key id;
- pin the corresponding public key in production client builds;
- add unexpected server signing-key continuity monitoring to eligibility;
- strengthen operator grouping if real-world alias evasion appears;
- run full site/web/server test suites once GitHub Actions runners execute again.

The Telium-operated homeserver should normally publish zero automatic referral weight and remain a reference/testing destination rather than the ecosystem's default account home.

**Status: core implementation complete; production rollout/hardening remains.**

## Invite-first new-user signup

Implemented:

- logged-out guild preview;
- inline registration using the same distributed Account home picker;
- account-home selection independent from the invited guild server;
- recovery-key acknowledgement before continuation;
- automatic continuation into the original cross-server invite;
- tests with account and guild on different origins.

Remaining work is covered by the same production signing/pinning and full-suite validation items above.

**Status: implemented; rollout validation remains.**

---

# 12. Push notifications

Browser Web Push/VAPID support exists.

Still missing:

- guild → user's homeserver notification event;
- homeserver push aggregation;
- cross-server coalescing;
- APNs;
- FCM.

**Status: local Web Push implemented; federated/mobile relay missing.**

---

# 13. Technology choices

The current stack broadly matches the intended architecture:

- Rust / axum / tokio;
- React;
- Electron;
- LiveKit;
- standalone protocol documentation.

Known substitution:

- plan: OpenMLS;
- current web client: `ts-mls`.

This is a technology substitution, not by itself a functional gap.

---

# 14. Explicit future/v2 work

Items the original plan itself treated as future work:

- SFrame E2EE for SFU-routed calls, if still desired beyond the current LiveKit E2EE path;
- privacy-sensitive guild connection relay through the user's homeserver;
- APNs/FCM homeserver notification aggregation;
- attachment archival/rehosting with uploader consent;
- full Postgres/Scylla/distributed-fanout scale architecture.

---

# Recommended implementation order

## P0 — production architecture

### 1. Add production storage/fanout tiers

- Postgres relational backend;
- Scylla/Cassandra message backend;
- NATS or Redis Streams event bus;
- stateless gateway/fanout pods.

(Cold storage and media both have an S3-compatible backend now; the storage abstraction from `objectstore.rs` was a byproduct rather than a preliminary — it does not extend to Postgres/Scylla, which is a different shape of problem.)

## P1 — product rollout and notifications

### 2. Finish distributed account-home onboarding rollout

- create/configure the production feed signing key and pin its public key in production clients;
- add signing-key continuity hardening;
- validate the complete site/web/server path when CI runners execute again;
- observe distribution after rollout and tune thresholds without personalized tracking.

### 3. Build federated/mobile notification aggregation

- guild → account-home notification relay;
- home coalescing/aggregation;
- FCM/APNs delivery;
- privacy-preserving encrypted-message fallback copy.

## P2 — protocol/media/voice polish

The media-origin ecosystem, screenshare semantics, guild vanity addressing and external emoji entitlement are done; their records are in `roadmap-completed.md`. What the batch did not reach:

### 4. Finish the operator media-policy rule engine

- paid-user, account-age, invitation-tree and staff-category predicates (section 5).

### 5. Close the residual DM gaps

- recovery-phrase UX;
- group membership policy enforcement and compatibility limits;
- custom-SFU control commands and browser coverage for the mesh → SFU path (section 6).

### 6. Optional homeserver-local authentication

- OIDC and passkeys (section 2);
- MessagePack gateway framing only if the distributed architecture justifies it.

---

# Roadmap principle

The active roadmap should contain unfinished work only. When a plan promise is complete end-to-end, move its implementation record to `roadmap-completed.md` instead of leaving a crossed-out task here.
