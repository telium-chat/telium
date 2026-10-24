// Everything the client says about what somebody other than the people you are
// talking to gets to observe.
//
// One namespace, one file, and that is the point of it rather than an accident
// of how the keys were named. `docs/privacy.md` is the source of truth for
// every sentence below, and the reason this file exists at all is the sentence
// at the top of `ConversationSignalsPane.jsx`: the difference between the
// choices a person is making "used to live only in `docs/privacy.md` -- a
// document nobody opens while they are deciding". The conversation-signals pane
// closed that gap for call modes and for the three conversation signals. These
// keys close it for the five remaining places where a decision is taken in the
// client and the fact that decides it is in the document.
//
// It is the same arrangement `web/src/lib/net/policy.js` already has for
// network addresses, and for the same reason: a privacy claim spread across
// JSX is a claim nobody can audit. Every promise the interface makes about
// observation is either here or in `policy.js`, so "what does Telium tell
// people we can see" is a question two files answer completely.
//
// ------------------------------------------------ the rule for adding a key
//
// Two tests, and a key that fails either one does not belong here:
//
//   1. **It is traceable.** Every sentence names a fact stated in
//      `docs/privacy.md` or visible in the code, and the comment above the key
//      says which. No sentence here is a summary, a reassurance, or an
//      inference from two other sentences. The document's own "Claims that
//      were too strong" list runs to ten entries and most of them are one
//      mistake wearing different clothes: a sentence that is true of half a
//      thing, printed as though it were true of all of it. Receipts and
//      typing. Friend ids and friend domains. What the aggregate view shows
//      and what the database contains. Entry 5 gives the shape a name --
//      "two true statements arranged to imply a third that is false" -- and
//      it is the failure mode a well-meaning privacy string falls into every
//      single time.
//   2. **It appears where a decision is being made.** A warning attached to
//      every control is a warning nobody reads, which is worse than silence
//      because it also devalues the warnings that had something to say. So a
//      key here is drawn at the moment somebody chooses -- picking a status,
//      confirming a block, opening the GIF grid, turning background push on --
//      and not on a help page, not behind a disclosure, and not on a control
//      whose consequence the person cannot do anything about.
//
// Two candidates were judged against that second test and deliberately left
// out. They are named here rather than only in the commit, because an absence
// that is only in a commit message is an absence the next reader will assume
// was an oversight and "fix". One of the two has since come back, and the
// paragraph that explains how is worth more than deleting it would be.
//
//   * **Viewing somebody's profile.** `docs/privacy.md` is blunt about the
//     fan-out -- opening a profile asks every domain that hosts a mutual
//     friend, so "up to twelve servers learn that you looked". It is the most
//     surprising fact in the document and it did not get a line, because
//     `useMutuals` prefetched on pointer *hover*: by the time a card existed to
//     write on, the twelve requests had gone. A sentence there would have told
//     somebody what they had already done, with no control to do it
//     differently, which is the purest form of the warning people learn to
//     ignore. What that surface needed was a setting, not a paragraph.
//
//     It has one now -- Profile lookups, in settings -- and that is what let
//     the `privacy.lookups.*` keys below through the second test. They are not
//     drawn on the card where the disclosure would arrive too late; they are
//     drawn under the three options, at the moment somebody is deciding how
//     often this happens at all. The rule did not bend. The surface changed
//     until it passed.
//   * **The privacy relay.** The document's own note says the relay is the one
//     actor with no section because the opt-in protected transport is not
//     built. There is nothing to disclose about a thing that does not run, and
//     a stub here would be the interface making a promise the code cannot keep.
//
// ------------------------------------------------------------ on the voice
//
// The pane these follow does not use `Notice`, and neither should anything
// drawn from this file. Nothing here has gone wrong. Dressing a factual list
// as an alert teaches people that facts are alerts, and the next real alert is
// the one they dismiss. Each of these is a flat, quiet statement of who is on
// the wire, in the same register as `POSTURE_OBSERVERS` in `lib/callmode.js`.

