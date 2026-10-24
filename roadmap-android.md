# Telium Android Roadmap

This roadmap tracks work needed to turn the Tauri 2 Android client from a capable mobile shell into a dependable daily-use messenger.

The direction is intentional: **keep the shared Telium React client, but let Android own Android-specific behavior**. The WebView should not be forced to fake platform features that Android already provides better and more reliably.

## Guiding rules

- Do not fork Telium protocol behavior just for Android.
- Prefer a small native bridge over large JavaScript workarounds for platform-only behavior.
- Keep push payloads content-free; wake the client, then fetch over Telium's authenticated connection.
- Voice/video must continue to work when the app is backgrounded or the screen is locked where Android permits it.
- Mobile polish is important, but lifecycle, notifications, calls, reliability, and data safety come first.
- Avoid letting `MainActivity.kt` become the permanent home for every Android feature. Split platform features into focused managers/bridges or internal Tauri plugins as they mature.

---

# P0 — Daily-driver blockers

## Native background push

The native Android notification pipeline is implemented. Remaining work here is focused on real-device lifecycle verification and completing routing/permission edge cases.

- [x] Add native Android push support.
- [x] Use content-free wake payloads. Push identifies that something changed and does not carry message plaintext.
- [x] After wake, fetch the authoritative notification inbox from the account homeserver, decrypt the descriptor locally, then navigate through normal Telium state as needed.
- [ ] Support notification taps that open the exact DM, channel, thread, or call. Canonical message/conversation navigation and call handling exist; keep this open until thread routing is verified too.
- [ ] Handle notification permission denial and recovery cleanly. Recovery paths exist, but keep this open until the full permission/lifecycle matrix is verified on an APK/device.
- [x] Add per-category Android notification channels for messages / DMs, mentions, calls, and account / security events.
- [x] Respect Telium's existing per-user notification preferences, including channel/mute policy and notification-preview preferences.
- [x] Deduplicate notifications across resume/reconnect races using the authoritative inbox, idempotent source IDs, cursor pull, and acknowledgement.
- [x] Do not expose decrypted DM contents to a third-party push service.

### Provider strategy

- [x] Implement one internal Telium push abstraction instead of baking a single vendor into protocol behavior.
- [x] Support FCM as the practical default for ordinary Android installations.
- [x] Support first-class UnifiedPush for users who want a non-Google path.
- [x] Document homeserver/provider requirements and how operators can omit or replace provider integrations. See `docs/notifications.md`.

## Proper Android call lifecycle

The current native audio routing work is a strong base, but Android should understand that Telium is actually in a call.

- [ ] Integrate Android Core-Telecom / Telecom APIs for VoIP lifecycle where practical. Authenticated active calls now register with stable AndroidX Core-Telecom, report active/disconnect lifecycle, and use a CallStyle foreground notification; keep this open until a real device verifies Telecom behavior while backgrounded and locked.
- [ ] Add an ongoing call foreground service with the correct microphone/camera service types and permissions. Audio calls now start a native microphone foreground service with a credential-free ongoing Return-to-call notification; camera/video service-type handling and real-device lifecycle verification remain.
- [ ] Keep voice alive with the screen locked and while another app is foregrounded.
- [x] Add native incoming-call notifications with Answer / Decline. Answer opens the authenticated conversation, rechecks that the call is still live, then joins through the normal voice client; Decline dismisses only this device's native alert.
- [x] Add native ongoing-call notifications with Return / Mute / Deafen / Hang Up as appropriate. The foreground CallStyle notification mirrors the authenticated client's mute/deafen state and sends credential-free control events back through the existing call bridge.
- [ ] Preserve the current speaker, earpiece, wired, USB, Bluetooth, BLE, and hearing-aid routing behavior.
- [ ] React correctly when a Bluetooth or wired device connects/disconnects mid-call.
- [ ] Handle audio-focus loss from phone calls, alarms, navigation, and other media apps without leaving Telium in a broken audio mode.
- [ ] Restore Android audio state reliably after every exit path, including crashes/reconnects where possible.

