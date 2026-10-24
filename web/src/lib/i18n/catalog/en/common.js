// The words that appear on more than one screen.
//
// ------------------------------------------------- when a key belongs in here
//
// A key belongs in `common` when the *same* word means the *same* thing in
// every place it is used. "Cancel" on a dialog that discards a draft and
// "Cancel" on a dialog that abandons an account migration are the same word
// and the same act, so there is one key. "Save" on a settings pane and
// "Send" on a composer are two words and two acts, so there are two.
//
// This is a sharper line than it looks and getting it wrong is the classic
// way a translation goes bad. English collapses distinctions other languages
// keep: our one "close" is the verb on a button and the adjective on a status
// and German has two different words; our one "you" is the same for a stranger
// signing up and a member being warned, and half of Europe has two. So the
// rule is not "is this the same string" -- it is "is this the same *sentence*,
// used the same way, by the same speaker, to the same person". If the answer
// is no, it is two keys even when it is one English word, and the second key
// lives in the namespace of the screen it belongs to.
//
// The cost of getting it wrong in the safe direction -- two keys where one
// would do -- is that a translator types a word twice. The cost of getting it
// wrong in the other direction is a sentence that cannot be fixed without a
// code change, discovered by a native speaker months after release. Duplicate
// freely.
//
// ------------------------------------------------------------- the util group
//
// `common.convo.*` and `common.activity.*` are here rather than in a namespace
// of their own because they are produced by `lib/util.js`, which is imported
// by roughly forty components and belongs to none of them. Putting them under
// the screen that happens to draw them would be a lie about where they come
// from.

