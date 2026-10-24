// The screens where somebody decides whether they are being attacked.
//
// Four surfaces, one subject: the trusted-link list, two-factor authentication,
// the device list, and the emoji verification dialog. They are one namespace
// because they are one question asked four ways -- is anything here not me? --
// and because a translator who has the device list's vocabulary in their head
// is the right person to be holding the verification dialog's.
//
// ------------------------------------------------- how to translate this file
//
// Every string in here is security copy, which means a looser translation is
// not a stylistic choice, it is a change to what the reader will decide. Three
// rules, and they override the usual instinct to make a sentence read nicely.
//
//   * **Never soften a warning and never invent one.** If the English says an
//     unverified device *can still read what you send*, a translation that says
//     it *might* be able to has told the reader the risk is hypothetical. And
//     the reverse: a sentence that adds alarm the English did not have teaches
//     people to ignore the ones that matter.
//
//   * **"Verified" is a term of art here and has exactly one meaning:** your
//     own account key has signed for that device. It is not "trusted", not
//     "confirmed", not "checked". Whatever word a language picks, it must be
//     the same word in `security.devices.*`, in `security.verify.*` and in the
//     encryption pane, because the badge on the row and the sentence in the
//     dialog are claims about the same fact and a reader who sees two words
//     will reasonably assume two facts.
//
//   * **Do not translate what is on the other person's screen.** The emoji
//     names in a verification are read aloud down a telephone by two people
//     who may not be using the same language; the safety material itself --
//     device names, key fingerprints, recovery codes, the authenticator secret
//     -- is data and is never translated and never reformatted. See the note
//     over `security.codes.*` for why reformatting is the dangerous half.
//
// ------------------------------------------------------------- what is a value
//
// Anything in braces here is a value the code supplies, and in this namespace
// the values are almost all *identifiers somebody has to compare against
// something else*: `{device}` is a device name the account holder chose,
// `{name}` is a username, `{domain}` is a hostname, `{reason}` is a sentence
// this client or the server already produced. None of them are translated.
// Move them wherever the grammar wants them; do not spell them differently.
//
// ---------------------------------------------------------- what is NOT in here
//
// Refusals. `reauth_required`, `reauth_expired`, `invalid_credentials`,
// `mfa_required`, `invalid_mfa_code` and the rest are server codes and their
// sentences live in `errors.js`, where every screen that can provoke them
// shares one wording. The keys below that end in `Failed` are the *context*
// around such a sentence, used only when the failure carried no code at all --
// see the comment over `security.mfa.setupFailed`.

