// The chrome around every screen, and the sentences it says about the network.
//
// Two groups of strings share this namespace because they share a surface:
// everything here is drawn by `views/Shell.jsx`, either as the frame around
// whatever view is open or as a banner across the top of it.
//
// -------------------------------------------- why the banners are the hard part
//
// `shell.socket.*` and `shell.fallback.*` are the sentences a person reads when
// Telium is not working, and they are the only strings in this catalogue whose
// job is to answer a question rather than to label a control: *is this my
// problem, somebody else's problem, or nobody's?* `lib/failure.js` opens with
// the argument for why that question deserves six different answers instead of
// one spinner, and it is worth reading before touching any of these.
//
// The practical consequence for a translator is that these sentences carry
// information that is not recoverable from the screen around them. A label can
// be a little vague and be rescued by the button underneath it; "your home
// server is down and messages will not send until it is back" cannot, because
// the screen it is drawn on looks exactly like the screen where everything is
// fine. If one of these has to be longer in another language to stay true, make
// it longer. `.banner-stack` scrolls.
//
// Three of them carry a `{role}` or `{promoted}` selector rather than existing
// as two keys, and the selector is always about *whose* server failed, never
// about severity. Getting that backwards produces the specific failure the
// banner rewrite existed to fix: a person whose own account server is
// unreachable being told that "the rest of Telium works normally", which is
// both false and the reason they stop trusting the banner.
//
// ------------------------------------------------------------ {name} is a domain
//
// Every `{name}`, `{home}` and `{standby}` here interpolates a server's domain
// -- `chat.example.org` -- and never a display name or a person. It is a
// technical token in the middle of a sentence, which in a language that
// inflects the surrounding words is the awkward case: prefer a construction
// that keeps the domain in a position where it does not have to agree with
// anything, the way English keeps it as a bare subject. `lib/failure.js`
// substitutes the string `that server` when it has no domain to name, which is
// `shell.socket.unnamedServer` below, so the sentence must read acceptably with
// that in the slot too.
//
// ---------------------------------------------------- the lag is four keys, not one
//
// `shell.fallback.lag*` could be one message with a `select` over the unit
// wrapping a `plural` over the count. It is four keys because the ICU subset in
// `format.js` is deliberately a subset, and a nested select-around-plural is
// exactly the kind of construction that is easy to write here and hard to be
// sure of in a language with six plural arms. Four flat keys cost a translator
// nothing and cannot be subtly wrong.

