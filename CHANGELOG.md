<!--
User-facing changelog, fetched by the client's "What's new" button
(web/src/lib/changelog.js). Two rules keep that working:

  * Newest first, one `## <date or name>` section per batch of changes
    worth telling people about.
  * The topmost `## ` heading is the identity the client uses to decide
    whether the What's new badge has been read. Editing that heading
    re-shows the badge to everyone.

Write for the people using the app, not the repo: what changed in their
hands, not which PRs merged.
-->

## 22 October 2026

- Servers now update to releases rather than to whatever was last merged. A server release is a `server-v<version>` tag, built once and published once, and both update paths move to the newest release. `telium-server version` reports the release version alongside the commit it was built from, so "which release is this?" has an answer you can read off the box.

## 21 October 2026

- An Android preview build is now downloadable from the download page. It is early — expect rough edges — and it installs and updates like a normal app, signed with Telium's own release key rather than a debug one.
- Windows and Linux releases are unchanged and still get the desktop download. Android is built and released separately, so a desktop release no longer implies an Android one.

## 15 October 2026

- Report bugs and send feedback from inside the client: Settings → Help & feedback assembles a pre-filled issue, shows you exactly what would be attached, and keeps a full copy on your clipboard either way.
- The desktop app's address field now opens the web client, the way a browser would.

## 14 October 2026

- Native installs — no Docker — get a real update path: the CI publishes a static server build for x86_64 and aarch64 (Raspberry Pi included), and a systemd timer keeps the box on the current release.
- Fixed: a DM frame sent from a session the account no longer remembers could stall message delivery instead of being stepped over.
- Fixed: DM frames that arrive out of order no longer bury each other.

## Earlier in October

- Guild calls stay up through the faults that used to end them — network blips and relay handover included.
- Calls answer cleanly when someone's signal arrives before your device has finished dialling.
