// A room, and the settings that decide what it is and who is in it.
//
// Three dialogs, one subject. `CreateChannelDialog` asks which kind of room
// you meant and then asks the one short form that answers it;
// `CreateCategoryDialog` asks a single question, because a category is a
// shelf rather than a room; and `EditChannelDialog` is everything about an
// existing channel on two or three tabs -- what the room is, what a forum's
// tags are, and who is allowed in.
//
// They are one namespace because they are one vocabulary. "Slowmode",
// "category", "overwrite", "private" and the four channel kinds appear in all
// three, and a translator who settled on a word for one of them in the create
// flow and a different word for it in the settings dialog has told the reader
// that two different things are being configured.
//
// -------------------------------------------------------- what is not a string
//
// Four kinds of thing in here are *data*, and a translation that touches any
// of them has broken something:
//
//   * **A channel's name, a category's name, a forum tag's name, a role's
//     name.** Somebody typed those. They arrive as `{name}`, `{channel}` or
//     `{region}` and they are drawn exactly as typed. Move the placeholder
//     wherever the grammar wants it; never spell it differently.
//
//   * **`@everyone`.** It appears literally inside three sentences below. It
//     is not the English word "everyone" -- it is the mention syntax for the
//     default role, the thing a person types into a message box to address
//     the guild, and it is the same seven characters on every server in every
//     language. Leave it as it stands, including the `@`. If a sentence reads
//     badly with a Latin token in the middle of it, rephrase the sentence
//     around the token rather than translating it.
//
//   * **A voice region's name.** `{region}` in `channel.voice.regionCustom` is
//     an identifier the server minted (`eu-west`, `sfu-3`). The word
//     "(custom)" beside it is ours and is prose; the name is not.
//
//   * **`kbps`.** A unit symbol from the SI-adjacent family every audio tool
//     on earth writes the same way. The *number* beside it is formatted by
//     `Intl` and so takes the locale's digits and grouping; the symbol itself
//     is left alone, and only the spacing between them is a translator's
//     decision -- which is exactly why it is a pattern with a placeholder in
//     it rather than a number glued to a literal in JavaScript.
//
// -------------------------------------------------- the `#` that is not a number
//
// A channel is written `#general` in this product, and the `#` is a sigil in
// the same family as `@everyone`: it is punctuation that means "channel", not
// the number sign and not a heading marker. No sentence in this namespace
// carries one today -- every place a channel is named here interpolates the
// bare name and the interface draws the sigil as an icon beside it, which is
// the arrangement to keep. If a sentence ever does need one inline, it gets a
// comment saying so, because a translator who sees `#` in a pattern has every
// reason to read it as an ICU plural's number placeholder and delete it.
//
// ------------------------------------------------------------------ durations
//
// Slowmode is a ladder of durations and every rung is a plural. They were an
// English ternary and a concatenation before this file existed -- `secs === 1
// ? '1 minute' : secs + ' minutes'` in spirit, a literal table of
// `'5 seconds'` in fact -- which is correct in English, wrong in Polish, and
// meaningless in a language that does not put the number first. The three
// `channel.duration.*` entries below are the whole ladder: the component picks
// the unit and hands over a count, and the catalogue decides how a language
// says "six of those".
//
// The `#` inside those three *is* the ICU number placeholder. See above for
// the one that is not.
//
// -------------------------------------------------- do not soften the tags note
//
// `channel.tags.moderatedNote` says the server refuses a moderator-only tag
// rather than merely hiding it, and `channel.perms.privateHintOff` says that
// making a channel private moves and deletes nothing. Both exist because
// people assumed the opposite and acted on the assumption. A translation that
// hedges either one ("may be refused", "should not delete anything") has
// turned a fact into a maybe, and the reader will make the same wrong decision
// the sentence was written to prevent.

