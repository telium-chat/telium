# Technical Plan: Federated Guild Chat Platform

*Working name: "Telium" — a decentralized Discord alternative with single-authority guilds*

## 1. Overview and Design Philosophy

This system is a federated chat platform built around one deliberate architectural departure from Matrix: **guild state is not replicated across homeservers**. Each guild lives on exactly one homeserver, which is the sole authority for its messages, membership, permissions, and voice infrastructure. This trades some resilience (a guild goes down when its homeserver does) for enormous simplifications: no state resolution algorithm, no eventual-consistency conflicts, no unbounded storage growth on every participating server, and a scaling model that looks like Discord's rather than like a distributed database.

The result is closer in spirit to XMPP's multi-user chat model or to email's "the mailbox lives somewhere specific" model than to Matrix's replicated DAG — but with a modern protocol surface (WebSocket gateway, REST API, WebRTC voice) that clients and users will recognize from Discord.

### Core principles

**Single authority per guild.** The homeserver that hosts a guild owns its data and enforces its rules. Other servers never hold canonical copies of guild state.

**Federated identity, direct connection.** Users have a home identity (`@user:home.example`) but clients connect *directly* to guild homeservers rather than proxying through their own homeserver. This avoids the double-hop latency and duplicated storage that plague fully-federated designs, and means a guild server's operator only needs to scale for their own guilds.

**Media lives with the sender's chosen origin.** Uploaded files are stored on a media origin the *uploader* controls — their homeserver by default, or any third-party host implementing the media protocol. The guild stores only references. Storage costs land on the person (or provider) who created the content, and file hosting becomes an open, pluggable ecosystem.

**Voice lives with the guild.** The guild's homeserver runs the SFU. Voice quality and capacity are the guild operator's responsibility, matching where the community actually lives.

**E2EE DMs with pragmatic key custody.** DMs are end-to-end encrypted. By default the user's homeserver escrows the keys (so account recovery works and casual server compromise still requires deliberate action to read DMs); users can opt into self-custody, accepting that lost keys mean lost history.

**Identities and guilds are movable.** Nothing in the network is welded to the server it was born on. Accounts, guilds, and even whole homeservers have first-class, signed migration paths (Section 10), because a federation where leaving your server means losing your life is federation in name only.

---

## 2. Topology and Roles

A single homeserver deployment can play three roles, together or separately:

**Identity provider** — hosts user accounts, issues identity assertions, stores DM inboxes and key vaults, serves the user's uploaded media, and stores the user's profile and small account-synced client data.

**Guild host** — hosts one or more guilds: channels, messages, roles, membership, expression assets (custom emoji/stickers), the realtime gateway, and the voice SFU.

**Media origin** — stores and serves uploaded files to authorized fetchers anywhere in the federation. Bundled with the identity role by default, but also deployable standalone: a dedicated file host that speaks only the media protocol is a valid, first-class node in the network (Section 6).

A hobbyist runs all three in one binary on one box. A large community might run a dedicated guild host while its members' identities live on dozens of other servers. Nothing in the protocol distinguishes these deployments — it's the same server software with different load profiles.

### Addressing

- Users: `@alice:home.example`
- Guilds: `#gaming:guilds.example` (plus an immutable internal ULID; the readable name is a vanity alias)
- Channels: ULIDs scoped to their guild — never addressed cross-server independently of the guild
- Media: `media://home.example/<blake3-hash>` — content-addressed, origin-qualified

Server discovery uses `/.well-known/telium/server` on the domain, pointing at the actual API host and port (so `home.example` can delegate to `telium.home.example:8443`). Each server publishes its Ed25519 signing keys at `/_telium/v1/keys`, with key IDs and validity windows, so any party can verify signatures made by any server.

---

## 3. Identity and Authentication

### Accounts and devices

An account is `@user:domain` plus a set of **devices**. Each device generates its own Ed25519 device key at login. The homeserver maintains a signed device list per account (needed later for E2EE, and load-bearing for migration authorization in Section 10). Password auth, OIDC upstream login, and passkeys are all homeserver-local concerns — the federation protocol only cares about the assertions the homeserver issues.

### Connecting to a guild: identity assertions

Because clients connect directly to guild servers, the guild server needs proof that a connecting client really is `@alice:home.example`. The flow:

1. Client asks its own homeserver for an **identity assertion**: a short-lived (≈5 min) signed token binding `{user_id, device_id, device_pubkey, audience: guilds.example, exp}` — signed with the homeserver's federation key.
2. Client opens a connection to `guilds.example` and presents the assertion.
3. Guild server fetches `home.example`'s public keys (cached, with the published validity windows), verifies the signature and audience, and issues its own **local session token** for that user+device.
4. Subsequent requests to that guild server use the local session token; the home server is not on the hot path for anything the user does inside the guild.

This is deliberately OIDC-shaped without requiring full OIDC: the homeserver is the IdP, the guild server is the relying party, and the audience field prevents a stolen assertion from being replayed against a different guild server.

**Revocation:** guild servers periodically (and on webhook push from the home server, best-effort) re-validate that the account still exists and the device is still active. A deactivated account stops being able to mint assertions immediately; existing local sessions expire within a bounded window (configurable, default 1 hour). This same revalidation loop is how guild servers learn about account migrations: the status endpoint can answer `moved` with a redirect (Section 10).

### Profiles, presence, and account-synced client data

Users have public **profiles**: display name, avatar, banner image or accent color, bio/about-me, and pronouns. The profile is canonical on the user's homeserver, served at `GET /_telium/v1/user/{id}/profile`, signed, and carries a monotonically increasing `profile_version`.

**How large guilds render member lists without melting.** A naive design — every client fetching every member's profile from that member's homeserver — would be quadratic misery and turn scrolling the sidebar of a 100k guild into a federation DDoS. Instead, the guild server caches the *display essentials* of each member: display name, avatar media reference, and current presence. These are pushed once at join time (the identity assertion carries the current `profile_version`, so the guild knows when its cache is stale and refreshes lazily) and thereafter served by the guild server itself as part of the lazy member list ranges (Section 4). Rendering the member list of an enormous guild therefore costs the same as it does on Discord: cached name + avatar ref from one server, for only the rows currently on screen. Foreign homeservers are never on the scroll path.

**Full profile on demand.** Clicking a user's profile is when the client fetches the full, current profile (bio, banner, etc.) directly from that user's homeserver — one request per deliberate user action, the cheapest possible place to spend a federation round-trip. If the homeserver is unreachable, the client renders the guild-cached essentials with an "extended profile unavailable" state.

**Presence.** The familiar colored status dots: online, idle, do-not-disturb, and invisible/offline, plus an optional custom status line and activity ("Playing X" / "Listening to Y", published by the client, with a global and per-guild privacy toggle). Presence is per-gateway-connection: the client reports its status to each guild server it's connected to, and each guild fans it out subject to the coalescing and subscription-scoping rules in Section 11 — presence is *the* fanout bomb at scale, which is why it's 30-second-granularity, visible-members-only, and disableable per guild. There is no global cross-federation presence: your presence in a guild is a matter between you and that guild server.

**Account-synced client data.** The homeserver stores a small encrypted key-value **client sync store** per account (bounded size, ~1 MB class): GIF favorites, frequently-used emoji, saved stickers, collapsed categories, notification preferences, drafts. This is what makes the client feel like *your* client on every device without any of it touching the federation protocol — it's purely a client-to-homeserver concern, but it must exist server-side because features like the GIF picker's favorites (Section 4) have to follow the account, not the device.

### Account migration (core feature)

Account portability is not a v2 afterthought — the ability to pick up `@alice:old.example` and move her, one click, to `@alice:new.example` with contacts and guilds following automatically is a headline feature and a design constraint on every schema in this document: **no table may assume a user ID is immutable forever.** The full mechanism — signed tombstones, redirect propagation, the security model, and what happens when servers shut down — lives in Section 10.

