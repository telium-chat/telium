# Uploads: operator burden + user experience plan

Every item below is one checkbox = one commit. Order is dependency- and risk-ordered:
data-deletion work first (extra care, tests before and after), UI polish last.

Statuses: `[ ]` todo · `[x]` done (build + tests green) · `[~]` blocked (reason stated inline).

Product decisions requested up front are marked **[DECISION]** and called out in chat.
Nothing under this plan deletes data silently: every reclamation path gets a grace window,
a test, and leaves a log line.

---

## Operator

- [x] **O1 — Reclaim media whose references are gone (refcount wiring)**
  Files: `server/src/routes/social.rs`, `server/src/routes/guild/channels.rs`,
  `server/src/routes/guild/lifecycle.rs`, `server/src/routes/media.rs` (new reclaim sweep),
  `server/src/federation/maintenance.rs`, `server/src/admin/health.rs`, `server/src/metrics.rs`,
  `web/src/views/control-plane/StoragePane.jsx`, `server/tests/` (new).
  Approach: when a message/channel/guild is deleted, decrement `media.refcount` for each hash in
  the deleted rows' attachments JSON (`json_each`); add a periodic reconcile sweep that recomputes
  live references (messages, profiles, guild/channel icons, expressions) and deletes rows + bytes
  that have been at `refcount <= 0` beyond a grace window (24 h), then broadcast purges; this also
  makes the dead `refcount <= 0` health check (`admin/health.rs:646`) and the Storage-pane
  "reached zero" copy truthful.
  Verify: server integration test — upload → send → delete message → advance grace → sweep →
  row, bytes, and purge broadcast all gone; profile/expression references are *not* reclaimed;
  existing media tests still green; `cargo test`.

- [x] **O2 — Deleting deduplicated media must not break other uploaders** **[DECISION]**
  Files: `server/src/routes/media.rs` (delete handler), `server/tests/` (new).
  Approach: depends on decision — recommended: owner delete returns 409 while `refcount > 1`
  (content is shared by other uploads); server admins bypass (takedown stays possible).
  Verify: test with two uploads of identical bytes — owner delete → 409; admin delete → 200,
  row + bytes gone; single-owner delete unaffected.

- [x] **O3 — Retention knobs: default TTL and age-based attachment expiry (both off by default)** **[DECISION]**
  Files: `server/src/config.rs` (MediaPolicy: `default_expiry_secs`, `attachment_max_age_days`),
  `server/src/routes/media.rs` (apply default TTL when the client sends no `X-Telium-Ttl-Secs`;
  age sweep), `server/src/federation/maintenance.rs`, `server/src/preflight.rs` (warn when on),
  `telium-chat-docs/src/content/docs/self-hosting/configuration.md`, `server/src/config.rs` tests.
  Approach: `default_expiry_secs = 0` keeps today's behavior; when set, uploads without a
  client-requested TTL get the default; `attachment_max_age_days = 0` (off) otherwise deletes
  attachment-purpose media older than the age regardless of references (destructive — preflight
  warns). Age sweep reuses O1's reclamation path.
  Verify: config parse round-trip; test default TTL applies only when no TTL header was sent;
  test age sweep touches only `purpose = 'attachment'` past the age; docs updated.

- [x] **O4 — Per-guild and per-channel upload size caps**
  Files: `server/migrations/` (nullable `media_max_file_bytes` on `guilds` + `channels`),
  `server/src/routes/media.rs` (narrowest-of global/guild/channel, mirroring
  `destination_limit`), guild + channel API and settings UI (`web/src/views/` guild/channel
  settings), `telium-chat-docs/…/configuration.md`.
  Approach: same pattern as `media_expiry_limit_secs`: column set by guild/channel settings,
  enforcement at upload time, effective cap published in capabilities/voucher metadata so U1 can
  pre-flight against it.
  Verify: migration applies and reverts; test that an upload over the channel cap is rejected
  with a message naming the limit; settings UI test; existing uploads unaffected when null.

- [x] **O5 — Stream uploads to disk instead of buffering in RAM**
  Files: `server/src/routes/media.rs` (upload handler: stream the body, incremental BLAKE3,
  temp file under the media dir), `server/src/objectstore.rs` (put-from-file for local and S3),
  `server/tests/`.
  Approach: consume `Body::into_data_stream()`, hash while writing to a temp file, abort
  mid-stream once over the size cap, then move into the store (rename locally; stream/read for
  S3); temp file removed on every error path.
  Verify: existing upload/dedup/scanner tests pass unchanged; new test — cap-sized upload
  succeeds, over-cap upload aborts before completion, failed upload leaves no temp file or row.

- [x] **O6 — Quota check race + admin "top consumers" view**
  Files: `server/src/routes/media.rs` (per-user upload lock around enforce+insert),
  `server/src/admin/` + `server/src/routes/mod.rs` (admin endpoint: top N owners by bytes),
  `web/src/views/control-plane/StoragePane.jsx` (or AccountsPane) to render it.
  Approach: serialize each user's quota check + insert with a per-user mutex (single-process
  instance lease makes this sound); new admin GET returns owner, bytes, object count.
  Verify: concurrency test — parallel uploads at the quota boundary never exceed it; endpoint
  test; control plane renders the table.