export const channel = {
  // ----------------------------------------------------- the shared field labels
  //
  // One key each, used by all three dialogs, because they are the same field
  // asking the same question in the same voice. `Name` in particular is a
  // *label on a form field*, not the noun "name" in a sentence -- languages
  // that decline it should use whatever case a form label takes.

  'channel.field.name': 'Name',
  'channel.field.topic': 'Topic',
  'channel.field.category': 'Category',
  // The "none of them" row at the top of the category picker. It is a choice,
  // not a description of a state: picking it takes the channel out of
  // whatever category it is in and leaves it at the top level.
  'channel.field.noCategory': 'No category',
  'channel.field.region': 'Region',
  // The switch on both create dialogs. `channel.perms.privateLabel` is the
  // same idea on the settings dialog and is deliberately a different string --
  // see the comment there.
  'channel.field.private': 'Private',

  // ------------------------------------------------------------ the kinds of room
  //
  // Four rooms, each with a name and one line under it. These are *words for a
  // thing*, chosen from a list, and not the identifiers the wire uses: the
  // wire says `announcement` in every locale and always will, and these are
  // what a person picking between them reads.
  //
  // Each type gets its own literal key and the component looks the key up in a
  // table. It does not build `channel.type.<type>.name` from the variable,
  // even though the shape would allow it, because a key assembled at run time
  // is a key no extractor finds and no translator is ever shown -- see the
  // note over `t()` in `lib/i18n/index.js`. The enforcement test would also
  // report all eight of these as unreachable, since it derives dynamic key
  // prefixes from template literals and a `+` concatenation is not one.
  //
  // A description is written only where the name does not already say it.
  // "Text" needs no help; "Announcement" does, because the restriction and the
  // cross-guild following are the two things that make it not a text channel.

  'channel.type.text.name': 'Text',
  'channel.type.text.description': 'Messages, threads and files.',
  'channel.type.voice.name': 'Voice',
  'channel.type.voice.description': 'Talk, and share a screen.',
  'channel.type.forum.name': 'Forum',
  'channel.type.forum.description': 'Every post is its own thread.',
  'channel.type.announcement.name': 'Announcement',
  'channel.type.announcement.description': 'Restricted posting. Other guilds can follow it.',

  // ------------------------------------------------------------ creating a channel

  'channel.create.title': 'Create a channel',

  // The heading of step two, one per kind.
  //
  // Four whole sentences rather than one sentence with the kind's name dropped
  // into it, and this is the single clearest example in the namespace of why
  // that matters. The code used to write
  // `` `New ${KINDS[kind].label.toLowerCase()} channel` `` -- which needs the
  // adjective before the noun, needs the name of the kind to survive being
  // lowercased, and needs a language where lowercasing a noun is not simply
  // wrong. German capitalises every noun; Japanese has no case to change;
  // French would want "Nouveau salon textuel" with agreement the English never
  // had to think about. Four keys, four sentences, no arithmetic.
  'channel.create.newText': 'New text channel',
  'channel.create.newVoice': 'New voice channel',
  'channel.create.newForum': 'New forum channel',
  'channel.create.newAnnouncement': 'New announcement channel',

  // The greyed-out example inside the empty name box. It is an example of a
  // channel name somebody would actually type, so it should be the word that
  // language's users would type -- lowercase and unpunctuated if that is the
  // local convention for channel names, which it is in English.
  'channel.create.namePlaceholder': 'general',

  // The hint under the Private switch. It names the consequence and then the
  // undo, in that order, because somebody reaching for this switch wants to
  // know they are not locking themselves out.
  'channel.create.privateHint': 'Hidden from @everyone. Grant it back in the channel’s permissions.',

  // An imperative on a button, not a description of what the dialog is for.
  // `channel.create.title` is the description; this is the act.
  'channel.create.submit': 'Create channel',
  // The lead-in to whatever the server said went wrong -- `errors.context`
  // joins the two. Phrased as the thing that did not happen rather than as an
  // apology, so the toast still says something useful when the server's own
  // sentence is one this client cannot translate.
  'channel.create.failed': 'Could not create channel',

  // ----------------------------------------------------------- creating a category
  //
  // A category is not a channel and its dialog is not the channel dialog: one
  // field, no kind, no topic, no region. The strings are separate from
  // `channel.create.*` for the same reason -- a language whose word for
  // "channel" is a room-like noun almost certainly wants a different word for
  // a heading that rooms sit under, and sharing the keys would forbid that.

  'channel.createCategory.title': 'Create a category',
  // Capitalised where the channel example is not, and deliberately: a channel
  // name is a slug in this product's convention and a category name is a
  // heading. The example should look like the thing it is an example of.
  'channel.createCategory.namePlaceholder': 'General',
  // Stronger than the channel version, because it is true of more: hiding a
  // category hides everything filed under it, which is the surprise worth
  // stating before somebody flips the switch.
  'channel.createCategory.privateHint': 'Hidden from @everyone, and so is everything under it.',
  'channel.createCategory.submit': 'Create category',
  'channel.createCategory.failed': 'Could not create category',

  // -------------------------------------------------------------- the settings shell

  'channel.edit.title': 'Edit channel',
  'channel.edit.titleCategory': 'Edit category',

  // The tabs. Each is one or two words in a horizontal strip that does not
  // scroll, so there is very little room: a translation two or three times the
  // length of the English will not fit and the strip will not grow. Prefer the
  // shortest true word.
  'channel.tab.overview': 'Overview',
  // "Tags" here names the tab; `channel.tags.fieldLabel` names the list
  // itself, in the empty state, where it is the label of a form field. They
  // are the same English word and they are two keys on purpose -- a language
  // that distinguishes a section heading from a field label needs both.
  'channel.tab.tags': 'Tags',
  'channel.tab.permissions': 'Permissions',

  // Deliberately not `common.save`. The overview tab holds a dozen settings
  // and saves them together, and "Save" alone next to "Cancel" reads as
  // committing whichever field the cursor is in. This button commits the lot.
  'channel.edit.save': 'Save changes',
  'channel.edit.saveFailed': 'Could not update the channel',
  // The same failure about a category. Two keys rather than one sentence with
  // the noun interpolated, because a noun dropped into a slot carries no
  // gender, no article and no case, and half the languages this will be
  // translated into need at least one of those to agree with the verb.
  'channel.edit.saveFailedCategory': 'Could not update the category',

  // ------------------------------------------------------------------- the overview

  'channel.edit.topicHint': 'Shown in the header.',
  // The two prompts inside an empty topic box. A voice channel gets "room"
  // because that is what it is -- people are in it, not reading it -- and the
  // distinction is worth keeping in any language that has one.
  'channel.edit.topicPlaceholder': 'What is this channel for?',
  'channel.edit.topicPlaceholderVoice': 'What is this room for?',

  // "Slowmode" is this product's term of art for a per-person send cooldown,
  // and it is the word moderators use to each other. Translate it if the
  // language has a settled equivalent; do not paraphrase it into a phrase
  // ("message delay setting") that will not survive being said out loud in a
  // moderation channel.
  'channel.edit.slowmodeLabel': 'Slowmode',
  // A voice channel carries a chat under its own id, so its slowmode is about
  // the typing and not about the talking. The parenthetical is doing real
  // work; do not drop it for length.
  'channel.edit.slowmodeChatLabel': 'Slowmode (chat)',
  // "manage messages" is the permission `perms.manage_messages.label` names.
  // It is spelled in lower case here because it is being described rather than
  // named -- the sentence is about people, not about a switch.
  'channel.edit.slowmodeHint': 'Anyone who can manage messages is exempt.',

  'channel.edit.previewsLabel': 'Show link previews',
  // The reassurance is the point: people turn previews off believing it stops
  // the guild's server from fetching the link, and it does not.
  'channel.edit.previewsHint': 'Fetched through the guild’s own proxy either way.',

  'channel.edit.expiryLabel': 'File expiration',
  // Two facts in two short sentences: what unit the box wants, and what an
  // empty box means. Keep them as two, and keep "Seconds" first -- it is the
  // one a person needs before they start typing.
  'channel.edit.expiryHint': 'Seconds. Empty falls back to the guild’s cap.',
  // Drawn inside the empty box, so it is what "no value here" means rather
  // than an instruction. "Channel" is load-bearing: the guild's cap still
  // applies, and this says only that the channel adds none of its own.
  'channel.edit.expiryPlaceholder': 'No channel limit',

  // ------------------------------------------------------------------- durations
  //
  // The slowmode ladder, and the one thing in this namespace most likely to be
  // got wrong by a tool. Each is a count and a unit, and the unit is the key:
  // the component knows that 300 seconds is "5 minutes" and asks for
  // `channel.duration.minutes` with `count: 5`, so a language decides for
  // itself how the number and the word agree.
  //
  // `#` is the count, formatted for the locale -- Arabic gets Arabic-Indic
  // digits here for free, which a `{count}` interpolation would also give but
  // a JavaScript template literal would not.
  //
  // Every arm the *language* needs must be present, not every arm English
  // needs: English and German take `one` and `other`, Japanese takes `other`
  // alone, Polish takes `one`, `few`, `many` and `other`, Arabic takes all
  // six. The enforcement test checks this per language.

  // The zero rung of the slowmode ladder. Not `common.off`: that one is the
  // state of a toggle ("On" / "Off") and this one is an option in a list of
  // durations, where it means "no wait at all". German alone would want
  // "Aus" for the toggle and "Keine" for this.
  'channel.slowmode.off': 'Off',
  'channel.duration.seconds': '{count, plural, one {# second} other {# seconds}}',
  'channel.duration.minutes': '{count, plural, one {# minute} other {# minutes}}',
  'channel.duration.hours': '{count, plural, one {# hour} other {# hours}}',

  // ---------------------------------------------------------------- forum defaults
  //
  // These set where a board *starts*. They are not rules: any reader can sort
  // and lay out a forum however they like, and nothing here overrides that. A
  // translation that reads as a restriction ("Sort order", "Layout") rather
  // than as a default is saying something the feature does not do.

  'channel.forum.sortLabel': 'Default sort order',
  'channel.forum.sortHint': 'Where the board starts.',
  // "Recent activity" means the last reply, not the last post: a two-year-old
  // thread somebody answered this morning is at the top. "Date posted" is the
  // thread's own creation time.
  'channel.forum.sort.activity': 'Recent activity',
  'channel.forum.sort.creation': 'Date posted',
  'channel.forum.layoutLabel': 'Default layout',
  'channel.forum.layoutHint': 'Gallery leads with each post’s first image.',
  'channel.forum.layout.list': 'List',
  'channel.forum.layout.gallery': 'Gallery',

  // ---------------------------------------------------------------- voice settings

  'channel.voice.regionLabel': 'Voice region',
  // SFU is the standard acronym for a selective forwarding unit, which is the
  // piece of server software a call's media actually passes through. It stays
  // as it is: it names a category of software, the people who change this
  // setting know the word, and there is no translated equivalent in any
  // language. "Auto" is the option directly below, named here so the sentence
  // and the list agree.
  'channel.voice.regionHint': 'Which SFU relays this channel. Auto follows the guild default.',
  // The top option in the create dialog's shorter region list.
  'channel.voice.regionAuto': 'Auto',
  // The same option in the settings dialog, which has room to say what "Auto"
  // resolves to. Two keys because they are two strings; a language that has
  // room for the long one in both places may use the same words twice.
  'channel.voice.regionAutoDefault': 'Auto (guild/server default)',
  // A region this guild defined for itself rather than one the server offers
  // to everybody. `{region}` is the identifier the server minted and is never
  // translated; the parenthetical is.
  'channel.voice.regionCustom': '{region} (custom)',
  'channel.voice.bitrateLabel': 'Bitrate',
  // Aimed at whoever pays for the guild's bandwidth, which on a self-hosted
  // server is the person reading this. Do not soften it into "may use more
  // bandwidth": the cost is per speaker and it is linear.
  'channel.voice.bitrateHint': 'Higher costs the host more bandwidth per speaker.',
  // `{kbps, number}` rather than a bare interpolation so the number is grouped
  // and digitised for the locale. The unit symbol is not translated -- see the
  // header -- but the space before it is the translator's to place or remove.
  'channel.voice.bitrateValue': '{kbps, number} kbps',
  'channel.voice.limitLabel': 'User limit',
  // "0" is the literal digit somebody types into the neighbouring control, so
  // it is written as a digit rather than as the word.
  'channel.voice.limitHint': '0 for no limit.',
  'channel.voice.limitNone': 'No limit',
  // The rungs of the user-limit picker. A plural, because "2 people" and
  // "1 person" are different words in English and different endings in most
  // other languages -- and the list does contain a rung of 2, so the `one`
  // arm is not hypothetical the way it is in `common.convo.group`.
  'channel.voice.limitPeople': '{count, plural, one {# person} other {# people}}',

  // ------------------------------------------------------------------ forum tags
  //
  // Tags carry ids and posts store the id, so renaming a tag renames it on
  // every post already wearing it. Nothing below says that out loud, and that
  // is a gap in the English rather than something to invent in translation.

  // Two ceilings in one line: how many tags the forum may hold, and how many
  // one post may wear. Both are the server's numbers, restated here so the
  // Add button can go quiet before a request would be refused.
  //
  // Two plural blocks in one pattern rather than two keys, because they are
  // one sentence to a reader and splitting them would hand a translator two
  // fragments whose order is a fact about English. `#` inside each block is
  // that block's own count.
  'channel.tags.limit': '{max, plural, one {Up to # tag.} other {Up to # tags.}} {perPost, plural, one {A post may wear #.} other {A post may wear #.}}',

  // The accessible names of the two boxes in a tag row. They are never drawn;
  // a screen reader says them, and the number is what tells somebody which of
  // fifteen identical rows they are in. `{n, number}` rather than `{n}` so the
  // digits are the locale's own.
  //
  // The screen reader announces the role ("edit text") by itself, so these
  // name the field and nothing else -- no "field", no "input", no "box".
  'channel.tags.emojiLabel': 'Tag {n, number} emoji',
  'channel.tags.nameLabel': 'Tag {n, number} name',
  // Drawn inside the empty boxes. Short by necessity: the emoji box is 84
  // pixels wide and does not grow, so a translation longer than about eight
  // characters will be cut off. If the language has no short word, prefer
  // leaving the box empty over a truncated one.
  'channel.tags.emojiPlaceholder': 'Emoji',
  'channel.tags.namePlaceholder': 'Name',
  // The switch on a tag row. "Moderator only" means only a member with the
  // manage-messages permission may put this tag on a post -- it is about who
  // may apply it, not about who may see it. A translation that reads as
  // "visible to moderators only" is describing a feature this does not have.
  'channel.tags.moderated': 'Moderator only',
  // The tooltip and accessible name of the × on a tag row, in two forms. The
  // name is data and is interpolated; the unnamed form is reached only while
  // somebody is still typing a brand-new row, which is why it is a separate
  // sentence rather than a default value glued into the first one.
  'channel.tags.removeNamed': 'Remove {name}',
  'channel.tags.removeUnnamed': 'Remove this tag',
  // The field label over the empty state. See `channel.tab.tags` for why this
  // is a second key holding the same English word.
  'channel.tags.fieldLabel': 'Tags',
  'channel.tags.empty': 'This forum has no tags yet.',
  'channel.tags.add': 'Add a tag',
  // Saves the whole tag list, which is why it is not `common.save`: the tags
  // tab has its own save and the overview tab has another, and a reader who
  // has both open in their head needs to know which one they are pressing.
  'channel.tags.save': 'Save tags',
  // Stated as a fact about the server, not about this screen, and the second
  // clause is the whole point: somebody who assumes the restriction is
  // cosmetic will design a workflow around defeating it. Do not hedge it.
  'channel.tags.moderatedNote': 'Moderator-only tags are refused by the server, not just by this screen.',
  'channel.tags.saveFailed': 'Could not save the tags',

  // ------------------------------------------------------------- who is allowed in

  // The switch at the top of the permissions tab. Longer than
  // `channel.field.private` on the create dialogs and deliberately so: there,
  // the switch sits inside a form that is visibly about a channel, and here it
  // is the first control on a tab full of role rows, where "Private" alone
  // could be read as being about the role.
  'channel.perms.privateLabel': 'Private channel',
  // `{permission}` is the name of the view permission, taken from
  // `perms.view_channel.label` rather than written out here. Two reasons: the
  // sentence is telling somebody to find a specific switch in the list below
  // it, so the two have to say the same words in every language; and a
  // translator who changed one and not the other would produce instructions
  // that point at nothing.
  'channel.perms.privateHintOn': 'Hidden from @everyone. Grant {permission} to a role below to let it back in.',
  // The reassurance half. It is what stops somebody flipping this back and
  // forth looking for their messages: nothing is destroyed and nothing is
  // moved, only the view is withdrawn. Do not weaken it to "should not".
  'channel.perms.privateHintOff': 'Takes the view away from @everyone. Nothing is moved or deleted.',
  // Shown under the switch when the channel is private, beside a padlock
  // glyph. It answers "will anyone be able to tell", which is the next
  // question every time.
  'channel.perms.lockNote': 'Shown with a lock in the channel list.',

  'channel.perms.roleLabel': 'Role',
  // "Overwrite" is the term of art for a per-channel exception to a role's
  // guild-wide permissions, and it is the word the server's API uses. This
  // line exists to say that the switches below apply to the role in the picker
  // above and to no other -- a thing people get wrong constantly.
  'channel.perms.roleHint': 'Overwrites are per role.',
  // What the three-state control means, named by the glyph rather than by the
  // state, because the glyphs are what is on screen. "Here" is doing the work
  // in both halves: the grant and the denial apply in this channel only.
  'channel.perms.triStateHint': 'Tick grants here, cross takes away here, dash leaves the role’s own setting alone.',

  // The headings the permission switches are grouped under on this screen.
  //
  // Deliberately *not* `perms.group.*`. Those are the role editor's headings
  // and they are full noun phrases ("Text Channel Permissions") because that
  // screen is about a role across a whole guild. Here the reader is already
  // inside one channel, so the heading only has to say which half of it is
  // being configured, and the column is narrow. Same concept, different
  // sentence, different key.
  'channel.perms.group.general': 'General',
  'channel.perms.group.text': 'Text',
  // A voice channel carries a text channel under its own id, so its message
  // permissions are grouped under "Chat" rather than "Text" -- the reader is
  // looking at a voice room and needs to be told that these are about the
  // typing in it. Keep the two words distinct if the language has two.
  'channel.perms.group.chat': 'Chat',
  'channel.perms.group.voice': 'Voice',

  // The three states, in the order they are drawn: deny, inherit, allow. Each
  // is a tooltip and half of an accessible name, so each is one word if the
  // language has one. "Inherit" means "leave the role's own setting alone" --
  // it is the absence of an overwrite, not a third opinion.
  'channel.perms.deny': 'Deny',
  'channel.perms.inherit': 'Inherit',
  'channel.perms.allow': 'Allow',
  // The accessible name of one of the three buttons: the state and the
  // permission it applies to, read aloud as "Deny Send Messages".
  //
  // This used to be `{choice} {permission}`, where `{choice}` arrived already
  // translated -- the call site passed in `t('channel.perms.deny')` and so on.
  // That looks like a two-placeholder pattern a translator can reorder, and
  // it is not one. What arrives in `{choice}` is a *finished word*: capital
  // letter, tooltip case, standing alone. A language that would rather say
  // "Send Messages: verweigern" cannot, because the word it has been handed
  // is "Verweigern" and it cannot lower-case, inflect, or agree with anything
  // a placeholder it never sees. German ended up inventing a colon it did not
  // want purely to keep the capital from landing mid-sentence.
  //
  // So `{choice}` is now the *machine* token -- `deny`, `inherit`, `allow`,
  // the same three strings `CHOICES` already holds in `EditChannelDialog` --
  // and each arm is a whole sentence. A language can now put the permission
  // first, decline the verb, join the halves with a word, or say three
  // completely unrelated things. The three words above are still drawn on
  // their own as tooltips, which is why they stay.
  //
  // `other` cannot be reached: `CHOICES` is a fixed list of three and nothing
  // computes that token. It exists because `select` requires it, and it says
  // the permission alone rather than a machine token, so that a build that
  // somehow got there reads as incomplete rather than as broken.
  'channel.perms.choiceLabel': '{choice, select, deny {Deny {permission}} inherit {Inherit {permission}} allow {Allow {permission}} other {{permission}}}',

  'channel.perms.saveFailed': 'Could not save that overwrite',
  // Said about the private switch rather than about an overwrite, because that
  // is the gesture the reader made. Naming the mechanism here would be
  // correct and unhelpful.
  'channel.perms.privateFailed': 'Could not change who can see this',
};