---

## 4. Guilds

### Data model

The guild server owns, per guild:

```
Guild        { id, name, icon_media_ref, owner, settings, created_at }
Channel      { id, guild_id, type: text|voice|forum|announcement, name,
               topic, position, parent_category, permission_overwrites[] }
Role         { id, guild_id, name, color, position, permission_bitfield }
Member       { user_id, guild_id, nickname, roles[], joined_at,
               timeout_until, banned }
Message      { id (ULID), channel_id, author, content, attachments[],
               reply_to, thread_id, edited_at, author_signature? }
Emoji        { id, guild_id, name, media_ref, animated, uploader }
Sticker      { id, guild_id, name, media_ref, format, uploader }
```

Permissions are a Discord-style bitfield with role hierarchy and per-channel overwrites. Because a single server evaluates every action, permission checks are a local function call — there is no cross-server permission reconciliation anywhere in the design, which is the largest single win of the single-authority model.

Messages get ULIDs (time-sortable, generated by the guild server, no coordination needed). Optionally, clients sign their messages with their device key (`author_signature`); the guild server stores the signature so history can later be audited as untampered even if you distrust the operator. This is opt-in per client and carries no protocol weight in v1 beyond storage.

### Expression assets: custom emoji, stickers, and the GIF picker

**Custom emoji and stickers are guild-owned assets, hosted by the guild server.** This is a deliberate, narrow exception to the "media lives with the sender" principle, and the right one: an emoji belongs to the *community*, not to whoever happened to upload it. If emoji lived on uploaders' homeservers, a guild's emoji pack would rot as members deactivated, migrated, or their homeservers died — unacceptable for assets that appear in years of message history. The guild server acts as the media origin for its own expression pack. The blast radius is inherently bounded: emoji and stickers are small, capped per guild (configurable, Discord-style slot counts), and re-encoded server-side at upload (size/dimension limits, animated formats normalized), so this doesn't reopen the storage-cost problem that sender-side media solves.