## User

- [x] **U1 — Pre-flight size/quota checks + honest oversize errors**
  Files: `server/src/routes/mod.rs` (body-limit rejection returns the API JSON error shape,
  not axum's plain-text 413), `web/src/views/chat/surface.jsx` (expose effective caps),
  `web/src/views/chat/useStaging.jsx` (reject before upload), i18n catalogs,
  `web/src/test/upload.test.js`.
  Approach: client compares `file.size` against the published `max_file_bytes`, O4's
  channel/guild cap, and remaining quota *before* sending, with a localized message; any 413
  that still happens is JSON with the server's sentence.
  Verify: unit test — oversized file never hits the network and gets the clear message; server
  test — oversize body yields the JSON error shape.

- [x] **U2 — Cancel in-flight uploads**
  Files: `web/src/lib/upload.js` (AbortController through `xhrSend` and `teliumFetch`),
  `web/src/views/chat/useStaging.jsx` (each staged entry owns a controller; removing the card
  aborts), `web/src/views/chat/StagedAttachments.jsx` (cancel affordance), i18n,
  `web/src/test/upload.test.js`.
  Approach: aborting rejects the send, the card is removed, nothing is stored or charged.
  Verify: unit test — aborting an in-flight upload removes the card and rejects; server-side
  request terminates (covered by client test with fake server).

- [x] **U3 — Users can delete their own uploads** **[DECISION — scope]**
  Files: `web/src/lib/upload.js` (`deleteMedia` → `DELETE /_telium/v1/media/{hash}`),
  attachment context menu (`web/src/views/chat/` attachments rendering), i18n.
  Approach (recommended scope): "delete file" on your own sent attachments; O2 semantics apply
  for shared content; server endpoint already exists.
  Verify: unit test — owner sees the action and the DELETE fires with the right hash;
  non-owner doesn't see it; error surface for 409.

- [x] **U4 — Retry failed uploads**
  Files: `web/src/views/chat/useStaging.jsx` (failed entries stay with `status: 'error'`),
  `web/src/views/chat/StagedAttachments.jsx` (error card + Retry), i18n catalogs (en/de/ar/ja),
  `web/src/test/upload.test.js`.
  Approach: on failure keep the card with an error tone and a Retry button that re-runs the
  send with the original options instead of dropping the file.
  Verify: unit test — failure keeps the card, Retry re-sends and flips to ready.

- [x] **U5 — Upload staged files concurrently**
  Files: `web/src/views/chat/useStaging.jsx`, `web/src/test/upload.test.js`.
  Approach: replace the serial for-loop with a small bounded pool (3 at a time), preserving
  per-entry progress and error handling.
  Verify: unit test — three staged files are all in flight before the first completes; error
  in one doesn't stop the others.

- [x] **U6 — Show quota usage ("used X of Y")**
  Files: `server/src/routes/media.rs` (capabilities: add `used_bytes` to `account`),
  `web/src/views/user-settings/AccountPane.jsx` (media section shows usage; warn tone near the
  cap), i18n, server capability test, client unit test.
  Approach: server publishes `used_bytes` (existing `SUM(size)` query) alongside `quota_bytes`;
  client renders "X of Y used".
  Verify: server test for `used_bytes`; client test renders usage and the warn state.

- [ ] **U7 — Client-side image downscaling** **[DECISION — scope]**
  Files: `web/src/lib/image.js` (canvas re-encode helper), `web/src/views/user-settings/ProfilePane.jsx`
  (avatar/banner over `max_profile_asset_bytes` downscaled before upload), attachments per
  decision, i18n.
  Approach (recommended scope): profile assets that would 413 are downscaled/re-encoded in
  steps until they fit — mirrors the server's own "crop or downscale it first" message.
  Verify: unit test — an oversized image is shrunk and uploads; a fitting image is untouched.

- [ ] **U8 — Show remaining lifetime on sent attachments**
  Files: attachment rendering in `web/src/views/chat/` (details/menu on Attachment, image and
  playable cards), `web/src/lib/` relative-time formatting, i18n catalogs.
  Approach: attachment references already carry `expires_at`; render "expires in X" in the
  attachment menu/details, with an explicit "expired" state once gone.
  Verify: unit test — renders the expected duration from a fixed `expires_at`.

---

## Audit (fill in at the end)

Compare this file line by line against the original assessment; every item is done, blocked
with a reason, or deferred with the operator's agreement. Outcome recorded here.

## Notes

- Work happens on a new branch off `kit/standalone-compose` (one commit per item); the dirty
  `site/src/config.ts` in the tree is untouched and not part of any commit.
- Anything marked **[DECISION]** waits for an explicit answer before its item starts.
