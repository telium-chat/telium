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

## 15 November 2026

- New: **Change password** in account settings. Your encrypted-message key is re-sealed under the new password in the same step, so signing in on a new device with the new password still brings your history. Resetting a forgotten password with your recovery key now does the same.
- Changed: the old ways of keeping your encrypted-message key (an extra passphrase, server-assisted recovery, devices only) are retired. If your account was still on one, a device that holds your keys moves it to your password the next time you sign in with it. Otherwise your older encrypted messages stay locked, and Settings → Encryption key offers to start a new vault so new messages are encrypted again.
- Changed: when a server limits how long files can be kept, the "keep files for" menu now shows the options that are too long as grayed out, with an info icon that explains the limit, instead of quietly leaving them out.
- New: **Your uploads** in settings. If your server limits how much you can upload, you can now see which files are using your quota, largest first, see when each one expires, jump to the message it was sent in, and delete the ones you don't need to get the space back. Files that other people have also uploaded identically are shown but can't be deleted from there, and profile pictures and emoji are counted separately since they're still in use.
- Fixed: "Encryption is out of sync" after someone starts a conversation over. If one of your devices missed the start-over, it used to get stuck: newer messages wouldn't open, and anything you sent was refused. Your device now notices, gets itself back into the conversation, and catches up - nobody has to press anything.
- Fixed: signing in on a second device now gets your account's keys properly.

## 26 October 2026

- Fixed: calls in a voice channel now stay up through server trouble. If a server the call runs on goes down or restarts for a few minutes, the call waits for it and rejoins on its own when it's back, instead of ending and taking everyone out of the voice channel. And a call that drops twice in a row now pauses briefly and tries again, instead of removing you from the channel.
- Fixed: long calls no longer reconnect out of nowhere. A call that had been going for a while used to be knocked into a full reconnect — join sound and all — by the first small network hiccup. The call now renews its connection quietly in the background, and the conversation just continues.
- Fixed: sound that breaks mid-call now repairs itself. If a glitch left you unable to hear the call, or the call unable to hear you, it used to stay broken until everyone left the channel and joined again. The call now fixes itself in place — usually within seconds, at most within a minute.
- Fixed: being removed from a voice channel now ends the call clearly. If a moderator disconnects you, the app tells you what happened and leaves the call with you, instead of leaving you sitting in a call that has quietly gone silent.

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
