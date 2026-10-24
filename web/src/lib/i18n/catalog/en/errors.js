// One sentence per machine code the server can refuse with.
//
// This file is the client half of the contract written down in
// `server/src/errcodes.rs`; read that first, because it explains what a code
// promises and why the promise is worth making. What is left to say here is
// how the two halves are kept honest and what a person writing one of these
// sentences has to get right.
//
// ------------------------------------------------------------ the two halves
//
// The server owns the code. This file owns the sentence. Neither knows the
// other's business, and that separation is the entire point: rewording
// "missing permission MANAGE_ROLES" into "You need Manage Roles for that" is a
// change to a string in a JavaScript file, needs no server deploy, needs no
// version negotiation, and cannot break a bot. Before codes, the same reword
// was a wire-breaking change dressed as a copy edit.
//
// A key here that names a code the server cannot emit is dead weight; a code
// the server emits with no key here falls through to the server's own English,
// which is correct but untranslated. `src/test/i18n-errors.test.js` checks the
// first direction against the registry. The second cannot be checked from the
// client -- a federated network runs servers this build has never seen -- and
// is exactly why the fallback to the server's prose exists rather than being
// treated as a bug.
//
// ------------------------------------------------------- writing one of these
//
// Three rules, all learned from the sentences these replace.
//
//   * **Say what happened, then what to do, in that order.** A person reading
//     an error is trying to work out whether they did something wrong,
//     something is broken, or they are being told no. Answer that first.
//
//   * **Interpolate the detail the server sent.** `{permission}`,
//     `{retry_after}`, `{destination}` -- every one of these arrives as its own
//     JSON field precisely so this sentence can put it wherever the grammar of
//     the language wants it. A sentence that ignores the field is a sentence
//     that has thrown away the only specific thing the server knew.
//
//   * **Never blame the reader for the protocol.** "Your client is out of
//     date" is a fact about software; "you did that wrong" is an accusation,
//     and it is usually false.

