// The message view.
//
// Everything a person reads while they are reading, writing or acting on a
// message: the timeline and its rows, the composer and its tray, the quote
// over a reply, the autocomplete, the forward sheet.
//
// The order below is the order somebody meets them in -- the history first,
// then the message, then the things you do to one, then the box you answer in
// -- rather than alphabetical. A catalogue is read far more often than it is
// looked up, and a translator working through it top to bottom is following a
// conversation rather than a dictionary.

export const chat = {
  // ------------------------------------------------------------- the timeline
  //
  // The stream itself: the empty room, the two ends of the history, and the
  // four things that can go wrong while reading it. Nothing in here is a
  // notification and nothing in here is an action the reader started, which is
  // why the tone is flatter than anywhere else in this namespace -- these are
  // the room reporting on itself, and a room that sounds anxious about its own
  // paging teaches people to distrust it.

  // The room with nothing in it. Two keys and not one because the component
  // draws them as a heading and a line under it, at two sizes, and a language
  // that wants a single sentence should put it in the heading and leave the
  // body a repetition-free second thought rather than cutting one sentence in
  // half across two type sizes.
  //
  // "Say something" is an invitation and deliberately not an instruction: this
  // is the first thing somebody sees in a channel they have just been let
  // into, and "Send the first message" reads like a task assigned by the
  // software. Keep whatever a language's equivalent of a nudge is.
  'chat.timeline.empty.title': 'Nothing here yet',
  'chat.timeline.empty.body': 'No messages yet. Say something.',

  // The head of the loaded history. Two states of one strip: it is either
  // fetching or it is telling you what to do to make it fetch. The second is
  // phrased as what the *reader* does rather than as "More messages above",
  // because there is nothing to press -- the scroll is the gesture -- and a
  // label that names a thing rather than an act sends people hunting for a
  // button that does not exist.
  'chat.timeline.loadingOlder': 'Loading older messages…',
  'chat.timeline.scrollForOlder': 'Scroll up for older messages.',

  // The accessible name of the round button that appears on a phone once the
  // reader has scrolled away from the foot of the room. "Bottom" is the end of
  // the *stream*, not a physical edge of the screen, so a language whose
  // reading order runs the other way still wants "the newest end" and not a
  // direction: this button never means "right" or "left", and in a vertical
  // script it does not mean "down" either.
  'chat.timeline.jumpToBottom': 'Jump to bottom',

  // The rule drawn across the stream at the first message you have not read.
  // One word, upper-cased by the stylesheet rather than by the string, because
  // casing is a property of a script and several have none -- and because a
  // language whose word for this is four letters long still has to fit on a
  // pill the width of the word.
  'chat.timeline.unreadMarker': 'New',

  // The three failures, as the *context* a thrown error is wrapped in -- see
  // `errors.context` and the note over `reportError`. They are phrases rather
  // than sentences for that reason: the sentence that follows is the server's
  // or the ladder's, and these say only which of the three things this client
  // was in the middle of.
  //
  // Split three ways rather than sharing one "Could not load messages",
  // because they are the three separate questions a reader has: is the history
  // above this broken, is the message I asked to jump to broken, or is the
  // whole room broken? A single phrase would make the first indistinguishable
  // from the third, and the third is the only one worth reloading over.
  'chat.timeline.loadOlderFailed': 'Could not load older messages',
  'chat.timeline.loadHistoryFailed': 'Could not load history',
  'chat.timeline.jumpFailed': 'Could not load that message',

  // A jump that found nothing. Not a failure: the message was deleted, or it
  // is in a room this account has since left, and the honest thing is that it
  // is *gone* rather than that something broke. "any more" carries that --
  // it says the link was once good -- and it is the half most likely to be
  // dropped for length. Keep it.
  'chat.timeline.messageGone': 'That message is not available any more.',

  // ------------------------------------------------------------ the message
  //
  // One row. Everything here is drawn hundreds of times on a screen, which is
  // the whole constraint on the writing: a word that is two characters too
  // long in English is a word that wraps a timestamp onto a second line in
  // German, and every one of these sits in a gutter or on a pill with no room
  // in it. Short, and then shorter.

  // The accessible name and the tooltip of the two doors to somebody's profile
  // card: the avatar beside the message and the name over it.
  //
  // One key, two values, and that is deliberate. The avatar is announced with
  // the *display* name, because that is what a screen-reader user has just
  // heard the message attributed to; the tooltip carries the full `@user:host`,
  // because a tooltip is where somebody goes to find out exactly who they are
  // talking to. Same sentence, same act, two different identifiers -- so one
  // pattern with `{name}` in it, and the component decides which identifier is
  // the answer to "for whom".
  //
  // `{name}` is data in both readings. Never translated, never transliterated.
  'chat.message.openProfile': 'Open profile for {name}',

  // Where the timestamp will be, while the message is still on its way. A
  // gerund and not "Sent" or a spinner's label: it is the row saying what it
  // is doing, in the slot that will hold the time it was done. Whatever a
  // language uses, it has to fit where a short time of day fits.
  'chat.message.sending': 'Sending…',

  // A message everybody agreed to stop showing. Not "This message was
  // deleted": the row is the message, so the sentence does not need to point
  // at itself, and the shorter form survives the italic muted line it is drawn
  // on. It deliberately does not say who deleted it -- the row does not know,
  // and guessing "by the author" would be wrong exactly when it matters.
  'chat.message.deleted': 'Message deleted',

  // A frame this device holds and cannot open. This is security copy and it
  // follows `en/security.js`'s first rule: it names the fact and does not
  // soften it. It is *not* an error -- nothing is broken, nothing will retry,
  // and the message is not coming -- and it is not "You do not have
  // permission" either, which would be a claim about a policy rather than
  // about a key. A device admitted to a conversation after this frame was sent
  // was never given the key that opens it, and that is what the reader is
  // being told.
  'chat.message.unreadable': 'Encrypted for a key this device does not have',

  // The mark after an edited message. Parenthesised and lower case because it
  // is an aside inside somebody else's sentence, not a badge: it is read as
  // part of the message, at the end, in the muted colour. The space before it
  // is the component's, not the string's -- a leading space in a catalogue
  // entry is the first thing a translation tool eats.
  'chat.message.edited': '(edited)',

  // The four controls that appear on a row under the pointer. All four are
  // glyphs, so every one of these is a tooltip and an accessible name at once,
  // and the note over `common.a11y.*` applies: name the act, and do not say
  // "button".
  //
  // Not `common.edit`, even though English spells them the same. `common.edit`
  // is the verb on a settings pane's own button, said by the interface about a
  // form; this one is said about *a thing somebody wrote*, and several
  // languages take a different verb for correcting your own words than for
  // changing a setting. `common.a11y.menu` is reused for the `…` deliberately
  // -- that one really is the same control doing the same job everywhere in
  // the client, and it is the one place a shared key is right here.
  'chat.message.actions.react': 'React',
  'chat.message.actions.reply': 'Reply',
  'chat.message.actions.edit': 'Edit',
  // One of the three quick reactions at the front of the hover bar. Named by
  // the emoji itself, because the glyph is the whole of the label.
  'chat.message.actions.quickReact': 'React with {emoji}',
  // The two actions the bar adds while Shift is held. They act at once, with
  // no confirmation -- holding the key is the confirmation -- so the labels
  // say the act plainly. Which of the two a row offers follows what the room
  // already knows about the message: a conversation has always known, and a
  // channel knows what it asked its server for when the room was opened.
  'chat.message.actions.pin': 'Pin',
  'chat.message.actions.unpin': 'Unpin',
  'chat.message.actions.delete': 'Delete',
  'chat.message.pinned': 'Pinned.',
  'chat.message.unpinned': 'Unpinned.',
  'chat.message.pinFailed': 'Pin failed',
  'chat.message.deleteFailed': 'Delete failed',
  // What the timeline says about a pin: the one place in this file where the
  // word is a label rather than a sentence, which is why it takes no full stop
  // where the toast above it has one. Drawn as a glyph beside the row's
  // timestamp and said as that word beside the glyph, for a reader the glyph
  // says nothing to.
  'chat.message.pinnedMark': 'Pinned',

  // The sentence the stream draws when a pin is made while the room is in
  // front of the reader -- a line of its own among the rows, the way a call
  // log line is. Two keys rather than one with a blank in it, because an act
  // nobody can name (a channel's pin arrives over a frame that carries no
  // hand, and the server keeps the one it stored) is a different sentence
  // rather than a sentence with the name left out of it. The name itself is a
  // placeholder, filled the way `quickReact` above fills its emoji.
  'chat.timeline.pinNotice.named': '{name} pinned a message',
  'chat.timeline.pinNotice.anonymous': 'A message was pinned',
  'chat.timeline.pinNotice.seeAll': 'See all pins',

  // The two failures a row can produce on its own. Context phrases, like the
  // timeline's: a coded refusal from the server already carries its own
  // finished sentence and these only name what was being attempted.
  'chat.message.reactionFailed': 'Reaction failed',
  'chat.message.editFailed': 'Edit failed',

  // The quoted line above a reply, when the message it quotes is not in hand.
  // Lower case and a fragment on purpose: it stands where a name and a snatch
  // of text would stand, in the same muted line, and a capitalised sentence
  // there would read as a system notice rather than as the reply's own header.
  'chat.message.quotedOlder': 'replying to an older message',
  // The same line when the message it answered has since been deleted.
  'chat.message.quotedDeleted': 'original message was deleted',

  // The tooltip on that line when it is a door. "the replied-to message"
  // rather than "the original": a reply to a reply has an original three steps
  // up, and this only ever goes one.
  'chat.message.jumpToQuoted': 'Jump to the replied-to message',

  // The same "it is gone" as `chat.timeline.messageGone`, said about a reply's
  // parent rather than about a jump the reader asked for by other means. A
  // separate key rather than a reuse because the reader arrived here by
  // pressing a quote of the very message being reported missing, and naming
  // the relationship is what makes that make sense -- the timeline's version
  // has no relationship to name. This is the "duplicate freely" rule doing its
  // job: one shared key would read as a non-sequitur in one of the two places.
  'chat.message.replyGone': 'The message this replies to is not available any more.',

  // The box that opens over a message being corrected, and the line under it.
  //
  // The hint names the two keys in lower case because they are keycaps being
  // quoted, not sentences: a language that capitalises its key names should
  // capitalise them, and one that writes them as words rather than as glyphs
  // should do that. What must survive is that both keys are named -- somebody
  // who has opened this box by accident needs the escape half more than the
  // save half, and it is the half that gets cut for length.
  'chat.message.editBox.label': 'Edit message',
  'chat.message.editBox.hint': 'enter to <save>save</save>, escape to <cancel>cancel</cancel>',

  // How many messages are in the thread hanging off this message.
  //
  // A real plural, and the reason this entry exists at all: it was
  // `${count} messages`, which is a sentence Polish cannot say and Japanese
  // says with no plural at all. The count is the entire content of the pill,
  // so `#` rather than a spelled-out word -- and `#` goes through the locale's
  // number formatter, which is what puts Arabic digits on an Arabic screen.
  'chat.message.thread.count': '{count, plural, one {# message} other {# messages}}',

  // --------------------------------------------------------------- delivery
  //
  // Who has a message you sent, and on how many of their devices. The rule the
  // whole surface is built on -- it reports acknowledgements that arrived and
  // never an absence -- is what shapes the writing: there is no string in here
  // that says anybody has *not* got something, because this device does not
  // know that and saying it would turn somebody's receipts setting into an
  // announcement about them.

  // The one-word state, as the dialog's title. Four keys rather than a `select`
  // on the state, because the component has to pick one anyway and because
  // these are past participles that agree with different subjects in several
  // languages -- "read" is about the person, "delivered" is about the message.
  //
  // `fallback` is the title when the state is one this build does not know,
  // which is a newer server than this client. It names the subject rather than
  // guessing at a state, which is the only honest answer available.
  'chat.delivery.title.sent': 'Sent',
  'chat.delivery.title.delivered': 'Delivered',
  'chat.delivery.title.read': 'Read',
  'chat.delivery.title.fallback': 'Delivery',

  // The line under the title, which says what the one-word state means for a
  // group rather than for one other person. "Everybody else" is the group
  // minus you, and the exclusion is load-bearing: a reader who counts heads
  // against the list below will otherwise be one out and conclude the dialog
  // is wrong.
  //
  // The `sent` state covers both "nobody yet" and "some of them", because
  // `delivered` and `read` are claims about everybody -- so the component
  // picks between the last two on whether the list has anybody in it, and
  // neither of them may imply the others are refusing.
  'chat.delivery.subtitle.delivered': 'Everybody else has it.',
  'chat.delivery.subtitle.read': 'Everybody else has read it.',
  'chat.delivery.subtitle.some': 'Some of the group have it.',
  'chat.delivery.subtitle.none': 'No acknowledgements yet.',

  // How many of one person's devices acknowledged.
  //
  // Three arms in one key because zero is not "no devices" -- it is an older
  // client's account-level watermark, which said the account had the message
  // without saying which device opened it. Rounding that to "on 1 device"
  // would be inventing a fact, and giving it its own key would let a
  // translator write the two halves in voices that do not match on the same
  // row. The `=0` arm is a different sentence and is meant to be: it describes
  // the *record*, where the other two describe the devices.
  //
  // Lower case throughout: this sits after a person's name on one row and is
  // read as part of it.
  'chat.delivery.devices': '{count, plural, =0 {device not stated} one {on # device} other {on # devices}}',

  // The mark on a row for somebody who has opened the message rather than
  // merely received it. Lower case and one word for the same reason as the
  // badges in `security.devices.*`: it is read as part of the row, not as a
  // heading over it.
  'chat.delivery.read': 'read',

  // Nobody has acknowledged anything yet. Said as a state of the *list* rather
  // than as "No one has this yet", which would be the absence claim this
  // surface refuses to make -- people with receipts off are not in the list
  // and this device cannot tell them apart from people who have not got it.
  'chat.delivery.empty': 'Nothing yet.',

  // And the sentence that stops the list from being read as a complete census.
  // It is the whole reason the dialog can be honest, so it is drawn under
  // every state of it, full or empty.
  'chat.delivery.receiptsHint': 'People with receipts off don’t appear here.',

  // ------------------------------------------------------------- the quote
  //
  // One message quoted in one line, over the composer while a reply is being
  // written and over the reply itself in the timeline.
  //
  // `<quoted/>` is where the message's own words go, and they are *elements* --
  // the quote is rendered markdown, with real custom emoji in it, so it cannot
  // be a `{value}`. Which is exactly why these two are one pattern each rather
  // than a lead glued to a name glued to a body in JavaScript: the colon, the
  // space and the order of the three parts are all facts about a language, and
  // the version of this that concatenated them could not be rearranged by a
  // translator at all. Move `<quoted/>` wherever the grammar wants it; do not
  // rename it and do not put anything inside it.
  'chat.quote.line': '{name}: <quoted/>',

  // The same line with the lead the composer's reply strip puts on it. A
  // separate pattern and not a prefix, so that a language that marks a
  // quotation by inflecting the name, or by putting the verb at the end, can
  // write the whole thing.
  'chat.quote.replyingTo': 'Replying to {name}: <quoted/>',

  // The words alone, for the line over a reply in the timeline, which draws
  // the name itself -- as a face and a coloured name ahead of the words. A
  // pattern rather than nothing so a language that wants the quote wrapped in
  // its own marks can add them here.
  'chat.quote.body': '<quoted/>',

  // What stands in for the words when the quoted message had none -- it was a
  // picture, a file, a sticker. Lower case, because it is read in the position
  // the words would have been in, inside somebody else's line. A noun and not
  // "sent an attachment": the line is already attributed.
  'chat.quote.attachment': 'attachment',

  // ---------------------------------------------------- the ephemeral reply
  //
  // A message delivered to one person over the gateway and written to no
  // history anywhere.

  // The label on every one, above whatever the application wrote and first in
  // the reading order.
  //
  // Said in full, as a sentence, rather than as a badge reading "EPHEMERAL":
  // the word is jargon out of the protocol and the two facts it stands for are
  // the two facts the reader actually has to take away -- nobody else in the
  // room can see this, and it will not be here after a reload. Both halves are
  // load-bearing and neither may be dropped for width; the card wraps.
  'chat.ephemeral.mark': 'Only you can see this — it will not be saved',

  // The button that takes it away. Not `common.dismiss`, which is the word on
  // a notice that will come back if it still applies: this one destroys the
  // only copy of a message that exists anywhere, because no server holds it.
  // The English is the same word and that is a coincidence of English; a
  // language with a stronger verb for "get rid of permanently" should use it
  // here and not there.
  'chat.ephemeral.dismiss': 'Dismiss',

  // -------------------------------------------------------- the encryption
  //
  // Read the header of `en/security.js` before touching anything below. It is
  // the same subject and the same three rules, and the third one is the one
  // that bites here: **do not translate what is on the other person's screen,
  // and do not translate what is not a word**.
  //
  // In this namespace that means:
  //
  //   * "MLS" and "OPAQUE" stay as they are, in every language. They are the
  //     names of published protocols, and somebody checking what this client
  //     claims will be searching for those six and seven letters. A
  //     transliteration is a dead end and a translation is a different
  //     protocol.
  //   * "Settings → {pane}" names a pane elsewhere in this client, and
  //     `{pane}` is that pane's own title -- `settings.nav.recovery` -- handed
  //     in rather than written out. It used to be written out in all four of
  //     these sentences, above a note telling translators to keep the spelling
  //     in step with the pane by hand. They could not: the pane's name was a
  //     literal in `views/user-settings/UserSettings.jsx` and appeared in no
  //     catalogue, so there was nothing to keep in step with and nothing that
  //     would have told anybody when it moved. Now there is one spelling and
  //     four sentences read it. Put the placeholder where your language wants
  //     the name, and do not translate around it. The arrow is a separator,
  //     not a word; "Settings" is the app's own settings and is already
  //     decided by `common.settings`.
  //   * `{names}` in the start-over sentence is a list of user identifiers
  //     already joined by `Intl.ListFormat` in the reader's own language. Data:
  //     move it, do not touch it.
  //
  // And the rule from `security.js` that overrides house style: never soften a
  // warning and never invent one. Several of these say that somebody other
  // than the intended reader can read the messages. That is the point of the
  // sentence and it is not to be made hypothetical.

  // What the servers in the path can see, in every custody mode plus the mode
  // this build does not recognise.
  //
  // Five whole paragraphs, with the relay sentence written out in each, rather
  // than one relay key glued to one custody key at run time. The glue was the
  // bug: two sentences joined by a space in JavaScript is an order no
  // translator can change, and here the order genuinely moves -- a language
  // that leads with the consequence and follows with the mechanism has to be
  // able to say "the operator can read these" first. Duplicating the relay
  // sentence four times is the cheap half of that trade.
  //
  // `unknown` is the mode a newer server named and this client has not met. It
  // says the weaker true thing and stops: claiming end-to-end because the
  // custody read had not landed yet would be the interface guessing in the
  // reassuring direction, which is the one direction security copy may never
  // guess in.
  'chat.encryption.custody.unknown': 'Messages here are MLS frames. Your home server relays them, and always sees who is talking to whom, and when.',
  'chat.encryption.custody.escrowed': 'Messages here are MLS frames. Your home server relays them, and always sees who is talking to whom, and when. This account uses legacy server-assisted DM recovery: your home server holds a key that opens the recovery vault and history mirror, so the operator can read these messages. Move recovery to your trusted devices under Settings → {pane}.',
  'chat.encryption.custody.opaque': 'Messages here are MLS frames. Your home server relays them, and always sees who is talking to whom, and when. Your Telium password restores encrypted DMs through OPAQUE. The password is never sent to your home server, and only your client gets the key to the vault and history mirror.',
  'chat.encryption.custody.device': 'Messages here are MLS frames. Your home server relays them, and always sees who is talking to whom, and when. Your DM recovery keys live on devices you approve. Your home server stores the encrypted history mirror but holds no key that opens it.',
  'chat.encryption.custody.self': 'Messages here are MLS frames. Your home server relays them, and always sees who is talking to whom, and when. Trusted devices hold your DM keys, and a separate recovery passphrase can restore them if every device is lost. Neither is ever sent to your home server.',

  // The escrow disclosure on its own, for the conversation dialog, which draws
  // it as a warning of its own rather than as part of the paragraph above.
  // Identical wording to the second half of `custody.escrowed` on purpose:
  // the reader may well see both, and two different accounts of the same
  // arrangement would read as two different arrangements.
  'chat.encryption.escrowedNote': 'This account uses legacy server-assisted DM recovery: your home server holds a key that opens the recovery vault and history mirror, so the operator can read these messages. Move recovery to your trusted devices under Settings → {pane}.',

  // Why the history above this point is closed on this device, drawn with the
  // history rather than as a banner, because it is a fact about what you are
  // looking at and not something to do about it.
  //
  // The second clause is the one that stops this being read as a fault:
  // forward secrecy is working as designed, and a new device is *supposed* not
  // to be handed what was said before it existed. A translation that reads
  // like an apology for a bug is telling the reader the opposite of the truth.
  'chat.encryption.notYetReadable': 'Earlier history is not readable on this device. Mirrored history returns with your recovery keyring; MLS does not hand old messages to a new device.',

  // ------------------------------------------------------- the header chip
  //
  // One word in the channel header, the whole story behind a click. Every one
  // of these has to fit on a pill beside a channel name on a phone, which is
  // the binding constraint: two words at the very most.

  // Named for what it means rather than for the mechanism. "Key escrowed" is
  // accurate and tells the reader nothing; what they need off a glance is
  // whether anybody else can read this.
  'chat.encryption.chip.keyChanged': 'Key changed',
  'chat.encryption.chip.serverCanRead': 'Server can read',
  'chat.encryption.chip.endToEnd': 'End-to-end',
  'chat.encryption.chip.encrypted': 'Encrypted',

  // How many devices in this conversation nobody has verified. A plural rather
  // than `${n} unverified`, which is the same bug the thread count had. Both
  // English arms read the same because "unverified" is the adjective and does
  // not agree with the number here -- in a language where it does, they will
  // not.
  'chat.encryption.chip.unverified': '{count, plural, one {# unverified} other {# unverified}}',

  // The chip's accessible name. The visible label is a word and the tooltip is
  // a paragraph, so the name a screen reader reads is neither: it is what
  // pressing the thing does.
  'chat.encryption.chip.open': 'Encryption details',

  // The chip's tooltip when somebody's account key has changed -- the same two
  // sentences the banner says, as one string, because a `title` attribute is
  // one string. One entry rather than the banner's two joined by a space: the
  // order of a headline and its explanation is a thing a language gets to
  // decide, and joining them in JavaScript decides it for them.
  'chat.encryption.chip.keyChangedTooltip': 'Someone here is using a different account key. A key reset looks like this; so does an impersonation. Verify them again before trusting it.',

  // --------------------------------------------------------- the banners
  //
  // Each is a headline that has to be read and a line that only has to be
  // there. They stack -- two of these can be true at once -- so each has to
  // stay readable above the next, which is the length budget: one short line
  // and one longer one, never a paragraph.
  //
  // The split into `.title` and `.body` is not a sentence cut in half. The two
  // are drawn at different weights in different colours and either may be read
  // alone, so each is a whole sentence and a translator may rebalance which
  // fact sits in which -- what must not happen is that the headline stops
  // being a complete claim on its own.

  // The engine did not come up. The composer refuses to send rather than
  // falling back to plaintext, and the body says the one cause that is worth
  // naming because it is the one the reader can fix in ten seconds.
  'chat.encryption.unavailable.title': 'Encryption is unavailable on this device.',
  'chat.encryption.unavailable.body': 'Private browsing blocks the local key store; a normal window works.',

  // This device holds no group for the conversation and could not let itself
  // in. The body names who can act, and deliberately includes this account's
  // own other devices, because they answer the ask on exactly the same terms
  // everybody else does -- a reader who thinks only other people can help will
  // wait instead of opening their laptop.
  'chat.encryption.awaiting.title': 'This device cannot send here yet.',
  'chat.encryption.awaiting.body': 'It has asked to be let in; that happens when a device already in the conversation opens it, including another of your own. Messages above came from your own history.',

  // The same state minus the part that was not true: the ask is a frame, and
  // with the sequencer unreachable it never left. Telling somebody to wait for
  // a peer who was never told is worse than telling them nothing, which is why
  // this is a separate banner and not a softer version of the one above.
  'chat.encryption.rejoinUndeliverable.title': 'Nobody has been asked to let this device in.',
  'chat.encryption.rejoinUndeliverable.body': 'The server that orders this conversation is unreachable, so the request never left. Starting over gives everyone still reachable a new group.',

  // The one banner that might be another person. "A key reset looks like this;
  // so does an impersonation" gives both readings in the order of likelihood
  // and refuses to choose between them, which is the honest position -- this
  // client cannot tell them apart, and a sentence that picked one would be
  // either crying wolf or covering for an attacker.
  'chat.encryption.changedIdentity.title': 'Someone here is using a different account key.',
  'chat.encryption.changedIdentity.body': 'A key reset looks like this; so does an impersonation. Verify them again before trusting it.',

  'chat.encryption.vaultLocked.title': 'Your older messages are locked on this device.',
  'chat.encryption.vaultLocked.body': 'Enter your recovery passphrase under Settings → {pane} to get them back.',

  'chat.encryption.deviceApproval.title': 'This device does not have your keys yet.',
  // "travel directly between your devices" is a claim about where the keys go
  // and is not decoration: it is the reason approving from another device is
  // safe to do. Do not reduce it to "your keys will be copied".
  'chat.encryption.deviceApproval.body': 'Approve it from a device you already use. The keys travel directly between your devices.',

  // Signing in worked and did not unlock the history, which is the state that
  // most looks like a failure and is not one. Two ways out, both real, in the
  // order of how much they cost.
  'chat.encryption.recoveryFallback.title': 'Signing in did not unlock your older messages.',
  'chat.encryption.recoveryFallback.body': 'Enter your recovery passphrase under Settings → {pane}, or approve this device from one you already use.',

  // Messages are being held back on purpose. The body says so rather than
  // leaving the reader to conclude that messages are being lost, which is the
  // fear this banner exists to answer.
  'chat.encryption.syncFailed.title': 'Encryption is out of sync on this device.',
  'chat.encryption.syncFailed.body': 'Newer messages are held back while Telium retries the MLS key schedule.',

  'chat.encryption.retrySync': 'Retry sync',

  // ---------------------------------------------------------- starting over
  //
  // The last resort under the admission banner: a new group for everybody, in
  // the same window. It is offered as what it is rather than as a repair, and
  // it costs two presses -- the first arms it, the second does it.

  // The unarmed label names the act in full. The armed one is the confirmation
  // and is deliberately not "Confirm" or "Yes": a bare yes on a destructive
  // button is a yes to a question the reader may have stopped reading, so the
  // verb is repeated inside it.
  'chat.encryption.startOver.arm': 'Start the conversation over',
  'chat.encryption.startOver.confirm': 'Yes, start over',

  // What appears beside the armed button. The second clause is the
  // irreversible half and is the reason the button is armed at all -- "nothing
  // said before it ever opens" means the history in this conversation stays
  // closed forever, on every device. It must not be softened to "may not be
  // available".
  'chat.encryption.startOver.warning': 'Everyone gets a new group; nothing said before it ever opens.',

  'chat.encryption.startOver.done': 'Started over. New messages here can be read again.',

  // Started over, but somebody could not be put in the new group -- a device
  // with no key package published cannot be added to a tree any more than it
  // could open the old one. Saying so is the difference between "it worked"
  // and the reader wondering later why one person is missing.
  //
  // `{names}` arrives already joined in the reader's own language, so the
  // pattern must not add "and" or commas of its own. `{count}` is how many
  // names are in it: English needs no agreement here, which is exactly why the
  // plural has to exist in the pattern -- a language that inflects the verb
  // for one versus several has nowhere to put that otherwise.
  'chat.encryption.startOver.partial': '{count, plural, one {Started over, but {names} could not be added yet.} other {Started over, but {names} could not be added yet.}}',

  // Context for a failure with no code of its own, in the shape
  // `security.mfa.setupFailed` uses and for the same reason.
  'chat.encryption.startOver.failed': 'Could not start the conversation over',

  // ------------------------------------------------------------ invite cards
  //
  // A link to somewhere else, turned into the two facts that decide whether to
  // press it: which place, and how many people are already in it.

  // The member count under a guild's name. A plural, and `#` rather than
  // `{count}`, so the numeral is drawn in the reader's own digits.
  'chat.invite.members': '{count, plural, one {# member} other {# members}}',

  // The same count with the host the invite resolves against. One pattern
  // rather than the count and a dash and the domain, which is what it was: the
  // separator is punctuation a language owns, and "on" is a preposition
  // several languages attach to the other end of the phrase. `{domain}` is a
  // hostname -- never translated, never given localised digits, because the
  // reader is matching it against what they will see in the address bar.
  'chat.invite.membersOnHost': '{count, plural, one {# member} other {# members}} on {domain}',

  // The button. Two keys because a guild whose name the host did not return
  // must not produce "Join " with a hole where the name was, which is what
  // trimming a template literal was hiding. `{guild}` is a name somebody chose:
  // data, moved but never translated.
  'chat.invite.join': 'Join {guild}',
  'chat.invite.joinUnnamed': 'Join',

  // ------------------------------------------------------------ the surface

  // What the composer's box says before anything is typed in it.
  //
  // One pattern with the destination in it, rather than the `'Message ' + name`
  // this used to be, and the reason is not tidiness. `Composer.jsx` used to
  // recover the channel's name by running `/^Message\s*/` over this very
  // string to label the drag-and-drop target -- so in any language whose verb
  // does not come first, or which does not put the destination last, the drop
  // hint would have named a fragment of its own placeholder. The surface knows
  // its channel; it now says so in a field of its own, and this is only ever
  // read by a human.
  //
  // `{target}` arrives already decorated -- `#general` for a text channel,
  // the bare name for a thread -- because whether a room's name carries a
  // sigil is a fact about the room, not about the sentence.
  'chat.surface.placeholder': 'Message {target}',
  // The same box in a conversation, which has no name to put in it. A separate
  // key rather than the pattern with an empty `{target}`: "Message " with a
  // hole at the end is not a sentence in any language, and a translator given
  // this one can write the imperative their language actually uses.
  'chat.surface.placeholderPlain': 'Message',

  // The composer, while somebody else's server is standing in for yours.
  //
  // Both machines are named on purpose. "Read-only" on its own reads like a
  // permission somebody took away; naming the outage and naming the copy makes
  // it what it is, which is a machine that is down and another one holding the
  // room open. One sentence rather than three glued fragments, because the
  // clause order here is entirely a fact about English -- a language that
  // fronts the consequence ("no new messages can be accepted: …") should be
  // free to.
  'chat.surface.standby': '{home} is not answering. You are reading a copy held by {standby}, which cannot accept new messages.',
  // Three refusals, and each one says why rather than only that. A composer
  // that greys out with no reason is indistinguishable from a broken one; see
  // the note at the top of `en/security.js` about naming the cause plainly.
  // They stay three keys rather than one `select` because they are three
  // different speakers -- a room's rule, a moderator's decision about you, and
  // the permission system -- and several languages change register between
  // those.
  'chat.surface.threadLocked': 'This thread is locked. Only moderators can post here.',
  'chat.surface.timedOut': 'You are timed out in this guild. You can read, but not post.',
  'chat.surface.noPermission': 'You do not have permission to send messages here.',

  // The three states a sender can be told about their own message, as the one
  // word that goes on the menu row.
  //
  // Deliberately duplicated from `chat.delivery.*`, which the details dialog
  // uses for its heading. They are the same three English words and they are
  // not the same three strings: this one is a menu row, which several
  // languages set as a noun ("Zustellung"), and that one is a dialog title
  // over a list of people, which the same languages set as a participle. One
  // key doing both jobs is how a menu ends up reading like a sentence
  // fragment. See the note about duplicating freely in `en/common.js`.
  'chat.surface.delivery.sent': 'Sent',
  'chat.surface.delivery.delivered': 'Delivered',
  'chat.surface.delivery.read': 'Read',

  // ----------------------------------------------------------- the composer

  // The controls in the cluster. Every one of these is a `title` on a button
  // whose visible content is a glyph, so it is read aloud as well as hovered:
  // name the action and nothing else, the way `common.a11y.*` explains.
  'chat.composer.attach': 'Attach a file',
  'chat.composer.moreActions': 'More message actions',
  // The title of the sheet that stands in for the whole cluster on a phone.
  // "Message actions" rather than "Actions" because a sheet covers the screen
  // and takes its context with it.
  'chat.composer.actionSheet': 'Message actions',
  // The initialism, not a word. It stays a catalogue entry rather than a
  // literal because a locale whose readers would not recognise three Latin
  // letters needs somewhere to put "GIF picker" or a transliteration -- and
  // because the same three letters are drawn *inside* the button as its face,
  // which is a separate decision a translator should not have to guess at.
  'chat.composer.gif': 'GIF',
  'chat.composer.emoji': 'Emoji',
  'chat.composer.send': 'Send',
  'chat.composer.cancelReply': 'Cancel reply',

  // The two clipboard verbs the formatting menu displaced and had to put back.
  //
  // `common.copy` already says "Copy" and this does not use it. The pair is
  // the reason: cut and copy are a matched set on a text box, several
  // languages translate them as a matched set ("Kopieren"/"Ausschneiden"), and
  // a translator who finds one of them in `common` and the other here has been
  // handed two halves of a decision in two different files. Keeping them
  // together costs one duplicated word.
  'chat.composer.copy': 'Copy',
  'chat.composer.cut': 'Cut',

  // Why the paperclip is off, in the words the button itself will say.
  //
  // The second one names the server rather than the setting because the person
  // reading it cannot change either: an account set to a third-party host on a
  // server that enables none has nowhere to put a file, and "uploads are
  // disabled" would send them looking through their own preferences for a
  // switch that is not there.
  'chat.composer.attachBlocked': 'You cannot attach files here',
  'chat.composer.noUploadHosts': 'No external upload hosts are enabled on your home server',
  // The note under the box after a message went somewhere it will wait.
  // Stated as a fact about the guild rather than about the reader -- it is not
  // a judgement on them, and a first message held for review is a rule they
  // walked into rather than something they did. The apostrophe is the typographic
  // one, which also keeps it clear of ICU's quoting character.
  'chat.composer.heldForReview': 'Held for moderator review: this guild holds new members’ first messages.',

  // ---------------------------------------------------------- the formatting

  // The seven formats, as the right-click menu names them.
  //
  // These are the names of marks, and the temptation with names of marks is to
  // leave them in English because the markers themselves are ASCII. Do not:
  // every writing system has its own words for emphasis, and the menu is the
  // only place this client ever teaches somebody that this app can do these
  // things at all.
  //
  // What is *not* translated is the chord beside each row -- `⌘B`, `Ctrl+E`.
  // A chord is notation for a key on a physical keyboard: the glyph is Apple's
  // and the key legend is the keyboard's, and a "translated" chord would name
  // a key the reader would then press to no effect. `chordHint` in
  // `views/chat/formatting.js` builds those and has no catalogue entry.
  'chat.format.bold': 'Bold',
  'chat.format.italic': 'Italic',
  'chat.format.strike': 'Strikethrough',
  'chat.format.code': 'Inline code',
  'chat.format.spoiler': 'Spoiler',
  'chat.format.block': 'Code block',
  'chat.format.quote': 'Quote',

  // The name of the strip that floats over a highlight. The seven above are
  // what it is *made of*; this is what it *is*, and a screen reader announces
  // it once when the bar arrives, before any tile is reached. Deliberately not
  // "Formatting menu" -- the right-click menu already answers to that shape of
  // name, and the two are different objects: a toolbar stays put, one control
  // per action, its tiles icons rather than rows.
  'chat.format.bar': 'Text formatting',

  // ------------------------------------------------------- staged attachments

  // The card's three actions. `title` and `aria-label` differ here on purpose
  // and so do their keys: the tooltip is read by somebody who can already see
  // which card they are pointing at, and the label is read by somebody who
  // cannot and needs the file named. A single key would have to pick one
  // audience.
  'chat.staged.preview': 'Preview',
  'chat.staged.rename': 'Rename',
  'chat.staged.remove': 'Remove',
  'chat.staged.previewOf': 'Preview {name}',
  'chat.staged.renameOf': 'Rename {name}',
  'chat.staged.removeOf': 'Remove {name}',
  // A progress bar's label. Present tense and continuous, because it is
  // announced repeatedly while the bar moves.
  'chat.staged.uploadingOf': 'Uploading {name}',
  // The staged sticker's own remove button. It has no name to put in a label,
  // so this is the one place the bare verb is also the accessible name.
  'chat.staged.removeSticker': 'Remove sticker',
  'chat.staged.closePreview': 'Close preview',

  // The rename prompt. `common.save` is not used for the confirm button:
  // "Rename" names the act, and a dialog whose button repeats its own title is
  // how somebody ends up unsure whether they are renaming or saving a copy.
  'chat.staged.renameTitle': 'Rename file',
  'chat.staged.renameLabel': 'File name',
  'chat.staged.renameConfirm': 'Rename',

  // The expiry chip, whose label is the answer rather than the question: a
  // control reading "Expires in 30 days" has already said what you wanted to
  // know and only has to be opened by somebody who wants a different answer.
  //
  // `{duration}` is a phrase, not a number -- it arrives already pluralised
  // and already formatted by `chat.upload.limit*` below -- which is why this
  // is a plain placeholder rather than a nested plural. A language that
  // inflects the noun after "in" will need to say so inside those entries.
  'chat.staged.keepFor': 'Keep files for',
  'chat.staged.expiresIn': 'Expires in {duration}',
  'chat.staged.keepsForever': 'Keeps forever',
  // Whose rule cut the list short. Worth a sentence rather than a silently
  // shorter menu: policy you have to infer from a missing option is policy
  // nobody knows about until a file disappears.
  'chat.staged.cappedNote': 'Files sent here are deleted after at most {duration}.',

  // The article forms, for that sentence only.
  //
  // English says "at most a day", not "at most 1 day" -- the sentence names a
  // rule of the room rather than counting anything, and the indefinite article
  // is what makes it read as one. That distinction does not survive
  // translation into a language with no article, and it should not have to:
  // those locales can give the `one` arm the same words as the numbered form
  // and lose nothing. The `other` arm is a real plural because the number is
  // real once it is above one.
  'chat.staged.capDays': '{count, plural, one {a day} other {# days}}',
  'chat.staged.capHours': '{count, plural, one {an hour} other {# hours}}',
  'chat.staged.capMinutes': '{count, plural, one {a minute} other {# minutes}}',

  // The host chip, for accounts sending to a third-party provider.
  'chat.staged.uploadHost': 'Upload host',
  'chat.staged.noHosts': 'No external upload hosts are enabled',
  // A provider's own name and domain. Both are identifiers and neither is
  // translated; what this entry exists for is the punctuation around them,
  // which is not the same everywhere.
  'chat.staged.hostOption': '{name} ({domain})',
  // Two sentences, two keys, because only the first can be replaced by a
  // description the provider wrote about itself. The second is ours and is
  // always said: an external upload is a public URL outside this app's access
  // control, and the sender is the only person in a position to decide that is
  // acceptable. It does not get softened in translation.
  'chat.staged.hostPolicy': 'Files are stored by this host under its own retention and abuse policies.',
  'chat.staged.hostPublic': 'External uploads are public provider URLs and are not protected by Telium access controls.',

  // What a drag reveals over the conversation: a destination on one line and
  // the instruction on the next. They are two entries because they were never
  // one sentence -- a room's name is a proper noun no locale translates, and
  // folding it into the instruction would have made the instruction's word
  // order depend on it.
  //
  // A conversation has no name to put on the first line, so it says what it is
  // instead. Lower case and article-led in English because it stands in for a
  // name in the same slot rather than titling anything.
  'chat.staged.dropTargetFallback': 'this conversation',
  'chat.staged.dropLine': 'Drop to upload',

  // A staged file that never made it up. Named rather than counted: a tray of
  // six files with one failure needs to say which one.
  'chat.staged.uploadFailed': 'Could not upload {name}',
  'chat.staged.tooLarge': 'Too large — attachments here are capped at {limit}.',
  'chat.staged.cancelUpload': 'Cancel upload',
  'chat.staged.cancelUploadOf': 'Cancel uploading {name}',

  // ------------------------------------------------------------ expiry units

  // The lifetimes the picker offers before any destination has had its say.
  //
  // Fixed strings rather than plurals: each of these is one of a named unit,
  // the numeral in it is always 1, and a translator writing "1 Stunde" is
  // making a judgement about how their language says "a single hour" that no
  // plural rule can help with.
  //
  // There used to be a fifth, `chat.upload.expiryMonth`, reading "30 days".
  // That one was different in kind and it is gone. Thirty is not part of how
  // the language says anything; it is `30 * 24 * 60 * 60`, a constant in
  // `lib/upload.js`, and nothing connected the two. A translator could not
  // know the number was load-bearing, and the day somebody widens that preset
  // to sixty days, four catalogues go on saying thirty and nobody finds out.
  // The preset now carries no `labelKey` at all and `expiryOptions` describes
  // it from its own seconds through `chat.upload.limitDays` below, which is
  // the plural that was already there for exactly this. English still reads
  // "30 days"; it now reads it because the seconds say so.
  'chat.upload.expiryHour': '1 hour',
  'chat.upload.expiryDay': '1 day',
  'chat.upload.expiryWeek': '1 week',
  // `common.never` says the same word, and this does not use it, for the same
  // reason as the clipboard pair above: it is the last of five options in one
  // menu and it should be translated alongside the other four. In several
  // languages the adverb "never" and the word that ends a list of durations
  // are not the same word.
  'chat.upload.expiryNever': 'Never',

  // A cap that is not one of the presets, in human units -- 900 seconds as
  // "15 minutes". Kept coarse on purpose: this labels a retention rule, not a
  // countdown.
  //
  // These replace `days === 1 ? '1 day' : days + ' days'`, which is the bug
  // this whole migration exists to fix twice over. It has two arms because
  // English has two; Arabic has six and Japanese has one, and neither of those
  // facts is knowable from the call site. `#` prints the count through
  // `Intl.NumberFormat`, so Arabic also gets Arabic-Indic digits, which the
  // string concatenation could never have done.
  'chat.upload.limitDays': '{count, plural, one {1 day} other {# days}}',
  'chat.upload.limitHours': '{count, plural, one {1 hour} other {# hours}}',
  'chat.upload.limitMinutes': '{count, plural, one {1 minute} other {# minutes}}',

  // An encrypted attachment that would not come back from the origin it was
  // put on. Two whole sentences rather than one with a noun phrase dropped
  // into it: "the attachment" is not a name, it is what English says when it
  // has no name to use -- definite article, lower case, bound to the verb in
  // front of it -- and a language that marks its objects differently has to be
  // free to change the rest of the sentence around it.
  'chat.upload.fetchFailedNamed': 'Could not fetch {name}',
  'chat.upload.fetchFailed': 'Could not fetch the attachment',

  // -------------------------------------------------------- the autocomplete

  // The note on the far edge of a completion row, saying what kind of thing
  // this row is.
  //
  // `@everyone` and `@here` are not translated -- they are the literal text
  // that goes into the message and that the server matches on -- but what they
  // *do* is, and that is this line. "Notify the channel" rather than "Everyone"
  // because the row already says everyone; what a reader about to press Enter
  // wants to know is what pressing it will set off.
  'chat.autocomplete.notifyChannel': 'Notify the channel',
  'chat.autocomplete.role': 'Role',
  // A custom emoji from this guild, against one from another. "Custom" is the
  // whole note in the local case because the guild is the room you are in and
  // naming it would be telling you where you are.
  'chat.autocomplete.emojiCustom': 'Custom',
  'chat.autocomplete.emojiFrom': '{guild} emoji',
  // The stand-in when a guild the emoji came from is not one this client has
  // loaded. Lower case would read as a description; this is filling a slot
  // where a proper name goes.
  //
  // It said "Other server" until it was noticed, and the key said
  // `otherServer`. In Telium a guild is not a server: a guild is a room with
  // members and channels, a server is the homeserver that hosts it, and one
  // homeserver hosts many guilds. The slot this fills is `{guild}` in
  // `chat.autocomplete.emojiFrom` one key up -- an emoji belongs to a guild --
  // so "server" here named the wrong thing entirely and named it with the one
  // word the product is careful to reserve for something else. The key was
  // renamed with the value so that the old fingerprint does not carry over
  // and every language re-reads it.
  'chat.autocomplete.otherGuild': 'Other guild',
  // The row that stands in for the list while the rest of the membership is
  // being fetched. It replaces the rows rather than sitting above them, so it
  // is a whole statement and not a header.
  //
  // Also "server" until it was noticed. The request behind it is
  // `api.members(guildId, ...)`: it is one guild's member list being searched,
  // not a homeserver's directory, and the two are different enough searches
  // that telling them apart matters to whoever is waiting.
  'chat.autocomplete.searching': 'Searching this guild…',

  // The second line on a voice channel's row, which is the one fact a reader
  // wants about a voice room: whether anybody is in it.
  //
  // The slash form is notation, not a sentence -- it is what a capacity is
  // written as on a door, and it survives being read right to left because
  // both numbers are already bidi-isolated. The unlimited case is a real
  // plural because it is a real count of people.
  'chat.autocomplete.voiceHereOfLimit': '{count}/{limit} in voice',
  'chat.autocomplete.voiceHere': '{count, plural, one {# person in voice} other {# people in voice}}',
  'chat.autocomplete.voiceLimit': '{limit, plural, one {Up to # person} other {Up to # people}}',

  // ------------------------------------------------------------- forwarding

  // Two titles for one dialog, because they are two acts. Forwarding moves a
  // message you are reading; sharing is the operating system handing this app
  // something from somewhere else. English could get away with one word and
  // most languages cannot.
  'chat.forward.title': 'Forward message',
  'chat.forward.shareTitle': 'Share to Telium',
  'chat.forward.search': 'Search channels and conversations',
  // What kind of destination a row is, as the pill on its right. A guild
  // channel's pill is the guild's name and needs no entry; these two are the
  // conversations, which have no name to show.
  'chat.forward.groupChat': 'Group chat',
  'chat.forward.directMessage': 'Direct message',
  // The button, and the button while it is working. Not `common.save`/
  // `common.saving`: this sends a copy somewhere, and several languages use a
  // different verb for dispatching a thing than for storing it.
  'chat.forward.send': 'Send',
  'chat.forward.sending': 'Sending…',
  'chat.forward.failed': 'Could not forward',
  'chat.forward.shareFailed': 'Could not share',
  // The empty state, with what was typed quoted back. The quotation marks are
  // inside the string and not around the placeholder in JSX precisely because
  // they are not the same marks everywhere -- German writes „…“ and Japanese
  // 「…」 -- and a component that drew them would have made that choice for
  // every language at once.
  'chat.forward.noMatches': 'Nothing matches “{query}”.',

  // ----------------------------------------------------------- the media card
  //
  // An attachment is a row with a name on it, and almost everything written
  // here is read by somebody who cannot see the picture: these are the strings
  // a screen reader says in place of the thing itself, plus the handful of
  // sentences the card shows when the bytes do not arrive.
  //
  // The rule that shaped this section: the file's name is never glued to a
  // word. Every entry below that mentions a file takes it as `{name}` and puts
  // the surrounding sentence entirely in the translator's hands, because the
  // code that used to assemble these strings then read them back apart again
  // -- `label.endsWith(' audio')` -- and there is no language but English in
  // which that test is true.

  // What the player is, named. Both patterns exist so that a screen reader can
  // say "holiday.mp4 video" where English wants it and "video holiday.mp4"
  // where the language does; the caller no longer decides the order.
  //
  // These two are the only entries in this namespace that get interpolated
  // into another entry rather than rendered directly -- every `{label}` below
  // is one of them -- so a translation that ends in punctuation will read
  // badly inside "Play …". Keep them as bare noun phrases.
  'chat.player.audioOf': '{name} audio',
  'chat.player.videoOf': '{name} video',

  // The transport, as a screen reader hears it. A verb and its object, and the
  // verb agrees with the object in languages that inflect -- which is exactly
  // why these are five patterns and not one verb concatenated onto `{label}`
  // at five call sites, which is what this file did before.
  'chat.player.play': 'Play {label}',
  'chat.player.pause': 'Pause {label}',
  'chat.player.seek': 'Seek {label}',
  'chat.player.mute': 'Mute {label}',
  'chat.player.unmute': 'Unmute {label}',
  'chat.player.volume': 'Volume {label}',
  'chat.player.fullscreen': 'Fullscreen {label}',

  // When the browser will not play it. Two keys because the offer differs:
  // a wrapper that can write to the phone offers to keep the file, and
  // everywhere else the only thing left to do is open it somewhere that can.
  // The dash is an em dash with spaces around it -- a language that joins
  // clauses with a comma or a particle instead should do that rather than
  // preserving the punctuation.
  'chat.player.failedSave': 'Playback failed — save the original file',
  'chat.player.failedOpen': 'Playback failed — open the original file',

  // The row around the player.
  //
  // `save` is the button; `saveNamed` and `openNamed` are the tooltips on the
  // filename itself, which is a control. Three entries and not one with a
  // `{name}` that is sometimes empty, because "Save" alone is an imperative
  // and "Save holiday.mp4" is an imperative with an object, and several
  // languages spell the bare form differently.
  'chat.attachment.save': 'Save',
  'chat.attachment.saveNamed': 'Save {name}',
  'chat.attachment.openNamed': 'Open {name}',

  // Where the bytes actually live. `{host}` is a domain -- it is never
  // translated, it is frequently Latin script inside an Arabic sentence, and
  // the pattern is what decides whether it reads left-to-right in the middle
  // of a right-to-left line, so keep it whole and keep it away from the edge.
  'chat.attachment.hostedOn': 'Hosted on {host}',

  // A file with no name we can show, and a URL we could not parse. These are
  // the words that stand in the slot where a filename or a domain would have
  // gone, so they are lower case on purpose: they are descriptions of an
  // absence, not titles. A language that has no lower case simply ignores that.
  'chat.attachment.unnamed': 'attachment',
  'chat.attachment.externalMedia': 'external media',
  'chat.attachment.externalHost': 'external host',
  'chat.attachment.unknownHost': 'unknown host',

  // Saving, and failing to. The unnamed case is its own sentence rather than
  // the named one with the slot emptied: English gets away with
  // "Attachment saved." because a capitalised noun at the head of a sentence
  // happens to fit where an interpolated filename fits, and German (which
  // capitalises the noun either way) and Japanese (which has no casing and
  // would rather mark the topic) do not have that coincidence available.
  'chat.attachment.saved': '{name} saved.',
  'chat.attachment.savedUnnamed': 'Attachment saved.',
  'chat.attachment.saveFailed': 'Could not save attachment',

  // The external file host. `{provider}` is a company name -- Gofile today --
  // and it is interpolated rather than baked in for the ordinary reason: the
  // verb goes last in Japanese, and "Gofile で開く" is unreachable from a
  // sentence that ends where English ends.
  'chat.attachment.openOnProvider': 'Open on {provider}',
  'chat.attachment.openProviderFailed': 'Could not open {provider}',

  // Two waiting states, drawn in the corner of the row where a file size
  // normally sits. Lower case and trailing ellipsis in English because they
  // are captions on a spinner rather than sentences; the ellipsis is the
  // single character U+2026, so a translator replacing it with three periods
  // is making the row wider for no reason.
  'chat.attachment.preparing': 'preparing…',
  'chat.attachment.decrypting': 'decrypting…',

  // The one failure a reader can do nothing about: the bytes arrived and the
  // key did not open them. Split for the same reason `saved` is split.
  'chat.attachment.decryptFailed': '{name} could not be decrypted',
  'chat.attachment.decryptFailedUnnamed': 'This attachment could not be decrypted',

  // --------------------------------------------------------------- the picture
  //
  // The lightbox and the thumbnail that opens it. `untitled` is the noun that
  // stands in for a picture nobody named, and it stands alone in `alt`, so it
  // is written as a caption would be written: capitalised, in English.
  //
  // That is why the zoom control is two entries. The named form drops a real
  // caption into a sentence; the unnamed form has the word already written into
  // it, at the casing that sentence wants, because a pattern cannot recase what
  // it interpolates and a caller that lowercased the noun first would be
  // corrupting German (Bild is capitalised mid-sentence too) to flatter
  // English. A translator into a language with no letter case simply writes the
  // same word twice and loses nothing.
  'chat.image.untitled': 'Image',
  'chat.image.viewLarger': 'View image larger',
  'chat.image.viewLargerNamed': 'View {label} larger',
  'chat.image.preview': 'Image preview',
  'chat.image.close': 'Close image preview',
  'chat.image.save': 'Save',
  'chat.image.openOriginal': 'Open original',

  // ------------------------------------------------------------- the GIF picker
  //
  // "GIF" stays "GIF" in all four catalogues shipped here: it is the name of
  // the format, it is what the button on the composer is drawn with, and every
  // GIF service in the world spells it this way. A translator whose language
  // genuinely has its own word for the format should use it -- the point of
  // giving it a key is that the decision is theirs and not ours.
  'chat.gif.search': 'Search GIFs',
  'chat.gif.results': 'GIF results',
  'chat.gif.picker': 'GIF picker',
  'chat.gif.dialogTitle': 'GIFs',
  'chat.gif.untitled': 'GIF',

  // The one chip that is not a category, and the words the header controls
  // use. "Trending" is the provider's idea of what is popular right now;
  // "Favorites" is the reader's own starred list, which has no chip any more
  // -- the first cell of the grid is that door now (see `GifPicker.jsx`) --
  // but the word is still the door's name, and it must match
  // `favorite`/`unfavorite` below in the same language or the door and the
  // star will be describing the same list by two names.
  'chat.gif.trending': 'Trending',
  'chat.gif.favorites': 'Favorites',
  'chat.gif.favorite': 'Favorite GIF',
  'chat.gif.unavailable': 'File unavailable',
  'chat.gif.unfavorite': 'Unfavorite GIF',

  // The two controls beside the search field, which the phone sheet does not
  // draw: a picker that can be made bigger, and one that can be made to fill
  // the window. "Resize" names the grip in the corner -- a focusable control
  // in its own right, so it needs a name a screen reader can announce rather
  // than a tooltip.
  'chat.gif.fullscreen': 'Fullscreen',
  'chat.gif.exitFullscreen': 'Exit fullscreen',
  'chat.gif.resize': 'Resize GIF picker',

  // The tooltip on a tile. `{title}` is whatever the provider called the GIF,
  // which is usually English and occasionally nothing at all -- in which case
  // the caller passes `chat.gif.untitled` into the slot, so this pattern
  // always has a noun to work with.
  'chat.gif.send': 'Send {title}',

  // Everything the grid can say instead of showing GIFs. The first two are
  // about this server's configuration rather than about the reader, and they
  // are phrased as statements of fact for that reason: there is nothing to do
  // about either from inside the picker.
  'chat.gif.disabled': 'GIF search is disabled by this server.',
  'chat.gif.notConfigured': 'GIF search is not configured yet.',
  'chat.gif.loadFailed': 'GIFs could not be loaded.',
  'chat.gif.loading': 'Loading GIFs…',
  'chat.gif.favoritesEmpty': 'Star a GIF to keep it here.',
  'chat.gif.noMatches': 'Nothing matched that.',

  // A share link the client could not resolve into an image, and a GIF whose
  // bytes never arrived. `{provider}` is Tenor, Giphy or Klipy -- company
  // names, never translated, always interpolated.
  'chat.gif.openOn': 'Open GIF on {provider}',
  'chat.gif.unavailable': 'GIF unavailable — open it directly',

  // The category chips.
  //
  // Each of these is only the caption. The search actually sent to the GIF
  // provider stays in English and lives in `CATEGORIES` in `GifPicker.jsx`,
  // because Klipy, Tenor and Giphy all index their libraries against English
  // tags -- so translating the query would empty the grid, while translating
  // the caption is simply correct.
  //
  // That frees these entries completely: they do not have to be translations
  // of the English word, only the right caption for a chip that returns those
  // GIFs. "Facepalm" and "Shrug" name gestures rather than words, and a
  // language whose readers know them by a different gesture, a loanword or
  // even an emoticon should say that instead.
  'chat.gif.category.reactions': 'Reactions',
  'chat.gif.category.happy': 'Happy',
  'chat.gif.category.cry': 'Cry',
  'chat.gif.category.love': 'Love',
  'chat.gif.category.dance': 'Dance',
  'chat.gif.category.cats': 'Cats',
  'chat.gif.category.dogs': 'Dogs',
  'chat.gif.category.thumbsUp': 'Thumbs up',
  'chat.gif.category.facepalm': 'Facepalm',
  'chat.gif.category.applause': 'Applause',
  'chat.gif.category.shrug': 'Shrug',
  'chat.gif.category.excited': 'Excited',

  // ----------------------------------------------------------- the emoji picker
  //
  // One thing this section does not contain: the names of the emoji. Those
  // come out of the Unicode dataset the picker lazy-loads, they are English,
  // and they stay English until that dataset ships a localised build. Two
  // thousand CLDR names re-typed by hand into four catalogues would be stale
  // by the next Unicode release and wrong in the meantime, which is worse than
  // being honestly untranslated. The shortcode beside each name (`:grinning:`)
  // is input syntax rather than a word and never moves in any case.
  'chat.emoji.search': 'Search emoji',
  'chat.emoji.grid': 'Emoji',
  'chat.emoji.picker': 'Emoji picker',
  'chat.emoji.dialogTitle': 'Emoji',
  'chat.emoji.categories': 'Emoji categories',

  // The footer, before the pointer has touched anything. It is also written
  // back into the same element by hand on every pointer move, so both spellings
  // of it come from this one key -- see `describe()` in `EmojiPicker.jsx`.
  'chat.emoji.hint': 'Pick an emoji.',

  // Two loads, and they are genuinely different waits: the first is the
  // Unicode dataset arriving over the network, the second is this account's
  // guilds answering with their own uploads. Somebody who sees the second one
  // for a while is waiting on servers, not on us.
  'chat.emoji.loading': 'Loading emoji…',
  'chat.emoji.loadingCustom': 'Loading custom emoji and stickers…',

  // Nothing to show. `empty` names the Recent section, so it has to agree with
  // `chat.emoji.group.recent` in the same language -- a translator who renames
  // the rail tab and not this sentence sends the reader looking for a tab that
  // is no longer called that.
  'chat.emoji.noMatches': 'No emoji match that.',
  'chat.emoji.empty': 'Nothing here yet. Emoji you pick show up under Recent.',

  // The quotation marks are inside the pattern on purpose. English curly
  // quotes are neither the Japanese corner brackets nor the Arabic pair, and a
  // translator who cannot move them is stuck with somebody else's typography
  // around their own words.
  'chat.emoji.results': 'Results for “{query}”',
  'chat.emoji.stickerResults': 'Stickers',
  'chat.emoji.savedStickers': 'Saved stickers',

  // Section headings over a guild's own uploads. `{guild}` is a server name --
  // arbitrary text chosen by somebody else, in any script -- so it is never
  // concatenated and the word order around it is the translator's.
  'chat.emoji.guildEmoji': '{guild} emoji',
  'chat.emoji.guildStickers': '{guild} stickers',
  'chat.emoji.saveSticker': 'Save sticker',
  'chat.emoji.unsaveSticker': 'Unsave sticker',

  // Skin tone. `skinToneOf` takes one of the six names below as `{tone}`,
  // which is why they are separate entries rather than a single label that
  // doubles as both: "Medium light skin tone" is one noun phrase in English
  // and an adjective agreeing with a noun in most of the languages this
  // client ships, and the agreement cannot happen if the phrase is glued.
  'chat.emoji.skinTone': 'Skin tone',
  'chat.emoji.skinToneOf': '{tone} skin tone',

  // The five Fitzpatrick modifiers and the unmodified glyph. "Default" is the
  // yellow, tone-less emoji -- not a skin colour, which is why it is not named
  // as one. The other five are the Fitzpatrick scale's own terms and are worth
  // matching to whatever wording the local platform uses, since readers meet
  // these exact six options in their operating system's picker too.
  'chat.emoji.tone.default': 'Default',
  'chat.emoji.tone.light': 'Light',
  'chat.emoji.tone.mediumLight': 'Medium light',
  'chat.emoji.tone.medium': 'Medium',
  'chat.emoji.tone.mediumDark': 'Medium dark',
  'chat.emoji.tone.dark': 'Dark',

  // The category rail. These are the Unicode emoji group names, shortened to
  // fit a tooltip: the dataset calls group 1 "People & Body" and group 3
  // "Animals & Nature", and a rail of ampersands reads as noise. Shorten them
  // the same way in every language rather than transliterating the long form.
  //
  // "Recent" is not a Unicode group; it is this reader's own history, and it
  // is the tab `chat.emoji.empty` points at by name.
  'chat.emoji.group.recent': 'Recent',
  'chat.emoji.group.smileys': 'Smileys',
  'chat.emoji.group.people': 'People',
  'chat.emoji.group.nature': 'Nature',
  'chat.emoji.group.food': 'Food',
  'chat.emoji.group.travel': 'Travel',
  'chat.emoji.group.activities': 'Activities',
  'chat.emoji.group.objects': 'Objects',
  'chat.emoji.group.symbols': 'Symbols',
  'chat.emoji.group.flags': 'Flags',

  // ---------------------------------------------------------------- link cards
  //
  // The play button over a video unfurled from a link. `{title}` is the page's
  // own Open Graph title, written by a stranger's website in a language we do
  // not know -- the colon is English punctuation for introducing it and a
  // language that would sooner lead with the title, or drop the separator
  // entirely, should do that.
  'chat.embed.playVideo': 'Play video',
  'chat.embed.playVideoTitled': 'Play video: {title}',
};
