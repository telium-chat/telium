// Moving an account, or a guild, from one homeserver to another.
//
// Three surfaces speak this namespace and they do not speak to the same person
// in the same situation, which is the first thing a translator has to hold on
// to:
//
//   * `migration.banner.*` is shouted at **every signed-in device at once**
//     while a move waits out its cooling-off window. Its reader may well not
//     be the person who started the move -- that is the entire reason the
//     banner exists (docs/migration.md, "Migration alerts") -- so it never
//     congratulates and never assumes consent. It says what is scheduled, when
//     it runs, and what to do if this is news.
//
//   * `migration.guided.*`, `migration.manual.*`, `migration.field.*` and
//     `migration.scheduled.*` are the **old** server talking to the account's
//     owner, who is about to hand their account to somebody else's machine.
//
//   * `migration.receive.*` and `migration.confirm.*` are the **new** server
//     talking to whoever is signed in there, who may be being phished into
//     accepting somebody else's account.
//
// ------------------------------------------------------- this is security copy
//
// Account migration is irreversible once it executes. Nothing in this file may
// be softened into reassurance, and three specific promises in it are load-
// bearing -- they are the sentences a person checks before they type a
// password, and a translation that drops or weakens one of them turns a
// deliberate act into an accident:
//
//   1. **"Nothing has moved yet."** Said by every screen that is *not* the
//      last one. The whole protocol is a sequence of preparations that look
//      like commitments -- creating an import code, confirming at the
//      destination, scheduling -- and a person who believes step one already
//      moved their account will not bother to finish, or will panic. Where the
//      English says nothing has happened yet, the translation must too.
//
//   2. **The cooling-off window, and who can cancel.** "Any active device can
//      cancel" is not a courtesy, it is the countermeasure against a stolen
//      session: the move is announced everywhere and stoppable from anywhere
//      for as long as the window lasts. A translation that says "you can
//      cancel" instead of "any of your devices can cancel" has described a
//      different, weaker mechanism.
//
//   3. **Which server is being asked for which password.** The one credential
//      this flow needs is the password on the server being *left*. Every
//      phishing variant of this protocol works by getting that typed somewhere
//      else, which is why `migration.field.passwordHint` exists and why it
//      must keep saying "not the destination".
//
// ----------------------------------------------- domains and ids are not words
//
// `{destination}`, `{source}`, `{here}`, `{subjectId}`, `{target}`, `{me}` and
// `{guild}` all hold a homeserver domain or an account/guild identifier that
// came off the wire. They are data. They are never translated, never
// transliterated, and never reordered into something that could read as a
// different name -- half the value of these sentences is that the reader can
// compare the domain on screen with the domain they meant to move to.
//
// -------------------------------------------------------------- server errors
//
// `migration_in_progress`, `migration_handoff_invalid` and `migration_refused`
// are server codes and live in `errors.js`, not here. The screens branch on
// `codeOf(err)` and render `errorMessage(err)`. What *is* here is the wrapper
// line a toast needs -- "Could not confirm this move: {reason}" -- because the
// context ("which of the four things I just did failed") is a fact about the
// screen and only the screen knows it. `{reason}` always arrives already
// translated; it is a whole sentence and usually ends in a full stop, so a
// language that cannot end a clause with a colon should reword the wrapper
// rather than try to punctuate the reason.