## Resume, reconnect, and network transitions

- [ ] Make gateway recovery reliable after Android Doze, process suspension, Wi-Fi/cellular changes, VPN changes, and device sleep.
- [ ] Rejoin voice state cleanly after brief network loss without duplicate subscriptions or ghost participants.
- [ ] Test switching Wi-Fi -> cellular -> Wi-Fi during text chat and during voice.
- [ ] Avoid reconnect storms when Android repeatedly pauses/resumes the WebView.
- [ ] Surface a useful offline/reconnecting state instead of silently appearing frozen.

---

# P1 — Android-native sharing, links, and files

## Share sheet support

Telium should be a useful target in Android's share sheet, not just an app that can receive shared text.

- [ ] Keep text/URL sharing.
- [ ] Add image sharing.
- [ ] Add video sharing.
- [ ] Add arbitrary file sharing.
- [ ] Add multi-file sharing with `ACTION_SEND_MULTIPLE`.
- [ ] Let the user choose the destination conversation/channel after entering Telium.
- [ ] Preserve captions/text supplied alongside media.
- [ ] Handle a share intent received while Telium is already running.
- [ ] Handle a share intent received before the WebView/session is ready.

## Deep links and app links

- [ ] Define canonical Telium deep-link routes for guilds, channels, messages, DMs, profiles, invites, and calls.
- [ ] Open supported `telium:` links directly in the app.
- [ ] Add verified Android App Links for official HTTPS links where appropriate.
- [ ] Make notification taps use the same routing path.
- [ ] Queue deep links safely until login/session restoration finishes.
- [ ] Provide a graceful fallback for links belonging to a different homeserver or an unavailable guild server.

## Files and media

- [ ] Keep using Android's Storage Access Framework for user-selected saves.
- [ ] Add a clean native path for attaching files from the Android document picker.
- [ ] Use the Android Photo Picker for photos/videos where available instead of broad media permissions.
- [ ] Support cancel/retry for large transfers.
- [ ] Make upload/download progress truthful on Android.
- [ ] Investigate background-safe transfers for large uploads/downloads using WorkManager or another Android-appropriate mechanism.
- [ ] Ensure encrypted DM attachments remain decrypted only on the client side before user-selected save.
- [ ] Test low-storage and revoked-URI-permission failure cases.

---

# P1 — Mobile UX that should feel intentional

## Navigation and Back behavior

The current mobile-specific drawers, sheets, long-press actions, and shared Back stack are the right direction.

- [ ] Audit Android 16 predictive Back behavior end-to-end.
- [ ] Back should dismiss the topmost sheet/dialog first, then drawers, then navigate within Telium, then leave the app.
- [ ] Add predictive-back animations where Tauri/Android integration permits it.
- [ ] Make sure gesture navigation and 3-button navigation both work.
- [ ] Prevent accidental app exits while a composer has meaningful unsent text.

## Keyboard / composer

- [ ] Continue hardening IME inset handling across Gboard, Samsung Keyboard, SwiftKey, hardware keyboards, and floating keyboards.
- [ ] Ensure autocomplete, emoji picker, attachment UI, reply UI, and mention suggestions never sit underneath the keyboard.
- [ ] Preserve scroll position when the keyboard opens/closes.
- [ ] Test multiline messages and very large accessibility font sizes.

## Touch and gestures

- [ ] Keep long-press message actions and haptic confirmation.
- [ ] Add sensible swipe gestures only where they are discoverable and reversible, such as swipe-to-reply.
- [ ] Ensure every desktop hover/right-click action has a touch-accessible equivalent.
- [ ] Audit touch targets for Android accessibility guidance.
- [ ] Avoid gesture conflicts between drawers, message swipes, media viewers, and Android system Back.

## Voice/video presentation