**Cross-server emoji just work, because references are global.** A message using `:pogfish:` from `#gaming:guilds.example` carries the emoji's full `media://guilds.example/<hash>` reference plus its name, exactly like any attachment reference. A client rendering that message in a *different* guild on a *different* server fetches the image from the owning guild's server. Emoji and sticker media is served publicly — no capability token, no membership voucher — because the assets are tiny, non-sensitive by construction (they passed the owning guild's upload moderation), and cross-guild rendering is the entire point. Read-through caches on receiving guild servers (Section 6) absorb the hotlink load, so one popular emoji doesn't hammer its home guild from across the federation.

Two policy knobs, both local and cheap because of single authority: guilds decide whether *their* members may use external emoji in *their* channels (an AutoMod-class setting), and which members may use *this guild's* emoji elsewhere is an entitlement guilds can leave open or restrict. Rendering received emoji always works regardless — policy governs sending, never display.

**The GIF picker is a client feature with an account-shaped shadow.** Search itself is not protocol: the reference client ships a pluggable GIF search provider interface (a Tenor-style API, a community-run index, or a self-hosted one), and a picked GIF is posted as an ordinary tier-2/tier-3 media reference or embed. But the user said it best: favorites have to be *saved in your account*. Favorited GIFs, frequently-used emoji, and saved stickers live in the account's client sync store on the homeserver (Section 3), so the picker's muscle memory follows the user across devices and — because the sync store rides along in the migration bundle — across homeservers too.

### Realtime gateway

Each guild server exposes a WebSocket gateway, one connection per (client, guild server) pair — a client in 5 guilds on 3 servers holds 3 gateway connections, multiplexing guild events over them. The gateway speaks a Discord-familiar shape:

```
HELLO → IDENTIFY (local session token) → READY
DISPATCH events: MESSAGE_CREATE, MESSAGE_UPDATE, TYPING_START,
  MEMBER_UPDATE, CHANNEL_UPDATE, VOICE_STATE_UPDATE, PRESENCE_UPDATE,
  GUILD_EMOJI_UPDATE ...
Client → server: heartbeats, voice state changes, typing, subscriptions
```

Two things Discord got right that we adopt wholesale:

**Lazy member lists.** Clients never receive the full member list of a large guild. They subscribe to the visible scroll window of the member sidebar and receive only those ranges — each row carrying the guild-cached display essentials (name, avatar ref, presence dot) from Section 3, so no foreign server is ever consulted to draw the sidebar. This is *the* thing that makes 100k-member guilds workable on a homeserver.

**Event intents/subscriptions.** Clients declare which event classes they want (e.g., no typing events, no presence) so the fanout tier can skip serialization and delivery entirely for uninterested sessions.

Wire format is JSON in v1 with a negotiated MessagePack option; the gateway protocol is versioned in the URL (`/gateway/v1`).

### Federation surface of a guild

Other servers interact with a guild server only for narrow, well-defined reasons:

- **Invite resolution** — resolving an invite code to guild metadata (name, icon, member count) for the join preview.
- **Media authorization** — guild server vouches to a media origin that a fetcher is a guild member (Section 6).
- **DM bootstrap** — looking up a user's home domain from their guild membership to initiate a DM (the DM itself never touches the guild server).
- **Identity revalidation** — the reverse direction, guild → home server, as described above; also the channel through which account-move tombstones propagate (Section 10).
- **Expression asset serving** — public fetches of the guild's emoji/stickers by clients and caches elsewhere in the federation.

That's the whole list. Guild servers never push message events to other servers. This keeps the server-to-server API tiny and auditable.

---

## 5. Server-to-Server Protocol

All S2S requests are HTTPS with a signed request scheme (similar to Matrix's federation signing): the requesting server signs `(method, path, body_hash, timestamp, origin, destination)` with its federation key and includes it in an `Authorization: X-Telium-Federation ...` header. Receivers verify against the origin's published keys. TLS provides transport secrecy; the signature provides origin authentication independent of TLS and works through reverse proxies and CDNs.

Endpoints (v1, exhaustively):

```
GET  /_telium/v1/keys                      key publication
GET  /_telium/v1/invite/{code}             invite preview (guild host)
POST /_telium/v1/media/authorize           membership voucher (guild host → media origin)
POST /_telium/v1/dm/send                   DM ciphertext delivery (home → home)
GET  /_telium/v1/user/{id}/devices         signed device list (home server)
GET  /_telium/v1/user/{id}/status          account exists / deactivated / moved+redirect / tombstone
GET  /_telium/v1/user/{id}/profile         full public profile, signed, versioned (home server)
GET  /_telium/v1/guild/{id}/status         guild exists / moved+redirect / tombstone (guild host)
POST /_telium/v1/migrate/import            migration bundle transfer, old host → new host (Section 10)
POST /_telium/v1/report                    federated abuse report
```

Deliberately absent: any endpoint for syncing guild state, backfilling rooms, or resolving state — those categories of complexity don't exist in this architecture. The migration endpoint moves a bundle exactly once, on explicit user or owner action; it is not a sync channel.

---

## 6. Media and Files

### The media origin as an interface, not a location

An attachment in Telium is a *reference* — an origin-qualified content address plus metadata — and the guild server stores only that reference (~200 bytes), never the file. The key generalization: **any host that implements the Telium media protocol can be an origin.** The sender's homeserver is the default origin, not a privileged one. This yields three trust tiers:

**Tier 1 — homeserver default.** Alice's client uploads to her own homeserver (`POST home.example/_telium/v1/media/upload`), which stores the file, computes its BLAKE3 hash, and returns `media://home.example/<hash>` plus metadata (size, mime, dimensions, thumbhash). Zero configuration; this is what everyone gets out of the box, and storage costs land with the uploader's provider. (Tier 1 is a *default*, not a mandate — operators can disable or restrict it per user and let tier 2 carry their users' uploads; see "Operator media policy" below.)

**Tier 2 — any conforming origin.** The client's upload target is configurable: a purpose-built Telium file server, a community CDN, an S3 gateway, or a client plugin wrapping any backend. References become `media://files.whatever.example/<hash>` and *everything downstream is identical* — capability URLs, membership vouchers, purge webhooks, upload scanning, deletion authority — because the origin implements the same small API. The media protocol is specced as its own document so third-party origins can be built without implementing anything else in Telium. Guilds can constrain which origins they accept references from (allowlist/blocklist by domain), since accepting a reference means trusting that origin's moderation practices. The curated host registry (below) is how users discover these origins and how guilds trust them at scale.

**Tier 3 — raw external links.** People will paste direct-download URLs from arbitrary hosts no matter what the protocol says, so this tier is designed rather than ignored — but as an *embed* system, not an attachment system (see below). Raw links render visually distinct from first-class attachments so users can tell which trust tier they're clicking.

(Guild-hosted expression assets — emoji and stickers, Section 4 — are technically a fourth case: the guild server acting as media origin for its own small, public, bounded asset pack. They use the same content-addressed references and the same wire format; they simply skip capability tokens and vouchers because they're public by design.)

### Reference flow (tiers 1–2)

1. Alice drags a file into a channel on `guilds.example`.
2. Her client uploads to its configured origin, which returns the content-addressed reference and origin-computed metadata.
3. The client sends the message with the reference; the guild server stores it.
4. Fetching clients retrieve the file from the origin directly.

The metadata is trustworthy *because the origin computed it*: the hash pins the content immutably, and the declared type/size came from the host that inspected the bytes, not from the sender.

### Access control for media

The problem: an origin must serve Alice's file to guild members — people it has no relationship with — without serving it to the whole internet. Two mechanisms, used together:

**Capability URLs.** The reference includes a per-upload random capability token in addition to the hash. Anyone holding the message can fetch the file. Zero federation round-trips, hotlink scraping is impractical (tokens are unguessable), and a leaked message leaks its attachments — same threat model as Discord's signed CDN URLs.

**Scoped vouchers (for tightened guilds).** Guilds can require membership verification: the fetching client first obtains a short-lived voucher from the guild server (`POST /media/authorize`), which the origin verifies via the guild server's signature before serving. Higher latency, real access control. Per-guild or per-channel setting.

### External links and the embed proxy (tier 3)

A bare URL to an arbitrary host loses properties the other tiers guarantee, and some losses are security holes: every member who views the channel fetches it, handing their IP to whoever controls the host (a hotlinked image is a free tracking pixel aimed at the whole guild); sender-supplied metadata is spoofable (`holiday.png` serving an executable); content behind the URL is mutable, so what moderators approved isn't what members later receive; and there's no purge webhook, scanning hook, or voucher support — the link is invisible to the abuse pipeline.

The mitigation is a guild-side **embed/camo proxy** (in the tradition of GitHub's camo): the guild server fetches the URL server-side, verifies content-type and size itself, generates and caches the preview/thumbnail, and members' clients talk only to the guild server for the embed. No member IP leak, no post-approval content swap for the cached preview, and one choke point where guilds can blocklist domains, strip embeds, or disable raw links per channel. The proxy fetches with size caps, timeout caps, and SSRF protections (no internal address ranges), and it proxies *previews* — clicking through to download the raw file is an explicit user action on a clearly external link.

GIFs picked from the client's GIF picker (Section 4) flow through these same tiers: a provider-hosted GIF is a tier-3 embed handled by the camo proxy; a GIF the user uploads or re-hosts is an ordinary tier-1/2 attachment.

### The curated host registry

The pressure that produces tier-3 links is users wanting hosts with properties their homeserver lacks — bigger size limits, permanence guarantees, specialty handling (video transcoding, galleries). The answer is to make tier 2 absorb that demand: a **curated registry of third-party file hosts**, surfaced in the client as installable upload plugins.

A registry entry is a signed manifest: the host's media-protocol endpoint, its size/retention/content policies, its abuse contact, and a conformance attestation (capability URLs, purge webhooks, upload scanning — verified by an automated conformance suite, not by promise). The client's "upload destination" picker lists the user's homeserver plus any installed registry hosts; picking one is one click, and everything the user posts from it is a full first-class tier-2 attachment — content-hashed, moderatable, voucher-capable.

Federation-appropriate curation: there is no single global list. The reference client ships a default registry feed (signed JSON, same mechanism as shared blocklists), and anyone — a guild, a community, a company — can publish their own feed for users or guilds to subscribe to. Guild origin-allowlists can reference a registry feed directly ("accept any host on feed X"), so guild operators curate by subscription rather than by maintaining domain lists manually. Hosts that misbehave get dropped from feeds, and their content ages out of guilds that trust those feeds.

What this does and doesn't fix: it should drain most real demand out of tier 3 — the person who wants a beefy file host now has a one-click path to a conforming one, and "make a plugin for your favorite host" becomes the community's way of promoting a host from raw-link status to first-class origin. But the embed proxy stays, because tier 3 was never only about file hosting: people paste YouTube links, news articles, and random URLs regardless of how good the attachment system is, and every pasted URL needs the same IP-protection and preview-verification treatment. The registry shrinks tier 3 to what it always should have been — a link-preview system — rather than eliminating it.

### Operator media policy: tier 1 is a setting, not an obligation

An underappreciated consequence of "the media origin is an interface": a homeserver's own upload endpoint is just one possible origin, so **operators can turn it off** — entirely, or selectively — and their users lose nothing but a default. The identity role never required the media role; this makes that separation an explicit, first-class policy surface:

```
server.media_policy:
  default: enabled | disabled | quota(bytes)
  per_user_overrides: allowlist / blocklist / group rules
    (e.g. "payers only", "accounts older than 30 days",
     "invited-by-tree", "staff")
  profile_asset_carveout: enabled (small fixed quota)
```

- **Disabled:** the server hosts no user uploads. Its users upload to a tier-2 origin instead — and because references are origin-agnostic, every downstream mechanism (capability URLs, vouchers, embeds, moderation) is untouched. Federation-wise, nothing changed; this server simply doesn't implement the media role for its users.
- **Allowlist/blocklist and quotas:** the middle ground — grant tier-1 to trusted or paying users, deny it to fresh signups, or cap everyone at a modest quota with tier-2 as the overflow path. Operators tune their exposure per user, not per server.
- **Profile-asset carveout:** avatars and banners are user media too, and a broken default avatar flow would make disabled-tier-1 servers feel second-class. Operators who disable general uploads can leave a tiny fixed per-user quota (a few hundred KB) exclusively for profile assets — or disable even that, in which case profile assets are tier-2 references like everything else.

**Why this matters for growth:** the thing that makes open registration scary is not the account row — it's hosting strangers' *content*. An account with no upload rights costs its operator an account row, a DM queue, and a key vault; it carries none of the takedown-pipeline, scanning, and legal-contact obligations of Section 9, because those attach to media origins, and this server isn't one for that user. An operator can therefore open registration to the world while their content-hosting exposure stays exactly at the set of users they've explicitly allowlisted. Cheap, low-liability open registration on many small servers — rather than everyone piling onto the few servers brave enough to host uploads — is precisely the growth shape a federation wants.

**The UX obligation that comes with it:** on a tier-1-disabled server, a user's *first* drag-and-drop must not feel broken. The client detects the policy (advertised in the server's capabilities response) and turns first upload into a one-screen origin setup: pick a host from the registry feed, one click, upload proceeds. Done well, most users on such servers never consciously learn their files live elsewhere; done badly, this feature reads as "uploads don't work," so the reference client treats that flow as a first-class onboarding surface, not an error dialog.

### Availability and caching

If an origin is down, its attachments are unavailable — an accepted consequence of the model. Clients render a clear "origin unreachable" state using the stored metadata (filename, size, thumbhash placeholder) rather than a broken image.

Guild servers MAY run a read-through cache with bounded size and TTL for hot media (a popular image in a 50k-member guild should not hammer a Raspberry Pi 50,000 times). The cache is explicitly non-canonical: it honors deletion (revalidation on TTL, plus a purge webhook from the origin on delete) and doesn't outlive the origin's deletion of the content beyond the TTL. The origin remains the sole authority over the content's existence — the cache just makes the physics work. The same cache is what makes cross-server emoji cheap: foreign guilds' emoji get cached exactly like any other hot media.

### Moderation of media

Guild moderators can delete the *reference* (the attachment disappears from the channel for everyone) but cannot delete the file from a foreign origin. The origin's operator moderates their own storage and is the entity legally responsible for hosted content — this applies equally to homeservers, tier-2 dedicated hosts, and guild servers hosting expression assets, which is precisely why guilds get origin allow/blocklists. The federated report endpoint lets a guild server forward abuse reports to any origin with evidence attached. Origins must ship with hash-list scanning hooks (e.g., industry CSAM hash lists) at upload time — table stakes for anyone running a public media origin, in the reference server from day one, and a conformance requirement of the media protocol spec rather than a courtesy.

---

## 7. Voice and Video

### Architecture

Each guild server runs (or points at) an **SFU** — a selective forwarding unit that receives each speaker's stream once and forwards it to subscribers. No mixing, no MCU. WebRTC end-to-end: Opus for audio, AV1/VP9/H.264 simulcast for video and streaming.

Signaling rides the existing guild gateway: `VOICE_STATE_UPDATE` (join/leave/mute), then a `VOICE_SERVER_UPDATE` event hands the client the SFU endpoint and a one-time token, and SDP/ICE negotiation proceeds over a dedicated lightweight WebSocket to the SFU. This mirrors Discord's split of "gateway for state, voice server for media" and lets operators scale SFUs independently of the main server process.

Guild servers should bundle an embedded TURN server, because a meaningful fraction of home users sit behind NATs that defeat direct UDP. `coturn` or an embedded Rust implementation; credentials minted per-session.

### Screensharing

Screensharing ("Go Live") is a first-class stream type in v1, not an afterthought bolted onto camera video — it shares the SFU forwarding path but differs everywhere that matters:

- **Capture and encoding profile.** The protocol constrains **bitrate, not resolution or framerate**: the SFU join token carries a maximum stream bitrate (per-channel/per-role configurable by the guild), and how the streamer spends that budget is theirs to choose. The client offers content presets — "text/detail" (high resolution, ~15fps, content-hint `detail`, sharpness prioritized) for screen-reading, "motion/gaming" (60fps, content-hint `motion`, smoothness prioritized, softer under movement) for gameplay, plus a custom picker — all encoding to the same bitrate ceiling. The simulcast ladder follows the chosen preset (e.g., a full-budget top layer and a low-bitrate fallback layer), so the guild's bandwidth cost is identical whichever trade-off the streamer picks; enforcement is trivial at the SFU since bitrate is visible in RTP without parsing payloads. Optional application/system audio is published as a second Opus track bundled with the screen track.
- **Permissions.** The existing `stream` permission flag in SFU join tokens governs it (already distinct from `video`), so channels can allow cameras but not screenshare or vice versa. Per-channel concurrent-streamer caps protect upstream bandwidth — screenshare fanout is the single most expensive thing a small SFU does.
- **Viewer model.** Watching is an explicit subscription (click to watch), not auto-subscribed like speaker audio, so a stream to a 30-person channel with 4 watchers costs 4 forwards, not 30. Viewers pick a quality layer; the SFU forwards the requested simulcast layer only.
- **Moderation.** Same as everything else at the SFU: guild server can kill a stream at ingress via the control connection, and `stream` permission removal takes effect immediately.

### Permissions and moderation

The SFU trusts the guild server's tokens, which encode channel, user, and permission flags (speak, video, stream, priority speaker). Server-mute is enforced at the SFU (streams from muted users are dropped at ingress, not just flagged), so client modifications can't bypass it.

### Encryption posture

v1: standard DTLS-SRTP — encrypted in transit, decryptable by the SFU. Same as Discord. The guild operator can technically tap voice channels; this is disclosed honestly in the threat-model documentation.

v2: optional E2EE voice via insertable streams / SFrame with keys distributed over MLS (piggybacking on the DM infrastructure below), for channels that opt in. Designed-for but not built in v1 — the SFU must simply never depend on parsing media payloads, only RTP headers, so E2EE can be added without SFU changes.

### Multi-region SFU pools

The detachable-SFU idea generalizes: a guild can configure a *pool* of SFUs, and each voice channel can be served by a different one.

```
guild.voice_regions: [
  { name: "us-east", sfu: "sfu1.guilds.example",   turn: ..., pubkey_hint: ... },
  { name: "eu",      sfu: "voice.rented-vps.example", ... },
  { name: "donated", sfu: "sfu.community-member.example", ... }
]
channel.voice_region: "eu" | "us-east" | "auto"
```

The critical design rule: **remote SFUs are dumb regional pipes, never authorities.** Signaling, membership, permissions, and moderation stay on the guild server exactly as above — the only thing that varies per channel is which endpoint `VOICE_SERVER_UPDATE` hands out. The guild server mints the join token (signed with its federation key), the SFU verifies it against the guild server's published keys — the same signature infrastructure the media-voucher flow uses — and receives mute/kick commands over a control connection from the guild server. The token carries the permission flags; the SFU never needs to understand roles, members, or guild state. The alternative — voice channels as links to foreign servers running their own rooms with their own membership — is explicitly rejected: it would require federating guild permissions to voice hosts (or produce channels guild moderators can't moderate) and would break the single-authority model for no capacity gain.

Third-party voice hosting falls out of this for free: an SFU operated by a community member or a hosting service is just an SFU configured to accept tokens from specific guild servers, presumably with per-guild participant and bandwidth quotas since the operator is donating upstream. From the protocol's perspective it is indistinguishable from a rented VPS.

Operational requirements that come with pools: the guild server health-checks each SFU and maintains a failover order per channel — on SFU failure it reassigns the channel and pushes a fresh `VOICE_SERVER_UPDATE`, so connected clients reconnect with a ~2s blip rather than a dead channel. Clients latency-probe the region list once per session so `"auto"` selects on measured RTT, not geography guesses. Each region entry can carry its own TURN endpoint, since TURN relaying belongs near the SFU, not near the guild server.

### Capacity honesty

A homeserver on a residential connection can realistically host voice for a handful of simultaneous channels; audio is cheap (~50–100 kbps/speaker forwarded to N listeners) but video/screenshare fanout is upstream-bandwidth-bound — a single 1080p stream to a dozen watchers can saturate a home uplink by itself, which is why watcher subscriptions are explicit and streamer caps exist. The multi-region pool above is the answer: everything stays home except the SFUs, which live wherever bandwidth is — a rented VPS, several regions, or community-donated hosts. This is the expected shape for large guilds.

---

## 8. Direct Messages and E2EE

### Routing

DMs bypass guild servers entirely. They travel home-to-home: Alice's client encrypts, hands ciphertext to `home.example`, which delivers to `friend.example` via `POST /_telium/v1/dm/send`, which queues it for Bob's devices. Offline recipients get store-and-forward with retry/backoff on the sending server. Group DMs (up to ~50 people) need one extra ingredient — a sequencer — and get their own subsection below.

### Cryptography

- **1:1 and group DMs: MLS (RFC 9420).** One protocol for both cases instead of Signal-style pairwise ratchets plus a separate group construction. MLS gives forward secrecy, post-compromise security, and efficient group membership changes. Each device is an MLS leaf; the home server acts as the Delivery Service and publishes KeyPackages (the MLS analog of prekey bundles) for asynchronous session establishment.
- Device list authenticity comes from the home-server-signed device lists (Section 3), with optional user-level cross-signing and emoji-verification between contacts for those who want homeserver-independent trust. Unverified-device warnings appear in the UI but don't block messaging.

### Group chats: a sequencer, not an authority

GCs are the one construct that sits between the architecture's two poles: guilds have a single authority, 1:1 DMs need none, and a group chat needs *something* in between — because of a hard MLS constraint, not a product choice. MLS commits (adds, removes, key updates) must be applied by every member in the same order; two concurrent commits fork the group. Someone has to sequence them. The design resolves this without inventing a mini-guild:

**The creator's homeserver is the group's sequencer and fanout point.** It's already the MLS Delivery Service; for a GC it additionally (a) assigns a total order to commits, and (b) fans each message out to every member's homeserver — one delivery path with consistent ordering and one place to queue for offline servers, rather than sender-side fanout from whoever spoke last. What the sequencer sees is ciphertext and the member-*server* routing list. Nothing else, by construction:

- **Group metadata is inside the encryption.** Name, icon, and topic live in MLS-encrypted application state; the sequencer doesn't learn what the group is called.
- **Membership policy is doubly enforced, but forgery-proof only once.** The group carries a signed policy extension (e.g., creator-only adds). Members' clients reject violating commits, and the sequencer refuses to sequence them — but since every commit is signed by a member device key, a malicious sequencer can *censor* (refuse to relay) and can never *forge* membership or messages. Same trust shape as 1:1 DMs: your homeserver can always drop your mail; it can never write it.

**Sequencer death is survivable — unlike guild death, and for free.** Every member's client holds full MLS state, and every member's homeserver holds that member's own history copy (it's their DM queue). The group's data never lived only on the sequencer. If the sequencer's server dies or its owner migrates, any member proposes **re-anchoring**: a signed commit designating a new sequencer among the members' homeservers, applied like any other commit. Brief outage, zero data loss. (Account migration composes cleanly: the §10 self-update commit and re-anchoring are the same machinery.)

**The ~50 cap is a feature, with an exit ramp.** Beyond that size, one-home sequencing and MLS tree operations both get uncomfortable, and the honest answer is "this wants to be a guild." The client offers a GC→guild conversion flow: create a guild on a chosen host, auto-invite the members. History stays behind in the GC — republishing it would mean decrypting E2EE messages into a guild without every author's consent — and the flow says so.

**Media** in GCs uses tier-1/2 references with capability URLs only. Voucher mode doesn't apply: vouchers require an authority to attest membership, and GCs deliberately lack one. Leaked-message-leaks-attachments is the accepted model here, as it already is for capability-mode guilds.

**Calls.** The transport is the user's choice, because the modes trade different things and the trade should never be silent:

- **Direct P2P** — lowest latency, end-to-end encrypted by construction, and reveals each party's IP to the other. Right for people who trust each other; wrong as a forced default for a call from a stranger.
- **Relayed P2P (TURN)** — still cryptographically peer-to-peer, so still E2E, but media exits from a homeserver's TURN relay rather than the user's connection. IP hidden, encryption intact, modest latency cost. This is the underrated middle mode and the right answer for "hide my IP" — it costs nothing in confidentiality.
- **SFU-routed** — media flows through an SFU: the sequencer homeserver's by default for GCs, either party's homeserver for 1:1, or any conforming SFU the conversation configures (see below — nobody is stuck without one). Token minting follows §7's dumb-pipe model — the control-plane server signs, the SFU verifies — so no new trust is added by the routing itself. IP hidden, plus seamless mid-call growth (a third person joining an SFU call is a subscription, not a renegotiation scramble) and screenshare-grade quality management. The honest cost, same as guild voice: v1 SFU calls are DTLS-SRTP terminated at the SFU, so the relay operator could tap them until SFrame E2EE lands in v2 — and GCs are SFrame's natural first customer, since the key-distribution channel it needs (the MLS group) is already in hand. The client's mode picker states this trade in plain words rather than burying it.

Two negotiation rules: **most-restrictive-wins** — a call goes direct only if *every* participant permits it, so one person's "always relay" setting (a per-account default with per-conversation overrides, in the client sync store) can't be overridden by a caller's preference — and the negotiation itself rides the encrypted call-setup messages, so no server learns anyone's privacy posture.

**No SFU is never a dead end.** A sequencer homeserver without an SFU doesn't cap the group at mesh calls — the GC can configure its *own* SFU, exactly as guilds configure voice pools in §7 and by the same mechanism: the sequencer remains the control plane and mints the join tokens (signed with its homeserver's federation key), and the configured SFU — a rented VPS, a community-donated box, or a host from a voice-capable registry feed, the same curation pattern as media hosts — verifies them against published keys and takes mute/kick over the control connection. The SFU never learns who the group is, only that a token is valid. The setting lives in the group's MLS-encrypted state (so even the choice of SFU isn't visible to servers outside the call path), changeable by whoever the group's policy extension permits. One disclosure the picker must make: in v1 the SFU sees call media (DTLS-SRTP terminates there), so choosing a third-party SFU means trusting its operator with call content until SFrame E2EE lands — at which point third-party SFUs become fully blind pipes and this caveat evaporates. Absent any SFU, the fallback remains full mesh for ≤4 participants (subject to the same relay rule via TURN), with the client saying plainly that larger calls need an SFU configured — a one-click fix, not a wall.



