// Notification settings, and the few words a notification itself is allowed to
// carry.
//
// Two surfaces share this namespace, and they share it because they are one
// subject seen from both ends. `views/user-settings/NotificationsPane.jsx` is
// where somebody decides how much a system notification may say about a
// message; `lib/notification-preview.js` is the twenty lines that obey that
// decision at the instant the notification is handed to the operating system.
// A translator who reads "Sender / title only" without also reading the
// sentence that actually appears when that option is chosen has translated one
// half of a promise, and the two halves have to agree or the setting is a lie.
//
// ---------------------------------------------- what is ours, and what isn't
//
// Almost nothing in a system notification is ours. The title is a channel
// name or a person's display name, the body is a message somebody typed, and
// both arrive at `notificationPreview()` already assembled by the three
// listeners in `App.jsx`. Not one of them is translated anywhere, and none of
// them should ever be: a channel called #annonces is called #annonces to a
// German reader too.
//
// What this file holds is the *frame* around that content -- specifically the
// two strings that exist only because the content was deliberately withheld.
// `notifications.system.generic` is what a body says when the message text has
// been redacted, and `notifications.system.appName` is what the title says
// when even the sender has been. They are the whole of the user-visible
// vocabulary of the redaction path, which is why they are so short and why
// they are the two entries here most worth getting right: for somebody running
// in "Hide sender and content" mode, they are the *only* words Telium ever
// puts on their lock screen.
//
// -------------------------------------------------- the `select` on a token
//
// Four keys here branch on a token rather than reading as a sentence:
// `local.permissionState`, and the three `push.android.*` keys. The values
// they switch on are machine vocabulary and are never themselves drawn --
// `granted` and `denied` come from the browser's Notification API,
// `prompt-with-rationale` from Android's, and the `push.android.*` stages are
// computed in the pane from three booleans the native host reports.
//
// They are `select` and not five separate keys for one reason: they are five
// answers to one question, drawn in one place, and a translator choosing words
// for "Blocked" needs to see "Allowed" and "Not asked yet" beside it to keep
// them parallel and to keep them short enough for the badge they sit in. Split
// across five keys in a translation tool they would arrive days apart, in
// alphabetical order, with nothing to say they were related.
//
// The tokens themselves must survive translation untouched. A translator who
// "translates" `granted` into their own language has not changed a word on
// screen -- they have deleted a branch, and the badge silently falls through
// to `other`, which reads "Not asked yet" on a device where notifications are
// working perfectly.
//
// ------------------------------------------------------- length and badges
//
// The status words go inside a `Pill`, which is a badge roughly wide enough
// for two short English words. "Wake unverified" is already at the limit and
// its German equivalent is not going to fit on one line, so the rows that draw
// them wrap -- see the `flex-wrap` in the pane. A translator does not have to
// be clever about length here; the layout gives way first.

