// How a guild gets a program to act on its behalf.
//
// One namespace, because every surface in it asks one decision -- *what is
// allowed to act here, and how much of this guild does it get?*
//
//   * **Installed bots.** Somebody else's application, fetched from somebody
//     else's home server, handed a list of powers over this guild. The install
//     card is a consent screen and the copy in it is consent copy.
//
// ------------------------------------------------- how to translate this file
//
// **The install card is consent copy, and consent copy is not softened.** The
// sentences under `bots.install.*` are what somebody reads in the ten seconds
// before they give a program from another domain the ability to read every
// message in their guild. If the English says a permission is *powerful*, or
// that a grant *takes effect immediately*, or that this server *will not hand
// it back*, the translation says the same thing with the same force. A
// translation that hedges ("may take effect", "is considered powerful") has
// changed what the reader will decide, which is the only thing this screen
// does.
//
// **Two words are terms of art here, and the call on each one is different.**
// Getting these wrong does not produce an awkward sentence, it produces a
// reader who thinks two things are one thing.
//
//   * **"bot"** -- TRANSLATE IT. It is a common noun, not a name: it means an
//     account driven by a program rather than by a person, and every chat
//     client in every language has a word for that. Whatever word a language
//     picks, it has to be the same word in `bots.install.*` and in
//     `bots.list.*`, because a reader who meets two
//     words will reasonably assume two kinds of thing. The one place to think
//     twice is `bots.list.badge` -- see the note there.
//   * **"intent"** -- TRANSLATE IT, but translate the protocol meaning and not
//     the English word's ordinary one. An intent here is not a wish or a
//     purpose: it is *one feed of events a bot asks to be sent*, the switch
//     that decides whether this bot is told about members joining or about
//     messages being typed. Where a language has no natural noun for that,
//     something closer to "event feed" or "subscription" is a better
//     translation than the cognate of "intent". Nothing is lost by moving away
//     from the English word: `bots.list.colIntents` sits above a column of the
//     protocol's own constants, which are shown untranslated (see below), so
//     the reader always has the machine spelling in front of them anyway.
//
// **"Permission" is not this namespace's word.** Every permission bit already
// has a translated name and a translated sentence in `perms.js`
// (`perms.<BIT>.label` and `perms.<BIT>.hint`), and those are what the
// checklists draw. Use the same word for the category here that `perms.js`
// uses for the things in it.
//
// -------------------------------------------------------- what is not a string
//
// A good deal of what is on these screens is data, and none of it is
// translated, transliterated or reformatted:
//
//   * **`{name}`** on the install card is the name a *remote* application gave
//     itself, fetched over federation. It is not a string this project wrote
//     and may be in any language or none.
//   * **Account ids and application references** (`@ping:bots.example`,
//     `bots.example/01ARZ3…`) are identifiers somebody will compare against
//     something else. Never localise their digits.
//   * **Capability constants** -- `GUILD_MESSAGES`, `MESSAGE_CONTENT`,
//     `MANAGE_MESSAGES` -- are the wire's own spelling, shown so that a
//     developer and an administrator can talk about the same bit. They are
//     drawn as themselves in the installed-bots table on purpose: the
//     human-readable name is beside them in the checklists, and the constant
//     is what appears in the developer's documentation and in a support
//     thread. Leave them exactly as they arrive.
//
// ---------------------------------------------------------------- the shape
//
// Two sentence pairs in here look alike and are not, and both pairs are
// marked at the keys: `bots.install.*` is about a bot that is not installed
// yet and can still be refused, and `bots.edit.*` is about one that is running
// right now and whose grants are being cut. The second is the more urgent of
// the two and it is the one where "immediately" is load-bearing.