### Read receipts and conversation signals (opt-in)

DMs and GCs support read receipts, designed under one non-negotiable rule: **receipts travel inside the encryption.** They are MLS application messages of a `receipt` type — to the homeservers and the sequencer they're indistinguishable from small messages, so no server on the path learns reading behavior. The alternative (servers exchanging read state) would leak exactly the interaction metadata E2EE otherwise protects, and is rejected outright.

- **Reciprocal opt-in, default off.** You receive read receipts only while you send them — a global account toggle (stored in the client sync store, so it follows the account across devices and migrations) with per-conversation overrides in both directions. Reciprocity prevents one-sided read-state surveillance and makes the setting self-explaining. Default-off matches the platform's posture everywhere else: presence is already subscription-scoped and disableable, and read state is strictly more intimate than an idle dot.
- **Delivered ≠ read.** Delivery acks are encrypted device-level acknowledgments sent unconditionally — low sensitivity, since successful federation delivery is roughly observable by the sending server anyway — rendering the familiar sent/delivered distinction. *Read* is the sensitive tier and the only one the reciprocal toggle governs.
- **GC receipts are watermarks, not events.** A per-message receipt from every reader in a 50-person group is a miniature fanout bomb (each read event → up to 50 homeserver deliveries). Instead, clients send coalesced read watermarks — "read up to ULID X" — batched on conversation close or idle, never per message; time-sortable ULIDs make the watermark comparison trivial. Group UI shows "read by *k*" (avatars past a threshold), counting only opted-in members; opted-out members are simply absent from the count rather than displayed as unread, so declining to participate doesn't itself broadcast a status.
- **Honest caveat for the threat-model docs:** encryption hides receipt content, not traffic. A small encrypted burst shortly after a delivery is guessable as "someone read something" to a server watching timing; batching blunts this substantially, but the documentation claims receipts are *unreadable* by infrastructure, never *invisible* to it.
- **Typing indicators share the transport, not the contract.** They ride the same encrypted rails (ephemeral application messages, so servers never see them) but are deliberately *not* part of the reciprocal opt-in: read receipts create persistent social accountability ("read three hours ago, no reply"), while a typing indicator fires only during active, voluntary engagement and evaporates in seconds — the arriving message reveals the same fact moments later anyway. So they default **on**, with a plain per-account toggle and per-conversation overrides for the one honest use case (drafting a difficult message without broadcasting the agonizing), and no reciprocity linkage. Both settings live together in one "conversation signals" panel. (Guild typing indicators are unrelated: they're gateway events under the guild's authority, already intent-filtered per Section 4. Guilds get no read receipts at all — read state across a 100k-member channel is neither socially meaningful nor architecturally sane.)



