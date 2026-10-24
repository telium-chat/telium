# Telium desktop (Electron)

Telium's desktop app uses Electron/Chromium. The React client in `web/src/` is still the application; this directory is only the native desktop shell and its narrowly scoped privileged bridge.

Tauri remains the Android shell under `web/src-tauri/`.

## Development

From `web/`:

```sh
bun install
bun run desktop:install
bun run desktop:dev
```

`desktop:dev` starts Vite on `127.0.0.1:5173`, waits for it to become reachable, then opens the same client in Electron.

## System tray

The Electron desktop app owns a persistent Telium tray icon. Closing the main window hides it instead of ending the process, so native notifications and desktop activity integrations can continue running. Clicking the tray icon or choosing **Open Telium** restores and focuses the existing window; **Quit Telium** performs a real application shutdown and runs the normal desktop cleanup path.

Tray lifecycle logic lives in `tray-lifecycle.cjs` and is covered by the Node-native desktop test suite. The Electron app and tray icons are owned under `electron/assets/`; desktop packaging no longer borrows icons from the Android/Tauri tree.

## Linux AppImage

From `web/`:

```sh
bun install
bun run desktop:install
bun run desktop:build:linux
```

The AppImage is written under `web/dist-electron/`. It uses electron-builder's
static AppImage runtime (`toolsets.appimage = 1.0.3`), so current distributions
that ship FUSE 3 do not need the legacy `libfuse.so.2` userspace library just to
start Telium.

Packaged AppImages check the public `telium-chat/telium` GitHub Releases feed at
startup and every six hours. A new version is offered with **Update & restart**;
choosing it downloads the AppImage through `electron-updater`, verifies the
download against the SHA-512 in the update metadata, replaces the running
AppImage, and relaunches Telium.
Development builds and unpacked Electron builds never self-update.

The **Desktop** settings page can add the current AppImage to the user's Linux
application launcher and can enable start-on-login. Both integrations are
per-user and reversible. Login startup passes `--start-in-tray`, so Telium loads
its background services and tray icon without showing the main window. Existing
desktop entries are refreshed on launch so an AppImage renamed by an update
continues to open the current version.

Desktop releases use tags of the form `desktop-v0.2.0`. The GitHub **Build
desktop AppImage** workflow derives the packaged version from that tag and
publishes the AppImage together with `latest-linux.yml`. The differential-update
blockmap is embedded in the AppImage by the static runtime builder. The YAML
metadata is what `electron-updater` reads; uploading an AppImage by itself does
not create an update channel.

## Security boundary

The renderer is intentionally a normal locked-down Chromium page:

- `contextIsolation: true`
- `nodeIntegration: false`
- `sandbox: true`
- `webSecurity: true`

Do not disable Chromium web security to work around CORS. Desktop-only operations belong behind explicit methods in `preload.cjs` and matching validated IPC handlers in `main.cjs`. The renderer must never receive a generic unrestricted native `fetch(url)` primitive.

The current bridge covers the capabilities the old desktop Tauri shell supplied: OS external links, native notifications, direct Gofile cookie setup, controlled GIF fetching, and window focus events. WebRTC, microphone, camera and screen video stay in Chromium so LiveKit sees the same browser media APIs as the web client.

Linux is the one deliberate exception for **screen-share audio**. Chromium's Linux display capture can return either no audio track or an audio track that exists but is silent, so the desktop shell uses `@vencord/venmic` to route PipeWire playback into a temporary virtual input named `vencord-screen-share`. When that virtual input is available it replaces Chromium's Linux display-audio track rather than merely filling in a missing one, matching Vesktop's workaround. Telium's own Electron Audio Service and input-audio streams are excluded from the PipeWire graph so call audio and microphones are not fed back into the share. The virtual source is disconnected when the share ends and hidden from the normal microphone picker.
