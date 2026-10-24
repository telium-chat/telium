# The Telium client

`web/` contains the shared Telium React client plus the browser build, Electron desktop shell, and Tauri 2 Android shell.

The important runtime split is:

- **Web:** Vite + React 19 in a normal browser.
- **Desktop:** Electron/Chromium under `electron/`.
- **Android:** Tauri 2 under `src-tauri/`.

Desktop is no longer a Tauri/WebKitGTK application. Tauri remains in the repository for Android.

For the full runtime/security matrix, see [`../docs/clients.md`](../docs/clients.md). For contributor/test guidance, see [`../docs/development.md`](../docs/development.md).

## Commands

```sh
bun install
bun run dev                  # browser dev server on http://localhost:5173
bun run test                     # Vitest/jsdom/integration suite
bun run build                # production browser build -> dist/

bun run desktop:install      # install Electron package dependencies
bun run desktop:dev          # Vite + Electron development
bun run desktop:build:linux  # Linux Electron AppImage -> dist-electron/

bun run tauri:android:dev
bun run tauri:android:build
bun run tauri:android:build:debug
```

`bun run dev` proxies `/_telium`, `/.well-known`, and `/gateway` (including WebSocket) to `TELIUM_ORIGIN`, defaulting to `http://127.0.0.1:8448`.

A persistent deployment can have `telium-server` serve `dist/` directly by setting `[web].dir` in `telium.toml`.

## Client architecture

A Telium client holds **multiple authority connections**, not one global connection.

The account home owns login/devices/identity/DM account state. Each guild server independently mints a guild-local session from a short-lived home-signed assertion and is thereafter authoritative for its guilds. A problem with one guild server should degrade the guilds on that authority rather than present the entire application as offline.

Key paths:

| Path | Responsibility |
| --- | --- |
| `src/lib/api.js` | REST/discovery clients for home and guild authorities |
| `src/lib/gateway.js` | Per-server gateway connections, heartbeats, reconnect/degraded state |
| `src/lib/store.js` | Long-lived protocol/application state |
| `src/lib/sync.js` | Account-synchronized preferences with explicit local-only exclusions |
| `src/lib/routing.js` | Client routing/deep links |
| `src/lib/serviceworker.js` | Browser service worker/Web Push integration |
| `src/lib/voice.js` + call helpers | Mesh WebRTC and LiveKit/SFU calls |
| `src/lib/rich-presence.js` | Desktop activity publication/normalization |
| `src/components/` | Kumo/Base UI compatibility wrappers and shared components |
| `src/views/` | Product surfaces |
| `src/test/` | Fake protocol server and integration tests |

`Store` is intentionally not ordinary component-local React state. It outlives views and is fed by independent sockets. Components subscribe to store events through hooks rather than creating websocket lifetimes from renders.

## Deliberate client rules

- **No HTML rendering shortcut.** Message content is rendered as React elements rather than `dangerouslySetInnerHTML`.
- **Permissions are server-authoritative.** The client hides unavailable actions for UX, but UI gating never replaces server checks.
- **Permission bitfields are `BigInt`/decimal strings.** Telium uses 64-bit permissions; JSON numbers are not safe for the full range.
- **Capabilities gate product UI.** Clients read server capabilities instead of assuming every home/guild supports every feature.
- **A degraded authority degrades only its own content.** Federation means partial failure is normal.
- **Unsent drafts are device-local.** They are not uploaded to account sync merely to gain cross-device convenience.
- **Native bridges are narrow.** Electron/Tauri helpers expose purpose-built operations, not generic filesystem/network/shell escape hatches.

## Desktop (Electron)

Electron details and sandbox rules live in [`electron/README.md`](electron/README.md).

The renderer keeps Chromium security enabled:

- `contextIsolation: true`
- `nodeIntegration: false`
- `sandbox: true`
- `webSecurity: true`

Native responsibilities include external-link opening, notifications, constrained provider/GIF helpers, window focus, and desktop activity integration. Microphone/camera/WebRTC/screenshare remain Chromium APIs so the shared LiveKit client can run normally.