- [ ] Add a polished full-screen mobile call surface.
- [ ] Keep a persistent compact voice control while browsing other channels.
- [ ] Add camera front/back switching.
- [ ] Handle orientation changes during calls without dropping media.
- [ ] Add picture-in-picture for active video/screenshare if it proves reliable and useful.
- [ ] Consider proximity-sensor behavior when using the earpiece.
- [ ] Make screen-share viewing usable on small displays with zoom/orientation controls.

---

# P2 — Notifications and Android conversation niceties

These are not blockers, but they can make Telium feel dramatically more native.

- [x] Group message notifications by conversation.
- [x] Use Android conversation metadata / shortcuts where it improves notification ranking and UX. Native notifications use `MessagingStyle` plus opaque conversation group keys; launcher/share shortcuts remain a separate privacy decision below.
- [ ] Investigate direct reply from notifications without weakening E2EE or session handling.
- [ ] Investigate marking a message read from a notification action.
- [ ] Investigate Android notification bubbles for DMs as an opt-in feature.
- [x] Add proper unread badge/count behavior where launcher support exists. Message and mention notifications contribute one unread each through Android's supported notification number/badge APIs; call and account/security channels are excluded from launcher unread badges.
- [ ] Use avatars/guild icons in notifications without allowing remote media to bypass Telium's media/privacy rules.

---

# P2 — Platform architecture cleanup

`MainActivity.kt` already owns safe areas, lifecycle wake edges, share intents, Gofile setup, file saving, call mode, audio focus, and device routing. That is useful today but should not grow without structure.

- [ ] Split Android responsibilities into focused components, for example:
  - `TeliumCallManager`,
  - `TeliumPushManager`,
  - `TeliumShareBridge`,
  - `TeliumFileBridge`,
  - `TeliumInsetsBridge`,
  - `TeliumDeepLinkRouter`.
- [ ] Define a versioned native bridge contract between React and Android.
- [ ] Require request IDs for asynchronous bridge operations.
- [ ] Reject subframe and unexpected-origin bridge messages by default.
- [ ] Keep bridge methods narrow; do not expose a generic native HTTP or filesystem escape hatch.
- [ ] Move mature reusable capabilities into internal Tauri mobile plugins where that reduces generated-Android patching.
- [ ] Add unit tests for bridge parsing/validation and instrumentation tests for high-risk native flows.

---

# P2 — Security and privacy hardening

- [ ] Threat-model push registration, token rotation, and device removal.
- [ ] Rotate/revoke Android push registrations when a device session is revoked.
- [ ] Ensure notification previews obey DM privacy and user settings.
- [ ] Consider an optional "hide notification contents" mode.
- [ ] Consider optional biometric/app-lock support using Android's biometric APIs.
- [ ] Ensure screenshots can be disabled on especially sensitive surfaces only if users actually want that behavior; do not globally block screenshots by default.
- [ ] Audit all WebView bridges for origin checks, frame checks, size limits, and malformed input.
- [ ] Keep cleartext traffic disabled in release builds.
- [ ] Avoid broad storage/media permissions when SAF/Photo Picker can accomplish the task.
- [ ] Audit exported activities/providers whenever new intent filters are added.

---

# P2 — Performance, battery, and reliability

- [ ] Measure cold-start and warm-start time on low-end hardware.
- [ ] Reduce unnecessary React work while long message histories are visible.
- [ ] Verify GIF/video playback does not keep the device awake or burn CPU off-screen.
- [ ] Suspend expensive animation/media work while the app is not visible.
- [ ] Audit long-lived timers and reconnect loops for Doze/battery impact.
- [ ] Test large guilds, large DM histories, thousands of cached media entries, and slow homeservers.
- [ ] Add memory-pressure recovery for media-heavy channels.
- [ ] Verify the client survives Android process recreation rather than assuming the process lives forever.
- [ ] Restore the last useful location after process death without restoring unsafe transient state.

---

# P2 — Tablets, foldables, keyboards, and large screens

Phone-first should not mean phone-only.

