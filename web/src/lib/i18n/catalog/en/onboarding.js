// The words somebody reads before they have an account.
//
// Two screens live in here and they are the only two screens in this client
// with no signed-in reader behind them: the invite landing (`views/
// InviteLanding.jsx`), which is what a link handed out by a guild opens, and
// the account-home picker (`views/AccountHomePicker.jsx`), which is the one
// question a federated network has to ask that a centralised one does not.
// The chip in `views/AccountHome.jsx` is the picker's quiet form and is here
// too, because it answers the same question.
//
// ------------------------------------------------- who is speaking, and to whom
//
// Nobody here has used Telium before. That is the single fact that should
// decide every word in this file, and it rules out three habits the rest of
// the catalogue is allowed:
//
//   * **No vocabulary the reader has not been given.** "Homeserver",
//     "federation", "guild" and "account id" are all load-bearing concepts on
//     these two screens and none of them can be assumed. Where a term has to
//     appear, the sentence around it says what it means -- which is why
//     `onboarding.home.explainer` is a definition and not a label.
//
//   * **No apology for the architecture.** A person who followed a link to
//     join a community did not ask to be taught about distributed hosting.
//     Every sentence about where the account goes is written as a statement of
//     what will happen, in one line, with a way to change it beside it. The
//     long version is `onboarding.home.selectionNote` and it comes *after* the
//     answer, never before it.
//
//   * **No second person plural or formal register games.** English cannot
//     express the difference; most of the languages this will be translated
//     into can, and every one of these strings is addressed to one stranger
//     who is being welcomed. Translators should use whatever their language
//     uses for a shop greeting a customer, not what it uses for a contract.
//
// ------------------------------------------------------ what is not translated
//
// Guild names, guild descriptions, inviter names, operator names, region
// labels and every hostname are the operator's or the user's, not ours. They
// arrive as placeholders -- `{guild}`, `{name}`, `{operator}`, `{domain}`,
// `{host}` -- and the sentence around them is what this file owns. A
// translator moves the placeholder wherever the grammar wants it and never
// touches what is inside it.
//
// ------------------------------------------------------------------- errors
//
// Almost none. Everything the server or the session store can refuse with
// already has a sentence in `errors.js` and reaches these screens through
// `errorMessage()`; the handful of keys below that look like errors are the
// ones this client decides on its own and could not express as a code -- see
// the comments on each.