Desktop Rich Presence—including arRPC, Wine/Proton IPC bridging, Linux MPRIS, artwork privacy, and device-local controls—is documented in [`../docs/rich-presence.md`](../docs/rich-presence.md).

## Android (Tauri 2)

Android uses the same React product/protocol code with native glue for platform behavior such as system insets, IME resize fallback, lifecycle wake, Android Back, audio focus/routing, file/share intents, and native provider helpers.

Android development requires Java 17, Android SDK/Platform Tools, Android NDK, and Rust Android targets. APKs are written below the generated Android project under `src-tauri/gen/android/app/build/outputs/apk/`. Release builds need real release signing.

Do not claim browser `getDisplayMedia()` support where Android System WebView does not provide it; a proper Android screenshare requires a native MediaProjection path.

Likewise, browser Web Push is not equivalent to killed-process Android-native push. Runtime docs/settings should say what is actually implemented on `main`.

## Voice/video/screenshare

The client supports both:

- mesh WebRTC when no SFU is selected; and
- LiveKit/SFU-backed calls when a guild/DM call obtains an SFU endpoint/token.

The SFU path is implemented; older text saying the client “has no SFU client” is obsolete. Screen shares are explicitly watched/subscribed, and the shared call UI handles voice, camera, share video/audio, local device selection, and floating media continuity.

See [`../docs/calls.md`](../docs/calls.md).

## DMs and account security

DM/group-conversation content uses MLS E2EE. Current homeservers support OPAQUE password authentication and client-held recovery-key wrapping; identity continuity, generated account recovery keys, human verification, and guardian policy are separate but connected security layers.

Read the canonical documents instead of inferring the current design from old PRs:

- [`../docs/account-security.md`](../docs/account-security.md)
- [`../docs/dm-encryption.md`](../docs/dm-encryption.md)
- [`../docs/identity-continuity.md`](../docs/identity-continuity.md)

A malicious web origin remains a malicious client. Strong “malicious homeserver but private plaintext” claims assume trusted packaged client code or another independently trusted web origin.

## Service worker, cache, and notifications

The browser service worker precaches build assets and supports Web Push. Browser notification permission and background push are separate choices.

The client also keeps a bounded IndexedDB snapshot of useful guild/channel/read-state/recent-conversation data so reload can paint before all connections are ready. The snapshot is a cache: live READY state supersedes it, and cached UI is not represented as live authority.

Electron uses a native notification bridge while running. Android background/killed-process delivery must be documented separately from browser service-worker push whenever that native pipeline changes.

## Media and GIFs

Telium-hosted media is documented in [`../docs/media.md`](../docs/media.md). Current external-provider behavior—including client-direct Gofile uploads and the optional browser playback compatibility relay—is documented in [`../docs/external-media.md`](../docs/external-media.md).

GIF search can use the server-advertised KLIPY configuration. The standard KLIPY application key is intentionally public because the browser calls the provider directly; it is not a homeserver secret.

Favorites are account-scoped synchronized URL state. Ordinary arbitrary external URLs still use the normal embed/camo privacy path where applicable.

## UI component layer

The client uses Cloudflare Kumo on Base UI plus Tailwind v4. `src/components/` is the compatibility/product layer that gives the rest of Telium stable primitives for buttons, fields, menus, modals, tables, settings, and hints.

Keep accessibility semantics in those shared wrappers when possible. A migration compatibility alias belongs in one wrapper, not copied through every view.

Menus should have visible/touch equivalents for actions that are also available by right-click; a feature should not become desktop-mouse-only by accident. The mobile product uses drawers/sheets and touch targets over the same permission/protocol behavior.

## Where to read next

- [`../docs/architecture.md`](../docs/architecture.md) — authority model.
- [`../docs/api.md`](../docs/api.md) — route/gateway map.
- [`../docs/clients.md`](../docs/clients.md) — runtime details/security boundaries.
- [`../docs/development.md`](../docs/development.md) — tests/CI/change checklist.
- [`../docs/README.md`](../docs/README.md) — complete documentation index.