export const shell = {
  // ------------------------------------------------------------- the empty frame

  // Drawn when the app is open and no channel is. Both halves are deliberately
  // short: this is not an error, nothing is wrong, and a paragraph explaining
  // how to pick a channel would imply otherwise.
  'shell.empty.title': 'No channel open',
  'shell.empty.body': 'Pick a channel to start.',

  // ---------------------------------------------------------------- the chrome

  // Screen-reader names for the three controls that have an icon and no text.
  // Not `common.a11y.close`: that one closes a dialog, and a person navigating
  // by landmark needs to know *which* of the two panels a button collapses,
  // because on a phone both are open over the conversation and both look the
  // same.
  'shell.a11y.closeMenu': 'Close menu',
  'shell.a11y.closeMembers': 'Close members',
  'shell.a11y.openChannels': 'Open channels',

  // One string for the member filter's label and its placeholder. They are the
  // same words on purpose -- the label is visually hidden and exists for
  // assistive technology, so two different phrasings would mean a screen reader
  // announcing something the sighted user cannot see.
  'shell.members.search': 'Search members',

  // The two secondary views a channel can have. Plural in English because each
  // names a collection rather than an action.
  'shell.tabs.forum': 'Forum posts',
  'shell.tabs.pinned': 'Pinned messages',

  // The name a phone's title bar shows for a guild whose own name has not
  // arrived yet -- a deep link opened cold, or a server still handshaking. It
  // is a placeholder measured in hundreds of milliseconds, but it is the first
  // word of the app a person sees on a slow connection, so it gets translated
  // like any other. The sibling case, "no guild at all", uses
  // `notifications.system.appName`: the product name is one string and lives in
  // one place, because a locale that transliterates it must not have to
  // remember to do so twice.
  'shell.title.guild': 'Guild',

  // --------------------------------------------------------------- the banners

  // Reading a cached copy of the app's own state, from before the connection
  // went. `{when}` is a formatted relative time -- "4 minutes ago" -- so the
  // sentence must read as though a phrase, not a timestamp, is dropped in.
  'shell.banner.cached': 'Showing your last state from {when}. Reconnecting…',

  // The four things a banner can offer. Each is a verb aimed at the reader.
  //
  // `retryHome` names a domain because the reader may be reading a copy served
  // by a different one, and "try again" without saying which server would be
  // ambiguous in the one situation where the ambiguity matters.
  'shell.banner.retryHome': 'Try {domain} again',
  'shell.banner.signIn': 'Sign in again',
  // "Telium" and not "the page": the desktop and Android shells draw this too,
  // and neither of them has a page.
  'shell.banner.reload': 'Reload Telium',
  // Offered only where something is already retrying on a backoff measured in
  // minutes. It means "stop waiting and try now", not "start trying".
  'shell.banner.wake': 'Try again now',

  // ------------------------------------------------- what went wrong with a socket

  // What `lib/failure.js` calls a server it has no domain for. It lands in the
  // `{name}` slot of every sentence below, so it has to be a noun phrase that
  // survives being the subject of all of them.
  'shell.socket.unnamedServer': 'that server',

  // The device, checked before any server is blamed. A machine with no network
  // fails every connection in the same second, and there is no close code that
  // distinguishes that from every one of those servers dying at once -- so this
  // sentence must not mention a server, because naming one would be an
  // accusation the client cannot support.
  'shell.socket.offline': 'This device is offline. Telium will pick up where it left off when the connection is back.',

  // The client is too old to speak to this server at all. Used only when the
  // server did not send its own words; when it did, those are shown instead,
  // untranslated, because the server knew which end was behind and this client
  // does not.
  'shell.socket.incompatible': '{name} speaks a version of Telium this client does not. Update Telium and try again.',

  // The other direction of the same disagreement: the server rejected what this
  // client sent. "Out of step" rather than "broken" because either end may be
  // the newer one and the reader cannot tell which.
  'shell.socket.malformed': '{name} did not understand what this client sent it. Reload Telium; if it keeps happening, this client and that server are out of step.',

  // A refused session. The selector is the whole message: losing the session on
  // your own account server stops everything, and losing it on one guild's
  // server stops that guild. Telling somebody the rest of Telium is unaffected
  // when it is their home server is the mistake this key exists to prevent.
  'shell.socket.sessionRefused': '{role, select, home {{name} no longer recognises this session. Sign in again to carry on.} other {{name} no longer recognises this session. Reconnect to it; the rest of Telium is unaffected.}}',

  // A planned restart, announced by the server on its way out. The one failure
  // where "wait" is a real answer rather than a euphemism, and the sentence
  // should sound like it.
  'shell.socket.restarting': '{name} is restarting. This will come back on its own.',

  // The first few seconds of any unexplained disconnection, before the client is
  // willing to call it an outage. Same selector, same reason as above.
  'shell.socket.reconnecting': '{role, select, home {Reconnecting to {name}.} other {Reconnecting to {name}. Other servers are unaffected.}}',

  // A home server that has been gone long enough to stop calling it a blip. The
  // consequence comes first because it is the part that is not obvious: guild
  // servers keep answering, so the screen looks alive, and somebody who does not
  // know this will keep typing into a room that is quietly dropping everything.
  'shell.socket.homeDown': '{name} is your account’s server and it is not answering. Messages you send will not go anywhere until it is back. Telium keeps retrying; if this lasts, whoever runs {name} is the person to ask.',

  // One guild's server, same duration, opposite consequence. "The rest of Telium
  // works normally" is true here and must stay in the sentence: without it this
  // reads like a total outage.
  'shell.socket.guildDown': '{name} is not answering. The rest of Telium works normally. Telium keeps retrying; if this lasts, that server’s operator is the person to ask.',

  // ------------------------------------------------------- reading a warm standby

  // Two situations that are indistinguishable from the inside -- same URL, same
  // account, same messages -- and could hardly be more different. One is a copy
  // of a stopped server that will refuse everything typed into it; the other is
  // the account being served from somewhere else and working normally. Saying
  // which is the entire job of this banner, so these two must not converge into
  // one reassuring phrasing in translation.
  'shell.fallback.promoted': '{home} is now being served by {standby}. Everything works normally.',
  'shell.fallback.readOnly': '{home} is not answering. Showing a read-only copy from {standby}, {lag}.',

  // How far behind the copy is, dropped into the `{lag}` slot above. Rounded to
  // a unit somebody can act on: "4 minutes behind" tells a reader whether to
  // trust what they are looking at and "247183 ms" does not.
  //
  // `lagUnknown` is a real state, not a fallback for a bug: a standby that has
  // not yet reported its position is common in the first seconds of a failover,
  // and claiming "0 seconds behind" there would be the most dangerous possible
  // lie in this file.
  'shell.fallback.lagUnknown': 'unknown age',
  'shell.fallback.lagSeconds': '{count, plural, one {# second behind} other {# seconds behind}}',
  'shell.fallback.lagMinutes': '{count, plural, one {# minute behind} other {# minutes behind}}',
  'shell.fallback.lagHours': '{count, plural, one {# hour behind} other {# hours behind}}',
};
