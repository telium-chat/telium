// Appearance, language, and the message-display switches.
//
// The settings panes that are *about* the interface rather than about the
// account. Security, devices and notifications are their own namespaces,
// because they are read by somebody with a different question in mind and
// because keeping them apart is what lets four people translate four panes
// without merging into each other.
//
// ------------------------------------------------------- the theme preset names
//
// `settings.theme.preset.<id>.name` and `.description` are keyed by the ids in
// `lib/scheme.js`, which is where they used to live as literals. They moved
// here rather than staying next to the numbers they name because a preset name
// is the only thing about a preset that is not a fact about colour: `hue: 75`
// is the same in every language and "Ash" is not.
//
// They are also the entries in this file a translator is most likely to get
// wrong, and the mistake is always the same one: translating the *word* rather
// than the *thing*. "Graphite" is not a request for the local word for the
// mineral -- it is a name for a very dark neutral grey with a trace of violet
// in it, and a language whose word for graphite carries no such association
// should pick a different word entirely. The descriptions say what each one
// actually looks like precisely so a translator can name it again from
// scratch. Somebody choosing a theme is choosing a picture, not a vocabulary
// test.
//
// ---------------------------------------------------------------- the sliders
//
// The custom-scheme knobs are the hardest copy in this file to translate and
// the easiest to translate badly. Each label is one word standing for a
// quantity the reader cannot see named anywhere else in the product, and each
// hint is the only explanation of it that exists. A hint that becomes a
// literal translation of the English metaphor ("how far a card *lifts off* the
// page") will read as nonsense in a language that does not put cards on pages;
// what the sentence has to convey is that the number controls how different a
// card's fill is from the page behind it. Translate the fact, not the figure
// of speech.