export const common = {
  // ------------------------------------------------------------- the verbs

  'common.cancel': 'Cancel',
  'common.close': 'Close',
  'common.back': 'Back',
  'common.next': 'Next',
  'common.done': 'Done',
  'common.save': 'Save',
  'common.saving': 'Saving…',
  'common.saved': 'Saved',
  'common.confirm': 'Confirm',
  'common.continue': 'Continue',
  'common.copy': 'Copy',
  'common.copied': 'Copied',
  // The toast after a copy. `{what}` is the translated name of the thing --
  // "Invite link", "Recovery key" -- handed in by whichever button was
  // pressed, so this is one sentence a translator can rearrange rather than a
  // fragment glued to a noun in JavaScript. See `lib/clipboard.js`.
  'common.copiedThing': '{what} copied.',
  'common.clipboardFailed': 'Could not reach the clipboard.',
  'common.delete': 'Delete',
  'common.remove': 'Remove',
  'common.retry': 'Try again',
  'common.refresh': 'Refresh',
  'common.edit': 'Edit',
  'common.download': 'Download',
  'common.dismiss': 'Dismiss',
  'common.learnMore': 'Learn more',
  'common.showMore': 'Show more',
  'common.showLess': 'Show less',
  'common.search': 'Search',
  'common.loading': 'Loading…',
  'common.enable': 'Enable',
  'common.disable': 'Disable',
  'common.on': 'On',
  'common.off': 'Off',
  'common.yes': 'Yes',
  'common.no': 'No',
  'common.none': 'None',
  'common.never': 'Never',
  'common.unknown': 'Unknown',
  'common.optional': 'Optional',
  'common.required': 'Required',

  // A dash where a value would be, used in tables. A separate key rather than
  // a literal because scripts that write right to left use a different
  // character for it, and because a translator seeing it in the list learns
  // that this app has a convention for "nothing here" and can match it.
  'common.empty': '—',

  // --------------------------------------------------------- accessibility

  // Labels for controls whose visible content is a glyph. These are read
  // aloud, never drawn, which changes how they should be written: a screen
  // reader announces the role ("button") itself, so "Close button" is heard as
  // "Close button button". Name the action, nothing else.
  'common.a11y.close': 'Close',
  'common.a11y.back': 'Go back',
  'common.a11y.menu': 'More actions',
  'common.a11y.dismissNotice': 'Dismiss this notice',
  'common.a11y.copyToClipboard': 'Copy to clipboard',
  'common.a11y.showPassword': 'Show password',
  'common.a11y.hidePassword': 'Hide password',
  'common.a11y.loading': 'Loading',
  // Announced by a live region when a step finishes, so somebody who cannot
  // see the tick knows it happened.
  'common.a11y.stepDone': '{step} — done',

  // ------------------------------------------------------------- the nouns

  // One word, and `app.boot.unreachableNotice` says "home server" in two. That
  // is not an inconsistency anybody forgot to fix: the compound noun is the
  // term of art for the *software* -- the thing a person runs, picks from a
  // list, or types the address of -- and it is what this label names, on a
  // field and in a settings row. The two-word form is the ordinary English
  // phrase for the reader's own server as a thing in the world, and it is what
  // a sentence about an outage should use.
  //
  // A language that has no equivalent distinction should use one word for
  // both; a language whose word for a server is not a noun a possessive can
  // attach to should rephrase the sentence rather than the label. What must
  // not happen is that this becomes a *transliteration* of the English
  // compound in a language that has a perfectly good word of its own.
  'common.homeserver': 'Homeserver',
  'common.username': 'Username',
  'common.password': 'Password',
  'common.email': 'Email',
  'common.account': 'Account',
  'common.device': 'Device',
  'common.settings': 'Settings',

  // -------------------------------------------------------- conversations

  // A group chat has no name of its own, so it is named by its size. The
  // count includes the reader, which is why `lib/util.js` adds one before
  // passing it: "Group - 3 people" is you and two others, and a group that
  // said "2 people" while showing three avatars would be read as a bug.
  //
  // Pluralised even though the count can never be one in practice -- a
  // one-person group is a DM and is named for the other person. The `one` arm
  // exists because a language with a `one` category needs it to *exist* for
  // the message to be well-formed, and because "can never happen" is a claim
  // about today's `conversations.js`.
  'common.convo.group': '{count, plural, one {Group - # person} other {Group - # people}}',

  // The five kinds of detected activity, as the verb that introduces the
  // name of what somebody is doing. Kept as five separate keys rather than one
  // `select` because they are drawn separately from the name -- the verb
  // carries the presence colour and the glyph, the name does not -- and
  // because "Listening to" is a verb plus a preposition that other languages
  // attach to the other end of the phrase or not at all.
  //
  // Which means a language where the verb cannot precede the name has a
  // problem this key shape cannot solve, and `common.activity.line` below is
  // the escape hatch: the surfaces that draw the whole phrase as one string
  // use it, so a translator can put the pieces in the right order there even
  // though the two-part rendering is stuck with ours.
  'common.activity.playing': 'Playing',
  'common.activity.streaming': 'Streaming',
  'common.activity.listening': 'Listening to',
  'common.activity.watching': 'Watching',
  'common.activity.competing': 'Competing in',
  'common.activity.line': '{verb} {name}',

  // The two defaults of `components/DataTable.jsx`, and they are here rather
  // than in that component because they are the last two English literals on a
  // primitive that five migrated surfaces draw.
  //
  // `table.empty` is visible and was at least obvious. `table.label` was not:
  // it is the `aria-label` on the table, so a caller that forgets to pass one
  // announced the word "Records" to a screen reader -- in German, in Japanese,
  // in Arabic, in every locale, with nothing on screen to reveal it. A sighted
  // reviewer cannot see this bug and a monolingual one cannot hear it, which
  // is exactly the class of string that survives a migration unless somebody
  // goes looking for the defaults rather than the visible text.
  //
  // Both stay deliberately generic. A default is what renders when the caller
  // has said nothing about what the rows are, so "Records" cannot become
  // anything more specific without lying on four of the five surfaces; the
  // right fix for any particular table is for its caller to pass a real label,
  // and several now do.
  'common.table.empty': 'Nothing here.',
  'common.table.label': 'Records',
};