export const security = {
  // ----------------------------------------------------------- trusted links

  'security.trustedLinks.title': 'Trusted links',
  // "your servers" means the homeservers and guild servers this account is on,
  // not servers the reader owns. If a language's word for server carries the
  // ownership too strongly, prefer a phrasing closer to "the servers you are
  // on": the distinction the sentence is drawing is between links inside
  // Telium and links out of it.
  'security.trustedLinks.description': 'Links to these domains open without asking. Everything else outside your servers is confirmed first.',
  // The accessible name and tooltip of the × beside one domain. `{domain}` is
  // a hostname -- never translated, never transliterated, and never given
  // localised digits, because the reader is matching it against what they will
  // see in the address bar. Phrased as what pressing it turns back *on* rather
  // than as "remove" or "forget": the list is a list of questions that are no
  // longer asked, and the undo is that the question comes back.
  'security.trustedLinks.forget': 'Ask again about {domain}',
  'security.trustedLinks.empty': 'You have not trusted any domains yet.',

  // -------------------------------------------------- two-factor authentication
  //
  // The section is named in full -- "two-factor authentication" -- and not as
  // "2FA" or "MFA" anywhere a reader can see. The acronyms are English
  // engineering shorthand; they are meaningless to somebody who has not met
  // them and they cannot be translated at all, so a catalogue that used them
  // would be handing every other language a word it has to leave in English.

  'security.mfa.title': 'Two-factor authentication',
  // "6-digit" and "TOTP" both name the protocol rather than this app: the
  // reader is being told which of the apps on their phone will work. TOTP is a
  // standard's name and stays as it is; the "6" may be written as a word where
  // that reads better.
  'security.mfa.appHint': 'Use any standard 6-digit TOTP authenticator app.',

  // The state line, with the number of unused recovery codes in it.
  //
  // One key and not two because the count changes which sentence is true, not
  // only which noun ending it takes. `=0` is the case that matters: an account
  // with two-factor authentication on and no recovery codes left is one lost
  // phone away from being locked out permanently, and saying "0 recovery codes
  // remain" in a green box is the interface calmly reporting a trap. So the
  // zero arm says what the consequence is, and the component paints the notice
  // as a warning rather than a success when it fires.
  'security.mfa.enabled': '{remaining, plural, =0 {Two-factor authentication is on, and you have no recovery codes left. If you lose your authenticator you will not be able to sign in — turn two-factor authentication off and set it up again to get a new set.} one {Two-factor authentication is on. # recovery code is left.} other {Two-factor authentication is on. # recovery codes remain.}}',

  // The same line when the homeserver did not say how many codes are left --
  // an older federated homeserver whose `mfa_status` predates the field. It
  // says less rather than guessing, because the guess `0` would be the arm
  // above: an account in perfectly good shape told it is one lost phone from
  // being locked out. A warning that is sometimes invented is a warning people
  // learn to skip.
  'security.mfa.enabledNoCount': 'Two-factor authentication is on.',

  // The field accepts either kind of code, and saying so is the whole point of
  // the label: somebody whose phone is gone needs to know the box in front of
  // them will take the paper code they kept for exactly this.
  'security.mfa.codeLabel': 'Authenticator or recovery code',
  'security.mfa.disable': 'Turn two-factor authentication off',
  'security.mfa.disabledToast': 'Two-factor authentication is off.',
  'security.mfa.enabledToast': 'Two-factor authentication is on.',

  // Shown between scanning and confirming. The second sentence exists because
  // people close this screen after the scan, assuming the scan was the act --
  // and an authenticator holding a secret the server has not yet committed to
  // is an authenticator that will produce correct-looking codes for an account
  // that does not want them. Do not drop it for length.
  'security.mfa.scanWarning': 'Scan this QR code, then enter the code it shows. Two-factor authentication is not on until that succeeds.',
  // The accessible name of the QR image. Named as what it is for, because
  // "QR code" alone tells a screen-reader user nothing about whether they can
  // skip it -- and they can: the manual key below is the same secret.
  'security.mfa.qrLabel': 'QR code for setting up your authenticator app',
  'security.mfa.manualLabel': 'Manual setup key',
  'security.mfa.manualHint': 'Use this only if your authenticator cannot scan the QR code.',
  'security.mfa.codeFieldLabel': '6-digit code',
  'security.mfa.verifyEnable': 'Verify and turn on',
  'security.mfa.setUp': 'Set up authenticator',

  // The hint under the password box before setup starts.
  //
  // "not sent" is load-bearing and is literally true on an OPAQUE homeserver:
  // the password is used to compute a proof locally and the password itself
  // never reaches the network. A translation that weakens this to "is not
  // stored" or "is kept private" is describing a different and much weaker
  // guarantee. If a language cannot carry "checked here, not sent" in one
  // clause, split it into two sentences rather than blurring it.
  'security.mfa.reauthHint': 'Re-enter your password. It is checked on this device and not sent.',
  'security.mfa.whyPasswordTitle': 'Why the password is asked for again',
  'security.mfa.whyPasswordBody': 'On an OPAQUE homeserver your password never leaves this device. Typing it here produces a one-use proof that you are the account holder, which is what authorises the change.',

  // The three context lines for a failure that arrived with no machine code.
  //
  // A coded refusal already has a finished sentence in `errors.js` and is shown
  // on its own -- "That code is not right. Codes expire after about a minute"
  // needs no preamble, and a preamble would bury the only actionable half. What
  // these cover is the uncoded case: a dropped connection during any of the
  // three requests produces the same "Telium could not reach the server", and
  // without the context the reader cannot tell whether two-factor
  // authentication is now on, off, or unchanged. `{reason}` holds that
  // sentence; it is already translated when it came from the catalogue and is
  // the server's own English when it did not.
  'security.mfa.setupFailed': 'Two-factor setup could not be started. {reason}',
  'security.mfa.enableFailed': 'Two-factor authentication could not be turned on. {reason}',
  'security.mfa.disableFailed': 'Two-factor authentication could not be turned off. {reason}',

  // ------------------------------------------------------------ recovery codes

  'security.codes.title': 'Recovery codes',
  // `<b>` is the first sentence, emphasised. One key rather than two so the
  // emphasis can land on whichever clause carries the instruction in the target
  // language -- in English that is the imperative at the front, and it is not
  // the front everywhere.
  'security.codes.warning': '<b>Write these down before you go on.</b> Each one works once, and they are not shown again.',
  // The accessible name of the list. A count, so it is pluralised; the codes
  // themselves are inside it, one element each, so a screen reader reads eight
  // codes rather than one seventy-character word.
  'security.codes.listLabel': '{count, plural, one {# recovery code} other {# recovery codes}}',
  'security.codes.copy': 'Copy them',
  'security.codes.download': 'Download them as a file',
  // What the "copied" toast calls them. A noun phrase and not a sentence,
  // because `copyToClipboard` puts it in front of the word "copied" -- which is
  // a fragment this namespace cannot fix from here; see the report note on
  // `lib/clipboard.js`.
  'security.codes.clipboardName': 'Recovery codes',
  // The first line of the downloaded text file, which is what somebody finds in
  // their downloads folder in a year. Translated, because they will be reading
  // it in their own language; the codes under it are not, because they are the
  // secret.
  'security.codes.fileHeading': 'Telium two-factor recovery codes',

  // ---------------------------------------------------------------- devices
  //
  // The verdict at the top answers one question -- is anything signed in that
  // I do not recognise? -- and the four keys below are the four answers it can
  // give. They are separate keys rather than one `select` because they are
  // different sentences with different subjects, and because the component
  // picks between them on facts (nothing known yet, none unverified, all
  // unverified, some unverified) that a translator should not have to
  // reconstruct from a pair of numbers.

  'security.devices.checking': 'Checking your devices.',
  'security.devices.allVerified': '{count, plural, one {Your device is verified.} other {All # of your devices are verified.}}',
  'security.devices.noneVerified': '{count, plural, one {Your device is not verified yet.} other {None of your # devices are verified yet.}}',
  // Only used when some but not all are unverified, which is why `{total}` is
  // pluralised separately and is always at least two: "2 of your 5 devices".
  // The nested plural is not decoration -- Russian needs the paucal form of
  // "device" after 2, 3 and 4 and the plural after 5, and the outer count says
  // nothing about which one `{total}` needs.
  'security.devices.someUnverified': '{count, plural, one {# of your {total, plural, one {# device} other {# devices}} is not verified yet.} other {# of your {total, plural, one {# device} other {# devices}} are not verified yet.}}',

  // The note under the verdict. "can still read what you send" is a statement
  // of fact about how the encryption works and must not be softened into a
  // possibility: an unverified device that holds the account's keys decrypts
  // everything the verified ones do. The second sentence says what verifying
  // buys, which is the only reason anybody does it.
  'security.devices.unverifiedNote': 'An unverified device can still read what you send. Verifying it is how you check it is yours and not somebody claiming to be you.',
  'security.devices.recogniseNote': 'Sign out anything you do not recognise.',
  // `{pane}` is another pane in these settings, named by its own title
  // (`settings.nav.recovery`) rather than spelled out here. Spelled out, the
  // two could drift apart in a language and this sentence would be sending the
  // reader to something that is not on their screen under that name; handed in
  // as a placeholder, they cannot. Move it where the sentence wants it.
  'security.devices.cannotSign': 'This device cannot sign for your account yet. Verify it from a device you already use, or unlock your messages under {pane}.',

  'security.devices.empty': 'No devices recorded.',
  // The accessible name of the list itself, announced before the rows.
  'security.devices.tableLabel': 'Devices signed in to your account',
  // Column headers. Kept apart from `common.device` and from the sentences
  // above deliberately: these are labels in a narrow column and beside a value
  // on a phone ("Last seen 2 hr. ago"), so a language that would use a full
  // noun phrase in prose wants the short form here.
  'security.devices.colDevice': 'Device',
  'security.devices.colAdded': 'Added',
  'security.devices.colLastSeen': 'Last seen',
  // The two timestamps, as patterns rather than as formatter calls in the
  // component, so a language that wants a different precision in a table cell
  // can have it without a code change. `{at}` is a number of milliseconds.
  // "Added" is absolute because it is a fact you check against your memory of
  // buying a laptop; "last seen" is relative because the only thing anybody
  // wants from it is how long ago.
  'security.devices.addedAt': '{at, date, medium}',
  'security.devices.lastSeenAt': '{at, relative}',

  // Badges on a row. Lower case on purpose: they sit inline after the device's
  // own name and are read as part of it, not as headings. Keep them to one or
  // two words -- the row wraps, but a badge that takes a whole line stops being
  // a badge.
  'security.devices.thisDevice': 'this device',
  'security.devices.signedOut': 'signed out',
  'security.devices.verifiedBadge': 'verified',
  'security.devices.unverifiedBadge': 'unverified',

  // The visible button label is one word because the column is narrow; the
  // accessible name is the whole phrase, because a screen reader otherwise
  // meets six buttons all called "Verify" and cannot tell them apart.
  // `{device}` is the name the account holder gave the device, or its
  // identifier if they gave it none. Data: never translated.
  'security.devices.verify': 'Verify',
  'security.devices.verifyDevice': 'Verify {device}',
  'security.devices.signOut': 'Sign out',
  'security.devices.signOutDevice': 'Sign out {device}',
  // Same shape and same reason as `security.mfa.setupFailed`: only used when
  // the refusal carried no code of its own.
  'security.devices.signOutFailed': 'That device could not be signed out. {reason}',

  // "a few minutes, not seconds" is a promise about the worst case and is there
  // to stop somebody pressing the button again, or concluding it failed,
  // while a revocation propagates. Do not round it down.
  'security.devices.revokeHint': 'Signing a device out takes a few minutes to take effect, not seconds.',
  'security.devices.whatVerifiedTitle': 'What verified means here',
  // The distinction in the last clause -- your account made this claim, not the
  // operator -- is the entire content of the badge. If it survives nothing else
  // in this paragraph, it has to survive.
  'security.devices.whatVerifiedBody': 'A verified device is one your own account key has signed for. Your server keeps this list, but it cannot forge those signatures, so the badge is a claim your account made rather than one the operator made.',
  'security.devices.revocationTitle': 'Revocation',
  'security.devices.revocationBody': 'Signing a device out revokes its credential at your home server. Anything already delivered to it stays delivered.',

  // ------------------------------------------------------ emoji verification
  //
  // Two people, or one person and their other device, comparing pictures. The
  // dialog says almost everything twice -- once for "this is my own other
  // device" and once for "this is somebody else" -- and those are separate keys
  // rather than one `select` on a flag, because they are not the same sentence
  // with a different noun in it: one of them is about a thing you own and the
  // other is about a person you are talking to, and several languages inflect
  // the verb differently for the two.

  'security.verify.titleSelf': 'Verify your other device',
  // `{name}` is the local part of a user id -- a username the reader typed or
  // clicked. Never translated.
  'security.verify.titlePeer': 'Verify {name}',
  'security.verify.starting': 'Starting…',
  // On the primary button while the other side has not answered. A gerund, not
  // an imperative: nothing is being asked of the reader here.
  'security.verify.waitingButton': 'Waiting',
  'security.verify.noMatch': 'They don’t match',
  'security.verify.match': 'They match',

  'security.verify.waitingSelf': 'Waiting for your other device…',
  'security.verify.waitingPeer': 'Waiting for {name} to open Telium…',
  'security.verify.pendingHintSelf': 'Open Telium there; both have to be online at once.',
  // "their whole account" and not "their device": one verification covers every
  // device that account has or will have, which is the fact that makes doing
  // this once worth the interruption.
  'security.verify.pendingHintPeer': 'Whichever device answers, this covers their whole account.',

  // `{count}` is how many pictures are on the screen -- seven, from the
  // protocol -- and it is a count rather than a literal so the sentence cannot
  // drift from the grid under it and so the numeral is drawn in the reader's
  // own digits. "in this order" is not optional: two devices showing the same
  // seven pictures in different orders is exactly what a relay attack looks
  // like from here.
  'security.verify.compareSelf': '{count, plural, one {Both devices should show this picture.} other {Both devices should show these #, in this order.}}',
  'security.verify.comparePeer': 'Compare these with {name} in person or on a call.',
  // "in person or on a call" is the security-relevant half: comparing them by
  // sending them through Telium itself proves nothing, because that is the
  // channel under suspicion. Keep the two options and keep them concrete.
  //
  // "something is sitting in between" is deliberately not "an attack is in
  // progress". It is the true and smaller claim -- the pictures differ because
  // the two ends do not share a key -- and it is the one a reader acts on
  // correctly whether the cause is an attacker or a bug.
  'security.verify.mismatchHint': 'If they differ, something is sitting in between.',

  'security.verify.confirmingSelf': 'Waiting for your other device to confirm…',
  'security.verify.confirmingPeer': 'Waiting for {name} to confirm…',
  'security.verify.doneSelf': 'That device is verified. Anyone who has verified you sees it too.',
  'security.verify.donePeer': '{name} is verified on all of your devices, including any device they add later.',

  // Two endings, and the difference matters to the reader.
  //
  // `stoppedByYou` is the one this reader caused by pressing "They don’t
  // match". It gets its own sentence because it is the only cancellation that
  // is also a finding: the second clause exists so that nobody reads a stopped
  // verification as a verified one.
  //
  // `stopped` covers everything else -- a timeout, the other side closing the
  // dialog, a key that did not check out. `{reason}` is a phrase produced by
  // `lib/verify.js` or forwarded from the other device, and it is *not*
  // translated: there is no code to translate it by, and an English phrase that
  // says what happened beats a translated one that says nothing. Treat it the
  // way `errors.js` treats a server's own `message`.
  'security.verify.stoppedByYou': 'Verification stopped because the pictures did not match. That device is still unverified.',
  'security.verify.stopped': 'Verification stopped: {reason}.',
  // The context line for a failure with no code, same as the `*Failed` keys
  // above. A verification that half-finished leaves nothing verified, which is
  // why this says "could not be finished" rather than "failed".
  'security.verify.finishFailed': 'Verification could not be finished. {reason}',
  // Shown when the handshake could not be started at all -- usually because the
  // other device is not reachable.
  'security.verify.startFailed': 'Verification could not be started. {reason}',
};
