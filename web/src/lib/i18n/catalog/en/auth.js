// Everything said to somebody who is not in yet, and everything said about the
// keys that would let them back in.
//
// Four screens share this namespace because they share a subject and a
// reader: `views/LoginView.jsx` (the sign-in, registration, MFA and
// password-reset flow), `views/RecoveryScreen.jsx` (the way out of a client
// that will not start), and the encryption pane split across
// `views/user-settings/RecoveryPane.jsx` and `RecoveryParts.jsx`. A person
// reading any of them is either locked out, worried about being locked out, or
// being handed the one string that prevents it. That is the tone to translate
// in: plain, specific, and never cheerful about a risk.
//
// ------------------------------------------------------- this is security copy
//
// Most of a client's strings can be translated loosely and nothing breaks. The
// sentences in this file cannot, and the failure modes are not cosmetic:
//
//   * **Vagueness is sometimes deliberate.** "That username and password do not
//     match an account here" (in `errors.js`) does not say which half was
//     wrong, because saying so tells an attacker whether an account exists. The
//     same restraint applies to `auth.recover.rejected` below. A translation
//     that helpfully sharpens either one into "no such account" re-opens an
//     enumeration oracle in that language only, where nobody reviewing English
//     will ever see it. Where a sentence is vague on purpose, the comment above
//     it says so.
//
//   * **A promise about where a secret went must stay true.** `auth.legacy.*`
//     and `auth.recoveryKey.passwordHint` tell the reader whether their
//     password left the device. Those are statements of fact about the protocol
//     that was run, not reassurance; a translation that softens "the homeserver
//     will receive your password" into something vaguer is a lie the reader
//     will act on.
//
//   * **"Cannot be shown again" means cannot.** `auth.key.warning` and
//     `auth.recoveryKey.onceWarning` are the only warning before an
//     unrecoverable loss. They must not read as boilerplate.
//
// ------------------------------------------- the recovery key is not a string
//
// The recovery key itself -- `telium-recovery-v1-` followed by 43 base64url
// characters -- is DATA. It is never translated, never transliterated, never
// re-spaced, and never localised into another script. It is the input to
// Ed25519 key derivation in `lib/account-recovery.js`, and a key whose
// characters were "helpfully" adjusted by a translation tool is an account
// nobody can ever open again -- including its owner, including us. The same
// goes for the `telium-recovery-v1-…` placeholder in `auth.recoveryKey.placeholder`
// and for every user id, homeserver hostname and guild name interpolated below.
// Translate the sentence around the value; never the value.
//
// ----------------------------------------------------------- reused from common
//
// `common.cancel`, `common.continue` and `common.password`/`common.username`
// carry the plain verbs and nouns these screens use, so they are not repeated
// here. What *is* repeated here, deliberately, is every word that looks like
// one of those but is a different act -- "Unlock" on a vault is not "Continue"
// on a form, and "Recovery key" as a field label, a section heading, a
// breadcrumb and a screen-reader name are four uses one word only happens to
// cover in English.