### Key custody: the two modes

Every account has a **key vault**: an encrypted blob on the homeserver containing the account's MLS state backups and history keys. What differs is who holds the vault key.

**Escrowed mode (default).** The vault is encrypted under a key held by the homeserver. Consequences, stated plainly: recovery always works — new device, forgotten password, whatever, the server can restore your keys and history. And the homeserver operator *can* read your DMs if they choose to, are compelled to, or are compromised. In this mode E2EE protects against network observers, guild servers, and the recipient's infrastructure being the only leak point — it is not protection against your own homeserver. The UI must not display escrowed-mode DMs with iconography implying server-proof secrecy.

**Self-custody mode (opt-in).** The vault key is derived from a user recovery phrase (BIP-39 style) and never leaves the client. The homeserver stores only ciphertext it cannot open. Lose the phrase and all logged-out devices, and history is gone — no recovery, by design, and the opt-in flow says so in exactly those words and requires the user to re-enter the phrase once to confirm they saved it.

Switching escrowed → self-custody re-encrypts the vault client-side and instructs the server to destroy its escrow key (with the caveat, disclosed, that you are trusting it to actually do so for pre-switch history). Switching back requires an active logged-in device.

This two-mode design matches the requirement exactly, and putting escrow at the *vault* layer rather than weakening the messaging cryptography itself means the wire protocol, the MLS implementation, and self-custody users' security are identical in both modes — escrow is purely a question of where one backup key lives. The vault is also the unit that travels during account migration (Section 10): in self-custody mode it moves as opaque ciphertext the new server can't open either, and in escrowed mode the escrow key deliberately does *not* transfer automatically — a detail that turns out to matter for migration security.

