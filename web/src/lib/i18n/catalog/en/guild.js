// The settings a guild has about itself: who may come in, who has been thrown
// out, what the place is called, where its voice traffic goes, and what has
// been done here lately.
//
// Ten panes behind one rail. They are one namespace because they are one job
// -- running a guild -- and because a translator who has the ban list's
// vocabulary in their head is the right person to be holding the gates pane's.
// The three panes that are *not* here are roles, channel permissions and the
// bot panes; roles and permissions have a vocabulary of their own that
// `perms.js` and `roles.js` own, and the bot panes speak about a different
// kind of thing entirely.
//
// ------------------------------------------------- who is reading these words
//
// Almost nobody. Every string below is behind a permission -- MANAGE_GUILD,
// BAN_MEMBERS, MODERATE_MEMBERS, VIEW_AUDIT_LOG -- so the reader is a
// moderator or an owner, which changes two things about how it should be
// translated.
//
// First, a moderator is *acting on other people*, and several of these
// sentences describe an irreversible act done to somebody who is not in the
// room. "Channels, messages, roles and members all go at once" is not a
// flourish; it is the last thing a person reads before a guild stops existing.
// Translate the consequence, in full, with the same flatness. A softened
// warning here costs somebody else their conversations.
//
// Second, a moderator is reading alongside things that are *not* translated --
// a rules box they typed themselves, an audit code the server chose, a
// hostname, a curator key. The copy has to sit next to that machine vocabulary
// without pretending to be it and without pretending it is prose. Where a
// string quotes a rule the reader types (`"allow example.org"`), the quoted
// part is syntax the server parses and must survive translation letter for
// letter; only the sentence around it moves.
//
// ------------------------------------------------------------ what is a value
//
// Anything in braces is supplied by the code, and in this namespace the values
// are almost all identifiers somebody has to match against something else:
// `{domain}` is a hostname, `{name}` is a guild name or a region name their
// owner typed, `{key}` is a curator's public key, `{scheme}` is a URL scheme,
// `{action}` is the literal word `allow` or `block` out of the rules box.
// None of them are translated. Move them wherever the grammar wants them; do
// not spell them differently, do not give them localised digits, and do not
// add quotation marks around them that English did not have -- a moderator is
// comparing them character by character against something on another screen.
//
// ---------------------------------------------- what is deliberately not here
//
// **Audit action codes.** `AuditPane` draws `e.action` -- `member.ban`,
// `role.update`, `guild.transfer_owner` -- inside a `<code>` element, exactly
// as the server sent it, and this catalogue gives none of them a human name.
// That is a decision rather than an omission. The list belongs to the server,
// it is longer than forty entries today, and it grows in releases this client
// knows nothing about; a lookup table here would cover some rows and not
// others, and a log where half the rows read as sentences and half as codes
// reads as a broken table rather than as an untranslated one. The code is also
// the string a moderator will paste into a support thread or grep for in a
// server log, which is the one job a translated name cannot do.
//
// If that is ever revisited, the shape is a table of *literal* keys in the
// source -- `{ 'member.ban': 'guild.audit.action.memberBan', ... }` -- read
// through `tOrNull` so an unknown code falls back to itself. Never a key built
// out of the code with a template literal: that is a key no extractor can find
// and no translator is ever shown.
//
// **Wire values.** The gate policies are `open`, `allowlist` and `blocklist`
// on the wire and the select below sends those bytes unchanged; only their
// visible labels are translated. Same for the two region types and the two
// health states in the voice pane.
//
// **Timestamps.** Every "when" column goes through `relative()` or the
// catalogue's `{at, dateTime}`, both of which are `Intl`'s work in the active
// locale. There is no date spelled out in a string here and there must not be.