export const auth = {
  // ------------------------------------------------------------ the way back
  //
  // The breadcrumb at the top of each step is not the word "Back": it names the
  // answer you are returning to change, so pressing it is a decision rather
  // than a direction. Which is why these are not `common.back` and why they are
  // nouns -- a language that inflects a destination differently from a subject
  // needs them separable from the field labels that use the same English word.

  'auth.crumb.welcome': 'Welcome',
  // Shown in place of the typed username when the field is still empty, so the
  // crumb always names something.
  'auth.crumb.username': 'Username',
  'auth.crumb.password': 'Password',
  'auth.crumb.recoveryKey': 'Recovery key',
  // The desktop's first screen, named by its one field.
  'auth.crumb.address': 'Telium address',

  // ------------------------------------------------------ naming a homeserver

  'auth.server.title': 'Where does your account live?',
  // The one fact that makes the question a question at all. Not an
  // explanation of federation -- somebody who has never had an account does not
  // need one, and this is the wrong moment for it.
  'auth.server.sub': 'Every Telium account belongs to one home server.',
  // "Home server", two words, is how this flow says it. `common.homeserver`
  // says "Homeserver", one word, which is how the settings surfaces say it.
  // The two spellings are a real inconsistency in the product and not something
  // a translator should have to arbitrate, so this screen keeps its own key and
  // whichever spelling a language settles on can be applied consistently here.
  'auth.server.label': 'Home server',
  // An example address, not a real one: `example` is a reserved TLD that can
  // never resolve, which is the point -- a placeholder that named a real host
  // would send typos to somebody's server. Translate only if the locale has its
  // own reserved example convention; otherwise leave it.
  'auth.server.placeholder': 'home.example',
  // `<a>` is the link to the public server directory. One key rather than
  // "Do not have one?" plus a link label, because the question and the offer
  // are one sentence and a language may want the offer first.
  'auth.server.noServer': 'Do not have one? <a>Find a home server</a>',
  'auth.server.use': 'Use this server',

  // The tick, cross and spinner beside the address field. Never drawn as words
  // -- these are `aria-label`s and exist only for a screen reader, which is why
  // they name a state and not an instruction. "Server not reachable" is the
  // honest word: the client knows nothing answered, not why.
  'auth.server.probeChecking': 'Checking server',
  'auth.server.probeFound': 'Server found',
  'auth.server.probeUnreachable': 'Server not reachable',

  // The dialog shown when somebody presses on past an address that did not
  // answer. `{host}` is the hostname as typed, stripped of scheme and path --
  // data, never translated.
  'auth.server.unreachableTitle': '{host} did not answer',
  // Three guesses and no diagnosis, because the client genuinely cannot tell a
  // typo from a private network from a server that is down. `<a>` is the server
  // directory again. Kept as one sentence-with-a-link rather than three keys:
  // the clause order is a fact about English, and the offer of a working server
  // is the useful half.
  'auth.server.unreachableBody': 'Nothing responded at that address, so it may be misspelled, private, or down. You can carry on with it, but signing in and creating an account will not work until it answers. <a>Find a home server</a> that is known to be up.',
  'auth.server.useAnyway': 'Use it anyway',

  // ---------------------------------------------- the desktop's first screen
  //
  // A packaged desktop app has no web address to stand in for "your server",
  // so instead of a start screen that quietly assumes one, it opens on a
  // single field that takes a whole address. Written for someone who has
  // never heard the word "homeserver": "server" is fine, the jargon is not.

  'auth.find.title': 'Sign in to Telium',
  'auth.find.label': 'Telium address',
  // DATA-shaped: an example handle on the project's own server. The shape --
  // `@name:server` -- is the message; translate "you" only if the locale
  // writes example names differently.
  'auth.find.placeholder': '@you:telium.chat',
  // Forgetting the server has to read as fine, because it is: a bare name is
  // looked for on the servers this device knows.
  'auth.find.hint': 'Your username and server, like @ada:telium.chat. Forgot your server? Just type your username.',
  // Screen-reader name for the list of accounts this machine has used.
  'auth.find.recentLabel': 'Accounts on this device',
  // `{user}` is a full handle and is data.
  'auth.find.forget': 'Forget {user} on this device',
  // On the button while the address is being looked up, and the line under the
  // field naming what is being looked up. `{host}` is data.
  'auth.find.busy': 'Looking up…',
  'auth.find.lookingUp': 'Looking up {host}…',
  'auth.find.invalid': 'That doesn\'t look like a Telium address. Try @name:server.',
  'auth.find.unreachable': 'Couldn\'t reach {host}. Check the spelling, or your connection.',
  // Deliberately definite, unlike the vague sign-in failure in `errors.js`:
  // the server's public status route has already said so, and the fix -- a
  // different spelling or server -- is only findable if this says which.
  // `<create>` is a button that starts making that account.
  'auth.find.noAccount': 'There\'s no account called {user} on {host}. Check the spelling, or <create>create an account</create>.',
  // The same news after a refused password, with a way back to the address.
  'auth.find.noSuchAccount': 'There\'s no account called {user} on {host}.',
  'auth.find.changeAddress': 'Use a different address',
  // A bare name was typed. `{user}` is data.
  // While a bare name is looked for on the servers this device knows.
  'auth.find.searching': 'Looking for {user}…',
  // One row per server that has an account by that name; pressing it goes to
  // the password. `{user}` and `{host}` are data.
  'auth.find.found': 'Found {user} on {host}',
  // Screen-reader name for that list of rows.
  'auth.find.foundLabel': 'Accounts called {user}',
  // Under the rows, for somebody whose account is on none of them.
  'auth.find.elsewhere': 'On a different server?',
  'auth.find.whichServer': 'Which server is {user} on?',
  'auth.find.afterColon': 'Or type it after a colon, like @{user}:your.server',
  // On the password step when the address had a forwarding note on it.
  'auth.find.moved': 'Your account moved to {host}.',
  // Said before any password is typed, so it cannot say "the same password".
  'auth.find.deactivated': 'This account is deactivated. Signing in with its password brings it back.',
  'auth.find.newTitle': 'New to Telium?',
  'auth.find.create': 'Create an account',
  'auth.find.homeExplainer': 'Your account home keeps your profile, sign-in, friends, and messages. You can still join communities hosted elsewhere.',
  'auth.find.changeHome': 'Choose a different home',

  // ----------------------------------------------------------- the first screen

  'auth.start.title': 'Welcome to Telium',
  // The two ways on. "Get started" rather than "Register" or "Sign up" because
  // the person taking it has not decided to join a *service* -- they are
  // starting, and the account is a consequence.
  'auth.start.signIn': 'Sign in',
  'auth.start.register': 'Get started',
  // `<recover>` is a button, not a link: it moves to a step in this same flow.
  'auth.start.lostPassword': 'Lost your password? <recover>Recover your account</recover>',

  // -------------------------------------------------------------- who you are

  // Two titles because they are two different questions. Registering, the
  // username is being *chosen* and can be anything; signing in, it already
  // exists and is being recalled.
  'auth.identity.titleRegister': 'Pick a username',
  'auth.identity.titleLogin': 'Who is signing in?',
  // Example usernames. "ada" is Ada Lovelace and is a name, so a locale may
  // swap it for one its readers will recognise as an example -- what must
  // survive is the *shape*: a bare name, or a full `@name:server` id. `{host}`
  // is the homeserver this flow is pointed at and is data.
  'auth.identity.placeholderNew': 'ada',
  'auth.identity.placeholder': 'ada or @ada:{host}',

  // ------------------------------------------------------------- the password

  'auth.password.titleRegister': 'Set a password',
  'auth.password.titleReactivate': 'Reactivate your account',
  'auth.password.titleLogin': 'Enter your password',
  // `{user}` is what was typed on the step before -- a username, so data. The
  // emphasis is inside the message rather than around a second key because in
  // a language that puts the name first, "as" has nowhere to go.
  'auth.password.signingInAs': 'Signing in as <b>{user}</b>.',
  'auth.password.confirmLabel': 'Confirm password',
  // Under the confirmation field while the two differ. "yet" is load-bearing:
  // it is shown while somebody is still typing the second copy, so it must read
  // as "keep going" and not as "you got it wrong". Shared with the password
  // reset step, which shows it for the same reason at the same moment.
  'auth.password.mismatch': 'These do not match yet.',

  'auth.password.mfaLabel': 'Authentication code',
  // Both accepted inputs, because somebody without their phone needs to know
  // the other one works here. "123456" is a shape, not a code.
  'auth.password.mfaPlaceholder': '123456, or a recovery code',
  // Said once, when the server first asks for a second factor. It is an
  // instruction rather than an error -- nothing has gone wrong yet -- which is
  // why it is not `errors.mfa_required`: that sentence answers a refusal and
  // names only the authenticator app. This one also names recovery codes,
  // because this is the screen where the field for them appears.
  'auth.password.mfaPrompt': 'Enter the six-digit authenticator code, or one of your recovery codes.',
  // Shown when a sign-in turns out to be for a deactivated account. Separate
  // from `errors.account_deactivated` because by the time this is read the
  // screen has already switched itself into reactivation mode, so the useful
  // sentence is not "signing in will reactivate it" but "the password you
  // already typed is the right one -- press again".
  'auth.password.deactivated': 'This account is deactivated. The same password brings it back.',

  'auth.password.submitRegister': 'Create account',
  'auth.password.submitReactivate': 'Reactivate account',
  'auth.password.submitLogin': 'Sign in',
  // `<recover>` is a button into the reset flow. "Forgot it?" refers to the
  // password named by the field above; a language that cannot carry that
  // reference should repeat the noun.
  'auth.password.forgot': 'Forgot it? <recover>Use your recovery key</recover>',

  // The three ways the attempt can fail, as a toast. `{detail}` is already a
  // finished sentence -- `errorMessage()` has translated the server's code, or
  // fallen back to the server's own prose -- so what these add is *which
  // attempt* failed, and the colon is the translator's to move or replace.
  // Three keys rather than one with a `select`, because "registration",
  // "reactivation" and "signing in" decline differently in most languages and
  // there is no gain in forcing them through one frame.
  'auth.password.registerFailed': 'Registration failed: {detail}',
  'auth.password.reactivateFailed': 'Reactivation failed: {detail}',
  'auth.password.signInFailed': 'Sign in failed: {detail}',

  // ----------------------------------------------------- the legacy password path
  //
  // The most consequential copy on the login screen. Normally Telium runs
  // OPAQUE, and the account password never leaves the device -- not hashed, not
  // encrypted, not at all. Each of these three blocks is shown at the one
  // moment that is about to stop being true, and the reader is being asked to
  // authorise it. So each says plainly what will be sent and where, and none of
  // them may be softened into "for security reasons" or "to continue".
  //
  // Three cases, kept apart because the risk is genuinely different in each:
  // an old account being upgraded once and never again; a server that cannot
  // accept a private registration; a server that cannot accept a private
  // sign-in.

  'auth.legacy.upgrade.title': 'This old account needs a one-time security upgrade.',
  // "For this upgrade attempt only" is the whole bargain and must survive
  // translation intact. OPAQUE is a protocol name and stays in Latin script.
  'auth.legacy.upgrade.body': 'The account predates OPAQUE. For this upgrade attempt only, the homeserver will receive your password through its legacy login endpoint. Telium then replaces the old verifier with OPAQUE so future sign-ins keep the password on this device.',
  'auth.legacy.upgrade.action': 'Upgrade this account',

  'auth.legacy.register.title': 'This homeserver does not support password-private registration.',
  // "Use this only if you trust the server" is advice about a party the reader
  // has a relationship with, not a disclaimer. Keep it as advice.
  'auth.legacy.register.body': 'Legacy registration sends your password to the homeserver. Use this only if you trust the server and cannot upgrade it to a current Telium release.',
  'auth.legacy.register.action': 'Use legacy registration',

  'auth.legacy.server.title': 'This homeserver does not support password-private sign-in.',
  'auth.legacy.server.body': 'Legacy sign-in sends your password to the homeserver. Use this only if you trust the server and cannot upgrade it to a current Telium release.',
  'auth.legacy.server.action': 'Use legacy sign-in',
  // Same warning, different verb: the account being reached is deactivated, so
  // the act is reactivation and the button should say what it does.
  'auth.legacy.server.actionReactivate': 'Use legacy reactivation',

  // --------------------------------------------------- resetting with the key

  'auth.recover.title': 'Reset your password',
  // Refused on this device, before anything is sent: the text does not begin
  // with the `telium-recovery-v1-` prefix, so it is not a recovery key at all
  // -- most often a passphrase, or the wrong line pasted out of a password
  // manager.
  'auth.recover.notAKey': 'That is not a Telium recovery key.',
  // Also refused on this device: right prefix, wrong contents -- truncated in
  // copying, or a character lost. Deliberately does not say which character:
  // the client knows only that the base64 did not decode to 32 bytes.
  'auth.recover.malformed': 'That recovery key is malformed.',
  'auth.recover.unsupported': 'This home server does not support recovery-key reset.',
  // The server's refusal, restated for this screen. `errors.invalid_recovery_proof`
  // is the same code's sentence and says "recovery phrase", which is the wrong
  // noun here -- this screen is about the generated key, and a sentence naming
  // a phrase would send somebody hunting for words they never had.
  //
  // Vague on purpose, and the server is vague for the same reason: it will not
  // say whether the account exists, whether the key is wrong, or whether the
  // account never had one, because distinguishing those is an account-existence
  // oracle. Do not translate it into anything more specific.
  'auth.recover.rejected': 'That recovery key was not accepted for this account.',
  'auth.recover.reachFailed': 'Could not reach your home server: {detail}',

  // -------------------------------------------------------- the new password

  'auth.reset.title': 'Choose a new password',
  'auth.reset.newLabel': 'New password',
  'auth.reset.confirmLabel': 'Confirm new password',
  // The minimum the homeserver asked for, so it is a number that arrives from
  // the wire and differs per server. Pluralised even though eight is the common
  // answer: a server may set it to one, and a language with more categories
  // than English needs the arms to exist.
  'auth.reset.minLength': '{count, plural, one {At least # character.} other {At least # characters.}}',
  // Not "yet": by the time this is shown the form has been submitted, so it is
  // a refusal rather than encouragement. Distinct from `auth.password.mismatch`
  // for exactly that reason.
  'auth.reset.mismatch': 'The new passwords do not match.',
  'auth.reset.submit': 'Reset password',
  'auth.reset.failed': 'Password reset failed: {detail}',

  // -------------------------------------------- the key handed out at signup

  'auth.key.title': 'Save your recovery key',
  'auth.key.sub': 'It resets your password and recovers your account if you lose every device.',
  // The last warning before a string that exists nowhere else on earth goes off
  // screen. "Nobody, Telium included" is the part that must not be lost: a
  // reader who thinks support can reissue this will not write it down.
  'auth.key.warning': '<b>Keep it somewhere safe and separate from your password.</b> Nobody, Telium included, can recreate it for you.',
  'auth.key.copy': 'Copy recovery key',
  // First person, because it is the reader making a claim about themselves
  // rather than the app instructing them. A language whose convention is to
  // keep buttons impersonal should follow its own convention -- what matters is
  // that pressing it reads as an assertion, not as "next".
  'auth.key.saved': 'I saved my recovery key',
  'auth.key.acceptFailed': 'Could not accept recovery key: {detail}',

  // --------------------------------------------------------- an account moving
  //
  // Shown above the whole login card when this client was opened from a guided
  // move link. Everything interpolated is data: `{name}` a guild's own name,
  // `{account}` a full user id, `{destination}` and `{source}` hostnames.
  //
  // One key per subject rather than a shared frame plus a `select`, because
  // "the guild X" and "@ada:example" take different articles and different
  // cases in most languages, and the second and third sentences differ too.
  // The emphasis on the first sentence is inside the message so it can land on
  // whichever clause carries the news in the target language.
  'auth.handoff.guild': '<b>Moving the guild {name} to {destination}.</b> Sign in to the account that should own it there, or register a new one. You will be asked to confirm before anything is sent to {source}.',
  'auth.handoff.account': '<b>Moving {account} to {destination}.</b> Sign in to the account it should move into, or register a new one. You will be asked to confirm before anything is sent to {source}.',

  // ------------------------------------------------- clearing local state
  //
  // `views/RecoveryScreen.jsx`: the screen a person reaches when the client
  // will not start, and the same controls embedded in settings. Read by
  // somebody who is stuck and possibly frightened, so every sentence answers
  // "what will this cost me" before it offers a button.
  //
  // The two tiers must stay distinguishable in translation. The first is a
  // cache and costs a slow reload. The second destroys keys held only on this
  // device. A language that renders both as "reset" has erased the one
  // distinction this screen exists to draw.

  'auth.localData.healed': 'Telium cleared its offline cache automatically, because the app failed to start twice in a row. Nothing on your account changed, and your encrypted conversations are untouched.',

  'auth.localData.cache.title': 'Clear cached data',
  'auth.localData.cache.body': 'Safe. Everything here is a copy of something a server still has, and it comes back on the next connection. You stay signed in and your encrypted conversations are not touched.',
  // The list under it. Named items rather than "some local data", because a
  // person deciding whether to press a button needs to know what goes.
  //
  // These three sentences used to live as an array of English strings in
  // `lib/local-state.js` (`CACHE_COSTS`), which is a module with no React above
  // it and no business holding interface copy. They are catalogue entries now;
  // the arrays there are left for whoever next touches that file to delete.
  'auth.localData.cache.cost1': 'The offline copy of your guilds, channels and recent messages.',
  'auth.localData.cache.cost2': 'Your locally mirrored preferences, until the next sync brings them back.',
  'auth.localData.cache.cost3': 'Anything the service worker had cached for offline use.',
  'auth.localData.cache.button': 'Clear cached data',
  'auth.localData.cache.reload': 'Reload',
  'auth.localData.cache.done': 'Cleared. Reload to start from a clean cache.',

  // U+2019 for the apostrophe, not a straight quote -- it is set as prose, and
  // the markup it replaces used `&rsquo;` for the same reason.
  'auth.localData.identity.title': 'Erase this device’s identity',
  'auth.localData.identity.body': 'Only if clearing the cache did not help. This destroys the encryption keys held on this device, and some of what they open exists nowhere else.',
  // The heading over the four losses. Not a question, and not softened: the act
  // below it is irreversible and one of the four items genuinely has no other
  // copy anywhere.
  'auth.localData.identity.confirmTitle': 'This cannot be undone. You will lose:',
  // Formerly `IDENTITY_COSTS` in `lib/local-state.js`; same note as the cache
  // list above. Each one names a concrete consequence rather than a mechanism,
  // except where the mechanism *is* the consequence: "it will be a new device
  // to everyone you talk to" is what a rotated MLS identity actually feels
  // like, and saying only "your signing identity" would tell the reader
  // nothing.
  'auth.localData.identity.cost1': 'This device’s MLS signing identity. It will be a new device to everyone you talk to, and they will see it as unverified until you verify it again.',
  'auth.localData.identity.cost2': 'The stored group state for every encrypted conversation. Messages already on this device stay readable only if the account’s recovery key can reopen them; anything this device is the last holder of is gone.',
  'auth.localData.identity.cost3': 'The cached DM recovery keyring, so the next sign-in has to unlock the key vault again — with your recovery key or passphrase, which you will need to have.',
  'auth.localData.identity.cost4': 'Your session. You will be signed out on this device.',
  // Ends in an ellipsis because pressing it opens the confirmation rather than
  // doing the thing -- the convention every desktop platform shares.
  'auth.localData.identity.open': 'Erase device identity…',
  'auth.localData.identity.confirm': 'Erase and sign out',

  // ------------------------------------------------------- how an account recovers
  //
  // The four custody modes, each as a name and a sentence. The sentence is what
  // the reader needs; the name is what a support thread needs, which is why
  // both exist and why the names keep their parenthetical protocol words.
  // "OPAQUE" and "MLS" are protocol names and stay in Latin script in every
  // language.

  'auth.custody.opaque.name': 'Password recovery (OPAQUE export key)',
  'auth.custody.opaque.note': 'Signing in with your password is enough to get your messages back.',
  'auth.custody.device.name': 'Trusted-device recovery',
  'auth.custody.device.note': 'Your keys live on the devices you have approved, and nowhere else.',
  // "(legacy)" marks a mode still supported but no longer offered. It is not
  // decoration -- it is why the pane elsewhere offers to remove it.
  'auth.custody.self.name': 'Independent passphrase (legacy)',
  'auth.custody.self.note': 'Your keys live on your devices, with a passphrase as the way back.',
  'auth.custody.escrowed.name': 'Server-assisted recovery (legacy)',
  // Blunt on purpose. This is the one mode where the operator can read the
  // reader's private messages, and a sentence that said "your server assists
  // with recovery" would be true and useless.
  'auth.custody.escrowed.note': 'Your home server holds a key that opens these messages.',
  'auth.custody.unknown': 'Not established yet',
  // Name then sentence, in the Advanced block. One key so a language that puts
  // the explanation first, or separates them with something other than a full
  // stop, can.
  'auth.custody.line': '{name}. {note}',

  // ------------------------------------------------------ am I all right?
  //
  // The verdict at the top of the encryption pane, in the order the states
  // matter: a locked vault beats a missing key beats an operator who can read
  // your mail. Each is a title and a note, and the title alone has to be
  // enough -- it is what a screen reader announces when the block changes.

  'auth.encryption.settingUp.title': 'Setting up encryption on this device.',
  'auth.encryption.settingUp.note': 'This takes a moment after signing in.',
  // "on this device" is the point: nothing is lost, the messages exist, this
  // machine simply cannot open them yet.
  'auth.encryption.locked.title': 'Your older messages are locked on this device.',
  'auth.encryption.locked.note': 'New messages work. To get the older ones back, use your recovery key below, or approve this device from one you already use.',
  'auth.encryption.escrowed.title': 'Your home server can read your private messages.',
  'auth.encryption.escrowed.note': 'This account is still on the old recovery setup. Turning it off takes one press and does not need a second password.',
  'auth.encryption.ok.title': 'Your private messages are protected.',
  // Stands in for the custody note when the mode is unknown -- true of every
  // mode this build understands, which is why it is safe as a fallback.
  'auth.encryption.ok.noteFallback': 'Only your devices can open them.',

  // The three summary rows. Labels are nouns naming the thing; values are short
  // enough to sit at the end of a narrow row, so prefer brevity over grammar
  // where a language forces the choice.
  'auth.encryption.keyFact': 'Recovery key',
  'auth.encryption.keySaved': 'Saved',
  'auth.encryption.keyLegacy': 'Old passphrase',
  'auth.encryption.keyMissing': 'Not made yet',
  'auth.encryption.devicesFact': 'Devices',
  // While the server's device list is still in flight.
  'auth.encryption.devicesCounting': 'Counting',
  // Two counts, two sentences. The first is shown when the account's own
  // cross-signatures have not been read yet, so all that is known is how many
  // devices exist. English needs no plural distinction in either, but the arms
  // are here because most languages do.
  'auth.encryption.devicesSignedIn': '{count, plural, one {# signed in} other {# signed in}}',
  // `{verified}` of `#` -- pluralised on the total, since that is the noun the
  // agreement follows. "Devices" is already the row's label, so it is not
  // repeated in the value.
  'auth.encryption.devicesVerified': '{total, plural, one {{verified} of # verified} other {{verified} of # verified}}',
  'auth.encryption.backupFact': 'Backup of older messages',
  'auth.encryption.backupItems': '{count, plural, one {# message} other {# messages}}',
  'auth.encryption.backupEmpty': 'Nothing stored',
  // "Devices" here names another settings pane, not the row above it. If that
  // pane's name is translated, this must match it.
  'auth.encryption.devicesHint': 'Devices is where you verify a device or sign one out.',

  // ------------------------------------------------ leaving server-assisted recovery

  'auth.escrow.title': 'Turn off server-assisted recovery',
  // The honest limit on what turning it off achieves: it is forward secrecy,
  // not amnesia. A sentence that implied the server forgets what it already
  // holds would be the most damaging kind of wrong on this page.
  'auth.escrow.explain': 'Your server stops being able to open anything sent after this. What it has already seen, it has already seen.',
  'auth.escrow.button': 'Turn it off',
  // Three outcomes, because the honest answer differs. The first is a partial
  // success and says so; the other two name what is now true, and which one is
  // shown depends on whether the account has a password-derived wrapper to fall
  // back on.
  'auth.escrow.doneRefresh': 'Done, though a few conversations still need a key refresh.',
  'auth.escrow.doneServer': 'Done. Your server can no longer open new messages.',
  'auth.escrow.doneDevices': 'Done. Your keys are on your devices now.',
  'auth.escrow.failed': 'Could not turn off server-assisted recovery: {detail}',

  // ------------------------------------------------------------- unlocking

  'auth.unlock.title': 'Unlock your older messages',
  // The hint under each field says where that secret came from, because the
  // difference between them is exactly what somebody in this state has
  // forgotten: one was handed to them by Telium, the other they chose.
  'auth.unlock.keyHint': 'The key you were given when this account was made.',
  'auth.unlock.passphraseLabel': 'Recovery passphrase',
  'auth.unlock.passphraseHint': 'The passphrase you added to this account yourself.',
  'auth.unlock.button': 'Unlock',
  'auth.unlock.enterKey': 'Enter your recovery key.',
  'auth.unlock.enterPassphrase': 'Enter your recovery passphrase.',
  // After unlocking on an OPAQUE account: the password now derives the wrapper,
  // so the key is not needed again on this device. Worth saying, because
  // otherwise the reader expects to be asked every time.
  'auth.unlock.done': 'Unlocked. Your password is enough from now on.',
  // The same act on an account whose custody mode cannot make that promise.
  'auth.unlock.doneDevice': 'Unlocked on this device.',
  'auth.unlock.failed': 'Could not unlock your messages: {detail}',
  // The third way in, named because it is the one that needs no secret typed
  // anywhere and is therefore the one to prefer.
  'auth.unlock.otherDevice': 'You can also open Telium on a device you already use and approve this one from there. Nothing is typed, and your server never sees the keys.',

  // ---------------------------------------------------------- the recovery key
  //
  // Used by both the login flow and the settings pane, which is why the shared
  // pieces live under one screen name rather than being written twice.

  'auth.recoveryKey.title': 'Recovery key',
  // The field label wherever a recovery key is typed in -- the reset step of
  // the login flow and the unlock form in settings. One key: it is the same
  // artefact, the same act and the same speaker in both.
  'auth.recoveryKey.fieldLabel': 'Recovery key',
  // The placeholder shows the fixed prefix every Telium recovery key starts
  // with. IT IS NOT TRANSLATABLE: `telium-recovery-v1-` is a literal compared
  // byte for byte in `lib/account-recovery.js`, and a translated prefix would
  // teach the reader to look for a string that no key has ever begun with.
  // Only the trailing ellipsis is typography.
  'auth.recoveryKey.placeholder': 'telium-recovery-v1-…',
  // The noun handed to `copyToClipboard`, which says "{what} copied." So it is
  // a subject in that sentence, not a heading.
  'auth.recoveryKey.clipboardName': 'Recovery key',
  // The moment the key is on screen for the only time it ever will be. Both
  // halves matter: write it down *before you go on*, and nobody can show it
  // again -- not support, not the operator, not us.
  'auth.recoveryKey.onceWarning': '<b>Write this down before you go on.</b> It is shown once and cannot be shown again, by us or by anyone.',
  'auth.recoveryKey.copy': 'Copy it',
  'auth.recoveryKey.download': 'Download it as a file',
  'auth.recoveryKey.saved': 'I have saved it',
  'auth.recoveryKey.replaceExplain': 'Enter your password to make the new key. The old one stops working.',
  'auth.recoveryKey.passwordLabel': 'Your password',
  // States a fact about the protocol, and it is the reason asking for a
  // password here is not a step backwards: OPAQUE verifies it locally and the
  // server receives a proof, never the password. Do not soften it into
  // "your password is safe".
  'auth.recoveryKey.passwordHint': 'Checked on this device. Your server never receives it.',
  'auth.recoveryKey.makeNew': 'Make the new key',
  'auth.recoveryKey.haveExplain': 'Your recovery key is the way back if you forget your password or lose every device. Keep it somewhere only you can reach. It cannot be shown again, and making a new one stops the old one from working.',
  'auth.recoveryKey.replaceButton': 'Make a new recovery key',
  'auth.recoveryKey.noneExplain': 'This account has no recovery key. Without one, forgetting your password means losing your older messages. Making one takes a few seconds.',
  'auth.recoveryKey.makeButton': 'Make a recovery key',
  'auth.recoveryKey.lockedFirst': 'Unlock your messages above, then you can make a recovery key.',
  'auth.recoveryKey.unsupported': 'This server does not offer recovery keys. Your keys stay on the devices you approve.',
  // The confirmation before replacing a key. Separate from the button that
  // opens it, because a dialog title and a button label are different parts of
  // speech in most languages even when English spells them the same.
  'auth.recoveryKey.replaceTitle': 'Make a new recovery key',
  // The cost, stated as the thing that actually goes wrong: a piece of paper
  // somewhere that silently stops working.
  'auth.recoveryKey.replaceBody': 'Your current recovery key stops working the moment the new one is made. If you have written it down somewhere, that copy becomes useless.',
  'auth.recoveryKey.replaceConfirm': 'Make a new one',
  'auth.recoveryKey.enterPassword': 'Enter your password.',
  'auth.recoveryKey.createFailed': 'Could not create your recovery key: {detail}',
  'auth.recoveryKey.savedToast': 'Recovery key saved. Keep it apart from your password.',
  // A distinct failure from `createFailed`: the key exists, the account just
  // did not record that it was accepted. Saying "finish" is what tells the
  // reader the key they are looking at may still be the right one.
  'auth.recoveryKey.finishFailed': 'Could not finish saving your recovery key: {detail}',
  // The state older clients could leave an account in: the key still resets
  // the password, but the copy of the vault it opened is gone. Typing the key
  // here puts it back; nothing about the key leaves the device but a signature.
  'auth.recoveryKey.missingExplain': 'Your recovery key can reset your password, but it no longer opens your older messages. Enter it here to fix that. If you no longer have it, make a new one instead.',
  'auth.recoveryKey.restoreButton': 'Reconnect my key',
  'auth.recoveryKey.restored': 'Your recovery key opens your older messages again.',
  'auth.recoveryKey.restoreFailed': 'Could not reconnect your recovery key: {detail}',

  // --------------------------------------------- the encrypted history backup

  'auth.backup.title': 'Backup of older messages',
  // `{at, relative}` renders as "5 min. ago" or, inside the 45-second window,
  // as `format.justNow`. It is the moment the mirror was last written.
  'auth.backup.explain': 'An encrypted copy is kept so a new device can catch up. Last written {at, relative}.',
  'auth.backup.empty': 'Nothing is stored yet. A new device would start from today.',
  'auth.backup.delete': 'Delete the backup',
  'auth.backup.deleteTitle': 'Delete the backup',
  // Bounds the loss precisely: this device keeps what it has, a future one
  // starts from now. Anything vaguer would read as "you will lose your
  // messages", which is not what happens.
  'auth.backup.deleteBody': 'Messages already on this device stay. A new device will not be able to get the older ones back.',
  'auth.backup.deleteConfirm': 'Delete it',
  'auth.backup.deleted': 'Backup deleted.',
  'auth.backup.deleteFailed': 'Could not delete the backup: {detail}',
  'auth.backup.detailName': 'Backup',
  // Two facts in one entry under Advanced: how much is sealed, and whether the
  // homeserver can open it. One key rather than two so the translator controls
  // the join, and `{readable}` is selected on rather than interpolated because
  // it is a boolean and not a phrase.
  'auth.backup.detail': '{count, plural, one {# sealed item.} other {# sealed items.}} {readable, select, yes {Your home server can open it.} other {Your home server cannot open it.}}',

  // ------------------------------------------------------------- advanced

  'auth.advanced.modeName': 'How this account recovers',
  'auth.advanced.identityName': 'Account identity',
  // Appended after the account's immutable identifier, separator included, so a
  // language can change or drop the middle dot. `{sequence}` is a position in
  // the identity's own signature chain and is passed as text, not as a number:
  // it is an identifier, and digit grouping would make it look like a quantity.
  'auth.advanced.rootSequence': ' · root sequence {sequence}',
  // Shown when the signature chain over the account's identity did not verify.
  // Says "could not be checked" and not "is forged", because those are
  // different claims and the client can only support the first.
  'auth.advanced.identityMismatch': 'This account’s identity history could not be checked.',
  'auth.advanced.legacyPassphraseName': 'Old recovery passphrase',
  'auth.advanced.legacyPassphraseBody': 'This account still carries a passphrase from an older version of Telium. Your password already does the same job.',
  'auth.advanced.removePassphrase': 'Remove the old passphrase',
  // The reassurance is the second clause and it is the reason removing it is
  // safe. Never drop it.
  'auth.advanced.passphraseRemoved': 'Old passphrase removed. Your password still gets your messages back.',
  'auth.advanced.removeFailed': 'Could not remove the old recovery passphrase: {detail}',

  // ------------------------------------------------------- recovery contacts
  //
  // Threshold recovery: three people, any two of whom can vouch the account
  // back in. The "any two of three" is in the label rather than in a footnote
  // because it is the whole mechanism, and somebody who reads it as "three
  // people can see my account" will not set it up.

  'auth.guardians.name': 'Recovery contacts (any two of three)',
  // `{version}` counts how many times the policy has been replaced. The second
  // sentence is the consequence of choosing again, and it matters: the old
  // three stop being able to help the moment new ones are saved.
  'auth.guardians.set': 'Set, version {version}. Choosing new ones cancels the old.',
  'auth.guardians.unset': 'Not set. Any two of the three can vouch you back in; one alone cannot.',
  // The label on each of the three fields. `{index}` is 1, 2 or 3.
  'auth.guardians.person': 'Person {index}',
  // An example user id. The shape is the message -- a full id with a server on
  // it, not a display name -- so whatever name a locale substitutes must keep
  // the `@name:host` form.
  'auth.guardians.placeholder': '@friend:home.example',
  // The two ways to get the form wrong, told apart rather than collapsed into
  // one "invalid" line: from the outside a blank field and a repeated one look
  // identical, and a disabled button with no reason beside it is a dead end.
  'auth.guardians.incomplete': 'Name all three before saving.',
  'auth.guardians.duplicate': 'Three different people. The same ID cannot count twice.',
  // `{people}` is a locale-joined list of user ids -- data, and already
  // formatted with the language's own list separator.
  'auth.guardians.verifiedList': 'People you have verified: {people}',
  // "the emoji check" is this client's name for the out-of-band verification
  // flow, where both sides compare a short emoji sequence. Translate it as
  // whatever that feature is called in the target language.
  'auth.guardians.verifyFirst': 'Verify someone with the emoji check first, then put their full ID here.',
  'auth.guardians.replace': 'Replace these three',
  'auth.guardians.save': 'Save these three',
  'auth.guardians.needThree': 'Choose three different people.',
  // The device holding this pane is not itself trusted to sign a new policy --
  // usually because it has not been verified yet. Phrased as a fact about this
  // device and this moment, since both can change.
  'auth.guardians.cannotSign': 'This device cannot sign for your account right now.',
  'auth.guardians.saved': 'Your three recovery contacts are saved.',
  'auth.guardians.saveFailed': 'Could not save your recovery contacts: {detail}',
  'auth.guardians.unsupportedName': 'Recovery contacts',
  'auth.guardians.unsupported': 'This server does not offer them.',

  // --------------------------------------------------------- the shared parts
  //
  // `views/user-settings/RecoveryParts.jsx`. These belong to components rather
  // than to a screen, and two of them are drawn by panes in other namespaces
  // (devices, conversations, bot tokens) whenever that caller passes no label
  // of its own. They live here because the component does; a caller that needs
  // a different word passes one.

  'auth.parts.advanced': 'Advanced',
  // The screen-reader name of the box a one-time secret is set in, when the
  // caller does not say what kind of secret it is. A secret announced as the
  // wrong kind of secret is worse than one announced as none, which is why the
  // bot-token surface overrides it.
  'auth.parts.recoveryKeyLabel': 'Recovery key',
  // How that box announces itself: the name, then how many chunks it is broken
  // into, so somebody reading it aloud against a piece of paper knows how far
  // through they are. `{label}` is the name above.
  'auth.parts.keyGroups': '{label}, {count, plural, one {# group of characters} other {# groups of characters}}',
  // Spoken before a summary value that needs doing something about, since the
  // warning triangle beside it is not in the accessibility tree. The trailing
  // space separates it from the value that follows; keep it.
  'auth.parts.needsAttention': 'Needs attention: ',

  // The text file offered by "Download it as a file". A file, not a screen --
  // it will be opened in a month by somebody who has forgotten what it is, in
  // an editor with no styling, so it names itself on the first line.
  'auth.parts.download.title': 'Telium recovery key',
  // `{user}` is the full account id the key belongs to. Written down because a
  // person with two accounts will otherwise own two indistinguishable files.
  'auth.parts.download.account': 'Account: {user}',
  // `{host}` is the server the account lives on, the part people forget. Said
  // on its own line as well as inside the account, because "which server was
  // I on?" is the question somebody opening this file on a new device has.
  'auth.parts.download.server': 'Server: {host} (sign in with the account above on any device)',
  // Two separate lines in the file, not one sentence wrapped -- the first says
  // what the key does, the second what that means for anyone else who finds it.
  'auth.parts.download.body1': 'This key resets your password and reopens your encrypted messages.',
  'auth.parts.download.body2': 'Anyone who has it can do both. Keep it somewhere only you can reach.',
};