---

## 9. Moderation, Abuse, and Trust

**Guild-level:** the standard kit — bans, timeouts, slow mode, role gating, audit log, AutoMod-style keyword/regex/link filters running server-side. All local operations, no federation involvement.

**Join friction controls:** because federated identity makes throwaway accounts as cheap as the most permissive homeserver in existence, guilds need levers: require accounts older than N days, require specific home domains (allowlist) or exclude them (blocklist), membership screening questions, first-N-messages-held-for-review. These are per-guild settings enforced at join and post time. (Migration interacts here: a migrated account carries its signed original creation date in the tombstone chain, so moving homeservers doesn't reset account-age gates — and doesn't let you launder a bad reputation by hopping servers, since the old ID remains resolvable.)

**Server-level defederation:** a homeserver operator maintains domain blocklists applied to identity assertions (guild role) and DM delivery (identity role). Subscribable shared blocklists (a signed JSON feed) let communities pool reputation without any central authority.

**Federated reporting:** `POST /_telium/v1/report` carries a report from any server to the server best positioned to act — guild host for message conduct, media origin for content, identity server for account-level abuse. Reports are signed, structured, and include evidence references.

**Legal reality check:** every media origin operator is hosting user content for the public and needs upload scanning, a takedown workflow, and a designated contact. The reference implementation ships these, defaulted on, because the median self-hoster will not build them.

---

## 10. Migration, Failover, and Continuity

Federation's honest failure mode is lock-in with extra steps: your identity is portable in theory but in practice welded to whichever server you picked on day one, and when that server dies, you die with it. Telium treats movability as a core feature with one shared mechanism — **signed tombstone/redirect records** — applied at three scales: accounts, guilds, and whole homeservers. On top of that sits an optional warm-standby scheme for the people and communities who want Proxmox-HA-grade continuity.

### Account migration

**The UX target:** Settings → "Move my account" → enter `new.example` → authenticate on the destination → one confirmation → done. Contacts, guilds, and DMs follow automatically. No manual re-adding, no "tell your friends your new handle."

**The flow:**

1. **Grant.** The user signs into (or registers on) the destination server; the client obtains a migration grant from it and presents it to the old server, along with fresh re-authentication *and* a signature from one of the account's existing device keys.
2. **Bundle transfer.** The old server exports a **migration bundle** — profile, client sync store, guild membership list, DM contact list, the key vault (as ciphertext), and pending DM queue forwarding state — in a versioned, forward-compatible format specified independently of any server's internal schema, and delivers it via `POST /_telium/v1/migrate/import`. Import is transactional: the destination validates the entire bundle and acknowledges only on full success. **Nothing on the old server is modified until that acknowledgment arrives** — a failed or version-mismatched import leaves the account exactly as it was, which is the answer to migration-corrupts-profile: the destructive step simply doesn't exist until both servers have proven the copy is whole.
3. **Tombstone.** Both servers and the user's device co-sign a redirect record — `{old_id, new_id, timestamp, sig_old_server, sig_new_server, sig_user_device}` — which the old server thereafter serves from `GET /user/{id}/status` (spec-mandated minimum retention; goal is indefinitely, it's ~300 bytes).
4. **Propagation.** No broadcast needed — the redirect flows through channels that already exist. Guild servers hit it on their periodic identity revalidation (plus best-effort webhook push) and remap membership; message history keeps the original author ID with a resolvable link. DM senders receive a `moved` response from `dm/send` and re-target. For MLS groups, the new account's devices join as new leaves via a client-performed self-update in each group — signed, and rendered in contacts' UIs as "Alice moved to @alice:new.example," not as a mystery stranger joining.

**The three concerns, addressed head-on:**

1. *Hacked account gets migrated out to steal information.* Defenses in layers: migration demands fresh re-auth **plus** an existing device-key signature (a stolen password alone is insufficient); a cooling-off delay (default 24h, homeserver-configurable) during which every logged-in device and the recovery email are notified and any active device can cancel with one tap; and — the deep backstop — the key vault. In self-custody mode the attacker exfiltrates ciphertext they cannot open. In escrowed mode, **the escrow key does not ride in the bundle**: re-establishing escrow on the destination requires the account's recovery credential, so even a successfully hijacked migration moves the account shell, not readable DM history. E2EE means migration theft steals a name, not a life.
2. *Version mismatch corrupts the profile.* Answered structurally above: the bundle format is versioned and specced independently of server internals, the destination validates before acknowledging, the source destroys nothing (the account is *redirected*, never deleted by migration — optional deletion is a separate, later, deliberate act), and the tombstone is only signed after verified import. The worst outcome of any mismatch is "migration didn't happen," never "account is broken." The conformance suite (the same apparatus that certifies media origins) includes migration round-trip tests across reference versions.
3. *A malicious server sends a migration request.* A tombstone without a valid user-device signature is invalid, and every verifier checks all three signatures. The honest caveat, stated plainly: a homeserver maintains its users' device lists, so a *fully* malicious operator can mint a fake device and forge the third signature — no protocol can make a server unable to impersonate accounts it hosts. What the design guarantees is that forgery is **loud and disputable**: the user's real devices will encounter a tombstone they never signed and scream about it, publishing a signed dispute; contacts who cross-signed the user out-of-band (Section 8) will see the new account fail user-key verification. The threat model is honest — device signatures raise the bar from "one API call" to "detectable fraud," not to "impossible."

### Guild migration

Guilds move with the same machinery, requested by the guild **owner** (re-auth + device signature + delay + cancellation window, identically):