export const migration = {
  // ------------------------------------------------------------- the banner

  // The whole alert, as one sentence, because every part of it moves in
  // translation: German puts the deadline before the verb, and a language with
  // a different clause order for "if you did not ask for this" cannot get
  // there from three concatenated fragments.
  //
  // The three selects:
  //   `subject`  -- `guild` when a guild is moving, anything else for the
  //                 account itself. A guild is named by its id and not by its
  //                 name: the name is a thing somebody chose and a thing an
  //                 attacker could choose to look like another guild, and this
  //                 is a warning, so it names the only identifier that cannot
  //                 be forged.
  //   `when`     -- `soon` when the deadline has already passed and the move
  //                 is merely waiting for a worker to pick it up. There is no
  //                 time to show in that branch, so the branch has no `{at}`
  //                 in it; do not add one.
  //   `mailed`   -- `sent` when the server also sent a warning to the recovery
  //                 address. The `other` branch is deliberately empty. The
  //                 leading space belongs *inside* the `sent` branch so the
  //                 sentence does not end in a stray space when no mail went.
  //
  // `{at}` is split into a date and a time rather than one combined value
  // because the pattern language has no combined form -- and splitting it is
  // the better shape anyway: the comma between them is punctuation, and which
  // punctuation joins a date to a time is a fact about the language. Seconds
  // are shown on purpose. This is a deadline, not a timestamp on a message,
  // and somebody deciding whether they have time to cancel is entitled to the
  // exact instant.
  'migration.banner.alert': '{subject, select, guild {The guild {subjectId}} other {Your account}} is set to move to {destination} {when, select, soon {as soon as it is picked up} other {on {at, date, short}, {at, time, withSeconds}}}. If you did not ask for this, cancel it and change your password.{mailed, select, sent { A warning was also sent to your recovery email.} other {}}',

  // On the banner, beside the warning. "Cancel" alone would be read as
  // dismissing the banner, which is the opposite of what the button does, so
  // the object stays in the label -- this is why it is not `common.cancel`.
  'migration.banner.cancel': 'Cancel move',
  'migration.banner.cancelFailed': 'Could not cancel the move: {reason}',

  // Shown when more moves are scheduled than the banner spells out. The count
  // is of the ones *not* shown, never the total. "Settings" names the pane and
  // must read the same here as `common.settings`.
  'migration.banner.more': '{count, plural, one {# more scheduled move is waiting. Open Settings to see it.} other {# more scheduled moves are waiting. Open Settings to see them.}}',

  // ------------------------------------------------------- the dialog titles

  // Two keys and not one `select`, because these are the dialog's title and
  // are read on their own with nothing around them: a translator needs to see
  // each as a complete heading. Both are the imperative "move", addressed to
  // the owner.
  'migration.title.account': 'Move this account',
  'migration.title.guild': 'Move this guild',

  // ------------------------------------------------ fields both flows draw

  // The guided move and the import-code move ask for the same three things, so
  // the labels live together rather than being written twice with a chance to
  // drift. A label that reads differently in two places in the same flow reads
  // as two different things being asked for.

  'migration.field.destination': 'Destination server',
  // An example domain, not a sentence. `example.org` is reserved by RFC 2606
  // precisely so documentation can use it without naming somebody's machine --
  // keep it exactly as it is. Translate `newhome` only if the reader's
  // language would not recognise it as a placeholder word; never translate the
  // `.example.org` part.
  'migration.field.destinationPlaceholder': 'newhome.example.org',
  'migration.field.oldServer': 'Old server',
  'migration.field.oldAccountId': 'Old account ID',
  'migration.field.oldGuildId': 'Old guild ID',
  'migration.field.password': 'Your password on this server',
  // Load-bearing (see the header, promise 3). Every phishing version of this
  // flow works by getting the destination's password typed into the source, or
  // the other way round. "old/current" is a deliberate belt-and-braces: the
  // reader may think of it as either, and the sentence has to be unambiguous
  // for both. Do not shorten this to "not the other one".
  'migration.field.passwordHint': 'This is the password for the old/current server, not the destination.',

  // ------------------------------------------------------- the guided move

  // The default flow: name the destination, confirm on the destination's own
  // page, come back and authorise here. Three screens, and the counter below
  // says which one you are on -- in a flow that deliberately sends somebody to
  // a second server and back, "how far along am I" is the question that stops
  // a forged middle step from passing unnoticed.
  'migration.guided.step': 'Step {current, number} of {total, number}',

  // Screen one. One sentence with the object selected rather than two keys,
  // because everything after the first clause is identical and a translator
  // splitting the difference across two entries would have to keep them in
  // step by hand. `guild` is the only branch tested; `other` covers the
  // account.
  'migration.guided.intro': '{subject, select, guild {Name the server you are moving this guild to.} other {Name the server you are moving to.}} Confirm on its page, then come back here to authorise with your password.',
  'migration.guided.continue': 'Continue on the new server',
  'migration.guided.opening': 'Opening…',
  'migration.guided.useCode': 'Use an import code',
  'migration.guided.lookingUp': 'Looking up {destination}…',
  'migration.guided.startFailed': 'Could not start the move: {reason}',

  // The destination answered, but publishes no client of its own to send the
  // person to. Not an error and not the destination's fault -- a headless or
  // API-only homeserver is a legitimate thing to be -- so this offers the
  // other route rather than refusing.
  'migration.guided.noClient': '{destination} does not publish a web page for receiving a move. You can still move there with an import code created on that server.',

  // Screen two: the destination's page is open in another window and this one
  // is waiting. `<b>` is the heading run; it names the server the reader
  // should now be looking at, because the whole risk of this step is
  // confirming on the wrong page.
  'migration.guided.finishThere': '<b>Finish on {destination}.</b> A window has opened on {destination}’s own page. Sign in, or {subject, select, guild {create the account that will own the guild there} other {create the account you are moving to}}, and confirm there.',
  // Read aloud by a live region as well as drawn, so it is a whole sentence.
  // "works once" and the expiry are both promises about the link's blast
  // radius and neither may be dropped.
  'migration.guided.waiting': 'Waiting for {destination} to confirm… This link works once and expires {expiresAt, relative}.',
  // `{url}` is the link with its fragment stripped -- the secret lives in the
  // fragment, so what is drawn is deliberately not the whole link. The `<a>`
  // carries the real one.
  'migration.guided.noWindow': 'If no window opened: <a>{url}</a>',
  'migration.guided.openAgain': 'Open it again',
  // The handoff died while this screen was waiting on it -- expired, or spent
  // by somebody else. `errors.migration_handoff_invalid` says the same thing
  // to the *destination* ("start again from the account you are leaving"),
  // which is the wrong instruction here: the reader is already on the account
  // they are leaving, and the fix is one button away.
  'migration.guided.linkExpired': 'That link has expired. Start again to get a new one.',

  // Screen three: the destination has confirmed and named the account that
  // will receive the move. One key, with the identifier tagged so it can be
  // drawn in a monospace run -- the reader is being asked to compare it
  // character by character with the account they just signed in to, which is
  // the one check that catches a hijacked handoff.
  //
  // The two branches differ in more than a noun: a guild moves *to a server*
  // and is *owned by* an account there, while an account moves *to an
  // account*. `{name}` is the guild's name (or its id when it has none) in the
  // guild branch and the account's own id in the other.
  'migration.guided.ready': '<b>{destination} is ready.</b> {subject, select, guild {This guild, {name}, will move to {destination}, owned there by <id>{target}</id>.} other {This account, {name}, will move to <id>{target}</id>.}} If that is not the account you just confirmed, cancel here.',
  // Load-bearing (see the header, promise 2). "any of your devices" is the
  // mechanism, not a figure of speech.
  'migration.guided.authorize': 'Re-enter your password to authorise it. Scheduling starts a cooling-off window in which any of your devices can cancel.',

  // ------------------------------------------- scheduling, and what it means

  'migration.schedule.action': 'Schedule the move',
  'migration.schedule.busy': 'Scheduling…',
  // Drawn under the form while the device signs the grant. Present tense and
  // specific about *which* device, because this is the step that requires a
  // key this browser holds and no other -- if it is going to fail, the reader
  // should already know the device was the thing being asked.
  'migration.schedule.signing': 'Signing this move with this device…',
  'migration.schedule.scheduling': 'Scheduling the move…',
  'migration.schedule.failed': 'Migration not started: {reason}',

  // Two local failures, neither of which is a server refusal. They are
  // translated here rather than through `errorMessage` because a thrown
  // `Error` carries no HTTP status and the ladder in `lib/i18n/errors.js`
  // reads a status of zero as a dead connection -- a missing signing key would
  // otherwise be reported as "check your connection", which sends somebody to
  // debug their wifi over a key that was never on this machine.
  'migration.schedule.noDeviceKey': 'This device has no stored signing key. Migration must be started from a device that already belongs to this account.',
  'migration.schedule.signFailed': 'This device could not sign the migration authorization.',

  // The last screen of both flows. `<b>` carries the correction the reader
  // most needs: "scheduled" and "completed" are the same word to somebody
  // skimming, and the difference between them is the entire cooling-off
  // window. "when you pressed Schedule" names the button
  // `migration.schedule.action` and must match whatever that says.
  'migration.scheduled.headline': '<b>The move is scheduled, not completed yet.</b> Nothing was deleted when you pressed Schedule. It will move to {destination} {at, relative} unless an active device cancels it first.',
  // "Settings → Account" is a path through this client's own interface; the
  // two words are the pane names and must match `common.settings` and
  // `common.account`. The arrow is a separator, not a word.
  'migration.scheduled.cancelHint': 'You can cancel during the cooling-off window from Settings → Account.',

  // ---------------------------------------------------- the import-code move

  // The fallback flow, for a destination with no page of its own and for
  // anybody who would rather carry the code by hand. It is two numbered steps
  // on one screen.
  //
  // `{step}` is a literal 1 and 2 and is a placeholder anyway, because a
  // numbered list is not written with ASCII digits in every script and a
  // translator should not have to know which digits this client can render.
  'migration.manual.step1': '{step, number}. Prepare the destination server.',
  'migration.manual.step1Where': 'Sign in on the server you want to move to, then open Settings → Account → Receive a move. It will create a one-time import code for this exact source.',
  // Which account to use over there. The distinction matters and is easy to
  // get wrong: a guild does not move "into" an account the way an account
  // does, it lands owned by one.
  'migration.manual.step1Which': 'For an account, use the destination account you created there. For a guild, use the account that should own it there.',
  'migration.manual.step2': '{step, number}. Authorize the move on this server.',
  'migration.manual.step2Password': 'Re-enter your current password below.',
  // Load-bearing (see the header, promise 2).
  'migration.manual.step2Cooling': 'Scheduling starts a cooling-off window. Any active device can cancel before the transfer executes.',
  'migration.manual.destinationHint': 'The server where you just created the import code.',
  'migration.manual.useGuided': 'Use the guided move',

  // The code itself. One key, because the sending screen labels the box the
  // code is typed into and the receiving screen labels the box it is read out
  // of, and they are the same object with the same name -- a reader carrying
  // it between two windows should see one word twice, not two words once.
  'migration.importCode.label': 'Import code',
  'migration.importCode.placeholder': 'one-time code from the destination',
  // "Only paste it into the move dialog on the old server" is the anti-
  // phishing line: an import code handed to anybody else is an invitation to
  // move an account they do not own into a server they do.
  'migration.importCode.hint': 'Single-use and short-lived. Only paste it into the move dialog on the old server.',
  'migration.importCode.sourceHint': 'Created by Settings → Account → Receive a move on the destination. It expires after seven days.',

  // ------------------------------------------------ the destination: a code

  'migration.receive.title': 'Receive a move',
  // `{destination}` is this server's own domain; `migration.receive.thisServer`
  // stands in when the session has not told us what it is yet, which is why it
  // is a noun phrase that fits the same slot rather than a sentence.
  'migration.receive.intro': '<b>You are preparing {destination} as the destination.</b> Nothing moves or is deleted by this step.',
  'migration.receive.thisServer': 'this server',
  'migration.receive.subject': 'What are you receiving?',
  'migration.receive.subjectAccount': 'An account',
  'migration.receive.subjectGuild': 'A guild',
  'migration.receive.accountIdHint': 'Your full ID on the old server, for example @you:old.example.',
  // An example identifier, not a sentence. `old.example` is a reserved name
  // (RFC 2606); leave the shape `@name:server` alone, since it is the shape
  // the field is checked against.
  'migration.receive.accountIdPlaceholder': '@you:old.example',
  'migration.receive.guildIdHint': 'Copy the guild ID exactly as shown on the old server.',
  'migration.receive.guildIdPlaceholder': 'guild ID from the old server',
  'migration.receive.sourcePlaceholder': 'old.example',
  // The account-id field fills this one in, so it is read-only and the hint
  // explains why it cannot be typed into rather than what to type.
  'migration.receive.sourceFromId': 'Read from the account id above.',
  'migration.receive.sourceGuildHint': 'The server that currently hosts the guild.',
  // Said before the code is created, because the ownership is decided by which
  // account is signed in *here* and there is no second chance to pick.
  'migration.receive.guildOwner': 'The moved guild will be owned here by the account you are signed in with.',
  'migration.receive.create': 'Create import code',
  'migration.receive.creating': 'Preparing…',
  'migration.receive.preparing': 'Checking the old server and creating a one-time import code…',
  'migration.receive.prepareFailed': 'Could not prepare this server: {reason}',
  'migration.receive.another': 'Create another code',

  // The code has been issued. Load-bearing (see the header, promise 1):
  // issuing a code looks like the end of the job and is the beginning of it.
  'migration.receive.ready': '<b>{destination} is ready to receive this move.</b> Nothing has moved yet.',
  'migration.receive.nextTitle': 'Now go back to the old server.',
  'migration.receive.nextUse': 'In its move dialog, use {destination} as the destination server and paste the import code above.',
  // What this code is *for*. A code is bound to one source account on one
  // source server, and showing both is what lets somebody notice they prepared
  // the wrong one before they carry it across.
  'migration.receive.approvalFor': 'This approval is for {subjectId} from {source}.',
  // Both an absolute date and a relative one, deliberately: the absolute date
  // is the one a person writes down, the relative one is the one that tells
  // them whether to hurry.
  'migration.receive.expires': 'It expires {expiresAt, date, medium} ({expiresAt, relative}).',

  // -------------------------------------- the destination: a guided handoff

  // The same dialog reached from a link the old server generated. There is no
  // code to show here: once this is confirmed, this server hands the claim to
  // the old server itself.

  // The link names a destination that is not the server this session is on.
  // Refused rather than attempted -- the old server would refuse it anyway,
  // and "Nothing was sent" is the part the reader needs, because a link that
  // opened somewhere unexpected is exactly what a phishing attempt looks like.
  // `{here}` is the server actually signed in to; `migration.confirm.anotherServer`
  // fills the slot when even that is unknown.
  'migration.confirm.wrongServer': '<b>This link is for moving {subject, select, guild {a guild} other {an account}} to {destination}.</b> You are signed in on {here}. Sign out, then sign in or register on {destination} and open the link again. Nothing was sent.',
  'migration.confirm.anotherServer': 'another server',

  // The ask. `{guild}` is `migration.confirm.guildNamed` when the link carried
  // a name and the bare id otherwise -- the name came in the link and nobody
  // checked it, so the id is always shown beside it.
  'migration.confirm.guild': '<b>Receive the guild {guild} from {source}?</b> It would be owned here by {me}. The move still has to be authorised on {source} by the guild’s owner.',
  // Quotation marks are punctuation and belong to the language: German writes
  // „so“ and French « so ». Change them to whatever this language uses; keep
  // the id in its brackets beside the name.
  'migration.confirm.guildNamed': '“{name}” ({id})',
  'migration.confirm.account': '<b>Move {subjectId} into {me}?</b> The move still has to be authorised on {source} with that account’s password.',
  'migration.confirm.thisAccount': 'this account',
  // The refusal path, spelled out because this screen can be reached by
  // following a link somebody else sent. "Not now" names the button
  // `migration.confirm.notNow` and must match it word for word, or the
  // instruction points at nothing.
  'migration.confirm.notYou': 'If you did not just start moving {subject, select, guild {a guild} other {an account}} from {source}, choose Not now. Nothing is sent unless you confirm.',
  'migration.confirm.notNow': 'Not now',
  // One key with a select rather than two, so a translator sees both buttons
  // of the same pair at once. This is the accessible name of the button as
  // well as its face.
  'migration.confirm.receive': '{subject, select, guild {Receive this guild} other {Receive this account}}',
  'migration.confirm.confirming': 'Confirming…',
  'migration.confirm.sending': 'Sending the confirmation to {source}…',
  'migration.confirm.failed': 'Could not confirm this move: {reason}',

  // Confirmed. Load-bearing (see the header, promise 1): this is the screen
  // somebody is most likely to read as "done", and it is the middle of the
  // protocol -- the old server has not been authorised yet and will ask for a
  // password before anything is scheduled. The second half is a direction, not
  // a status: go back to the other window.
  'migration.confirm.done': '<b>{source} has been told this {subject, select, guild {guild} other {account}} is ready.</b> Nothing has moved yet. Go back to the window where you started the move: {source} will show {target} {subject, select, guild {as the guild’s new owner} other {as the destination}} and ask for your password there before the cooling-off window begins.',
};