export const bots = {
  // ------------------------------------------------------------- installing
  //
  // The consent screen. It is read in order -- what is this, who is serving
  // it, what does it want, install -- and the order is the argument, so the
  // keys are written in the order they are read.

  'bots.install.title': 'Install bot',
  // The opening explanation, above the reference box. Two facts in it are
  // doing the work and neither is decoration: the descriptor is *signed*, so
  // what the card shows is what the origin published; and nothing is installed
  // until the reader presses the button, so reading the card costs nothing.
  // Keep both.
  'bots.install.intro': 'Paste an application reference. Telium will fetch the bot’s signed application descriptor and show exactly what it is asking for before anything is installed.',
  'bots.install.referenceLabel': 'Application reference',
  // An example of the *shape* of a reference, not a sentence: a host, a slash,
  // and the first digits of an application id. Leave it exactly as it is. The
  // host is the reserved documentation domain and the digits are a ULID
  // prefix -- localising either one would teach somebody to type a reference
  // that cannot resolve.
  'bots.install.referencePlaceholder': 'bots.example/01…',
  'bots.install.referenceHint': 'Paste the reference copied from the bot developer.',
  // Replaces the hint above while the descriptor is being fetched across
  // federation, which against a cold remote is genuinely seconds. It sits in
  // the same narrow line under the field, so it cannot grow much.
  'bots.install.loading': 'Loading application…',

  // The eyebrow over the origin, in small capitals above the address.
  //
  // It is the first thing on the card and it is deliberately blunt about whose
  // program this is. The address underneath is the only fact on the card that
  // says who is actually being trusted -- a name is not a signature, and
  // `bots.exampIe` with a capital i serving an application calling itself
  // "Telium Moderation" reads correctly at a glance to everybody. This line is
  // what frames the address as the thing to read.
  'bots.install.thirdParty': 'Third-party application',
  // The application's own name for itself, under the address.
  //
  // "Calls itself" rather than "Name" on purpose, and the distancing is the
  // whole point of the phrasing: the origin is verified, the name is not, and
  // a language that renders this as a plain label ("Name: Ping Bot") has
  // quietly told the reader the name is a fact about the application rather
  // than a claim by it. `<name>` marks the claimed name so it can be drawn in
  // the page's own ink against the muted sentence around it; `{name}` inside
  // it is a remote string and is never translated.
  'bots.install.callsItself': 'Calls itself <name>{name}</name>',
  // What the card calls an application whose descriptor carried no name at
  // all. A common noun standing in for a missing one, so it is lowercase-ish
  // in feel but sentence-initial in position -- translate it as the bare noun.
  'bots.install.unnamed': 'Bot',
  // The developer has published the application but closed it to new
  // installations. Not a failure and not a refusal of *this* reader, which is
  // why it says "not currently accepting" rather than anything about
  // permission: there is nothing here for them to fix.
  'bots.install.closed': 'This application is not currently accepting new installations.',

  'bots.install.intentsTitle': 'Intents',
  // Why these boxes start ticked and the permission boxes below do not: an
  // intent is a feed the bot was built around, so switching one off is how a
  // bot breaks quietly, and none of them is authority over anybody. The
  // imperative is an instruction to the reader, not a description of the
  // control.
  'bots.install.intentsHint': 'These are the event categories the bot requests. They start enabled; uncheck anything this server should not expose.',
  'bots.install.intentsEmpty': 'This bot requests no gateway intents.',
  'bots.install.permissionsTitle': 'Permissions',
  // The other half of that pair, and the one that must not be softened. A
  // permission *is* authority over this guild; the dangerous ones start
  // switched off so that granting one is something the reader did rather than
  // something they failed to undo, and this sentence is where that is said.
  // "The powerful ones" is the same word `perms.js` marks those bits with --
  // use whatever word that file uses, not a synonym.
  'bots.install.permissionsHint': 'These are the permissions the developer requests. The powerful ones start switched off — tick only what this bot needs to do its job.',
  'bots.install.permissionsEmpty': 'This bot requests no guild permissions.',
  // Why one particular box is greyed out, shown under that box alone.
  //
  // The rule is that nobody may hand a bot a power they do not hold
  // themselves, and the sentence says both halves of it -- you do not have
  // this, and therefore the server will refuse -- because a reader told only
  // the second half goes looking for a setting to change.
  'bots.install.cannotGrant': 'You do not hold this permission here, so this server will not let you give it away.',

  // The button, in its three states. Two keys and not one with a fallback
  // inside it, because "Install Ping Bot" and "Install bot" are different
  // sentences: the first names a particular application and the second uses
  // the common noun, and a language that inflects after the verb may need to
  // treat them differently. `{name}` is a remote string, clamped to one line
  // before it gets here.
  'bots.install.submit': 'Install {name}',
  'bots.install.submitUnnamed': 'Install bot',
  'bots.install.installing': 'Installing…',

  // The context around a failure that arrived with no machine code -- a
  // dropped connection, a remote that never answered. A coded refusal has its
  // own finished sentence in `errors.js` and is shown on its own; these say
  // which of the three requests was the one that did not land.
  'bots.install.previewFailed': 'Could not load bot',
  'bots.install.failed': 'Could not install bot',

  // -------------------------------------------------------- what is installed

  'bots.list.title': 'Installed bots',
  // The standing warning over the list, and the sentence people do not expect:
  // reducing a bot's grants is not a change that waits for the bot to
  // reconnect. Every dispatch re-checks the current grant, so a socket that is
  // open right now stops receiving the moment the grant is cut. That is the
  // reassuring half and it must survive translation intact -- an administrator
  // cutting a misbehaving bot's permissions needs to know whether they also
  // have to remove it.
  'bots.list.notice': 'Removing a bot immediately revokes its guild membership and live bot sessions. Reducing its grants also takes effect for already-open sockets because every dispatch re-checks the current guild grant.',
  'bots.list.empty': 'No bots are installed in this guild.',
  // The accessible name of the list itself. Without it the table primitive
  // announces its own English default ("Records") to every screen reader in
  // every language.
  'bots.list.tableLabel': 'Installed bots',
  // Column headings. They sit above narrow columns and cannot grow much; the
  // last two head columns of wire constants (`GUILD_MESSAGES`, …) that are
  // shown untranslated, so the heading is the only translated word there.
  'bots.list.colBot': 'Bot',
  'bots.list.colPermissions': 'Permissions',
  'bots.list.colIntents': 'Intents',
  // The badge beside a bot's display name in the list.
  //
  // Capitals because it is a badge rather than a word in a sentence, and it is
  // a key rather than a literal because it is a *word*, not a logo -- the
  // Telium wordmark is drawn the same in every language and this is not that.
  // Most languages keep "BOT": it is the badge every chat client uses and
  // people recognise the shape of it before they read it. Use your language's
  // own established term where there is one, keep it short enough for a pill,
  // and match whatever word `bots.install.unnamed` uses.
  'bots.list.badge': 'BOT',
  'bots.list.removeFailed': 'Could not remove bot',

  // ------------------------------------------------------- narrowing one that
  //                                                          is already here
  //
  // These look like `bots.install.*` and are not. Everything here is about a
  // bot that is running right now, in a guild full of people, and the edits
  // land on open sockets -- which is why the hints below talk about effect
  // rather than about intent.

  // The heading over the editor. `{name}` is the bot's display name, or its
  // account id when it has none; either way it is data and is drawn as itself.
  'bots.edit.heading': 'Edit {name}',
  // The developer's home did not answer, so the only capabilities known are
  // the ones this bot already holds. Reducing is still completely safe --
  // nothing needs the descriptor to take something away -- and widening is
  // what cannot be offered. Saying which half still works is the point of the
  // sentence; a translation that reduces it to "could not be reached" leaves
  // an administrator believing they cannot disarm a bot that is misbehaving.
  'bots.edit.offline': 'The bot’s home could not be reached, so only its current grants are shown. You can still reduce them safely; widening them requires re-checking the application descriptor.',
  'bots.edit.intentsTitle': 'Granted intents',
  'bots.edit.permissionsTitle': 'Granted permissions',
  // Shown in place of the hints below while the application's declared ceiling
  // is being fetched. "Ceiling" is the term of art for the most a developer
  // has said this application may ever be given; whatever word a language
  // picks for it, use the same one in `bots.edit.permissionsHint`.
  'bots.edit.ceilingLoading': 'Loading the application ceiling…',
  // Why this particular checklist is worth reading before saving. Message
  // content is the intent that decides whether a bot reads the words of every
  // message or only the fact of it, and "immediately" is exact rather than
  // approximate: the next dispatch is already filtered.
  'bots.edit.intentsHint': 'Message content is privacy-sensitive; removing it takes effect immediately.',
  // The two ceilings, stated as one sentence. Neither clause is optional: the
  // first explains a box that cannot be re-ticked after a developer withdrew
  // the permission, the second explains a box this particular administrator
  // may not tick at all. Both are refusals the server would otherwise deliver
  // as a single blanket 403 naming no box.
  'bots.edit.permissionsHint': 'A server can never grant more than the developer declared, and you can never grant more than you hold yourself.',
  // The submit button. "Grants" and not "changes": the reader is saving a set
  // of powers, and the noun is the one the rest of this namespace uses for
  // what a bot has been given.
  'bots.edit.save': 'Save grants',
  'bots.edit.failed': 'Could not update bot',

  // ---------------------------------------------------------------------
  // The capability checklist: `components/BotCapabilityChecklist.jsx`.
  //
  // One control drawn twice -- once over gateway intents, once over guild
  // permission bits -- on the install card, on the edit sheet, and on the
  // developer's own application page. Every row is a box somebody is about to
  // tick on a stranger's behalf, so every row is consent copy: say plainly
  // what the bot will be able to do, and do not make it sound smaller than it
  // is. The privileged rows in particular ("message content", "presence") are
  // the ones a reader is most likely to wave through, which is exactly why
  // their sentences are blunt in English and must stay blunt everywhere.
  //
  // **The identifiers beside these labels are never translated.**
  // `GUILD_MESSAGES`, `MESSAGE_CONTENT`, `MANAGE_ROLES` are the wire's own
  // spelling. They are printed under each box on purpose, so that an
  // administrator reading this screen in Japanese and a developer reading a
  // log in English are demonstrably talking about the same bit. A translated
  // constant would break that and would break nothing visibly, which is the
  // worst way for it to break. Translate the label and the sentence; leave
  // anything in `CAPITALS_WITH_UNDERSCORES` exactly as it stands.
  //
  // Permission rows are not in this block at all: they read `perms.<BIT>.label`
  // and `perms.<BIT>.hint`, the same entries the roles editor uses. That is a
  // rule, not an accident -- this screen once had a second permission table of
  // its own and it disagreed with the roles editor on six names. Do not
  // re-coin a permission name here; fix it in `perms`, once, for both screens.

  // The eight gateway intents, keyed by the wire constant lowercased. Each
  // label names a *category of events the bot will be sent*, not a thing the
  // bot may do -- an intent is a subscription. "Messages" here means "message
  // events", and a translation that reads as "the bot may send messages" is
  // wrong in a way that matters, because sending is a permission and this is
  // not the permission list.
  'bots.intent.guild_messages.label': 'Messages',
  'bots.intent.guild_messages.hint': 'Receive message create, update and delete events.',
  'bots.intent.guild_members.label': 'Members',
  // The colon introduces a list of examples, not a definition. If your
  // language does not use a colon this way, a sentence and a second sentence
  // is better than a colon that reads as an equals sign.
  'bots.intent.guild_members.hint': 'Receive guild member changes: who joined, who left, who was renamed.',
  'bots.intent.guild_presences.label': 'Presence',
  // "everyone here" is doing real work: this is the intent that tells a bot
  // whether each individual member is at their computer, continuously, and the
  // reader should finish the sentence understanding the scope is the whole
  // guild and not the bot's own conversations. Do not shorten it away.
  'bots.intent.guild_presences.hint': 'Receive online status and presence changes for everyone here.',
  'bots.intent.guild_typing.label': 'Typing',
  'bots.intent.guild_typing.hint': 'Receive typing indicators.',
  'bots.intent.guild_expressions.label': 'Emoji and stickers',
  'bots.intent.guild_expressions.hint': 'Receive guild emoji and sticker changes.',
  // "Guild structure" is the shape of the place -- its channels, its roles,
  // their order and their settings -- as against the people in it or what they
  // are saying. Use whatever word for a server/guild this catalogue uses
  // elsewhere; the word "structure" is the part to get right.
  'bots.intent.guild_structure.label': 'Guild structure',
  'bots.intent.guild_structure.hint': 'See channels, roles, and structural changes.',
  'bots.intent.guild_voice_states.label': 'Voice states',
  'bots.intent.guild_voice_states.hint': 'Receive voice channel membership and state changes.',
  'bots.intent.message_content.label': 'Message content',
  // The single most consequential box on this screen, and the reason the
  // second sentence exists: without it a bot is told that a message happened,
  // by whom and where, and not one word of what it said. Both halves must
  // survive translation. Do not soften "every message it can see" into
  // "messages" and do not drop the contrast in the second sentence -- it is
  // the only place a reader learns what unchecking the box actually buys them.
  'bots.intent.message_content.hint': 'Read the text of every message it can see. Without this a bot gets the fact of a message and not its words.',

  // Headings over the groups of intent rows. They are phrases rather than
  // nouns on purpose -- they read as answers to "what is this bot being let
  // in on?" -- so translate the question they answer, not the words.
  'bots.intent.group.activity': 'What happens here',
  'bots.intent.group.people': 'Who is here',
  'bots.intent.group.structure': 'How this guild is arranged',
  // The group holding the boxes that are a privacy decision rather than a
  // feature. Keep it short: it sits above the row that already says at length
  // what the risk is, and it is paired with the `powerful` pill on the row.
  'bots.intent.group.privileged': 'Privileged',

  // The rest of the control, shared by the intent and the permission drawing.

  // The heading over capabilities this build has no description for -- because
  // the server is newer than the client. It is a statement about the client's
  // ignorance, deliberately, and not about the capability being unusual or
  // suspect: "not described by this client" and not "unknown" or "invalid".
  // The reader is being told the software is out of date, not that something
  // is wrong with their bot.
  'bots.capability.unknownGroup': 'Not described by this client',
  // The sentence under such a row. `{capability}` holds a machine identifier
  // sent by the server -- something like `GUILD_SCHEDULED_EVENTS`. Move it
  // wherever your grammar wants it, but never translate it, never transliterate
  // it, never insert spaces or break it across a line: it is the only handle
  // the reader has for searching their server's documentation. The promise in
  // the second half ("left exactly as it is") is the important one -- it tells
  // the reader that editing other boxes will not quietly delete this grant --
  // so keep it as a promise and not as an apology.
  'bots.capability.unknown.hint': 'This server knows the capability {capability} and this client does not. It is left exactly as it is.',
  // Shown instead of the boxes when there are none. A caller that knows what
  // it is drawing passes its own line (see `bots.install.intentsEmpty`); this
  // is the fallback and has to work for both intents and permissions, which is
  // why it says "requested" and names nothing.
  'bots.capability.emptyDefault': 'None requested.',
  // The pill on a row that is a privacy decision rather than a feature -- today
  // only message content. Lowercase and one word in English because it is a
  // tag sitting inside a line of a form, not a heading; match your language's
  // convention for that rather than the English casing. It is a warning, so
  // pick a word with weight: "powerful", not "advanced" and not "special".
  'bots.capability.powerful': 'powerful',
  // The pill on a grant the developer has since removed from the application's
  // declared ceiling. The bot still holds it. "No longer offered" is about the
  // developer's offer having been withdrawn, not about the grant having
  // lapsed or been revoked -- nothing has been taken away from anybody yet.
  'bots.capability.withdrawnBadge': 'no longer offered',
  // The sentence under such a row while the bot still holds the grant. Every
  // clause is load-bearing: the developer did this (not this server, and not
  // the reader); the bot has it right now; the reader can remove it; and
  // removing it is one-way, because the server will refuse to grant it again
  // while it is outside the declared ceiling. That last clause is the one a
  // reader needs before they click, so it must not be softened into "you may
  // not be able to grant it again".
  'bots.capability.withdrawnHeld': 'The developer has withdrawn this from the application. The bot still holds it and you can take it away — but this server will not hand it back.',
  // The same row after the reader has unticked it, before saving. Said in two
  // short sentences because it is the confirmation of a decision that cannot
  // be undone, and a reader skimming one long sentence can miss the second
  // half. "It cannot be granted again" is a statement about this server's
  // rule, not a prediction -- keep it flat and absolute.
  'bots.capability.withdrawnRemoved': 'Withdrawn by the developer and now removed. It cannot be granted again.',
};