- [ ] Add responsive two/three-pane layouts for tablets and unfolded foldables.
- [ ] Preserve the compact phone navigation model at narrow widths.
- [ ] Handle live window resizing on foldables, DeX, ChromeOS, and multi-window Android.
- [ ] Add useful keyboard shortcuts for hardware keyboards.
- [ ] Audit pointer/hover behavior on tablets and ChromeOS without breaking touch behavior.
- [ ] Test landscape mode instead of treating it as an accidental layout.

## Android TV

The manifest currently advertises Leanback launcher support. Decide intentionally whether Telium supports Android TV.

- [ ] Either build and test a TV-appropriate UX, focus model, and remote navigation...
- [ ] ...or remove the Leanback launcher advertisement until that support actually exists.

Do not claim a platform simply because the APK can technically launch on it.

---

# P3 — Nice Android goodies

- [ ] Dynamic-color integration as an optional theme source without overriding Telium's identity/accent system.
- [ ] Better native haptics for call connect/disconnect, long-press actions, and destructive confirmations.
- [ ] Android share targets / conversation shortcuts for frequent DMs if the privacy tradeoff is acceptable.
- [ ] Optional picture-in-picture for active calls/screenshares.
- [ ] Media controls for Telium-hosted audio playback when something is intentionally playing in the background.
- [ ] Quick Settings tile for mute/deafen while in a call, if Android restrictions and UX justify it.
- [ ] Better tablet/foldable drag-and-drop for attachments.
- [ ] Per-account launcher shortcuts if Telium eventually supports multiple simultaneous accounts.
- [ ] Accessibility pass: TalkBack labels/order, switch access, font scaling, reduced motion, high contrast, and color-independence.

---

# Build, release, and distribution

- [ ] Keep CI producing a signed debug APK for easy testing.
- [ ] Add reproducible release APK/AAB builds with documented signing-key handling.
- [ ] Produce arm64 as a baseline; decide whether x86_64/emulator and additional ABIs are release targets.
- [ ] Add Android-specific CI checks for Kotlin/Gradle plus Rust/Tauri integration.
- [ ] Run at least one emulator instrumentation smoke test in CI.
- [ ] Keep target SDK current and review Android behavior changes before bumping it.
- [ ] Define an update/distribution strategy for Play Store, direct APK, and potentially F-Droid-compatible builds where feasible.
- [ ] Publish release notes that distinguish protocol changes from Android-only behavior.

---

# Device / regression matrix

Before calling a major Android subsystem complete, test more than one happy-path emulator.

Minimum useful matrix:

- current Android release,
- one older supported Android version,
- Pixel / AOSP-like device,
- Samsung device if available,
- gesture navigation and 3-button navigation,
- Wi-Fi and cellular,
- Bluetooth headset,
- wired/USB audio where possible,
- screen locked during voice,
- app backgrounded during voice,
- app killed before receiving a push,
- permission denied then later re-enabled,
- low storage,
- dark/light Telium themes,
- large font / display scaling.

For call-related changes also test direct, TURN-relayed, and SFU calls so Android-specific work does not accidentally change Telium's transport/privacy semantics.

---

# Definition of "daily-driver Android client"

The Android client should not be considered daily-driver complete until all of the following are true:

- [ ] A killed app can alert the user to a new DM/mention without putting message plaintext in the push provider.
- [ ] Tapping that notification opens the correct destination.
- [ ] Incoming and ongoing calls behave like Android calls and survive normal background/lock-screen use.
- [ ] Bluetooth/headset routing works reliably.
- [ ] Sharing text, photos, videos, and files into Telium works.
- [ ] Saving encrypted attachments works through Android storage APIs.
- [ ] App resume/network changes do not routinely require a manual reconnect.
- [ ] Android Back/gesture navigation feels correct.
- [ ] The keyboard does not cover the composer or important overlays.
- [ ] Release builds have a repeatable signing/distribution path.

Once those are solid, polish items such as bubbles, PiP, dynamic color, shortcuts, and more ambitious tablet/TV experiences become worth prioritizing.