export const privacy = {
  // ------------------------------------------------------------ presence

  // Drawn under the four status rows in the account menu, where Invisible is
  // chosen.
  //
  // This is the sharpest of the gaps this file was written for. The row's own
  // note says "you appear offline", which is exactly true of other people and
  // exactly false of the server doing the appearing, and the only place that
  // difference was written down was the presence row of the homeserver table
  // in `docs/privacy.md`: "Whether you are connected, on how many devices, and
  // when -- **including when you have chosen Invisible**, which is collapsed
  // to 'offline' only for everyone else."
  //
  // Somebody who reads "you appear offline" as "nobody can tell I am here" has
  // been told the opposite of what the system does, and they have been told it
  // at the instant they were relying on it. So the sentence is drawn in the
  // menu, next to the choice, and it says which party is excluded from the
  // promise rather than softening the promise into vagueness. "counts the
  // devices" is load-bearing and must survive translation: the homeserver does
  // not merely know you are somewhere, it knows how many places.
  'privacy.presence.invisible': 'Invisible is what everyone else is told. Your home server still sees this connection and counts the devices you are signed in on.',

  // ---------------------------------------------------------------- blocks

  // The body of the block confirmation.
  //
  // `docs/privacy.md` carries this under "A block does not stop a DM" and
  // again as correction 9, which is the most carefully worded paragraph in the
  // document because the true sentence and the reassuring one are so close
  // together. What a block does: message requests "hold a stranger's
  // one-to-one out of your rail, raise no unread and no notification, and
  // refuse to carry your typing or your call signalling back to them before
  // you accept". What it does not do: "a block still does not stop a DM being
  // *sent*. It stops it reaching you."
  //
  // The code agrees, and it is worth saying where, because this sentence is a
  // claim about a server: `local_dm_policy` in `server/src/routes/dm.rs`
  // answers `visible: false` for a blocked relation *after* the conversation
  // has been created and the frames stored, and `may_receive_dm_interaction`
  // deliberately drops typing and call signalling "so a remote sender must not
  // learn whether the recipient is pending, declined or blocked".
  //
  // The old copy said "Requests from them stop reaching you", which is true of
  // friend requests and reads as a claim about messages. Somebody deciding
  // whether a block is enough protection needs the last clause most: their
  // messages are still written down on your home server, and the person you
  // blocked cannot tell. Both halves are the answer to a real question
  // ("will they know?" and "am I now unreachable?") and neither is padding.
  'privacy.block.body': 'They see the friendship end, and nothing from them reaches you again — no request, no message, no notification, and they are never told which. It does not stop them sending: your home server still takes their messages and stores them, and on their side the conversation looks ordinary.',

  // ------------------------------------------------------------- GIF picker

  // Drawn inside the GIF grid, and only in a private conversation.
  //
  // `docs/privacy.md`, under external providers: "**GIFs are the exception, and
  // they are not proxied.** The client fetches GIF embeds itself, on purpose.
  // So the GIF host [...] **sees your IP, and the GIF you chose, every time one
  // renders**, including inside an end-to-end encrypted DM. [...] There is
  // currently no setting to turn this off."
  //
  // Of every fact in this file this is the one most worth putting in front of
  // somebody, because it is the only one they can act on in the next second:
  // told at the moment of picking, a person may pick something else or send
  // nothing. That is the whole test a surface here has to pass, and this one
  // passes it outright.
  //
  // It is drawn in a private conversation and nowhere else, and the asymmetry
  // is deliberate rather than laziness about the guild case. In a guild
  // channel the message is already plaintext to the guild's server, so a third
  // party also seeing it is a small addition to a large disclosure and a line
  // about it would be noise on a screen where people send fifty GIFs a day. In
  // an encrypted conversation it is the reverse: the person chose a channel
  // that no server can read, and this one control steps outside it. The
  // contrast is the information.
  //
  // `{host}` is the provider actually configured for this deployment, read off
  // the search API's own base URL rather than written into the sentence, since
  // the document is careful to say "Tenor, Giphy, or whichever provider is
  // configured" and an operator can point it anywhere.
  'privacy.gif.head': 'This conversation is encrypted. The GIF is not.',
  'privacy.gif.body': 'Your device asks {host} for these results and fetches whatever you send straight from them, so they see your address and which GIF you picked. None of it goes through your home server, and there is no setting that turns it off.',

  // -------------------------------------------------- typing, in an E2EE DM

  // Appended to the encryption claim in a conversation's header chip and to
  // the same claim spelled out in the conversation's details.
  //
  // `docs/privacy.md` gives typing its own box under the homeserver, and the
  // reason it is the first of the ten corrected claims is that the code used
  // to say the comfortable thing: "Read and delivery receipts are genuine MLS
  // application frames [...] **Typing is not.** Current clients send typing as
  // a plaintext gateway event, and the server fans it out to every member [...]
  // So the sequencer **and every participant's homeserver** learn who is
  // typing, in which conversation, at what millisecond."
  //
  // The chip is where this client says the word "encrypted", and its tooltip
  // is already the list of what the servers in the path can still see. That
  // list had one omission and it was the only item on it that is not
  // encrypted, which makes this an asterisk on an existing claim rather than a
  // new warning -- the cheapest kind of honesty there is.
  //
  // Drawn only while this account is actually emitting typing. Somebody who
  // has already turned the signal off in Conversation signals is not subject to
  // the caveat, and the document says so in as many words: "Turning the typing
  // toggle off in Conversation signals stops your client emitting it, which is
  // a real and complete mitigation for you personally." A disclosure that
  // disappears once it has been dealt with is the opposite of warning fatigue:
  // seeing it means it is true of you right now.
  'privacy.typing.inEncrypted': 'Typing indicators are the exception: they leave in the clear, so your server, everyone else’s server and everyone in the conversation see them as they happen. Conversation signals turns them off.',

  // ----------------------------------------------------------- profile lookups

  // Drawn under the three options on the Profile lookups pane, and under all
  // three of them rather than only under the loose one -- see the comment at
  // the note in `ProfileLookupsPane.jsx` for why an argument that only appears
  // beside the choice we dislike is not a disclosure.
  //
  // `docs/privacy.md` on the mutual-friend check: your home server "asks one
  // peer per domain present in your friend list whether it hosts somebody you
  // have both accepted", and "for a user with friends on twelve servers, one
  // profile view is twelve disclosures of a browsing event". The guild half is
  // visible in `store.mutualGuildsWith`, which asks every guild host this
  // account belongs to whether that person is a member.
  //
  // The head says "a question this account asks out loud" because the thing a
  // reader needs before the list is that a lookup is not a local operation.
  // The chips look like something the client already knew -- it knows your
  // friends, it knows the guilds -- and the entire surprise of this section is
  // that answering "what do we have in common" is a network act with an
  // audience. Naming that first is what makes the three rows land as
  // consequences rather than as trivia about federation.
  'privacy.lookups.head': 'Finding what you have in common with somebody is a question this account asks out loud.',

  // The three parties, ordered by how much each one learns and how little it
  // was asked to. Your own server first because it is the only one you chose;
  // the strangers last.
  //
  // "Your home server" is separated from the peers even though it is the thing
  // that contacts them, because what it holds is different in kind: it already
  // has your friend list, so the lookup tells it only the timing. The peers
  // are the new disclosure.
  'privacy.lookups.party.home': 'Your home server',
  'privacy.lookups.sees.home': 'that you looked, and who at. It already holds your friend list, so the lookup adds the timing and nothing else.',

  // The load-bearing row, and the one the wording of has to survive
  // translation intact. It is **one peer per domain**, not per friend, and it
  // is every such domain, not only the ones that turn out to have an answer --
  // that is the whole reason the number is large and the reason a server with
  // nothing to say still learns something. `local_mutuals` keeps the peer's
  // own friend rows on the peer, so what travels is the fact of the question,
  // not a list; saying "your friend list" here would be the stronger claim
  // the document's corrections list warns against.
  'privacy.lookups.party.friendHosts': 'Every server that hosts a friend of yours',
  'privacy.lookups.sees.friendHosts': 'one signed question each, naming you and the person you are looking at. They are all asked, including the ones with nothing to say, so each of them learns that you were reading at that moment.',

  // The half that runs from this browser rather than from your server, which
  // is why it is worth its own row: it carries this device's address, and the
  // home-server-side wording above would quietly be wrong about it.
  'privacy.lookups.party.guildHosts': 'Every server you share a space with',
  'privacy.lookups.sees.guildHosts': 'a request from this device asking whether that person is a member, so they see your address as well as the fact that you asked.',

  // The qualification that belongs after the list rather than inside it, in
  // the `PrivacyNote` sense: the case where the rule above does not hold.
  //
  // It exists to stop the pane implying its own middle option is private. All
  // three settings produce exactly the list above whenever a lookup fires; the
  // setting changes how often and on whose initiative, never the audience.
  // Leaving that unsaid would be correction 5 in the document -- "two true
  // statements arranged to imply a third that is false" -- assembled out of an
  // accurate party list and an accurate set of option labels.
  'privacy.lookups.note': 'That is who hears about it every time a lookup happens. The setting above changes how often, and whether anything but a deliberate open can start one — it does not make a lookup quieter.',

  // -------------------------------------------------------- background push

  // Drawn under the background-push switch.
  //
  // `docs/privacy.md` on Web Push: "the provider sees your endpoint URL -- a
  // stable per-browser identifier -- the timing and size of every push, an
  // urgency hint, and a TTL. The payload is encrypted to your browser's key
  // (RFC 8291), so the provider does not see the guild or channel named inside
  // it. But VAPID authentication means the provider **does** learn which
  // homeserver is pushing to that endpoint. Over time that is a log of when
  // your homeserver had something to tell you."
  //
  // The section already said the true and comfortable half -- wake-ups carry
  // no message content -- and stopped there, which is the exact shape of
  // correction 5 in the document: "Two true statements arranged to imply a
  // third that is false." What the provider cannot read is the content; what
  // it does accumulate is a timeline. Somebody deciding whether to hand a
  // browser vendor a doorbell is deciding about the timeline, so the timeline
  // is what the sentence is about, and the encryption is mentioned only to be
  // bounded.
  //
  // The head names the provider as the part of this that is not yours, because
  // the rest of the pane is about Telium's own behaviour and a reader
  // skimming it has no reason to notice that one row reaches outside.
  'privacy.push.head': 'Your push provider is the browser vendor’s service, and it is the one part of this that is not yours.',
  'privacy.push.provider': 'It gets a stable address for this browser, and the time and size of every wake-up. The contents are encrypted to this browser, so it cannot read them — but the signature on each one names your home server, so over time it holds a log of when your home server had something to tell you.',
};
