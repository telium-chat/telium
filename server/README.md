# telium-server

The Telium reference homeserver is one Rust binary with independently configurable **identity**, **guild**, and **media** roles. SQLite is the implemented/default database.

The architecture is intentionally single-authority per subject: an account has one account home and a guild has one authoritative guild server. Guild state is not multi-master replicated and there is no conflict-resolution layer for ordinary guild writes.

For the complete documentation map, start at [`../docs/README.md`](../docs/README.md). The high-level authority model is in [`../docs/architecture.md`](../docs/architecture.md).

## Run it

```sh
cargo run -- init      # write telium.toml from current defaults
cargo run -- serve     # start the homeserver
cargo run -- backup    # take one consistent backup now
cargo run -- keys      # print published server signing keys
cargo test
cargo check
```

Warm-standby commands:

```sh
cargo run -- standby status
cargo run -- standby pair b.example
cargo run -- standby sync
cargo run -- standby promote a.example
```

Read [`../docs/warm-standby.md`](../docs/warm-standby.md) before using standby promotion in a real deployment.

## Configuration

[`telium.example.toml`](telium.example.toml) is the canonical annotated configuration. Important sections include:

- **`[roles]`** — enable/disable identity, guild, and media roles.
- **`[federation]`** — discovery/test peer overrides and HTTP policy.
- **`[media_policy]`** — upload/storage/cache limits and whether ordinary file hosting is enabled.
- **`[media_registry]`** — external-host registry and browser Gofile playback compatibility policy.
- **`[moderation]`** — upload hash lists and moderation-related operator policy.
- **`[voice]`** — configured SFU regions.
- **`[failover]`** — standby replication/promotion relationships.
- **`[backup]`** — scheduled snapshots/retention/staleness reporting.
- **`[web]`** — optional static serving of the built React client.
- **`[klipy]`** — optional direct-browser GIF search configuration.

Feature/operator policy is published through `GET /_telium/v1/capabilities` where clients need to gate behavior; specialized registries such as external media use their own documented endpoints.

For deployment/operator consequences, see [`../docs/operator-guide.md`](../docs/operator-guide.md).

## Federation and sessions

A user's home session is never meant to become a foreign guild credential.

For a remote guild, the account home signs a short-lived assertion binding the user/device to a specific audience. The guild server verifies it and mints its own local session token. After that exchange the account home is off the guild hot path.

When identity and guild roles are co-hosted, `/sessions/local` performs the same logical exchange internally.

Server-to-server traffic is signed independently of TLS where the request itself needs authenticated server identity; other public federation lookups return signed documents. See [`../docs/federation.md`](../docs/federation.md).

## Source layout

| Path | Responsibility |
| --- | --- |
| `src/crypto.rs` | Server Ed25519 keys and identity assertions |
| `src/perms.rs` | Permission bitfield/evaluation and hierarchy |
| `src/guildstore.rs` | Shared membership/permission reads |
| `src/gateway/` | WebSocket sessions, events, presence, subscriptions |
| `src/federation/` | Signed S2S transport, discovery/key cache, federation policy |
| `src/routes/identity.rs` | Accounts, profiles, sessions/devices, MFA, assertions, sync |
| `src/routes/opaque.rs` | OPAQUE registration/login/reauth/password reset |
| `src/routes/identity_continuity.rs` | Immutable identity and guardian/recovery policy |
| `src/routes/guild.rs` | Guilds/channels/roles/members/invites/expressions |
| `src/routes/messages.rs` | Guild message history/write/edit/delete/typing |
| `src/routes/social.rs` | Reactions, pins, threads/forums, read state/search/follow |
| `src/routes/moderation.rs` | AutoMod, gates, held messages, reports |
| `src/routes/friends.rs` | Friend requests/blocks/presence/mutuals |
| `src/routes/dm.rs` | Encrypted conversation routing, key packages, vaults |
| `src/routes/dmvoice.rs` | DM/group-call state and SFU coordination |
| `src/routes/voice.rs` | Guild voice state, tokens, streams/watch/signaling |
| `src/routes/media.rs` | Telium media plus external-host/Gofile helpers |
| `src/routes/migrate.rs` | Account/guild migration endpoints |
| `src/routes/memberships.rs` | Account-side membership registry/remap state |
| `src/routes/failover.rs` | Standby/failover HTTP surface |
| `src/routes/alerts.rs` | Migration alerts, recovery-email state, signed-out cancel links |
| `src/replicate.rs` | Standby snapshot/log replication |
| `src/promotion.rs` | Signed authority promotion/fencing |
| `src/relocation.rs` | Signed server-relocation records |
| `src/backup.rs` | Consistent scheduled snapshots/retention |
| `src/cold.rs` | Cold message-history segments |
| `migrations/` | SQLite schema history |