export const settings = {
  // -------------------------------------------------- the name of a pane

  // The title of the encryption-key pane in user settings, and the only pane
  // title in that screen that lives in the catalogue at all. The other sixteen
  // are still literals in `views/user-settings/UserSettings.jsx`, which is not
  // a migrated file. This one had to come out ahead of the rest because five
  // sentences in two other namespaces send the reader to that pane by name,
  // and a name cited in five translated sentences cannot go on living in a
  // file no translator ever opens.
  //
  // The five are `chat.encryption.custody.escrowed`,
  // `chat.encryption.escrowedNote`, `chat.encryption.vaultLocked.body`,
  // `chat.encryption.recoveryFallback.body` and `security.devices.cannotSign`.
  // Each interpolates this entry as `{pane}` instead of spelling it out. That
  // is the whole reason the key exists: an instruction that names a control is
  // wrong the instant the two spellings drift, and two spellings in two
  // namespaces translated by two people on two different days will drift. The
  // placeholder makes the drift impossible rather than merely discouraged.
  // The precedent is `channel.perms.privateHintOn`, which takes the view
  // permission's own name for exactly this reason.
  //
  // What that means for a translator: translate this one entry and all five
  // sentences follow it in the same breath, with nothing else to edit. Leave
  // it and they all keep saying "Encryption key", which is what the pane
  // itself still says on your screen, because the pane list around it has not
  // been migrated yet. Both of those are self-consistent and either is fine.
  // What is no longer possible is translating one and not the others, which
  // is the failure this key was made to prevent.
  //
  // Keyed under `nav` to match `guild.nav.*`, the same idea one screen over:
  // the sidebar row and the heading at the top of the pane are one string
  // drawn twice, so there is one key and not a `nav` and a `title`.
  //
  // "Key" here is the recovery key that opens your message history -- not a
  // password, and not the passphrase, which is one of the ways to get at it.
  // The pane is named for what somebody arrives looking for rather than for
  // the machinery behind it (the keyring, the vault, the recovery parts), so
  // a language with a choice between the everyday word for a key and a
  // cryptographic term of art should take the everyday one.
  'settings.nav.recovery': 'Encryption key',

  // ------------------------------------------------------------------- theme

  'settings.theme.title': 'Theme',
  // "Follows you" = syncs with the account rather than staying on this device.
  // Worth saying because the alternative is genuinely what people expect from
  // a display setting, and somebody who does not want their work laptop's
  // theme on their phone deserves to find that out here and not later.
  'settings.theme.description': 'Follows you to your other devices.',

  'settings.theme.preset.graphite.name': 'Graphite',
  'settings.theme.preset.graphite.description': 'Deep neutral grey. The default.',
  'settings.theme.preset.obsidian.name': 'Obsidian',
  // Not a figure of speech: the pixels really are `#000`, and an OLED panel
  // does not light a black pixel at all. The sentence is here to explain the
  // battery saving, so keep the causal link.
  'settings.theme.preset.obsidian.description': 'Black to the pixel, which an OLED screen turns off.',
  'settings.theme.preset.ash.name': 'Ash',
  'settings.theme.preset.ash.description': 'A warmer, lighter grey for a room with a lamp on.',
  'settings.theme.preset.midnight.name': 'Midnight',
  // "the way Telium used to open" -- a nod to the old default, for people who
  // miss it. A language with no way to carry the nostalgia can drop it; what
  // must survive is "violet-tinted dark grey".
  'settings.theme.preset.midnight.description': 'Violet in the grey, the way Telium used to open.',
  'settings.theme.preset.evergreen.name': 'Evergreen',
  'settings.theme.preset.evergreen.description': 'Dark, with the green of a long night indoors.',
  'settings.theme.preset.paper.name': 'Paper',
  'settings.theme.preset.paper.description': 'Paper white, for a bright room.',

  'settings.theme.custom.label': 'Build your own',
  'settings.theme.custom.description': 'A handful of sliders, and the app changes under them as you go.',

  // ------------------------------------------------------- the custom scheme

  'settings.scheme.title': 'Your scheme',
  'settings.scheme.description': 'Every position on every slider stays readable; that is what the ends of them are for.',

  'settings.scheme.mode.label': 'Page',
  'settings.scheme.mode.hint': 'Which of the two palettes the rest of these adjust.',
  'settings.scheme.mode.dark': 'Dark',
  'settings.scheme.mode.light': 'Light',

  'settings.scheme.depth.label': 'Depth',
  // Two hints for one slider, because the slider means a different thing at
  // each end of the light/dark switch: on a dark page the bottom of the range
  // is true black, and on a light page there is no black anywhere near it.
  // Kept as two keys rather than one `select` because they are two sentences
  // with nothing in common, and a `select` would ask a translator to keep two
  // unrelated ideas inside one pattern.
  'settings.scheme.depth.hintDark': 'All the way down is true black, which an OLED screen turns off.',
  'settings.scheme.depth.hintLight': 'How far the page sits below white.',

  'settings.scheme.separation.label': 'Separation',
  'settings.scheme.separation.hint': 'How far a card lifts off the page, and the sidebar sinks behind it.',

  'settings.scheme.tint.label': 'Tint',
  // "None of it is a colour you would name" is doing real work: the numbers
  // here top out around 0.02 chroma, which is visible as warmth or coolness
  // and never as a hue. Without the sentence people turn it to maximum
  // expecting a coloured interface and conclude the slider is broken.
  'settings.scheme.tint.hint': 'How much colour is in the greys. None of it is a colour you would name.',
  // The reading beside the slider when the tint is fully off. A word rather
  // than `0.000`, because zero tint is a state and not a quantity.
  'settings.scheme.tint.none': 'none',

  'settings.scheme.greyHue.label': 'Grey hue',
  'settings.scheme.greyHue.hint': 'Which way the tint leans. It does nothing while the tint is off.',

  'settings.scheme.accentHue.label': 'Accent hue',
  'settings.scheme.accentHue.hint': 'Links, the focus ring, the caret and unread state. There is only the one.',

  'settings.scheme.accentStrength.label': 'Accent strength',

  // The readings beside each slider. Percentages and angles go through
  // `number` and not through a template literal, so a locale that writes
  // `95,2 %` with a comma and a space gets one, and Arabic gets Arabic-Indic
  // digits. The degree sign is a symbol rather than a word in every script
  // this client ships, so it is part of the pattern.
  'settings.scheme.reading.percent': '{value, number, fixed1}%',
  'settings.scheme.reading.degrees': '{value, number, integer}°',
  'settings.scheme.reading.amount': '{value, number, fixed3}',

  // ---------------------------------------------------------------- language

  'settings.language.title': 'Language',
  'settings.language.label': 'Interface language',
  // The one row in the picker that names a behaviour rather than a language,
  // and therefore the one row written in the language currently on screen.
  'settings.language.auto': 'Use system language',

  // What the hint under the picker says depends on how much translation there
  // is, which is why it is a `select` on a state this client computes rather
  // than a sentence somebody has to remember to update when a language lands.
  //
  //   `none`     -- English is the only catalogue in the build.
  //   `partial`  -- at least one shipped language is incomplete.
  //   `complete` -- every shipped language is finished.
  //
  // `{languages}` is a list built by `Intl.ListFormat`, so it already has the
  // right conjunction and the right commas for the reader's language; the
  // pattern must not add its own "and".
  'settings.language.hint': '{state, select, none {English only for now. Telium is built to be translated — see the translator guide if you would like to help.} partial {{languages} are partly translated; anything not translated yet appears in English.} other {Telium is available in {languages}.}}',

  // ---------------------------------------------------------------- messages

  'settings.messages.title': 'Messages',
  'settings.messages.compact.label': 'Compact messages',
  'settings.messages.compact.hint': 'Trades the space between messages for more of them on screen.',
  'settings.messages.members.label': 'Show the member list',
  // Says the quiet part: hiding the list is not only a display change, it
  // stops a subscription. People who turn it off to save bandwidth should
  // learn that it works, and people who wonder why presence went stale should
  // be able to find the reason.
  'settings.messages.members.hint': 'The member list is range-subscribed, so hiding it also stops the updates.',
  'settings.messages.typing.label': 'Send typing indicators',
  'settings.messages.typing.hint': 'Off means guild servers are never told that you started writing.',

  // How a date is written when a message is old enough to carry one -- which
  // is "any day that is not today"; see `beforeToday` for where that boundary
  // comes from. The hint says when a date appears at all, because the setting
  // chooses the shape of something the reader has not necessarily seen yet.
  //
  // The choice is an order and only an order: which of the two numbers comes
  // first. The labels are the notation rather than an example date, because
  // the example would be this catalogue's English -- separators, digits, all
  // of it -- while what the setting changes is where the day goes, and the row
  // keeps the reader's own locale for everything else. What an older client
  // stored here was a style name (`medium`, `short`, `dayMonth`) rather than
  // an order, which is not a choice the reader made and is read as their
  // locale's own order rather than as `mdy`.
  'settings.messages.dateFormat.label': 'Date format',
  'settings.messages.dateFormat.hint': 'Messages from a day other than today show their date beside the time. This chooses whether the month or the day comes first.',
  'settings.messages.dateFormat.mdy': 'MM/DD/YY',
  'settings.messages.dateFormat.dmy': 'DD/MM/YY',

  // --------------------------------------------------------- profile lookups

  // The three options on the Profile lookups pane, keyed by the mode ids in
  // `lib/mutual-lookups.js` so that the pane can map over `LOOKUP_MODES`
  // rather than name each one twice.
  //
  // Two rules hold across all six strings, and a translation that breaks
  // either one breaks the setting rather than merely reading oddly.
  //
  // **Each label names the act that spends the requests, in the first person,
  // from the reader's side.** Not "Prefetch on hover" and not "Eager" -- the
  // question these answer is "when am I willing for this to happen", and the
  // answer has to be a thing the reader recognises themselves doing. Somebody
  // who has never heard the word prefetch has still definitely pointed at a
  // name.
  //
  // **No label or description says which one is safe, private or
  // recommended.** The argument for the default is in `lib/mutual-lookups.js`
  // where it can be reviewed; a description that editorialises would also be
  // lying, because the middle option produces exactly the same disclosure as
  // the loose one every time it fires. The descriptions say what happens and
  // what it costs, and let the `privacy.lookups.*` note under them supply the
  // audience.
  'settings.lookups.title': 'When to look up what you have in common',

  // The old behaviour. The description has to carry the part nobody guesses:
  // it is not that hovering is *faster*, it is that crossing a member list
  // spends the whole fan-out on names you never opened.
  'settings.lookups.hover.label': 'Whenever I point at a name',
  'settings.lookups.hover.description': 'Mutual friends are ready the instant a card opens. Running your pointer down a member list asks about each name it rests on, including the ones you had no intention of opening.',

  // The default. "a moment after" is deliberate and must survive translation:
  // it sets the expectation that the chips arrive late, which is what
  // `reserveMutuals` holds the space for, so the delay reads as the thing that
  // was chosen rather than as the interface being slow.
  'settings.lookups.open.label': 'When I open somebody’s profile',
  'settings.lookups.open.description': 'Nothing is asked while you are only reading names. Opening a profile asks about that one person, and the answer fills in a moment after the card.',

  // Not "Off", because off suggests a feature being disabled rather than a
  // question not being put. The description names what disappears, because a
  // person choosing this should not discover the consequence later and read
  // it as a fault.
  'settings.lookups.never.label': 'Never',
  'settings.lookups.never.description': 'No server is ever asked. Profiles stop showing friends and spaces you have in common, including on people you have known for years.',

  // The empty states on the two profile tabs while the setting is Never.
  //
  // They exist because the alternative was worse in a specific way: with no
  // handling the panels sit on "Finding mutual friends…" forever and the tabs
  // read "0 Mutual Friends", which is a client telling somebody a falsehood
  // about a stranger -- you have no friends in common -- when the truth is
  // that it declined to ask on their behalf. The body says where the decision
  // lives so the state is recoverable by the person looking at it, and says it
  // once rather than on both tabs in two different wordings.
  'settings.lookups.off.friendsTitle': 'Not looked up',
  'settings.lookups.off.guildsTitle': 'Not looked up',
  'settings.lookups.off.body': 'Profile lookups are set to never ask, so nothing here was checked. This is not a claim that you have nothing in common.',
};