- The export bundle carries channels, roles, members, message history, emoji/stickers, and settings; ULIDs are preserved, and because the guild's canonical identity is its immutable internal ULID (Section 2), the readable `#gaming:old.example` alias simply re-points.
- Old host publishes the co-signed guild tombstone at `GET /guild/{id}/status`; invite links resolve through it; members' clients follow the redirect on next connect and mint identity assertions for the new audience — from the member's perspective the guild hiccups once and comes back at a new address.
- Same transactional non-destructive rule: the source guild stays live until verified import, then flips to redirect-only.
- Migration between hosts running different storage tiers (SQLite hobby box → Postgres/Scylla deployment) is an explicit design requirement of the bundle format — "our community outgrew the Raspberry Pi" is the *expected* migration story, and it should be an afternoon, not a data-archaeology project.

### Homeserver relocation

Two cases, one easy and one bulk:

- **Same domain, new machine.** Restore from backup, repoint DNS/well-known. Nothing is protocol-visible; the domain is the identity. This must be boring, and the reference implementation's backup/restore path (below) is what makes it boring.
- **New domain.** A domain-level tombstone: the old domain publishes a signed `{moved_to: new.example}` record alongside its keys, the new domain's federation keys are cross-signed by the old federation key, and every `@user:old.example` and guild remaps wholesale — semantically a bulk account+guild migration with one signature covering all of it, using the same verification logic peers already implement.

### Fallback servers and warm standby

The Proxmox-HA instinct — always-synced, fail over fast — is the right instinct, and the design admits it *without* reopening the replicated-state can of worms, by being strict about what the standby is:

- Accounts and guilds MAY publish a `fallback` entry in their public metadata: a designated standby server plus a standing, co-signed **failover authorization** created when the pairing is configured. Clients cache it.
- Replication to the standby is **operator-controlled streaming backup** (the mechanism Section 13 already endorses), not protocol-level federation of state. The standby is not a second authority; while the primary lives, the standby serves nothing.
- If the primary is unreachable past a client-side threshold, clients try the fallback, which serves from its last replicated snapshot — read-only by default, or fully live if the operator pre-authorized promotion.
- **Split-brain is fenced, not hoped away.** Promotion publishes a signed **failover record** with a monotonic sequence number chained onto the failover authorization; the record supersedes the primary's authority, and a primary that comes back up sees the record and demotes itself to standby. At every moment exactly one server in the pair is authoritative — "last valid promotion wins" is enforced by the signed chain, not by timing luck. The honest cost, disclosed like every other trade-off in this document: a data-loss window equal to replication lag at the moment of failure.
- **The floor for everyone else:** users and operators who never configure a fallback still get a first-class backup story — the reference server ships one-command scheduled encrypted backup to any S3-compatible target, restore is documented and tested in CI, and the client periodically nags operators whose backup is stale. "You will never lose your account to a dead disk" is the minimum bar; the fallback pair is the deluxe version.

### Planned and unplanned shutdown

**Planned sunset.** The admin flips the server into **migration mode**: a sunset date is announced in-protocol, every user gets the one-click migrate prompt at login, and new registrations close. On the question of whether the admin may *forcefully* migrate accounts: **no — the admin cannot choose a destination on users' behalf.** A server unilaterally moving its accounts to a server of its choosing is precisely the malicious-migration attack from concern #3, and legitimizing it for sympathetic reasons would hand every future attacker a cover story. What the admin can do: bulk-execute migrations users have individually consented to, and, at shutdown, for every unmigrated account, (a) produce a downloadable personal-data bundle in the standard migration format — importable at any homeserver later, minus the live redirect — and (b) publish a terminal tombstone (`gone`, no forwarding address), or a redirect to the user's pre-configured fallback if one exists. Guilds sunset via owner-driven guild migration, with the admin able to extend the window for large communities mid-move.

**Unplanned death.** This is exactly what the fallback pair and the backup floor exist for. If an operator ran neither, the identity is gone — the plan says so without euphemism, because pretending otherwise is how federated projects burn trust. The systemic mitigation is not protocol magic but the onboarding design in Section 13: casual users land on professionally-operated homeservers with real backup regimes by default, so the "my homeserver was a laptop in a dorm and it flooded" story happens to people who explicitly chose that risk, not to everyone's least technical friend.

---

## 11. Scaling a Massive Guild on One Authority

The single-authority constraint means a big guild scales like a well-architected centralized service, operated by one party — which is a solved problem, unlike scaling a replicated DAG.

**Process architecture.** The guild host decomposes into: stateless HTTP API pods, gateway/fanout pods (holding WebSocket connections), a pub/sub bus (NATS or Redis Streams) carrying guild events, the SFU pool, and storage. A guild's event stream is a single ordered topic; fanout pods subscribe to topics for the guilds their connected clients care about.

**Storage tiers by deployment size:**
- *Small (≤ a few thousand members):* single binary, SQLite, local disk media cache. This is the Raspberry Pi / home NAS story and it must stay a one-command deployment.
- *Medium:* Postgres, S3-compatible media cache, 2–3 fanout pods.
- *Large (10k–500k members):* Postgres for relational state (members, roles, channels) + ScyllaDB/Cassandra for the message log partitioned by `(channel_id, time_bucket)`, dedicated fanout tier, SFU pool on rented bandwidth.

**The fanout math** is the real constraint: one message to a 100k-member guild with 20k connected sessions is 20k gateway deliveries. With intents filtering, lazy member lists, and batched serialization (serialize once per event per wire format, then broadcast bytes), a single fanout pod handles tens of thousands of sessions; the pub/sub bus makes the tier horizontally flat. Presence is the other fanout bomb and is therefore coalesced (30s granularity), subscription-scoped (only visible members), and entirely disableable per guild — this is the scale-side half of the presence design in Section 3, and it's also why member-list rows carry guild-cached profile essentials rather than anything fetched cross-server.

**Cold storage:** message history beyond a configurable horizon can move to object storage in compressed segments, transparently paged in for search/scrollback. Keeps the hot store bounded regardless of guild age.

---

## 12. Client Architecture

One protocol, many surfaces. First-party client: desktop/web (single codebase), with the mobile story following the same core.

The interesting client-side problems this architecture creates:

**Connection management.** A user in 40 guilds across 15 servers holds 15 gateway connections. The client needs a connection manager with staggered reconnects, per-server backoff, and a degraded-state UI (guild greyed out when its server is unreachable — other guilds unaffected, which is genuinely better than Discord's all-or-nothing outages). The connection manager is also where fallback records (Section 10) get exercised: primary unreachable past threshold → try the published standby.

**Unified inbox.** Unread state, mentions, and notification aggregation across N servers happens client-side (v1). A v2 option lets your homeserver run a notification aggregator you point push at, so mobile push works without every guild server needing push credentials — guild servers post notification events to the user's home push relay, which talks to APNs/FCM.

**Local-first cache.** Aggressive local storage of recent messages per channel (SQLite in the client) so switching guilds is instant and brief server unavailability is cosmetic.

**Expression UX.** The emoji/sticker picker merges packs from every guild the user belongs to (assets render cross-server per Section 4); the GIF picker is a pluggable-provider search surface. Favorites and frequently-used state for all three live in the account's client sync store, so they follow the user across devices and homeservers.

---

## 13. Onboarding Non-Technical Users

Most future users do not care about federation, will never run a server, and will bounce off anything that asks them to choose a homeserver before they've seen a single message. The network's growth depends on them anyway, so the plan treats "my friend sent me an invite link and I was chatting 60 seconds later" as a hard product requirement — while keeping the door to the federated depths wide open one layer down.

**The default path.** The reference client's signup screen has one primary action: create an account. It lands on a **flagship homeserver** (or a small rotation of vetted ones) operated by the project or its partners, with server choice living behind an "advanced" affordance for the people who want it. Clicking a guild invite with no account offers signup inline — one screen, then you're in the guild. Nothing about this is protocol-privileged: the flagship is an ordinary homeserver that anyone could replace, which is the line that separates "sensible default" from "Matrix.org-style de facto centralization." Users who later grow opinions get the one-click account migration from Section 10 — the default server is a starting point, not a trap, and that fact is itself the answer to most centralization criticism.

**Why supporting them is cheap — and how to make it cheaper.** The architecture already did most of the cost work: because clients connect to guild servers directly, the flagship never proxies guild traffic (the double-hop cost that makes large Matrix homeservers expensive). An identity-mostly account costs the flagship: an account row, a DM queue, a key vault, presence-free profile serving, and — the only real number — media storage for the user's own uploads. Accordingly, the cost levers are almost all media levers:

- Free-tier media quotas with modest per-file caps; old media that is no longer referenced by any retained message ages out (disclosed policy, with the thumbhash-placeholder degradation from Section 6).
- Cold object storage for everything beyond the hot window.
- The tier-2 origin ecosystem as the pressure valve: heavy uploaders one-click a third-party host from the registry, moving their storage cost off the flagship entirely — the media-origin pluggability is quietly the flagship's business model insurance.
- The operator media policy from Section 6 as the endgame lever: a server can offer free accounts with tier-1 disabled or minimally quota'd (profile-asset carveout only), pushing all real uploads to tier-2 origins. This applies well beyond the flagship — it's what lets *any* small operator open registration without adopting strangers' content liability, which multiplies the places a newcomer can land.
- Push relay traffic batched and coalesced; it's the second cost center after storage but a far smaller one.

Back-of-envelope, an identity-role account is a cents-per-month object, which is what makes a free flagship tier sustainable via an optional paid tier (bigger quotas, retention guarantees) rather than via anything that would warp the protocol.

**Non-technical community owners** get the same treatment on the guild side: the client's "create a guild" flow offers managed guild hosting from any provider implementing the (ordinary, unprivileged) guild-host role — a marketplace, not a monopoly — alongside the "host it yourself" path with the one-command single-binary deployment. Guild migration (Section 10) means starting on a managed host and moving to your own hardware later is a supported afternoon, not a rebuild.

---

## 14. Technology Choices (reference implementation)

- **Server:** Rust (axum + tokio) — one binary encompassing all three roles with roles toggled by config; SQLite default, Postgres/Scylla behind a storage trait. Rationale: memory footprint matters enormously for the homeserver story, and fanout is a natural fit.
- **SFU:** build on `webrtc-rs`, or embed/integrate LiveKit's open-source SFU initially to avoid spending a year on congestion control before having a product.
- **MLS:** OpenMLS.
- **Client:** TypeScript; desktop via Tauri (not Electron — footprint again), web from the same codebase, React + a virtualized message list.
- **Protocol spec:** written as an implementation-independent spec from day one (the Matrix lesson worth copying) — the reference implementation is not the spec. The migration bundle format and the media protocol get their own standalone spec documents, since third parties implement both.

---

## 15. Honest Risks and Open Questions

**The availability trade-off is real.** A guild on a home connection disappears during a power cut, taking history with it if the disk dies. Section 10 is the layered answer — one-command encrypted streaming backup as the floor, the fallback/warm-standby pair with fenced promotion for communities that want HA, and guild migration as the pressure-release valve — but none of it removes the fundamental fact that single authority means single point of failure, and the docs should keep saying so.

**Sender-side media has a mortality problem.** When users delete accounts or servers die, old attachments 404 forever across every guild they posted in. The metadata+thumbhash placeholder softens the UX, and guilds that care can enable an archival mode that re-hosts attachments in important channels *with the uploader's consent flag* — an explicit, visible exception to sender-side storage, off by default. (Account migration keeps media alive rather than orphaning it: the user's uploads move in the bundle and the old references redirect through the domain tombstone. Guild-hosted emoji dodge the problem entirely by construction, which is half of why Section 4 hosts them on the guild.)

**Escrowed E2EE will draw criticism** from the security community, and partially deservedly — messaging norms have moved toward custody-free designs. The defense is honesty: precise UI language, identical cryptography in both modes, and self-custody being a first-class setting rather than a buried toggle. Consider flipping the default to self-custody for accounts that opt into a "security-focused" setup path.

**Migration trust bottoms out at the homeserver.** As Section 10 concedes, a fully malicious homeserver can forge a device signature and fake a migration of its own users; the design makes this detectable and disputable, not impossible. Cross-signing adoption is the real mitigation, and cross-signing UX is famously where these schemes go to die — budget genuine design effort there rather than shipping Matrix-style verification friction.

**A flagship homeserver is a centralization gravity well.** The onboarding strategy (Section 13) deliberately concentrates casual users, and the honest risk is recreating Matrix.org's dominance. The structural counterweights — the flagship is protocol-unprivileged, account migration is one click, and the client surfaces server choice at signup even if de-emphasized — are real but not sufficient on their own; publish flagship population stats and treat "% of active users on the flagship" as a metric to drive *down* over time.

**Spam economics.** Anyone can stand up a homeserver and mint accounts. The join-friction toolkit and shared blocklists are the answer — with migration tombstones ensuring server-hopping doesn't reset account age or launder identity — but expect this to be a permanent arms race and staff the abuse tooling accordingly.

**Double-hop-free design means guild servers see IPs** of all connecting members (like Discord does, unlike Matrix). Document it; support connecting via the user's homeserver as an optional relay for privacy-sensitive users (v2), at a latency cost.

## 16. Build Order

**Phase 1 — Text MVP (single server):** accounts, guilds, channels, roles/permissions, gateway, message history, media upload with capability URLs, profiles (avatar/banner/bio) and presence dots, custom emoji and stickers (single-server), the client sync store (GIF/emoji favorites), the single-binary SQLite deployment, and the scheduled-backup floor. Everything on one server, but with the identity-assertion flow implemented internally so federation is a config change, not a rewrite.

**Phase 2 — Federation:** key publication, S2S signing, cross-server guild joins, invite resolution, cross-server media fetch, cross-server emoji/sticker rendering, federated profile fetch with guild-side essential caching, configurable/pluggable media origins, operator media policy (tier-1 disable/allowlist/quotas + the first-upload origin-setup flow), the embed proxy for external links, federated reports, defederation lists. **Account and guild migration land here** — tombstones, the versioned bundle format, and redirect propagation — because migration is a federation primitive, not a bolt-on, and every later phase (vault transfer, fallback records) builds on its signature chain.

**Phase 3 — DMs + E2EE:** MLS integration, home-to-home delivery, group chats (sequencer role, commit ordering, re-anchoring, GC→guild conversion flow), opt-in read receipts and encrypted conversation signals, key vault with both custody modes, device verification UI, vault handling within account migration (ciphertext transfer, escrow re-establishment rules). 1:1 and GC calls (direct/relayed/SFU mode negotiation) land with Phase 4's SFU work.

**Phase 4 — Voice, video, and screensharing:** SFU integration, gateway signaling, TURN, detachable SFU config, server-mute enforcement, and screensharing — bitrate-budgeted streams with user-selectable content presets (text/detail vs. motion/gaming), application audio, explicit watcher subscriptions, per-channel streamer caps. Multi-region SFU pools with per-channel assignment and failover land at the end of this phase — they reuse the single-SFU token and control-plane work.

**Phase 5 — Scale + polish:** Scylla message store, fanout tier, lazy member lists at scale, push relay, cold storage, fallback/warm-standby pairs with fenced promotion, flagship onboarding flow and the managed-hosting marketplace surfaces, mobile clients.

Phases 3 and 4 can proceed in parallel after Phase 2; they share no components except the gateway.