The route registry is centralized in `src/routes/mod.rs`.

## API

Do not maintain a second hand-copied route list here. The current grouped HTTP/gateway surface and authentication classes are documented in [`../docs/api.md`](../docs/api.md); `src/routes/mod.rs` remains the canonical executable registry.

That document covers account/OPAQUE, guilds/messages/moderation, friends/mutuals, DMs, voice, media/external providers, migration, failover, and operator routes.

## Security/privacy boundaries

A few rules are worth keeping visible at the server entry point:

- Current account authentication supports **OPAQUE**. See [`../docs/account-security.md`](../docs/account-security.md).
- DM/group-conversation application content uses **MLS E2EE** and is opaque to routing/storage code. See [`../docs/dm-encryption.md`](../docs/dm-encryption.md).
- Immutable identity/verification/guardian policy is documented in [`../docs/identity-continuity.md`](../docs/identity-continuity.md).
- Guild messages are **not** currently MLS E2EE; the authoritative guild server can read them.
- Permission enforcement is server-side. Client-hidden buttons are not authorization.
- Hidden guild resources should avoid existence leaks (for example inaccessible channels use not-found behavior).
- Blocks are one-sided account-home state and are not disclosed to the blocked account as “blocked.”
- Federation signatures authenticate the logical Telium origin above TLS.
- A standby is read-only until signed promotion and a demoted old primary fences writes.

## Media

Telium-hosted files are content-addressed objects referenced by capability-bearing `media://` descriptors. Guild servers can cache remote media without becoming the authoritative origin. Upload scanning, expression normalization, migration forwarding, and camo/embed behavior are described in [`../docs/media.md`](../docs/media.md).

The current Gofile external-host adapter has a different path: upload bytes remain client-direct in the current client; native playback can remain direct; ordinary browser playback can optionally stream through a compatibility relay controlled by `gofile_playback_proxy`. External host choices and that playback flag are published by `GET /_telium/v1/media/registry`. See [`../docs/external-media.md`](../docs/external-media.md).

## Voice and SFU

The repository **does include a reference SFU** under [`../sfu/`](../sfu/). Older documentation that said the media path had “nothing at the far end” is obsolete.

The homeserver remains the authorization authority: it checks membership/permissions and mints short-lived SFU tokens. The SFU verifies those rights and moves media; it does not invent guild authorization.

- Call protocol: [`../docs/calls.md`](../docs/calls.md)
- SFU architecture/config: [`../sfu/README.md`](../sfu/README.md)
- Operator deployment wizard: [`../sfu/self-service.md`](../sfu/self-service.md)
- Shared signing/token crate: [`../telium-protocol/README.md`](../telium-protocol/README.md)

## Operations and continuity

Use the canonical docs for procedures rather than reconstructing them from routes:

- [`../docs/backup.md`](../docs/backup.md)
- [`../docs/migration.md`](../docs/migration.md)
- [`../docs/relocation.md`](../docs/relocation.md)
- [`../docs/warm-standby.md`](../docs/warm-standby.md)
- [`../docs/sunset.md`](../docs/sunset.md)

## Development expectations

Run the Rust tests/checks for server changes and the cross-component workflows when the change affects web/SFU/native behavior. New routes need auth/failure tests and updates to `docs/api.md`; new operator settings need `telium.example.toml` documentation and a subsystem doc update.

See [`../docs/development.md`](../docs/development.md).