export const onboarding = {
  // ====================================================== the invite landing

  // ------------------------------------------------------- opening the link

  // The first paint, before the guild server has said what the code is for.
  // Two lines rather than a spinner alone: an invite link is the one URL in
  // this app a person is likely to have been sent by somebody they do not
  // entirely trust, and naming what is being asked of whom is worth the
  // second line.
  'onboarding.invite.opening': 'Opening invite…',
  'onboarding.invite.openingHint': 'Asking this guild’s server what the link opens.',

  // A 404 from the preview. Split from the generic failure because it is the
  // one case where this client knows the answer -- the link is dead, nothing
  // is broken, and trying again will not help -- and a person who was sent a
  // stale link should not be left wondering whether their connection is at
  // fault. The heading states it and the body lists the three ways a link
  // dies, in the order they actually happen.
  'onboarding.invite.expiredTitle': 'This invite is no longer valid',
  'onboarding.invite.expiredBody': 'It may have expired, reached its use limit, or been revoked.',

  // Anything else: the guild server did not answer, answered with something
  // this client could not read, or refused for a reason it did explain. The
  // heading is deliberately about the invite rather than about the server,
  // because "could not open this invite" is what the reader was trying to do
  // and "the server returned 503" is not. The body is the server's own
  // sentence where there is one; `unreachable` is the fallback when there is
  // not.
  'onboarding.invite.unopenableTitle': 'Could not open this invite',
  'onboarding.invite.unreachable': 'The guild server could not be reached.',
  // The way out of a dead end. Goes to this deployment's root, so it is the
  // name of the product rather than the name of the server.
  'onboarding.invite.goToTelium': 'Go to Telium',
  // The same way out on desktop, where an invite is not a page of its own but
  // a link pasted into the sign-in screen, so leaving goes back to that screen.
  // Also offered under a live invite there, for somebody who pasted the wrong
  // link or would rather just sign in.
  'onboarding.invite.backToSignIn': 'Back to sign in',

  // --------------------------------------------------------- the invitation

  // The line above the guild's name, so it reads as one sentence with the
  // heading underneath: "alice invited you to join" / "Telium". Which means
  // the phrase has to end where a name can follow it, and a language that
  // puts the object before the verb needs to be free to reorder the whole
  // thing -- there is nothing this file can do about the heading being a
  // separate element, so a translator who cannot make it work should write a
  // standalone line and let the name below it stand as a caption.
  //
  // `{name}` is the inviter's short name (the local part of their account id),
  // not their full id: `@alice:home.example` reads as an address and this is
  // a sentence about a person.
  'onboarding.invite.invitedBy': '{name} invited you to join',
  // The same line when the invite carries no inviter -- a vanity link, or one
  // made by somebody whose account has since gone. Not "somebody invited
  // you": nobody may have, and a guess here is a guess about who the reader
  // should trust.
  'onboarding.invite.invited': 'You were invited to join',

  // The two counts under the guild's name. Both go through `plural` even
  // though English inflects only one of them: a language with a `one`
  // category needs that arm to exist for the message to be well formed, and
  // several languages do inflect the word beside "online". `#` is the count
  // formatted for the reader's locale, which is the whole reason these are
  // not built with `toLocaleString()` at the call site.
  'onboarding.invite.online': '{count, plural, one {# online} other {# online}}',
  'onboarding.invite.members': '{count, plural, one {# member} other {# members}}',

  // ------------------------------------------ joining with an account you have

  // Shown to somebody already signed in, so the only question left is which
  // account is about to walk through the door. `{name}` is their display name
  // where they have one and their account id where they do not, which is why
  // the sentence has to work with both -- "Joining as Alice." and "Joining as
  // @alice:home.example." are both it.
  'onboarding.invite.joiningAs': 'Joining as {name}.',
  // The same slot when the session exists but nothing about the profile has
  // loaded yet. Says the thing that matters -- there is nothing left to set
  // up -- without naming somebody it cannot name.
  'onboarding.invite.accountReady': 'Your account is ready.',

  // A guild with screening on: the account was created, the join was
  // accepted, and membership is now somebody else's decision. Drawn in the
  // warning tone rather than the danger one, and the first half says so
  // explicitly, because everything the reader was asked to do did work and an
  // error-coloured box would say otherwise.
  'onboarding.invite.screeningPending': 'Your account is ready. This guild requires screening before you become a member.',

  'onboarding.invite.join': 'Join {guild}',
  'onboarding.invite.joining': 'Joining…',
  // Signs out and returns to the form. Not "Sign out": the reader is not
  // trying to leave, they are trying to arrive as somebody else, and naming
  // the destination rather than the act is what makes that clear.
  'onboarding.invite.useAnotherAccount': 'Use a different account',
  // Last resort when the join failed with nothing this client can translate
  // and nothing the server explained. Reached through `errorMessage`'s
  // `fallbackKey`, so by the time it is on screen every better sentence has
  // already been tried.
  'onboarding.invite.joinFailed': 'Could not join this guild.',

  // ------------------------------------------------------------- the form

  // The name other members will see. Asked first and asked plainly, because
  // it is the only field on this form whose answer is visible to anyone else
  // and the only one a person might want to think about. The hint exists to
  // stop them thinking about it.
  'onboarding.invite.displayNameLabel': 'Display name',
  'onboarding.invite.displayNamePlaceholder': 'What should everyone call you?',
  'onboarding.invite.displayNameHint': 'You can change this later.',

  // Registering asks for a username; signing in accepts either a username or
  // a full account id, because somebody with accounts on two homeservers can
  // only be unambiguous with the id. Two labels rather than one that covers
  // both, since "Username or account id" in front of a person creating their
  // first account is two things to decide between where there is only one.
  //
  // `common.username` covers the register-mode label; this is the other one.
  'onboarding.invite.accountIdLabel': 'Username or account id',
  'onboarding.invite.usernamePlaceholder': 'yourname',
  // A worked example, and the only place on this screen the shape of an
  // account id is shown. `home.example` is the reserved example domain and
  // should stay as it is; `yourname` is a word and should be translated.
  'onboarding.invite.accountIdPlaceholder': 'yourname or @you:home.example',
  // Said once, here, rather than in a paragraph about federation. "The first
  // part" is deliberately vague about the rest of it: the homeserver half is
  // decided by the field further down and explaining both at once is what the
  // old copy did.
  'onboarding.invite.usernameHint': 'This becomes the first part of your Telium account id.',

  // The second factor, asked for only after a server has said it needs one.
  // The label names the thing; the placeholder shows both accepted shapes,
  // because a recovery code is what somebody reaches for at exactly the
  // moment they cannot get at their authenticator.
  'onboarding.invite.mfaLabel': 'Authentication code',
  'onboarding.invite.mfaPlaceholder': '123456 or recovery code',
  // Not `errors.mfa_required`. That one is an error -- something was refused
  // -- and this is an instruction: nothing has gone wrong, the form has just
  // grown a field. It also names recovery codes, which is the thing worth
  // saying to somebody who has lost their phone and is reading this on it.
  'onboarding.invite.mfaPrompt': 'Enter the six-digit authenticator code or one of your recovery codes.',

  // --------------------------------------------- where the new account lives

  // The label on the typed-address field, on both this screen and the picker.
  // Two words, not "Homeserver": `common.homeserver` is the term of art and
  // is right in settings, where the reader has already met it. On the way in
  // it is a server that is your home, which is a thing a stranger can picture.
  'onboarding.home.label': 'Home server',
  'onboarding.invite.homePlaceholder': 'home.example',

  // Under the chip, when the account is going to the server that served this
  // invite. The second sentence is the one that earns the line: somebody who
  // sees a server named next to an invitation reasonably wonders whether
  // changing it will break the invitation, and the answer is no.
  'onboarding.invite.homeHint': 'Where your new account will live. Changing it does not change the invitation.',
  // The same field, once it has been opened for typing. Two hints rather than
  // one because the tense is different and the stakes are different:
  // registering decides where an account will be made, signing in has to
  // match where one already is, and a person who types the wrong thing gets a
  // different failure in each case.
  'onboarding.invite.newHomeHint': 'The server your new Telium account will belong to.',
  'onboarding.invite.existingHomeHint': 'The server where your existing Telium account lives.',

  // ------------------------------------------------------ what this client refuses

  // Three refusals this client makes before anything reaches the wire, so
  // there is no server code to translate them by and they live here rather
  // than in `errors.js`. All three are phrased as the missing step and not as
  // a mistake -- nothing has been submitted yet, so nobody has done anything
  // wrong.
  'onboarding.invite.needHome': 'Choose a home server for your account.',
  'onboarding.invite.needDisplayName': 'Choose the display name people in the guild should see.',
  'onboarding.invite.needCredentials': 'Enter your username and password.',

  // Two answers a homeserver can give that are judgements about the *server*
  // rather than refusals of a request: it answered, it is a Telium server, and
  // it does not do this. `{name}` is the server's own name for itself where it
  // published one and its hostname otherwise, so the sentence has to read with
  // either -- "Example Chat does not host user accounts." and "home.example
  // does not host user accounts." are both it.
  //
  // `errors.registration_closed` says nearly the same thing as the second of
  // these and is deliberately not reused: it is the server refusing a
  // registration that was actually attempted, where this is this client
  // declining to attempt one, and the difference matters when the reader is
  // choosing between several servers rather than fixing one.
  'onboarding.invite.noIdentityRole': '{name} does not host user accounts.',
  'onboarding.invite.registrationClosed': '{name} is not accepting new accounts.',

  // ------------------------------------------------------- legacy password auth

  // Both are one key with the emphasis inside it rather than a bold heading
  // and a body as two keys. They are two sentences of one paragraph: the
  // first says what kind of thing is about to happen and the second says what
  // it costs, and a translator who cannot see them together cannot get the
  // register right. `<b>` is the emphasis; the tag name is arbitrary and the
  // component map in `InviteLanding.jsx` turns it into a `<strong>`.
  //
  // The distinction between them is whose fault the weakness is. `upgrade` is
  // this reader's own account being old, the exposure is one-time, and there
  // is a genuine reason to go ahead. `server` is the homeserver being old,
  // the exposure is every sign-in from now on, and the right answer is
  // usually no -- which is why that one ends on trust and the other does not.
  //
  // Neither may be softened in translation. The literal claim -- your
  // password will be sent to this server -- is the whole point of showing the
  // notice, and a version that says "less secure" without saying what happens
  // is a version that nobody will read carefully enough.
  'onboarding.invite.legacyUpgrade': '<b>This old account needs a one-time security upgrade.</b> This attempt only, the server will receive your password. Later sign-ins will not.',
  'onboarding.invite.legacyServer': '<b>This homeserver uses legacy password authentication.</b> Continuing sends your password to this server. Only do this if you trust it.',

  // The button inside that notice. Three, because the act is three different
  // acts: repairing an account, making one the old way, and signing in to one
  // the old way. Every one of them names what it does rather than saying
  // "Continue", since this is the press that discloses the password and a
  // vague verb on it would be a dark pattern.
  'onboarding.invite.legacyUpgradeAction': 'Upgrade this account',
  'onboarding.invite.legacyRegisterAction': 'Use legacy registration',
  'onboarding.invite.legacySignInAction': 'Use legacy sign-in',

  // ------------------------------------------------------------ submitting

  'onboarding.invite.creating': 'Creating account…',
  'onboarding.invite.signingIn': 'Signing in…',
  // The two labels on the one button that finishes this screen. Both name the
  // guild, because the reason this person is filling in a form at all is the
  // guild and the button should say what they get rather than what the form
  // does. `{guild}` is the guild's own name and may be long -- the button
  // wraps rather than clips, see the note at the call site.
  'onboarding.invite.createAndJoin': 'Create account & join {guild}',
  'onboarding.invite.signInAndJoin': 'Sign in & join {guild}',
  // Last resorts, reached only when nothing in the failure could be
  // translated and the server explained nothing.
  'onboarding.invite.createFailed': 'Could not create your account.',
  'onboarding.invite.signInFailed': 'Could not sign in.',

  // The switch between registering and signing in, under the form. One key
  // each including the link, because "Already have a Telium account?" and
  // "Sign in" are a question and its answer and the order of the two is a
  // fact about English -- a language that fronts the verb needs to be able to
  // put the link first. `<a>` is a button in the markup, not a link; the tag
  // name is the catalogue's, not the DOM's.
  'onboarding.invite.haveAccount': 'Already have a Telium account? <a>Sign in</a>',
  'onboarding.invite.needAccount': 'Need a Telium account? <a>Create one</a>',

  // The footnote at the bottom of every state of this screen, and the one
  // sentence on it that explains the whole architecture. It is placed last
  // and set small on purpose: it answers a question most people will not ask,
  // and the ones who do ask it are looking for exactly this.
  //
  // `{domain}` is the host of the guild's server. The emphasis is on the
  // domain because the sentence is about that server specifically, and the
  // second half is about servers in general.
  'onboarding.invite.hostNote': '<b>{domain}</b> hosts this guild. Your account can live on a different Telium server.',

  // ================================================= the recovery key handover

  // Shown once, immediately after an account is created, with the join
  // deliberately paused behind it. This is the only moment the key exists
  // anywhere but in the reader's hands, so the screen's job is to stop
  // somebody who is in a hurry to reach a chat room.
  'onboarding.recoveryKey.title': 'Save your recovery key',
  'onboarding.recoveryKey.body': 'It can reset your password and recover your encrypted account.',
  // One key with the emphasis inside it. The bold half is the instruction and
  // the rest is why it cannot be put off -- splitting them would let a
  // translator render a warning whose two halves disagree about how urgent it
  // is. "Cannot be recreated" is literal: no operator, including the one who
  // runs the homeserver, can issue another.
  'onboarding.recoveryKey.warning': '<b>Keep it separate from your password.</b> It cannot be recreated.',
  'onboarding.recoveryKey.copy': 'Copy recovery key',
  // The name of the thing copied, handed to `copyToClipboard` so its toast
  // can say what landed on the clipboard. Sentence-cased because that toast
  // begins with it. See the note at the call site: the sentence around it
  // still lives in `lib/clipboard.js` and is not yet on the catalogue, so
  // this word is currently the only translated half of it.
  'onboarding.recoveryKey.clipboardLabel': 'Recovery key',
  'onboarding.recoveryKey.download': 'Download it as a file',
  'onboarding.recoveryKey.finishing': 'Finishing…',
  // First person, and the only string in this file written in the reader's
  // own voice rather than the product's. That is what makes it a claim the
  // reader is making rather than a button that dismisses a dialog, and it is
  // the difference between somebody saving the key and somebody clicking OK.
  'onboarding.recoveryKey.confirm': 'I saved my recovery key',

  // ================================================== the account home picker

  // The heading over the picker, and the sentence that has to carry the whole
  // idea of federation to somebody who has never heard of it. Two clauses:
  // what this server does for you, and what it does not decide. The second is
  // the one that stops the choice feeling permanent -- "communities can live
  // anywhere" is the reason picking the "wrong" home is not a mistake.
  //
  // Not "instance", not "node", not "federation". A translator should reach
  // for whatever their language would use for the branch of a bank that holds
  // your account, not for a networking term.
  'onboarding.home.title': 'Account home',
  'onboarding.home.explainer': 'This server keeps your account and sign-in. Communities can live anywhere.',

  // Opens and closes the list of the other recommendations. Pairs with
  // `common.done`, which is what the same button says while the list is open.
  'onboarding.home.chooseOther': 'Choose a different one',
  // At the end of that list: a server that is not on it. Leads to the field
  // where any server's address can be typed.
  'onboarding.home.useAnother': 'Use another server',
  // While the signed recommendation document is being fetched and verified.
  // "Healthy" rather than "available": the choice is made from uptime and
  // capability, and saying so is what makes the wait feel like work being
  // done on the reader's behalf.
  'onboarding.home.finding': 'Finding a healthy community server…',

  // The second half of a server's detail line, after its region. `{rate}` is
  // a percentage the operator published, already a number out of a hundred --
  // so the per-cent sign is written into the pattern rather than applied by
  // the number formatter, and a language that writes it before the number or
  // with a space in front of it should move it here.
  'onboarding.home.uptime': '{rate, number}% recent uptime',
  // What goes between a server's region and its uptime, and between its
  // domain and both. A key rather than a literal for the same reason
  // `common.empty` is one: it is punctuation with a direction, and a
  // right-to-left catalogue needs to be able to change both the character and
  // the spacing around it without a code change.
  'onboarding.home.detailSeparator': ' · ',

  // Who runs the server. `{operator}` is the operator's own name for
  // themselves and is never translated; where they published a contact
  // address the name is also the link, which is why the tag is inside the
  // placeholder's sentence rather than around the whole line. A catalogue
  // that drops the `<a>` loses the link and keeps the words, which is the
  // right way for this to fail.
  'onboarding.home.operatedBy': 'Operated by <a>{operator}</a>',
  // The badge on the recommended server. It says what kind of server this is
  // -- one run by the community rather than by the Telium project -- and it
  // is a noun, not a verb or a status.
  'onboarding.home.communityBadge': 'Community',
  // The recommendation, said as a choice made for the reader. `{name}` is the
  // server's own name and is never translated; `<b>` sets it apart.
  'onboarding.home.picked': 'We picked <b>{name}</b> for you',
  // Why it was not simply us, in one line under the choice. Three claims, in
  // the order somebody new needs them: the servers are separate, that does
  // not wall anybody off, and spreading out is the point. "Server", never
  // "homeserver" or "instance".
  // Written for someone who has never heard the word "server" used this way:
  // the name on the card above ("Atlas") means nothing on its own, so this has
  // to say what it is before it says why it was picked.
  'onboarding.home.why': 'This is where your account lives, a bit like choosing an email provider. You can still talk to anyone and join any community, whichever server they use. We spread new people across trusted servers so Telium never depends on one company.',
  // Names the group of alternative servers for a screen reader, which
  // otherwise meets a run of unlabelled buttons with server names in them.
  // "Other" is doing real work: the recommended one is not in this list.
  'onboarding.home.otherChoices': 'Other recommended account homes',

  // No recommendation could be made -- nothing was signed, nothing verified,
  // or nothing in the document was usable. Says so plainly and then hands the
  // decision over, because the alternative is a dead end on the first screen
  // of the product. "Any homeserver you trust" is the honest criterion: this
  // client has no opinion left to offer at this point.
  'onboarding.home.unavailable': 'No verified community recommendation is available right now. Choose any homeserver you trust instead.',
  // Appended to the line above in the one case where the cause is this build
  // rather than the network: an ordinary web build ships without the
  // recommendation signing key, so it can never verify one. Kept as its own
  // sentence rather than folded in, because it is true in some builds and
  // never true in others, and a translator needs to be able to write it as a
  // standalone remark.
  'onboarding.home.noPinnedKey': 'This client build has not pinned the recommendation signing key yet.',

  // The escape hatch for somebody who already knows which server they want --
  // an operator, or somebody joining a friend's. Marked "Advanced:" so that
  // it reads as a road not taken rather than as a field left blank, and the
  // HTTPS requirement is stated because the commonest thing typed here is a
  // bare hostname.
  'onboarding.home.advancedHint': 'Advanced: enter the HTTPS address of any Telium homeserver that allows registration.',
  'onboarding.home.advancedPlaceholder': 'https://home.example',
  // Switches from the recommendation to that field. "Domain" rather than
  // "address" because that is what the person who wants this is holding.
  'onboarding.home.useDomain': 'Use a server domain',
  // Leaves for the public directory. The only outbound link on either screen.
  'onboarding.home.browseAll': 'Browse all servers',

  // The chip's accessible name when it is a button -- `views/AccountHome.jsx`.
  // Its visible content is a hostname and a chevron, which a screen reader
  // announces as "home.example, button" and which says nothing about what
  // pressing it does. `{host}` leads so that voice control still matches the
  // word on screen, and the rest says where the press goes.
  'onboarding.home.chipAction': '{host} — change where your account lives',

  // ------------------------------------------------ the address, once it exists
  //
  // Said wherever a new account is finished, because people are not used to
  // having to remember which server they are on, and the next device they
  // sign in from will ask. `{user}` is the full address and is data.
  'onboarding.address.yours': 'Your Telium address is <b>{user}</b>. You\'ll need it to sign in on another device.',
  'onboarding.address.copy': 'Copy address',
  // The noun in the clipboard's "… copied." toast.
  'onboarding.address.clipboardLabel': 'Address',
};