export const guild = {
  // ------------------------------------------------------------------ the shell
  //
  // The rail down the side of the settings dialog. Each of these is one word
  // or two in a narrow column that does not scroll sideways, so length is a
  // real constraint: a label that wraps to three lines pushes the rest of the
  // rail off the screen on a phone. Prefer the shortest phrase that is still
  // the name of the thing, and if a language cannot be that short, shorten the
  // *phrase* rather than abbreviating the words -- an acronym a reader has to
  // decode is worse than a wrapped line.
  //
  // These are also the strings the pane search box filters on, which is the
  // other reason they should be what somebody would actually call the pane.

  'guild.nav.overview': 'Overview',
  'guild.nav.roles': 'Roles',
  'guild.nav.channels': 'Channel permissions',
  'guild.nav.bots': 'Bots',
  // "Gates" is the term of art for the checks a join is put through, and it is
  // used in the pane, in the save toast and in the server's own documentation.
  // Whatever word a language picks, it must be the same word in all of
  // `guild.gates.*`. "Origins" is the second half of the pane and means the
  // hosts an attachment may come from -- not a place, and not an origin in the
  // browser-security sense the reader may know from elsewhere.
  'guild.nav.gates': 'Gates and origins',
  'guild.nav.queue': 'Moderation queue',
  'guild.nav.purge': 'Spam cleanup',
  'guild.nav.bans': 'Bans',
  'guild.nav.invites': 'Invites',
  // The pane holds custom emoji *and* stickers, and is named for the emoji
  // because that is what nearly everybody opens it for. Do not rename it to
  // the union ("Expressions"): the English word was tried and read as jargon.
  'guild.nav.expressions': 'Emoji',
  // "SFU" is a protocol term -- selective forwarding unit, the relay a group
  // call runs through -- and it is in the label because the person who opens
  // this pane came looking for the word they read in their relay's own
  // documentation. It stays in Latin letters.
  'guild.nav.voice': 'Voice / SFU',
  'guild.nav.audit': 'Audit log',

  // The dialog's own title when the guild record has not arrived yet, so the
  // heading is a word rather than an empty box for one frame.
  'guild.title.fallback': 'Guild',
  // The eyebrow over the guild's domain at the top of the rail. It is a label
  // for a value directly beneath it, not a sentence, so it takes no full stop
  // and no colon.
  'guild.hostedBy': 'Hosted by',
  // Shown instead of the whole panel when this client is not connected to the
  // server that holds the guild. "Right now" is doing real work: nothing is
  // broken and nothing was lost, the connection is simply not up, and a reader
  // who thinks their guild is gone will go looking for somebody to tell.
  'guild.unreachable': 'That guild’s server is not reachable right now.',

  // ------------------------------------------------------------ shared durations
  //
  // Two selects in this namespace offer spans of time -- how long an invite
  // lives, and the longest lifetime an attachment may ask for -- and they
  // offer the same spans, so they share one set of labels. One key per option
  // rather than a pluralised `{n, plural, ...}` because these are fixed
  // choices in a menu and not counts of anything: a translator should write
  // "24 Stunden" or "٢٤ ساعة" or whatever their language actually puts in a
  // menu, including the digits in their own numerals, rather than being handed
  // a number and a noun and asked to make it agree.
  //
  // The *values* behind them are counts of seconds and are not here.

  'guild.duration.hour': '1 hour',
  'guild.duration.sixHours': '6 hours',
  'guild.duration.day': '1 day',
  'guild.duration.threeDays': '3 days',
  'guild.duration.week': '1 week',
  'guild.duration.thirtyDays': '30 days',
  // The top of the attachment-lifetime select: no cap at all. Distinct from
  // `common.never`, which is the invite select's "this link does not expire" --
  // one says there is no ceiling, the other says there is no deadline, and
  // English can use two different phrases for them.
  'guild.duration.unlimited': 'No limit',

  // ------------------------------------------------------------------- overview

  'guild.overview.name': 'Name',
  'guild.overview.description': 'Description',
  // The picker button, and what it says while the upload is in flight. The
  // second is a state, not a promise: the file has been handed to the server
  // and the button cannot be pressed again until it answers.
  'guild.overview.chooseIcon': 'Choose icon',
  'guild.overview.savingIcon': 'Saving icon…',
  // The line under the picker, which is the only confirmation that the upload
  // landed -- there is no second Save step after the crop dialog. Two states,
  // two keys, both complete sentences because they are read on their own.
  'guild.overview.iconSet': 'Custom icon set.',
  'guild.overview.iconNone': 'No icon.',
  'guild.overview.iconFailed': 'Could not save icon',

  // The two facts under the name and description fields, drawn side by side as
  // two sentences rather than one. Two keys and not one because they fail
  // independently: a federated guild record may carry a member count and no
  // creation date, or the other way round, and a single sentence would have to
  // be written four times to cover that.
  'guild.overview.memberCount': '{count, plural, one {# member} other {# members}}.',
  // What the previous line used to say was "? members", which reads as a count
  // of zero-or-something rather than as an absent fact. An older federated
  // server that does not publish the count gets a sentence instead.
  'guild.overview.memberCountUnknown': 'Member count unknown.',
  'guild.overview.created': 'Created {at, date, medium}.',
  // Deliberately vague, and deliberately not "Created at an unknown date":
  // this is a guild old enough to predate the field, and the honest thing to
  // say is that it has been here a while.
  'guild.overview.createdUnknown': 'Created a while ago.',

  // ------------------------------------------------------------- vanity link

  'guild.overview.vanity.title': 'Vanity link',
  'guild.overview.vanity.toggle': 'Enable vanity link',
  'guild.overview.vanity.hint': 'Off by default. When enabled, anyone with the address can preview and join this guild. Invite links still work too.',
  'guild.overview.vanity.label': 'Address name',
  'guild.overview.vanity.placeholder': 'linuxcommunity',
  'guild.overview.vanity.address': 'Guild address: {address}',
  'guild.overview.vanity.linkLabel': 'Browser link',
  'guild.overview.vanity.linkClipboard': 'vanity link',
  'guild.overview.vanity.saveFailed': 'Could not save vanity link',

  // -------------------------------------------------------- attachment lifetime

  'guild.overview.expiry.title': 'File expiration',
  // "here" is this guild. The second sentence is the part moderators get
  // wrong: this is a ceiling, and a channel may still choose something
  // shorter, so a guild-wide value of a week does not mean every file lives a
  // week.
  'guild.overview.expiry.hint': 'The longest lifetime an attachment may keep here. Channels may set a tighter cap.',
  // A field label that is the opening of the sentence its select finishes --
  // "Files may be kept for at most" / "30 days". A language that cannot split
  // a sentence across a label and a menu should make the label a noun phrase
  // ("Maximum file lifetime") rather than leaving a fragment hanging.
  'guild.overview.expiry.label': 'Files may be kept for at most',

  // ------------------------------------------------------- moving and ownership

  'guild.overview.move.title': 'Moving this guild',
  // A move is a two-party act and the order matters: the destination accepts
  // first, the current owner authorises second. Somebody who reads it the
  // other way round goes looking for a button that is not there yet. The last
  // sentence is the reassurance that stops people copying invite links out
  // before they start.
  'guild.overview.move.hint': 'The new owner confirms on the destination server, then the current owner authorises the move here. Old links keep resolving.',
  'guild.overview.move.ownerOnly': 'Only the guild owner can move it.',
  'guild.overview.move.button': 'Move to another server',
  // Shown to the owner when their own account lives on a different server from
  // the guild. `{domain}` is a hostname and is never translated.
  'guild.overview.move.elsewhere': 'This guild is hosted by {domain}, so the move has to be started from an account there.',

  // Three keys that are all "transfer ownership" in English and need not be in
  // any other language: the first names a section, the second is the button
  // that opens the question, the third is the button that commits it. A
  // language that distinguishes a noun phrase from an imperative should use
  // the noun for the heading and the imperative for the two buttons.
  'guild.overview.transfer.title': 'Transfer ownership',
  'guild.overview.transfer.button': 'Transfer ownership',
  'guild.overview.transfer.confirm': 'Transfer ownership',
  // "must already be a member" is the precondition people fall over: the
  // server refuses an account that has not joined, and the refusal arrives
  // after the id has been typed.
  'guild.overview.transfer.hint': 'The new owner must already be a member. After the transfer only they can transfer or delete the guild.',
  'guild.overview.transfer.dialogTitle': 'Transfer {name}',
  'guild.overview.transfer.label': 'New owner account id',
  'guild.overview.transfer.dialogHint': 'Enter the full account id of a current member.',
  // An example account id, in the shape this client requires:
  // `@localpart:domain`. It is in the catalogue rather than in the component
  // because a translator should be free to make the local part a name their
  // readers would recognise as a placeholder -- an English-shaped example is
  // as opaque as an English sentence. Two things must not change: the
  // `@` and `:` punctuation, which is the syntax the field validates, and the
  // `example.org` domain, which is reserved by RFC 2606 precisely so that
  // documentation cannot accidentally name somebody's real server. Substitute
  // a different reserved domain (`example.com`, `example.net`) if one reads
  // better; never a domain that resolves.
  'guild.overview.transfer.placeholder': '@member:example.org',
  'guild.overview.transfer.done': 'Ownership transferred.',
  'guild.overview.transfer.failed': 'Could not transfer ownership',

  'guild.overview.delete.title': 'Deleting this guild',
  // The last sentence before the button, and the only place the reader is told
  // what this client's model actually means: a guild lives on one host and is
  // replicated nowhere, so there is no other copy and no undelete. Do not
  // hedge it into "may not be recoverable". Do not add a reassurance English
  // did not give.
  'guild.overview.delete.hint': 'Channels, messages, roles and members all go at once. Nothing holds a copy to restore it from.',
  'guild.overview.delete.button': 'Delete guild',
  'guild.overview.delete.confirm': 'Delete guild',
  'guild.overview.delete.dialogTitle': 'Delete {name}',
  // The field is a lock rather than a question: the dialog already knows the
  // name and what it is buying is a second of deliberate attention. "the name"
  // means the guild's own name, which is shown in the title above the field.
  'guild.overview.delete.label': 'Type the name to confirm',
  'guild.overview.delete.dialogHint': 'This cannot be undone.',
  'guild.overview.delete.failed': 'Could not delete the guild',

  'guild.overview.saveFailed': 'Could not save',

  // ---------------------------------------------------------------------- gates

  // The opening line of the pane. The second sentence is a rule about
  // federation, not a suggestion: the host server's own gates always apply on
  // top of these, so a guild can add checks and can never remove one.
  'guild.gates.hint': 'Gates run when someone joins. This guild can be stricter than its host, never looser.',

  'guild.gates.minAge.label': 'Minimum account age (days)',
  // Which clock this is measured against, which is the question moderators
  // ask: not when the account joined here, but when it was created wherever it
  // lives.
  'guild.gates.minAge.hint': 'Measured from the account’s creation date on its home server.',

  // The three gate policies. The words on the wire are `open`, `allowlist` and
  // `blocklist` and they are not these strings -- these are only the labels in
  // the menu, and changing one changes nothing the server sees.
  //
  // "Allowlist" and "blocklist" are the two shapes a rule table can have: on
  // an allowlist nothing is admitted unless a rule says so, on a blocklist
  // everything is admitted unless a rule says otherwise. If a language has no
  // established pair for that, prefer a phrase that states the default ("only
  // the listed domains" / "every domain except the listed ones") over a
  // transliteration of the English.
  'guild.gates.policy.open': 'Open',
  'guild.gates.policy.allowlist': 'Allowlist',
  'guild.gates.policy.blocklist': 'Blocklist',

  'guild.gates.domainPolicy.label': 'Home domain policy',
  // The quoted fragments are the syntax the box is parsed with: `allow` and
  // `deny` are keywords the server matches literally, so they stay in English
  // inside the quotation marks while the sentence around them is translated.
  // The example hostnames may be swapped for other reserved-domain examples;
  // they may not be swapped for real ones. "the Open policy" refers to the
  // option named by `guild.gates.policy.open` above -- if that label is
  // translated, this reference must follow it.
  'guild.gates.domainRules.label': 'Home domain rules',
  'guild.gates.domainRules.hint': 'One per line, as "allow example.org" or "deny spam.example". Under the Open policy these are ignored.',

  'guild.gates.screening.label': 'Screening questions',
  // "the applicants queue" is the second half of the moderation queue pane and
  // must be named the same way there (`guild.queue.applicants.title`).
  'guild.gates.screening.hint': 'One per line. Leave empty to admit without screening; otherwise a joiner lands in the applicants queue.',

  // "N" is a stand-in for the number typed in the field beside it, in the
  // algebraic sense, and it is deliberately not interpolated: the label names
  // the setting rather than reporting its value. A language that does not use
  // Latin `N` as a variable should use whatever letter its readers would
  // expect in the same position, consistently in both strings.
  'guild.gates.hold.label': 'Hold first N messages',
  'guild.gates.hold.hint': 'A new member’s first N messages wait for approval instead of appearing. Zero disables the hold.',

  // The second half of the pane. An "origin" here is the host an attachment
  // was uploaded to, and the check happens when a message carrying one is
  // posted -- not when the file is fetched, which is what a reader who knows
  // the browser sense of the word will assume.
  'guild.gates.origins.hint': 'Which origins this guild accepts attachments from. Checked when a message is posted.',
  'guild.gates.originPolicy.label': 'Media origin policy',
  'guild.gates.originRules.label': 'Media origin rules',
  // Every quoted run is syntax: `allow`, `block`, `feed:` and `key:` are
  // parsed literally and must survive untranslated, and so must the angle
  // brackets around `<curator key>`, which mark the one part a reader
  // substitutes. The last sentence is the precedence rule and it is load
  // bearing -- a moderator who blocks a host by name expects that to hold even
  // when a feed they subscribe to allows it, and it does.
  'guild.gates.originRules.hint': 'One per line, as "allow files.example" or "block sketchy.example". A curator feed is "allow feed:https://… key:<curator key>". A named host wins over a feed.',

  'guild.gates.save': 'Save gates',
  'guild.gates.saved': 'Gates saved.',
  'guild.gates.saveFailed': 'Could not save gates',
  'guild.gates.refreshFailed': 'Could not refresh feeds',
  // After pinning a curator from the directory. Two sentences because there
  // are two facts and the second is the one that matters: nothing has been
  // subscribed to yet, a line was written into a box above, and the
  // moderator's own Save is still what commits it.
  'guild.gates.pinned': 'Added to the rules above. Save gates to subscribe.',

  // ------------------------------------------------------- the curator directory

  // A curator publishes a signed list of media hosts. Subscribing to one is
  // how a guild delegates "which hosts are reputable" without maintaining the
  // list itself -- and the sentence says the part people get wrong: reading
  // the directory changes nothing at all until a key is pinned.
  'guild.gates.curators.hint': 'Curators this server knows of. A feed decides nothing until you pin its key here.',
  'guild.gates.curators.tableLabel': 'Curators',
  'guild.gates.curators.colCurator': 'Curator',
  'guild.gates.curators.colFeed': 'Feed',
  // The column says where this client heard about the curator: either from the
  // server the reader is on, or from a directory that server follows. The
  // cell under it is either `guild.gates.curators.thisServer` or a hostname.
  'guild.gates.curators.colSource': 'Listed by',
  'guild.gates.curators.thisServer': 'This server',
  // The button, and the state it turns into. "Pin" is the term of art for
  // binding a subscription to one specific public key so that a later key
  // cannot silently take its place; it is the same word as certificate
  // pinning, and if a language has that term already it should use it.
  'guild.gates.curators.pin': 'Pin key',
  'guild.gates.curators.subscribed': 'Subscribed',

  // ------------------------------------------------------------ subscribed feeds

  // Both halves matter. A feed that has expired keeps refusing what it blocks
  // and stops admitting what it allows, which is the fail-closed direction and
  // is not what most people expect from "expired".
  'guild.gates.feeds.hint': 'Feeds are fetched when first saved and then hourly. An expired feed stops admitting its hosts but keeps refusing the ones it blocks.',
  'guild.gates.feeds.tableLabel': 'Subscribed feeds',
  'guild.gates.feeds.colFeed': 'Feed',
  'guild.gates.feeds.colHosts': 'Hosts',
  // The feed's own version number, as the curator published it. Not a count of
  // anything and not sortable prose -- a serial, in the sense a DNS zone has
  // one.
  'guild.gates.feeds.colSerial': 'Serial',
  'guild.gates.feeds.colFetched': 'Last fetched',
  'guild.gates.feeds.colKey': 'Curator key',
  'guild.gates.feeds.colState': 'Status',
  'guild.gates.feeds.refresh': 'Refresh feeds',

  // The line under a feed's address: the rule's own keyword, and who signed
  // the list. `{action}` is the literal `allow` or `block` the moderator typed
  // into the rules box, so it arrives untranslated and stays that way -- it is
  // the same token they will read back in the box above. `{curator}` is a
  // hostname. The `·` is a separator, not punctuation; a script that uses a
  // different one may swap it.
  'guild.gates.feeds.curatedBy': '{action} · curated by {curator}',
  // How many hosts the last good fetch carried, in a column about eight
  // characters wide. Two keys rather than one with a zero arm, because the
  // second half is a parenthetical that is absent -- not empty -- when a feed
  // blocks nothing.
  'guild.gates.feeds.hosts': '{hosts, number}',
  'guild.gates.feeds.hostsWithBlocks': '{hosts, number} ({blocks, number} blocked)',
  'guild.gates.feeds.fetchedAt': '{at, dateTime}',

  // Where this subscription's key stands. `Pinned` is the quiet case -- the
  // key in the rule is the key in force and nothing has moved.
  'guild.gates.feeds.keyPinned': 'Pinned',
  // A curator can only move the key in force by publishing a rollover signed
  // by the key before it, so a rotation is a fact this client verified rather
  // than a claim it was told. The count is how many such rollovers the chain
  // carried.
  //
  // This used to be `Rotated {count, number}x`, with "x" as the English
  // abbreviation for "times" and a note asking each language to append
  // whatever it puts after a count of repetitions. That note could not be
  // followed. A suffix is not what most languages do with a count: German
  // wants "einmal" for one and "3-mal" for the rest, Japanese wants the
  // counter 回 *after* the numeral with no space, Arabic changes the noun in
  // six different ways and puts the numeral on the other side of it for two
  // of them. None of that fits in a suffix, and English itself was already
  // wrong at one -- "Rotated 1x" is not a sentence anybody says.
  //
  // So it is a plural, which is the construct that lets each language say the
  // whole thing. Keep the arms short: this is a pill in a narrow column, and
  // a language that needs more room than English should shorten the verb
  // before it shortens the count.
  'guild.gates.feeds.keyRotated': '{count, plural, one {Rotated once} other {Rotated # times}}',
  // The key the verified chain has arrived at, which is not the key the rule
  // still names. `{key}` is base64 and is never translated, wrapped or given
  // localised digits: the reader is comparing it against what their curator
  // published.
  'guild.gates.feeds.keyInForce': 'In force: {key}',
  // A rollover the curator has announced but that is not in force yet.
  'guild.gates.feeds.keyRotationAnnounced': 'Rotation announced',
  'guild.gates.feeds.keyNext': 'Next: {key}',

  // The five states a feed can be in, drawn as a pill. "Active" with an error
  // beside it is a real combination and not a contradiction: the hosts from
  // the last good fetch still apply, and the most recent fetch was not taken.
  'guild.gates.feeds.state.active': 'Active',
  'guild.gates.feeds.state.expired': 'Expired',
  // Not "Pending": the feed was saved and the hourly fetch has not come round
  // yet, so nothing is wrong and nothing is waiting on the reader.
  'guild.gates.feeds.state.pending': 'Not fetched yet',
  'guild.gates.feeds.state.failed': 'Failed',
  // A feed rule written without a `key:` clause. It is a warning rather than
  // an error because the rule is accepted and simply trusts nobody, so the
  // feed contributes nothing until a key is added.
  'guild.gates.feeds.state.unpinned': 'No key pinned',

  // ------------------------------------------------------------ moderation queue

  'guild.queue.held.title': 'Held messages',
  // What each button does, said before either is pressed. "silently" is the
  // half that needs saying: the author is not told, so rejecting is not a
  // conversation with them.
  'guild.queue.held.description': 'Approving sends the message now. Rejecting drops it silently.',
  // The pill on a held card when the server did not say which rule caught it.
  // Lowercase on purpose: it sits where a reason like "new account" or "link"
  // would sit, and those are lowercase too.
  'guild.queue.held.reason': 'held',
  // Stands in for the body of a held message that has no text at all -- an
  // attachment on its own, or a sticker. The parentheses mark it as the
  // interface speaking rather than as the message's content, which matters
  // here more than usual: everything else in that box is what somebody wrote.
  'guild.queue.held.noText': '(no text)',
  'guild.queue.held.emptyTitle': 'Nothing waiting',
  'guild.queue.held.emptyBody': 'The hold queue is empty.',
  'guild.queue.approve': 'Approve',
  'guild.queue.reject': 'Reject',
  // Shown when a decision could not be sent. Very often this is not an outage
  // but another moderator having got there first, which is why it says what
  // could not be done rather than guessing why.
  'guild.queue.heldFailed': 'Could not act on that message',

  'guild.queue.applicants.title': 'Applicants',
  'guild.queue.applicants.description': 'People whose answers to the screening questions are waiting on a decision.',
  // "Admit" rather than "Approve", and the difference is deliberate: a held
  // message is approved, a person is admitted. Two acts, two words, and a
  // language that has two should use both.
  'guild.queue.admit': 'Admit',
  'guild.queue.applicants.emptyTitle': 'Nobody is waiting',
  // Not "there are no applicants" -- the usual reason this list is empty is
  // that the guild asks no screening questions at all, and a moderator looking
  // for a queue they never enabled should be told where it comes from.
  'guild.queue.applicants.emptyBody': 'Applicants only appear here when this guild asks screening questions.',
  'guild.queue.applicantFailed': 'Could not act on that applicant',

  // ----------------------------------------------------------------------- bans

  // The scope of a ban, said once at the top. A guild ban is not a server ban
  // and not an account suspension: the person keeps their account, keeps every
  // other guild, and is only shut out of this one.
  'guild.bans.hint': 'A ban applies to this guild only.',
  'guild.bans.tableLabel': 'Bans',
  'guild.bans.empty': 'Nobody is banned.',
  'guild.bans.colAccount': 'Account',
  'guild.bans.colReason': 'Reason',
  'guild.bans.colWhen': 'When',
  // Where a reason would be. Lowercase and unemphatic on purpose: it reports
  // that the moderator who banned this account did not write anything down,
  // which is a gap in the record rather than a fact about the person. It
  // replaced a bare hyphen, which said the same thing to a sighted reader and
  // nothing at all to a screen reader.
  'guild.bans.noReason': 'no reason recorded',
  'guild.bans.unban': 'Unban',
  // The accessible name of the same button. A moderator on a screen reader
  // meets six buttons called "Unban" and needs to know which row they are on;
  // `{account}` is a full account id and is read out as itself.
  'guild.bans.unbanAccount': 'Unban {account}',
  'guild.bans.unbanFailed': 'Could not lift the ban',
  'guild.bans.add': 'Ban by account id',
  'guild.bans.dialogTitle': 'Ban an account',
  // The example is part of the label because the field takes a full federated
  // id and not a display name, and that is the single mistake people make
  // here. See the note on `guild.overview.transfer.placeholder` for what may
  // and may not be changed about the example.
  'guild.bans.dialogLabel': 'Full account id, like @someone:example.org',
  'guild.bans.confirm': 'Ban',
  'guild.bans.banFailed': 'Could not ban',

  // -------------------------------------------------------------- spam cleanup

  'guild.purge.title': 'Spam cleanup',
  // "named account" because this tool needs an id typed in: it is not a sweep
  // of the channel, it is everything one account said here recently.
  'guild.purge.hint': 'Removes a named account’s most recent messages in this guild.',
  'guild.purge.accountLabel': 'Account id',
  // See `guild.overview.transfer.placeholder`. The local part being "spammer"
  // is a joke that survives translation badly; a translator should use
  // whatever their readers would recognise as a stand-in name.
  'guild.purge.accountPlaceholder': '@spammer:example.org',
  'guild.purge.limitLabel': 'Maximum messages',
  'guild.purge.button': 'Delete recent messages',
  // What actually happened, reported as a count. This used to be built in
  // JavaScript as "Deleted N messages." and said "Deleted 1 messages." every
  // time somebody purged a single message.
  //
  // The zero arm is not the plural of nothing: a purge that matched nothing is
  // a different outcome from a purge that worked, and "Deleted 0 messages"
  // reads as a failure report with a number in it. It says plainly that the
  // guild is unchanged.
  'guild.purge.deleted': '{count, plural, =0 {No messages were deleted.} one {Deleted # message.} other {Deleted # messages.}}',
  'guild.purge.failed': 'Could not purge messages',

  // ------------------------------------------------------------------- invites

  'guild.invites.create.title': 'Create invite',
  // The first word is the argument: an invite link is a credential, so it is
  // handed out like one. Do not soften "credentials" into "links" -- the whole
  // sentence exists to make somebody set a limit before they paste it into a
  // public channel.
  'guild.invites.create.hint': 'Invites are credentials. Give them an expiry or use limit where you can.',
  'guild.invites.maxUses': 'Maximum uses',
  // The placeholder in an empty number field: leaving it blank means the
  // invite may be used any number of times. It is the *value* the empty field
  // stands for, so it is a noun and not an instruction.
  'guild.invites.maxUsesPlaceholder': 'Unlimited',
  'guild.invites.expires': 'Expires',
  'guild.invites.create.button': 'Create invite',
  // Only shown when the clipboard refused -- the ordinary path copies the link
  // and says so through `common.copiedThing`. So this is a fallback, and the
  // second sentence is what makes it useful.
  'guild.invites.created': 'Invite created. Copy it from the list below.',
  'guild.invites.createFailed': 'Could not create invite',
  // What the "copied" toast calls the thing that was copied, as the `{what}`
  // of `common.copiedThing`. A noun in whatever case that sentence needs it.
  'guild.invites.clipboardName': 'Invite',

  'guild.invites.list.title': 'Invite links',
  'guild.invites.tableLabel': 'Invite links',
  'guild.invites.empty': 'No invites have been created.',
  // The invite's short code -- the trailing part of the link -- shown so a
  // moderator can match a row against a link somebody sent them.
  'guild.invites.colCode': 'Code',
  'guild.invites.colUses': 'Uses',
  'guild.invites.colExpires': 'Expires',
  'guild.invites.colCreator': 'Created by',
  // Two shapes for one cell, because an invite either has a cap or does not.
  // They were one expression glued together in JavaScript, which meant the
  // slash was English punctuation nobody could move and the numbers went
  // through no formatter at all -- a guild with 1,200 uses of a link showed
  // "1200" on every screen in the world.
  'guild.invites.uses': '{used, number}',
  'guild.invites.usesOf': '{used, number} / {max, number}',
  // An invite that is past its expiry. Past tense: it is not expiring, it has.
  'guild.invites.expired': 'Expired',
  'guild.invites.revoke': 'Revoke',
  // The accessible name of the same button, for the reason given over
  // `guild.bans.unbanAccount`. `{code}` is the invite code and is read as
  // itself.
  'guild.invites.revokeInvite': 'Revoke invite {code}',
  'guild.invites.revokeFailed': 'Could not revoke invite',

  // ----------------------------------------------------------------- audit log

  'guild.audit.tableLabel': 'Audit log',
  // Not "empty": an audit log with nothing in it means nothing auditable has
  // happened since the server started keeping the record, which is a fact
  // about time rather than about the table.
  'guild.audit.empty': 'Nothing recorded yet.',
  'guild.audit.colWhen': 'When',
  // Who did it. Always an account, never the server itself -- an automatic
  // action is recorded against the account whose settings caused it.
  'guild.audit.colActor': 'Actor',
  // What they did, drawn as the server's own code. See the long note at the
  // top of this file for why the codes themselves are not translated.
  'guild.audit.colAction': 'Action',
  // What it was done to: an account, a role, a channel. Empty where the action
  // had no target, in which case the cell shows `common.empty`.
  'guild.audit.colTarget': 'Target',

  // ---------------------------------------------------------- emoji and stickers

  'guild.expressions.emoji.title': 'Custom emoji',
  'guild.expressions.emoji.add': 'Add emoji',
  'guild.expressions.emoji.emptyTitle': 'No custom emoji yet',
  // The file formats are format names and stay in Latin letters. "shortcode"
  // is the term of art for the `:name:` form typed in the composer, and it is
  // the word the composer's own picker uses -- keep the two the same.
  'guild.expressions.emoji.emptyBody': 'Upload a PNG, GIF, WebP or JPEG; the file name becomes the shortcode. The server re-encodes it and scales it down to fit.',
  // The tooltip and accessible name of the × on one emoji tile. `{name}` is
  // the shortcode its uploader chose, and the colons around it are the syntax
  // that makes it one -- they are not quotation marks and must stay.
  'guild.expressions.emoji.remove': 'Remove :{name}:',
  'guild.expressions.emoji.addFailed': 'Could not add emoji',
  'guild.expressions.removeFailed': 'Could not remove',

  'guild.expressions.stickers.title': 'Stickers',
  'guild.expressions.stickers.add': 'Add sticker',
  'guild.expressions.stickers.emptyTitle': 'No stickers yet',
  // Says where they turn up, because a sticker that has been uploaded and
  // never seen again is the complaint this line answers.
  'guild.expressions.stickers.emptyBody': 'Stickers are picked from the emoji picker and sent on their own.',
  'guild.expressions.stickers.addFailed': 'Could not add sticker',

  // ------------------------------------------------------------- voice regions
  //
  // A "region" here is one relay this guild may route a call through, named by
  // its address. The vocabulary is borrowed from the SFU's own documentation
  // -- SFU, TURN, relay -- because the person adding one is reading that
  // documentation in another window. Those three stay in Latin letters.

  'guild.voice.regions.title': 'Voice regions',
  'guild.voice.regions.description': 'Add your own relay so this guild, or individual voice channels, uses it.',
  // The two defaults, above the table. `<code>` marks the value as an address
  // rather than a word; the tag is required and the name inside it is not
  // translated.
  'guild.voice.serverDefault': 'Server default: <code>{name}</code>',
  'guild.voice.serverDefaultNone': 'No server default.',
  'guild.voice.guildDefault': 'Guild default: <code>{name}</code>',

  'guild.voice.tableLabel': 'Voice regions',
  'guild.voice.empty': 'No regions configured.',
  'guild.voice.colName': 'Name',
  'guild.voice.colSfu': 'SFU',
  'guild.voice.colType': 'Type',
  'guild.voice.colHealth': 'Health',
  // Where the region came from: added by this guild, or offered by the server
  // to everyone on it. Lowercase, because the column is a one-word status and
  // the rest of the table reads that way.
  'guild.voice.typeCustom': 'custom',
  'guild.voice.typeServer': 'server',
  // Whether the server's own last health check passed. This is the server's
  // opinion and not the browser's -- the probe in the add flow below is a
  // different measurement and may disagree with it.
  'guild.voice.healthOk': 'ok',
  'guild.voice.healthDown': 'down',
  // The title on the star beside a region's name. The star itself is a glyph
  // with nothing in it to translate, and this is the only thing that tells a
  // screen reader what it means.
  'guild.voice.defaultMarker': 'Guild default',
  'guild.voice.makeDefault': 'Make default',
  // Accessible names for the two row buttons, which are otherwise six
  // identical words in a column. `{name}` is the region's own name.
  'guild.voice.makeDefaultRegion': 'Make {name} the guild default',
  'guild.voice.removeRegion': 'Remove {name}',
  'guild.voice.loadFailed': 'Could not load voice regions',
  'guild.voice.addFailed': 'Could not add voice region',
  'guild.voice.defaultFailed': 'Could not set default region',
  // The parenthetical is the usual cause and is worth its words: a channel
  // pointing at a region holds it, and the fix is to move the channel rather
  // than to try again.
  'guild.voice.removeFailed': 'Could not remove region (it may still be used by a channel)',

  // ------------------------------------------------------- adding a region

  'guild.voice.add.title': 'Add a region',
  // Step one asks one thing. The heading is a question because the step is
  // one, and the line under it says what kind of answer counts.
  'guild.voice.add.step1Title': 'Where is the relay?',
  'guild.voice.add.step1Body': 'The address of an SFU this guild may dial.',
  'guild.voice.add.sfuLabel': 'SFU address',
  // An example address. `example.com` is reserved (RFC 2606); the host label
  // in front of it may be translated if that reads better, the domain may not
  // be replaced with one that resolves, and the `https://` stays.
  'guild.voice.add.sfuPlaceholder': 'https://sfu.example.com',

  // What is wrong with the address, said while it is being typed rather than
  // held back until a press. All three are corrections, not refusals: the
  // field still holds what was typed and the reader is told what to do next.
  //
  // The scheme in `{scheme}` is whatever they actually typed -- `ws`, `wss`,
  // `turn` -- and is shown back to them unchanged.
  'guild.voice.address.needsHost': 'Add the host after it, like https://sfu.example.com.',
  'guild.voice.address.wrongScheme': 'A region is dialled over http or https, not {scheme}.',
  // The most common mistake: a bare hostname. The explanation is the important
  // half -- a bare host is not rejected by the browser, it is *resolved*
  // against this page, which produces a region that points back at the client
  // and looks alive because the client is.
  'guild.voice.address.bareHost': 'Start with https:// — a bare host is read as part of this page’s address, not as a server.',

  // Step two. The crumb goes back to step one and is named for what is there.
  'guild.voice.add.crumb': 'Address',
  'guild.voice.add.step2Title': 'Name it',
  'guild.voice.add.nameLabel': 'Region name',
  'guild.voice.add.nameHint': 'What this relay is called in a channel’s region picker.',
  // A stand-in name, not an address: lowercase and hyphenated because that is
  // the shape region names take. Translate it to something equally
  // placeholder-shaped in your language, or leave it.
  'guild.voice.add.namePlaceholder': 'my-relay',
  // TURN is a protocol name (RFC 8656) and stays in Latin letters; only the
  // "(optional)" part is translated. It is optional because most SFUs relay
  // for themselves and only a few need a separate TURN host.
  'guild.voice.add.turnLabel': 'TURN (optional)',
  'guild.voice.add.turnPlaceholder': 'turn.example.com:3478',
  'guild.voice.add.makeDefault': 'Make this the guild default',
  'guild.voice.add.submit': 'Add region',

  // ------------------------------------------------------------- the probe
  //
  // The browser tries to fetch the relay's health endpoint while the address
  // is being typed. It is best-effort by construction: a correctly configured
  // private SFU will usually fail it, because it sends no CORS headers and the
  // browser stops the request before any answer arrives.
  //
  // So every verdict below is written against one misreading -- that a failure
  // here means the address is wrong. None of them gate the submit, none of
  // them say "you cannot add it", and each one ends somewhere the reader can
  // act. Do not translate them into something more decisive than they are;
  // their vagueness is the accurate part.

  'guild.voice.probe.checking': 'Checking whether your browser can reach it…',
  'guild.voice.probe.recheck': 'Check reachability',
  // "Your browser" and not "we": the measurement was made from this machine,
  // on this network, and says nothing about anybody else's.
  'guild.voice.probe.reachable.title': 'Your browser reached it.',
  // The trust prerequisite, attached to the *good* verdict on purpose: a relay
  // that answers can still refuse this guild, and somebody who reads a tick as
  // "done" will not find out until a call fails.
  'guild.voice.probe.reachable.body': 'A private SFU still has to be configured to trust this guild before a call will connect — being up and accepting this guild are two different things.',
  'guild.voice.probe.unreachable.title': 'It did not answer.',
  'guild.voice.probe.unreachable.body': 'That can mean the relay is down, or that it simply does not answer requests from a browser. If it is a private SFU, check it has been configured to trust this guild. You can add it either way and try a call.',
  'guild.voice.probe.unverified.title': 'Could not check from here.',
  // "normal" is doing the work here. This verdict fires for most correctly
  // configured private relays, and a translation that makes it sound like a
  // problem will send people to debug something that is not broken.
  'guild.voice.probe.unverified.body': 'The browser was blocked before it got an answer, which is normal: an SFU that sends no CORS headers is perfectly fine and simply cannot be probed from a web page. This is a hint, not a verdict — add it and try a call.',

  // The mark beside the field is a glyph, so these are its accessible names --
  // heard, never drawn. Name the state, not the icon: a screen reader
  // announces neither a tick nor a colour.
  'guild.voice.probe.a11yChecking': 'Checking the address',
  'guild.voice.probe.a11yReached': 'Reached it',
  'guild.voice.probe.a11yFailed': 'Could not reach it from this browser',
};