export const notifications = {
  // -------------------------------------------------- local notifications

  // "Local" as opposed to "background push": these are the notifications
  // Telium shows itself, from a tab or a desktop window that is already
  // running. The distinction matters to the reader because the two have
  // completely different failure modes -- one needs a permission, the other
  // needs a server subscription -- so the section titles have to be
  // distinguishable at a glance and not both be some word for "notifications".
  'notifications.local.title': 'Local notifications',
  'notifications.local.description': 'Alerts from this browser or desktop app while Telium is running in the background.',

  // Two keys for what English would call one row, because the thing being
  // named is genuinely different: on the web it is a permission the *browser*
  // holds for this one site, and in the desktop and Android builds it is a
  // permission the *operating system* holds for the whole app. Some languages
  // have distinct words for the two and every language has a different
  // sentence to explain them, which is why the blocked notices below are split
  // the same way.
  'notifications.local.systemPermission': 'System permission',
  'notifications.local.browserPermission': 'Browser permission',

  // The badge beside that row. `state` is the raw permission string: the four
  // the web and native hosts can return (`granted`, `denied`, `default`,
  // `prompt`, `prompt-with-rationale`), plus `loading` while the first
  // asynchronous read is in flight and `unsupported` when the host has no
  // notification API at all.
  //
  // `other` deliberately covers `default`, `prompt` and `prompt-with-rationale`
  // together: all three mean the same thing to a person -- nobody has been
  // asked yet -- and the difference between them is a platform detail about
  // *how* the prompt would be shown. "Not asked yet" rather than "Ask" or
  // "Default", because the reader is being told a state, not offered an
  // action; the action is the button next to it.
  'notifications.local.permissionState': '{state, select, loading {Checking…} granted {Allowed} denied {Blocked} unsupported {Unavailable} other {Not asked yet}}',

  // Not `common.enable`, even though the English is identical. This button
  // does not turn a Telium setting on -- it opens the platform's own
  // permission prompt, and the word has to survive sitting next to
  // `notifications.local.enabling` in a progress state. Keeping the pair in
  // one file means a translator who lengthens one can see the other and keep
  // them the same verb; reaching into `common` for half of a pair is how a
  // button ends up reading "Allow" and then "Enabling…".
  'notifications.local.enable': 'Enable',
  'notifications.local.enabling': 'Enabling…',

  // Both say the same thing and neither can say it in the other's words: the
  // web build cannot send you to an operating-system settings panel, and the
  // desktop build has no site permission to re-allow. The sentence has to name
  // the right place or it is advice that leads nowhere.
  'notifications.local.blockedSystem': 'Notifications are blocked in your operating system settings. Re-enable Telium there first.',
  'notifications.local.blockedBrowser': 'Notifications are blocked for this site in the browser’s settings. Re-allow them there first.',

  'notifications.local.unsupported': 'Local notifications are not available in this browser.',

  // A service worker has fetched a newer build and it is waiting for a reload.
  // This lives in the notifications namespace rather than a general one
  // because the row is drawn in this pane and nowhere else -- it is here at
  // all because a stale service worker is one of the two things that stops
  // notifications arriving, and somebody debugging that is already on this
  // screen.
  'notifications.local.updateReady': 'A newer build is installed',
  // The button that reloads the page onto that new build. Not `common.refresh`:
  // "Refresh" is what a list does when it re-fetches, and this discards the
  // running app.
  'notifications.local.reload': 'Reload',

  // Said once, after the platform prompt has been answered with a yes. "on
  // this device" is load-bearing and must not be dropped in translation: the
  // preference it confirms is not synced, and somebody who reads this as
  // "notifications are on for my account" will wonder why their laptop is
  // silent.
  'notifications.local.enabled': 'Notifications enabled on this device.',
  // `reason` is a sentence, already translated, from `errorMessage()` -- most
  // often the homeserver's or the platform's own explanation. It is a complete
  // sentence with its own full stop, which is why nothing follows the
  // placeholder here.
  'notifications.local.enableFailed': 'Could not enable notifications: {reason}',

  // ------------------------------------------------------- background push

  // The other half: waking a Telium that is *not* running. The description is
  // a privacy claim and not a feature summary, and it is the claim the whole
  // section exists to make good on, so it should stay a claim in translation.
  // "Push providers" means Apple, Google and whoever else carries the
  // doorbell; naming them generically is deliberate, because which one is in
  // use depends on the build.
  'notifications.push.title': 'Background push',
  'notifications.push.description': 'Push providers only wake Telium. Notification content stays inside Telium’s encrypted inbox.',

  // The footnote under the whole section. One key and one sentence pair, not
  // two: the second half ("pulls an opaque inbox row…") is the evidence for
  // the first ("carry no message content"), and a translator handed them
  // separately cannot see that the second is explaining the first.
  'notifications.push.privacyHint': 'Provider wake-ups carry no message content. Android and supported browsers pull opaque inbox rows, decrypt them on-device, and acknowledge only rows they successfully process.',

  'notifications.push.android.label': 'Android background notifications',

  // `stage` is computed in the pane from what the native host reports, and the
  // five values are a ladder rather than a set: `blocked` (the OS has not
  // granted notifications at all) → `none` (granted, but nothing enrolled) →
  // `inbox` (the encrypted inbox exists, but no wake endpoint) → `unverified`
  // (an endpoint exists, but no wake has been proven to arrive) → `ready`.
  // `checking` is not on the ladder; it is the badge's own "we have not heard
  // back yet" and never reaches the notice or the button.
  //
  // The badge collapses `blocked` and `none` into "Not set up", because from
  // the reader's side they are the same fact -- this phone will not wake -- and
  // the notice underneath is where the difference between them is explained.
  'notifications.push.android.state': '{stage, select, checking {Checking…} ready {Ready} unverified {Wake unverified} inbox {Inbox only} other {Not set up}}',

  // The button beside the badge, which is only drawn on the three middle
  // rungs. Each is an imperative naming the *next* rung, not the goal: "Test
  // wake" sends one real doorbell, "Finish setup" chooses a push distributor,
  // "Set up" starts from nothing. A translation that used one verb for all
  // three would make the button look inert when it is in fact doing something
  // different each time.
  'notifications.push.android.action': '{stage, select, unverified {Test wake} inbox {Finish setup} other {Set up}}',
  'notifications.push.android.testing': 'Testing…',

  // The paragraph under the row, on the same ladder. These are long on purpose:
  // background delivery on Android fails quietly and in several distinguishable
  // ways, and a reader who is not told which rung they are on has no way to
  // guess. Each branch says what is true now and what the next step buys.
  //
  // `other` is the `blocked` rung -- the one case where the next step is not on
  // this row at all but in the Local notifications section above, which is why
  // it is the only branch that points somewhere else.
  'notifications.push.android.notice': '{stage, select, ready {Ready for background wake. Telium sent a real content-free test doorbell through the configured push provider and Android confirmed it reached the native push service.} unverified {The encrypted inbox and push endpoint are registered, but no verified wake has reached this phone yet. Test wake before relying on notifications while Telium is closed.} inbox {The encrypted inbox is ready, but this device does not yet have a confirmed wake endpoint. Finish setup to choose or refresh its Android push distributor.} none {Set up the encrypted Android inbox and push distributor for background delivery.} other {Enable system notifications first, then Telium can enroll this Android device for encrypted background delivery.}}',

  // Said after enrolment returns. `outcome` is the same ladder as `stage`,
  // read off the status the host just handed back, collapsed to the three
  // endings enrolment can actually have. The differences are worth keeping:
  // the first is a promise kept, the second is a qualified success that the
  // reader may need to act on, and the third is "come back in a moment".
  'notifications.push.android.enrolled': '{outcome, select, verified {Android background notifications passed a test wake.} endpoint {Android registered a push endpoint, but wake delivery is not verified.} other {Android push is set up; the wake endpoint is registering.}}',
  'notifications.push.android.enrollFailed': 'Could not enroll Android notifications: {reason}',

  // The web build's one switch. "when it is closed" is the whole point of the
  // setting and the part most likely to be lost in a shorter translation:
  // without it the row reads as a duplicate of the local-notification
  // permission above it.
  'notifications.push.web.label': 'Wake this browser when it is closed',
  'notifications.push.web.hint': 'Registers an encrypted Web Push subscription with your home server.',

  // Both confirmations name the browser rather than the account, for the same
  // reason `notifications.local.enabled` names the device: a Web Push
  // subscription belongs to one browser profile on one machine, and somebody
  // who reads this as an account-wide switch will be surprised by their phone.
  'notifications.push.web.on': 'This browser can wake for notifications.',
  'notifications.push.web.off': 'Background push disabled on this browser.',
  'notifications.push.web.onFailed': 'Could not enable push: {reason}',
  'notifications.push.web.offFailed': 'Could not disable push: {reason}',

  // Shown when there is no service worker to subscribe with. The desktop
  // version is not a failure and is not phrased as one -- desktop
  // notifications do work, the gap is only the closed-app case -- which is why
  // it is drawn in a neutral notice and the browser one in a warning.
  'notifications.push.desktopOnly': 'Desktop notifications work while Telium is running. Waking a fully closed desktop app is not implemented yet.',
  'notifications.push.unsupported': 'This browser cannot register background push on this device.',

  // -------------------------------------------------------------- alerts

  // What gets announced, and how much of it. Short because it is a section
  // heading over three unrelated switches and a dropdown, and anything longer
  // would be trying to summarise them.
  'notifications.alerts.title': 'Alerts',

  // The privacy control. The hint has to do two jobs at once and both are
  // necessary: tell the reader the setting follows their account to other
  // devices, and stop them from reading that as "so my messages are synced
  // somewhere". The second clause is the one to preserve if a language needs
  // to shorten.
  'notifications.alerts.preview.label': 'Notification previews',
  'notifications.alerts.preview.hint': 'Controls what system notifications reveal on this device. The preference syncs with your account; message content still stays inside Telium’s encrypted notification path.',

  // The three modes, in decreasing order of what they disclose. Their values
  // (`full`, `sender`, `hidden`) are persisted preference tokens and are not
  // in this file at all -- they live in `lib/notification-preview.js`.
  //
  // "Sender / title only" is the awkward one and the slash is doing real work:
  // for a DM the thing kept is a person's name, and for a channel mention it
  // is the channel's title, and no single English noun covers both. A language
  // with a word that does cover both should use it and drop the slash.
  'notifications.alerts.preview.full': 'Full preview',
  'notifications.alerts.preview.sender': 'Sender / title only',
  'notifications.alerts.preview.hidden': 'Hide sender and content',

  'notifications.alerts.mentions.label': 'Notify on mentions',
  'notifications.alerts.mentions.hint': 'Shows a notification when you are mentioned while Telium is in the background.',

  'notifications.alerts.dms.label': 'Notify on direct messages',
  // Two hints for one switch, picked by build rather than by language. The
  // desktop and web sentence explains *why* the switch exists separately from
  // the mentions one; the Android sentence cannot, because it has a more
  // urgent limitation to declare first -- a killed app does not yet wake for
  // DMs, and somebody who turns this on expecting it to is going to miss
  // messages. Neither sentence is a shortened version of the other, so they
  // are two keys.
  'notifications.alerts.dms.hint': 'Every message in a DM is addressed to you, so mentions do not cover them.',
  'notifications.alerts.dms.hintAndroid': 'Shows encrypted DM/group-chat alerts while Telium is backgrounded or fully closed. Killed-app alerts stay generic until MLS is running again.',

  // Three keys where there was one, because the sound preference grew two more
  // switches and each is a different promise.
  //
  // The first is the master: mentions and DMs, the things addressed to you.
  // "whether or not it is in front" is the load-bearing half of its hint and
  // must survive translation -- somebody who reads this as "plays while you
  // are looking at Telium" has been told the opposite of what the switch does.
  'notifications.alerts.sound.label': 'Play a sound for mentions and DMs',
  'notifications.alerts.sound.hint': 'Plays while the client is running, whether or not it is in front.',

  // The second half of the same preference, and the reason the first is worth
  // having separately: a chime for every line in a busy guild is the setting
  // people turn sounds off over. Greyed rather than hidden while sounds are
  // off, so it does not read as something that was just created when you flip
  // the switch above it.
  //
  // "Also" is doing real work and is not filler: this switch is meaningless
  // read on its own, and a translation that drops the word leaves two
  // sound switches with no stated relationship between them.
  'notifications.alerts.soundMessages.label': 'Also for ordinary messages',
  'notifications.alerts.soundMessages.hint': 'Every message in a channel you are reading, not only the ones addressed to you.',

  // The ringtone, which is on unless it is turned off -- the one switch in
  // this section that defaults the other way. A chime for a message that will
  // still be there in an hour is a thing to ask for; a call is over in thirty
  // seconds whether or not anybody heard it, so hanging the ringtone off a
  // preference most accounts have never touched would ship silence.
  //
  // The hint has to name all three ways the ringing stops, because a repeating
  // sound nobody can see the end of is the kind of thing people quit an app
  // over. The card with Answer on it appears either way; this is only the
  // sound.
  'notifications.alerts.callRing.label': 'Ring for incoming calls',
  'notifications.alerts.callRing.hint': 'A repeating ringtone while somebody is calling you in a conversation. Stops when you answer, decline, or they give up.',

  // ------------------------------------------ the notification's own words

  // The two strings `lib/notification-preview.js` substitutes for content it
  // has been told to withhold. Read the header of this file before changing
  // either: between them they are the entire visible vocabulary of a device
  // running in "Hide sender and content" mode.

  // The title slot when the sender has been redacted, and the fallback title
  // whenever the caller had nothing to put there.
  //
  // It is a key rather than a literal for one reason, and it is not that the
  // product has a different name anywhere: it does not. It is that a script
  // which does not use the Latin alphabet may want the name transliterated so
  // it can be read at a glance on a lock screen, and that decision belongs to
  // the person who reads that script. A translator with no such need should
  // leave this exactly as it is -- the name is a name, not a noun.
  'notifications.system.appName': 'Telium',

  // The body slot when the message text has been redacted and the caller
  // supplied nothing more specific. Callers normally do supply something --
  // "New mention", "New direct message", "Incoming call" -- so this is the
  // sentence of last resort, and it has to be true of any of them.
  //
  // Deliberately says nothing about who or where. It is drawn on a lock screen
  // by somebody who has asked for exactly that, and a helpful-sounding
  // "New message from a contact" would leak the one bit they asked to hide.
  'notifications.system.generic': 'New notification',

  // ---------------------------------------- the frame around what was typed
  //
  // The call sites for everything below are the three
  // `store.on('mention' | 'dm-notify' | 'ring')` listeners in `src/App.jsx`.
  // They used to assemble these sentences out of template literals, which is
  // the reason they are worth reading carefully: a notification body is the
  // one string in this client that is composed from a name, a channel and a
  // hundred and forty characters of somebody's message, and every one of those
  // joins was a word order this app had decided on behalf of every language.
  //
  // What they are: the interface half of a notification whose other half is
  // somebody's words. `{sender}`, `{name}`, `{channel}` and `{message}` all
  // hold user-generated content -- a display name, a conversation's title, a
  // channel's name, a message body already clipped to 140 characters by
  // `notifyBody`. None of them is translated, ever, and a translator must not
  // "helpfully" reorder a name into a form their language would prefer for a
  // *person*: these are arbitrary strings that may be in any script.
  //
  // What a translator may do, and is the whole reason these are patterns
  // rather than concatenations, is move the placeholder. A language that
  // introduces the speaker after the utterance, or marks the channel with a
  // particle rather than a prefix sigil, can write that here; the JavaScript
  // that used to build these strings could not be told any of it.
  //
  // There is no count in any of them, which is why no `plural` appears here.
  // Telium notifies per message rather than coalescing, so the "3 new messages
  // in #general" shape that would need one does not exist yet. It should be
  // added as a `plural` key when it does -- never as a `{n} new messages`
  // interpolation, which has no correct translation into Polish or Arabic.

  // The title of a channel-mention notification: a channel name wearing the
  // sigil the rest of the client draws it with. A key rather than a `#` glued
  // on in JavaScript so a right-to-left locale can place the sigil on the side
  // its readers expect, and so a language that marks channels differently can.
  'notifications.system.channelTitle': '#{channel}',
  // What stands in when the mention arrived for a channel this client has not
  // loaded. Lower case on purpose: it sits in the sigil slot above, where a
  // real channel name would also be lower case.
  'notifications.system.unknownChannel': 'channel',

  // The body of a message notification in full-preview mode: who spoke, and
  // what they said. The colon is this language's way of attributing speech and
  // is not sacred -- a language that quotes, dashes or inverts is free to.
  'notifications.system.messageFrom': '{sender}: {message}',
  // A DM frame this device cannot open. Not an error: the message arrived, it
  // is real, and the key to it lives on another device this account trusts.
  // The sentence has to be neutral enough not to read as "something broke".
  'notifications.system.encryptedFrom': '{sender} sent an encrypted message',
  // A DM whose body is empty because the message is a file. "sent an
  // attachment" rather than naming the file: the filename is content, and this
  // sentence is drawn in modes where content has been withheld.
  'notifications.system.attachmentFrom': '{sender} sent an attachment',

  // The redacted bodies the three listeners pass as `genericBody`. Each says
  // only what kind of thing arrived -- the rung above `notifications.system.
  // generic`, which says not even that.
  'notifications.system.newMention': 'New mention',
  'notifications.system.newReply': 'New reply',
  'notifications.system.newDm': 'New direct message',
  'notifications.system.incomingCall': 'Incoming call',
  // The body of a ring notification when the conversation has a name worth
  // showing -- a group call, or a DM the reader has titled. `{name}` is that
  // title and is user-generated. A one-to-one call with no title falls back to
  // `notifications.system.incomingCall`, because "Calling Alice" on a screen
  // whose title already says Alice is one Alice too many.
  'notifications.system.calling': 'Calling {name}',

  // The toast when the *browser* refuses to draw one of the above.
  //
  // Reached from `showLocalNotification`'s rejection handler in `App.jsx`, and
  // it is the context half of `errors.context` -- the sentence the underlying
  // failure gets appended to. Which is why it names the act rather than the
  // outcome ("Could not show a notification", not "Notification failed"): the
  // string after it is already the outcome, and two of those read as one
  // sentence saying nothing twice.
  //
  // Worth noticing that this is the one string in the file the reader sees
  // *inside* the app rather than on a lock screen, so it is subject to the
  // ordinary toast constraints -- short, and true whether the failure was a
  // withdrawn permission, a browser that has quietly stopped allowing them, or
  // a platform with no notification API at all.
  'notifications.system.showFailed': 'Could not show a notification',

  // ------------------------------------ what the service worker is allowed to say
  //
  // These three are the only sentences `src/sw.js` can put on a screen, and
  // they are the only strings in this catalogue that are read somewhere the
  // catalogue does not exist. The worker is emitted as plain text rather than
  // bundled, so it has no module graph and cannot import this file; the page
  // resolves these keys and posts the finished sentences to the worker, which
  // stores them against the next wake-up. `lib/serviceworker.js` does the
  // posting and the long version of why is at the top of `src/sw.js`.
  //
  // Two consequences a translator should know about. The first is that a change
  // to any of these reaches a device only after that device next opens Telium
  // -- there is no way to reach a worker that is asleep. The second is that
  // `src/sw.js` carries an inlined English copy for the case where the page has
  // never run, and `src/test/sw-strings.test.js` fails if this file and that
  // copy stop saying the same thing.

  // The title on every notification the worker posts. The same name as
  // `notifications.system.appName` and it resolves from that key rather than
  // repeating the word, for the transliteration reason given there.

  // A move of the whole account to another homeserver has been requested, and
  // the owner is being woken so they can cancel it if it was not them. This is
  // the one wake-up that is not about a channel and the one that can matter at
  // three in the morning: it says what happened and what opening the app is
  // for, and nothing else, because the push provider reads this body too.
  'notifications.wake.migration': 'A move of your account was requested. Open Telium to review or cancel it.',

  // Everything else. A wake-up carries a guild id and a channel id and no
  // content whatsoever -- the server builds it that way on purpose -- so this
  // sentence is the honest maximum. Do not translate it into something more
  // specific: "New message" would be a claim about content the worker has not
  // seen and may be wrong about.
  'notifications.wake.activity': 'New activity in a channel you follow.',

  // The toast the page raises when the worker has installed a newer build and
  // is waiting to take over. Not `notifications.local.updateReady`: that one
  // is a status row inside the settings pane and reads as a statement, this
  // one interrupts and has to ask for something.
  'notifications.wake.updateToast': 'A new version is ready. Reload to use it.',
};