export const errors = {
  // ------------------------------------------------------------- credentials

  // Deliberately vague about *which* half was wrong, matching the server's
  // deliberate vagueness. A sentence that said "no account with that name"
  // would hand an attacker the enumeration oracle the single code was chosen
  // to deny, and it would do it in every language at once.
  'errors.invalid_credentials': 'That username and password do not match an account here.',
  'errors.account_deactivated': 'This account is deactivated. Signing in will reactivate it.',
  'errors.account_deleted': 'This account has been deleted and cannot be signed in to.',
  'errors.account_already_active': 'This account is already active.',
  'errors.mfa_required': 'Enter the code from your authenticator app.',
  'errors.invalid_mfa_code': 'That code is not right. Codes expire after about a minute — try the next one.',
  'errors.mfa_setup_not_started': 'Start setting up two-factor authentication before confirming a code.',
  'errors.mfa_not_configured': 'This account has no second factor set up.',
  // "Update this app" and not "your password is wrong", which is what a
  // downgrade attempt feels like from the inside and is the exact confusion
  // that makes people retype a correct password five times.
  'errors.opaque_required': 'This account signs in with a newer exchange that this version of Telium does not speak. Update Telium and try again.',
  'errors.reauth_required': 'Confirm your password to continue.',
  'errors.reauth_expired': 'That took long enough that we need your password again.',

  // ---------------------------------------------------------------- recovery

  'errors.invalid_recovery_proof': 'That recovery phrase is not right for this account. Check for a missing or swapped word.',
  'errors.recovery_attempt_expired': 'This recovery attempt has expired. Start again from the beginning.',

  // ------------------------------------------------------------ registration

  'errors.registration_closed': 'This homeserver is not accepting new accounts.',
  'errors.username_taken': 'Somebody already has that username on this homeserver.',
  // `{reason}` is a slug, not prose, so it is selected on rather than
  // interpolated. A `select` with an `other` arm means a server that invents a
  // fourth reason still gets a sentence instead of a blank.
  'errors.username_invalid': '{reason, select, too_short {That username is too short.} too_long {That username is too long.} charset {Usernames can use letters, digits, dots, dashes and underscores.} reserved {That username is reserved.} other {That username cannot be used here.}}',
  'errors.invite_invalid': 'This invite is no longer valid. It may have expired, been used up, or been revoked.',

  // ------------------------------------------------------------- permissions

  'errors.missing_permission': 'You need the {permission} permission to do that.',
  'errors.role_hierarchy': 'You cannot do that to somebody whose highest role is above yours.',
  'errors.owner_only': 'Only the owner of this guild can do that.',
  'errors.not_a_member': 'You are not a member of this guild.',
  'errors.timed_out': 'You are timed out here until {expires_at, time, short}.',

  // ------------------------------------------------------- server ownership

  // The one refusal on this list that a person meets while doing something
  // else. Three of the four arms are reached from account settings -- close my
  // account, delete my account, move me elsewhere -- by somebody who may never
  // have thought of themselves as running the server, so each arm names the
  // thing they were actually doing before it explains why it stopped.
  //
  // `{attempted}` is selected on rather than interpolated, exactly as
  // `username_invalid` selects on `{reason}`: the four cases are four
  // sentences in English and will be four differently-shaped sentences
  // everywhere else, and splicing a verb into a shared frame is what makes a
  // translation read like a machine wrote it. The `other` arm is the safety
  // net for a server newer than this client that has found a fifth way to
  // leave.
  //
  // `{user_id}` appears only in the `revoke` arm. On the other three the
  // account is the reader's own and naming it would be an odd thing to do to
  // somebody's face; on `revoke` it is somebody else's and leaving it out
  // would make the sentence ambiguous about who the server is worried about.
  'errors.last_admin':
    '{attempted, select, ' +
    'deactivate {You are the only administrator of this server who can sign in, so deactivating your account would leave nobody able to run it.} ' +
    'delete {You are the only administrator of this server who can sign in, so deleting your account would leave nobody able to run it.} ' +
    'move {You are the only administrator of this server who can sign in, so moving your account to another homeserver would leave nobody able to run it.} ' +
    'revoke {{user_id} is the only administrator of this server who can sign in, so removing their access would leave nobody able to run it.} ' +
    'other {That would leave this server with no administrator who can sign in.}} ' +
    'Give server-administrator access to another account that can sign in, then try again.',

  // ------------------------------------------------------------ bot sessions

  // Shown to a person only in the bot management pane; the SDK reads the code
  // and never this string. Written for the admin who is looking at a bot that
  // has stopped working, which is why it says where the bot is not installed.
  'errors.bot_not_installed': 'This bot is not installed on that guild server.',
  // Keyed `assertion_rejected`, not `bot_assertion_rejected`, because the key
  // has to be the code that travels on the wire and the wire says
  // `assertion_rejected` -- the Rust constant is named `BOT_ASSERTION_REJECTED`
  // but its *value* is not. The two were spelled differently here until
  // `i18n-coverage.test.js` compared this file against `server/src/errcodes.rs`
  // and found that this message could never have been reached. Do not "fix"
  // the name to match the constant; fix nothing, and keep the test.
  'errors.assertion_rejected': 'That guild server did not accept this bot’s credentials.',
  'errors.not_a_guild_server': 'That address does not host guilds.',

  // ------------------------------------------------------------ availability

  // `retry_after` is a count of seconds, so it is pluralised. English only
  // needs `one`/`other`; Arabic needs six categories and Japanese needs one,
  // and none of that is this sentence's problem -- each catalogue writes the
  // arms its own language has.
  'errors.rate_limited': '{retry_after, plural, =0 {Slow down a moment and try again.} one {Slow down a moment — try again in # second.} other {Slow down a moment — try again in # seconds.}}',
  'errors.demoted': 'This server has handed over to another node. Reconnecting.',
  'errors.standby_read_only': 'This server is on standby and can only be read from right now. Your message has not been sent.',
  'errors.shut_down': 'This homeserver has been shut down by its operator.',
  'errors.try_again': 'Something else is using that right now. Try again in a moment.',

  // --------------------------------------------------------------- migration

  'errors.migration_in_progress': 'This account is moving to {destination}. It cannot be changed here until the move finishes.',
  'errors.migration_handoff_invalid': 'This migration link is no longer valid. Start the move again from the account you are leaving.',
  'errors.migration_refused': '{destination} refused the move.',

  // ----------------------------------------------------------------- uploads

  'errors.too_large': 'That file is too big. The limit here is {limit, bytes}.',
  'errors.unsupported_media_type': 'Files of type {media_type} are not accepted here.',
  'errors.quota_exceeded': 'Out of space — {used, bytes} of {limit, bytes} used.',

  // ------------------------------------------------------- client-side codes

  // Not server codes. `lib/store/session.js` raises these when it judges a
  // server's *answer* rather than when a server refuses a request: a homeserver
  // that offers only the legacy password exchange to an account this client
  // knows has enrolled in OPAQUE is either very old or lying, and the client
  // will not send a password either way. They live in this namespace because
  // they reach the login screen through exactly the same path as a real code
  // and there is no reason for the screen to care which kind it got.
  'errors.opaque_downgrade': 'This server offered an older, weaker sign-in than your account uses. Telium has not sent your password. If you are on a public network, try again from somewhere else.',
  'errors.legacy_auth_required': 'This homeserver is too old to sign in to with this version of Telium.',

  // --------------------------------------------------------- the bottom rungs

  // What `reportError` puts between "what was being attempted" and "what went
  // wrong". A key rather than a template literal because the colon is not
  // universal: French puts a space before it, and a language that would rather
  // use a dash, a newline or a different word order can have one.
  'errors.context': '{context}: {message}',

  'errors.generic': 'Something went wrong.',

  // A 500 and a 502 are not the same news, and this is the one that says so.
  // A 502 means the request never reached anything that could act on it, so
  // "try again" is simply true. A 500 means a server ran the request and threw
  // somewhere inside it, and nobody on this side of the wire knows how far it
  // got before it did -- so the honest sentence has to leave that open, and
  // must not end with an invitation to press the button again. That is not
  // pedantry: the request that most often 500s is a write, and a cheerful
  // "try again" on a half-finished write is how somebody sends a payment
  // twice.
  'errors.serverFault': 'The server had a problem with that. It may or may not have gone through.',

  // Reached when a fetch produced no response at all, which is what a dropped
  // connection, a captive portal and a DNS failure all look like from here.
  // Phrased as a guess rather than a diagnosis because it is one -- with the
  // exception of the second key, which is not a guess at all.
  //
  // The split is `navigator.onLine`, and it is worth two keys because the two
  // cases call for different actions from the reader and only one of them is
  // anybody's fault. A device with its radio off does not need to hear that
  // Telium could not reach the server; it needs to hear that it is offline,
  // which is a thing the reader can fix in one gesture. Running them together
  // -- which this client did for a long time -- produced the worst of both: an
  // accusation aimed at a server that was answering perfectly.
  //
  // Both say "nothing was sent", and both mean it: `lib/retry.js` has already
  // decided whether the request was safe to replay before anything reaches
  // here, so a request that might have been carried out does not come down
  // this rung.
  'errors.offline': 'Could not reach the server. Nothing was sent; try again in a moment.',
  'errors.offlineDevice': 'This device is offline. Nothing was sent.',

  // ---------------------------------------------------- refusals with no code

  // The rung between the server's own sentence and the generic apology, keyed
  // by HTTP status.
  //
  // These exist because a refusal can be perfectly well-formed and still carry
  // nothing to translate. A reverse proxy in front of a homeserver answers 502
  // with its own HTML; a load balancer answers 503 with nothing at all; an
  // expired session on an older server answers 401 with an empty body. In none
  // of those cases has any Telium code run, so there is no `code` field and no
  // `message` field -- but the *status* is still a fact about what happened,
  // and it is enough to say something better than "Something went wrong."
  //
  // Only the statuses that mean something distinct to a reader are here. A 400
  // is not: a well-behaved server sends a message with it saying which field
  // was wrong, and a server that does not has told us only that it disliked
  // something, which is what the generic line already says. The rule for
  // adding one is whether the number alone licenses a sentence that helps.
  //
  // Every one of them says what to do next rather than naming the status,
  // because the number is not information to the person reading it.
  'errors.status.401': 'Your session has expired. Sign in again to carry on.',
  'errors.status.403': 'You do not have permission to do that here.',
  'errors.status.404': 'That is not there any more.',
  'errors.status.409': 'Somebody else changed that first. Take another look and try again.',
  'errors.status.413': 'That is too large for this server to accept.',
  'errors.status.429': 'You are going too fast for this server. Wait a moment and try again.',
  // 502, 503 and 504 share one sentence on purpose. The difference between
  // them is which box in front of the server gave up, which is a fact about
  // somebody else's infrastructure and not about the reader's afternoon.
  'errors.status.gateway': 'The server is not answering right now. Try again in a moment.',

  // ------------------------------------------------------------ gateway close

  // Keyed by the numeric close code, which is what a websocket close frame
  // actually carries and what `docs/spec/gateway.md` registers. The reason
  // string beside it is English from the server and is the fallback, the same
  // way `message` is for HTTP.
  //
  // These were written from memory against the spec document and four of the
  // six were wrong -- 4001 described 4002's failure, 4002 described 4004's,
  // 4005 claimed a second sign-in where the server means a restart, and 4008
  // claimed a connection limit where the server means the client never
  // identified in time. They are now written from `server/src/gateway/mod.rs`,
  // which is the only place the mapping is actually decided, and the list is
  // in the order that file closes on. A close code is a contract with one
  // implementation; reading the other document is how you end up telling
  // somebody to sign in again because a server rebooted.
  //
  // Two of these say "reconnecting" and four do not, and that is not a
  // stylistic choice: `lib/gateway.js` gives up on 4001, 4002, 4004 and 4015
  // and keeps trying on the rest, so a sentence promising a reconnection on
  // one of the terminal codes would be a sentence that never comes true.

  // The client connected and then never sent IDENTIFY -- which, from the
  // reader's side, is this build doing something wrong rather than the server
  // refusing them. Terminal: the next socket would stall in the same place.
  'errors.gateway.4001': 'Telium could not start a session with this server.',
  // A frame neither end could parse, including a binary frame on a protocol
  // that is text-only in v1. The same disagreement as 4015 wearing a different
  // number, and terminal for the same reason: the retry sends the same frame.
  'errors.gateway.4002': 'Telium and this server disagree about how to talk to each other.',
  // The server's one code for four distinct causes -- authentication failed, a
  // bot session with no application behind it, a revoked session and an
  // expired one. They are one row in `docs/spec/gateway.md` and one sentence
  // here, and the sentence has to be true of all four, so it names the outcome
  // (the session is not good any more) rather than the cause. Terminal: the
  // token in hand is the one that was just refused.
  'errors.gateway.4004': 'This server would not accept your session. Sign in again.',
  // Not a failure. The server is coming back and the token is still good, so
  // `gateway.js` retries this one on a short window rather than the escalating
  // backoff -- which is why the sentence promises the reconnection.
  'errors.gateway.4005': 'This server is restarting. Reconnecting.',
  // The server waited for IDENTIFY and stopped waiting. Distinct from 4001,
  // which is the client never sending one at all; this is the clock running
  // out, usually on a connection slow enough that saying so is useful.
  'errors.gateway.4008': 'Signing in to this server took too long. Reconnecting.',
  'errors.gateway.4009': 'This connection timed out. Reconnecting.',
  // 4010 is new with the bounded gateway outbox, and it is the one close on
  // this list that is about the reader's own device rather than about the
  // server. The server queues events for a session and the queue has a
  // ceiling; a client that stops draining it -- a laptop that slept, a tab
  // the browser froze, a connection that went quiet without closing -- falls
  // past that ceiling and the server drops the socket rather than hold events
  // nobody is reading. So the honest sentence names the gap rather than
  // blaming either end, and says what happens next, because what happens next
  // is the reassuring part: reconnecting takes a fresh READY and the missed
  // events arrive with it. Nothing is lost, and the reader does not need to
  // do anything. Saying "you fell behind" would be accurate and would read as
  // an accusation for something a sleeping laptop did.
  'errors.gateway.4010': 'This connection fell behind and was reset. Catching up.',
  // Two different limits, and the difference matters to the reader because
  // only one of them is about them. 4011 counts sockets belonging to this
  // account -- too many tabs, too many devices, something this reader can act
  // on. 4013 counts unidentified sockets from anywhere, which on a busy server
  // is a stranger's traffic and nothing the reader did.
  'errors.gateway.4011': 'Too many Telium connections open for your account. Close one and try again.',
  'errors.gateway.4013': 'This server is busy accepting connections. Waiting before trying again.',
  // The version handshake, and the one close the server composes real prose
  // for: `mod.rs` sends the incompatibility *and its remedy*, written by the
  // side that knows which of the two ends is out of date. So this entry is
  // almost always the fallback rather than the answer -- `closeMessage` takes
  // the server's reason ahead of it whenever there is one, deliberately
  // inverting the usual order, because a generic sentence about versions is
  // worth less than a specific one naming which half to update.
  'errors.gateway.4015': 'Telium and this server are running incompatible versions.',
  'errors.gateway.unknown': 'The connection closed unexpectedly (code {code}).',
};
