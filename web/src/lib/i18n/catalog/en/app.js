// The screens that exist before the app does, and the one that exists after it
// has fallen over.
//
// Three surfaces, all of them drawn by `src/App.jsx` itself rather than by any
// view underneath it: the "connecting" card, the "your home server is not
// answering" card, and the error boundary. They share a namespace because they
// share a property nothing else in this catalogue has -- they are the strings
// that get read when the rest of the client is not working.
//
// --------------------------------------------- why that changes the translation
//
// Everywhere else, a reader who does not understand a sentence can look at the
// screen around it for context. Here there is no screen around it. The error
// boundary has replaced the entire document with four lines of text, and the
// boot cards are a logo and a paragraph. So each of these has to be
// self-contained: it must say what happened, and it must say what the reader
// can do, without leaning on a heading somewhere else or a button the reader
// can see but this string does not name.
//
// The second consequence is about tone, and it is the one that is easy to get
// wrong in translation. Somebody reading `app.crash.title` has just lost
// whatever they were doing. Somebody reading `app.boot.unreachable` cannot
// sign in and does not know whether the fault is theirs. Neither sentence may
// be cheerful, neither may be chatty, and neither may apologise at length --
// what both readers want is the fact and the next step, in that order. English
// gets there by being flat; a language whose neutral register is different
// should use *its* neutral register rather than transliterating this one.
//
// ------------------------------------------------- the error boundary is special
//
// `app.crash.*` is drawn by a React class component, which is the only place
// in this client that calls the module-level `t()` rather than `useT()`. That
// is not laziness -- a class cannot hold a hook -- and it has one visible
// consequence a translator should know about: the crash screen does not
// re-render when the language changes. It cannot, because nothing is left
// running to tell it to. It draws in whatever language was active at the
// moment of the crash and stays there until the reload it is asking for.
//
// Which means these four strings are also the ones most likely to be read in
// English by somebody whose language is not English: if the thing that threw
// was the catalogue chunk for their language, English is all there is. That is
// the correct behaviour and it is worth not trying to be clever about.

export const app = {
  // --------------------------------------------------------- the crash screen

  // Deliberately says "this screen" and not "Telium". Most render failures
  // take one view down -- a dialog, a settings pane -- and the inner boundary
  // catches them with the store, the sockets and the toasts all still alive.
  // A sentence that said the app had crashed would be wrong in the common case
  // and would send people to reload when they did not have to.
  'app.crash.title': 'Something went wrong while rendering this screen.',

  // The thrown message is drawn underneath this, in a monospace face, and is
  // NOT translated: it is a developer string in an unknown language and
  // pretending otherwise would mean shipping a translation of every error
  // JavaScript can produce. It is there to be copied into a bug report, and a
  // translated one would be worth less in that report, not more.

  'app.crash.reload': 'Reload',
  // The button that opens a pre-filled issue. "Report this" rather than "Send
  // a report", because nothing is sent: it opens a tracker page in a browser
  // and the reader chooses whether to file it. A translation that implies the
  // report has already gone is a promise this button does not keep.
  'app.crash.report': 'Report this',
  // A question, not a label, and that is the point. It is the disclosure that
  // reveals the storage-reset controls, and it is phrased as the sentence the
  // person who needs it is already thinking -- somebody whose first reload
  // fixed things never reads it, and somebody whose second one did not
  // recognises themselves in it immediately. Translate the recognition, not
  // the words.
  'app.crash.recover': 'Still broken after a reload?',

  // ---------------------------------------------------------- the boot screens

  // `{domain}` is a hostname -- `chat.example.org` -- and is data. Never
  // translated, never transliterated, and never wrapped in quotation marks by
  // a translation: the bidi isolation in `format.js` already keeps it from
  // reordering inside a right-to-left sentence, and added punctuation would
  // make people think it was part of the name.
  'app.boot.connecting': 'Connecting to {domain}…',
  // `{name}` is the display name of the account being switched to -- data,
  // never translated.
  'app.boot.switching': 'Switching to {name}…',

  // `{reason}` is whatever the homeserver or the network said, put through
  // `errorMessage`: a translated `errors.*` line when the failure carried a
  // code, and the raw server string when it did not. See `codeOf` in
  // `lib/i18n/errors.js` for why the second case exists and why it is right
  // that it does.
  //
  // There is no full stop after `{reason}` and that is not a typo. This
  // pattern is one sentence wrapped around *another sentence* -- every
  // `errors.*` line in this catalogue ends in its own punctuation, and so does
  // almost every string a server sends. Adding one here produced "... is down.."
  // on every coded failure, which is the kind of defect that survives review
  // for a year because nobody reads the last two characters of an error.
  //
  // A translator whose language punctuates differently should punctuate the
  // half before the colon however their language does, and still leave the end
  // alone: whatever follows the colon arrived already finished.
  'app.boot.unreachable': 'Could not reach {domain}: {reason}',

  // The same screen when the device is the thing that is offline, and a
  // separate key rather than a branch inside the one above because it is not a
  // shorter version of that sentence -- it is a different sentence with a
  // different subject, a different culprit and a different instruction. The
  // screen above names the reader's home server and asks them to wait; this
  // one names their own connection and asks them to fix it. The version of
  // this client that ran them together produced the worst possible line: the
  // browser's `Failed to fetch` appended to a domain that was answering
  // perfectly, while the actual cause was a switched-off radio two feet away.
  //
  // `{domain}` is deliberately absent. Naming a server this device has not
  // tried to reach is the accusation that bug was made of.
  //
  // No `reason` either, and for the same reason the notice below is not drawn
  // in this state: everything the client could say about the failure is
  // downstream of a network that is not there, so there is nothing true to add
  // and the shorter screen is the more honest one.
  'app.boot.offline': 'This device is offline. Telium will sign you in as soon as the connection is back.',

  // The distinction this makes is the whole reason the screen exists rather
  // than showing an empty app. A dead home server does not sign you out and
  // does not end the sessions you already hold -- it stops new ones being
  // minted, which is why guilds you are already in keep working for a while
  // and new ones fail. Getting that backwards in translation turns a wait into
  // a panic.
  //
  // "Home server" is two words here and one word ("Homeserver") in
  // `common.homeserver`. See the note there: the compound is the term of art
  // for the software, and this sentence is talking about the reader's own
  // server as a thing in the world.
  'app.boot.unreachableNotice': 'Server sessions keep working until they expire, but new ones cannot be minted while your home server is down.',

  // The way out of this screen for somebody whose home server is not coming
  // back. Not `security.devices.signOut`: that one is a verb aimed at another
  // device in a list, this one is aimed at the reader's own session, and a
  // language that marks the object differently needs the two apart.
  'app.boot.signOut': 'Sign out',
};
