// The role hierarchy, the editor for one rung of it, and the per-channel
// overwrites that bend it.
//
// Three screens share this namespace because they are three views of one
// model: a role is a named bundle of permissions with a position, a member
// wears every role handed to them, and a channel overwrite says "except
// here". Somebody translating the role editor without the overwrite grid in
// front of them will invent a second word for "allow", and the two screens
// will then disagree about what a permission can be.
//
// -------------------------------------------- what is NOT in this namespace
//
// **The permissions themselves.** Every switch on the Permissions tab and
// every row of the overwrite grid is labelled from `perms.<bit>.label` and
// explained from `perms.<bit>.hint`, and the group headings come from
// `perms.group.*`. Nothing here duplicates them, and nothing here should: the
// error layer says "You need the Manage Roles permission" out of the same
// keys, and a second set of names in this file would be a screen and an error
// message quietly disagreeing about what a control is called. Where a sentence
// here needs to name a permission -- the Administrator notice, the mention
// hint, the bot-role notice -- it takes the name as `{permission}` and the
// code hands it the translated label. That is why those sentences interpolate
// a word that looks like a constant: it is one, and it is already translated.
//
// **Role names, channel names, colours and positions.** A role's name is
// typed by a person in the guild, a channel's name likewise, a colour is a hex
// value, and a position is a number the server keeps. All of them are data:
// they are interpolated into a sentence, never translated, and never
// lowercased or capitalised by a formatter.
//
// **`@everyone`.** The literal, wherever it appears -- as the name of the
// default role, in `roles.everyone.locked`, in `roles.display.mentionable` --
// stays exactly those nine characters in every language. It is what somebody
// types into the composer to ping a guild, so a translated form would be a
// word that does nothing. Translate the sentence around it and leave the token
// alone. (`perms.mention_everyone.label` makes the same promise for the same
// reason.)
//
// ------------------------------------------------------- how to translate it
//
// **Rank language.** "Above", "below", "outranks" and "stands at or above your
// own" are the vocabulary of one idea: roles are a ladder, and you may only
// touch rungs beneath the highest one you stand on. A language whose natural
// metaphor for authority is not vertical should pick its own metaphor and then
// use it in all four places rather than mixing ours with theirs.
//
// **The editor is a screen you are editing, not a form you submit.** The save
// bar appears the moment something differs from what the server holds, and
// `roles.editor.unsaved` is the only warning that leaving would lose work. It
// is deliberately a little sharp ("Careful, ..."), because the two ways out of
// it -- reset, or save -- are both one click away and neither is guessable
// from a milder sentence.
//
// **A guild's permissions are the thing people lose guilds over.** The notices
// here are the second half of the warnings in `perms.js`: the Administrator
// line, the bot-managed line, and the line that says this server will refuse
// what you are about to try. Do not soften any of them, and do not turn a
// statement of fact into a suggestion.

export const roles = {
  // ------------------------------------------------------------- the list

  // The sentence above the hierarchy. It is the rule the whole screen obeys
  // and it is stated once, up front, because every greyed-out control below
  // follows from it and none of them explain themselves.
  'roles.list.hint': 'A role can only be edited, moved or handed out by somebody above it.',

  // `@everyone` is drawn as its own section rather than as the bottom row of
  // the list, because it is the one role that cannot be dragged, renamed or
  // deleted -- so "Default Permissions" is the heading, not the role's name.
  // The same two words head the editor when that section is opened.
  'roles.everyone.title': 'Default Permissions',
  'roles.everyone.description': 'What every member of this guild can do, before any role is handed out.',

  // How many members wear a role. Drawn as visible text under @everyone and
  // read aloud as the accessible name of the count beside every other row --
  // one key, because it is the same fact said to two audiences, and a screen
  // reader meeting a bare "2" beside an icon learns nothing from it.
  //
  // A real plural rather than "member(s)": Polish needs three forms of the
  // noun and Arabic six, and the number is `#` so it is grouped for the locale
  // (1,234 / 1.234 / ١٬٢٣٤) rather than pasted in as digits.
  'roles.memberCount': '{count, plural, one {# member} other {# members}}',

  // The heading over the draggable list, with the size of the hierarchy in it.
  //
  // Both arms are the same in English and that is not an oversight. The noun
  // is a heading rather than a count phrase, so English does not inflect it --
  // but a language that agrees a heading with the number following it has
  // nowhere else to say so, and a translator who needs the distinction would
  // otherwise have to ask for a code change to get it.
  'roles.list.title': '{count, plural, one {Roles - #} other {Roles - #}}',
  'roles.list.description': 'Drag a role to change who outranks whom.',

  // The button that makes one. An imperative on a button, not a description of
  // the screen -- if a language distinguishes the two, this is the imperative.
  'roles.list.create': 'Create Role',

  // Both the accessible name and the placeholder of the filter box, which is
  // deliberate: the placeholder disappears the moment somebody types, and a
  // field whose only name was its placeholder is a field with no name at all
  // as soon as it is in use.
  'roles.list.search': 'Search roles',

  'roles.list.empty.title': 'No roles yet',
  'roles.list.empty.body': 'Everyone here has the default permissions and nothing else.',

  // What the filter says when it matches nothing. `{query}` is what the reader
  // typed -- data, quoted so the empty-looking cases ("  ", a single letter)
  // are still visibly the thing they searched for. The quotation marks are
  // English's; a language with its own pair (« », „ “, 「 」) should use them.
  'roles.list.noMatch': 'No role matches “{query}”.',

  // The two controls on a row, named for the role they act on because a screen
  // reader otherwise meets a column of buttons all called "Edit". `{role}` is
  // the name somebody in this guild typed.
  'roles.row.edit': 'Edit {role}',
  'roles.row.delete': 'Delete {role}',

  'roles.create.title': 'Create role',
  // The label on the name field, in the creation dialog and on the Display
  // tab. One key: it is the same field asking for the same thing.
  'roles.create.nameLabel': 'Role name',
  'roles.create.confirm': 'Create',
  'roles.create.failed': 'Could not create the role',

  // The heading of the confirmation, which is a separate key from the button
  // tooltip above even though English spells them identically. A heading names
  // a thing about to happen; a tooltip names an action a control performs, and
  // several languages write those differently.
  'roles.delete.title': 'Delete {role}',
  // Said because it is the part nobody expects: the role is gone from the
  // hierarchy *and* from every channel that had carved out an exception for
  // it, and those exceptions do not come back if the role is recreated.
  'roles.delete.body': 'Channel overwrites naming this role go with it.',
  'roles.delete.failed': 'Could not delete the role',

  // A failed drag. The list has already snapped back to the order the server
  // holds by the time this is read, so it says what did not happen rather than
  // what to do.
  'roles.reorder.failed': 'Could not reorder the roles',

  // ----------------------------------------------------------- the editor

  'roles.editor.back': 'Back to roles',

  // Why the Display tab is missing when the default role is open. Keep the
  // `@everyone` token exactly as it is; translate the rest.
  'roles.everyone.locked': '@everyone cannot be moved, renamed or deleted.',

  // A role an installed bot brought with it. Two sentences for the same fact,
  // told apart by whether the reader can act on it: the first ends in a place
  // to go, the second in the name of the permission that would let them go
  // there. Naming it is the whole point of the second -- the Bots page is not
  // in their sidebar and does not appear when they look for it, so "go to the
  // Bots page" alone is a dead end. `{permission}` arrives already translated,
  // from `perms.manage_guild.label`.
  'roles.managed.canManageGuild': 'This role belongs to an installed bot. It was created by the install and cannot be edited here — change what the bot may do from the Bots page of these settings.',
  'roles.managed.needsManageGuild': 'This role belongs to an installed bot. It was created by the install and cannot be edited here. What the bot may do is changed from the Bots page, which needs {permission}.',

  // The rank rule, said at the moment it bites. It is phrased as what the
  // server will do rather than as what the screen is doing, because the screen
  // is only reporting: the refusal is the guild's own server's, it is the same
  // refusal the request would meet, and a reader who thinks this is a client
  // limitation will go looking for another client.
  'roles.editor.notEditable': 'This role stands at or above your own, so this server will not let you change it.',

  // The three tabs. "Display" is what the role looks like, "Permissions" is
  // what it may do, "Manage Members" is who wears it -- and the third is two
  // words because it is a tab you act from, not a list you read.
  'roles.tab.display': 'Display',
  'roles.tab.permissions': 'Permissions',
  'roles.tab.members': 'Manage Members',

  'roles.editor.saveFailed': 'Could not save the role',

  // The bar that appears when the draft and the server disagree. Sharper than
  // a neutral "You have unsaved changes" on purpose: this screen has no submit
  // button of its own and leaving it is one click, so the sentence has to do
  // the work a form's shape usually does.
  'roles.editor.unsaved': 'Careful, you have unsaved changes.',
  // Throws the draft away and goes back to what the server holds. One word,
  // and it sits beside "Save Changes" in a bar a few hundred pixels wide, so a
  // translation that needs a phrase should pick the shortest honest one.
  'roles.editor.reset': 'Reset',
  // Not `common.save`: that one is the plain verb on a dialog. This names the
  // set of edits collected across three tabs and sends all of them at once.
  'roles.editor.save': 'Save Changes',

  // ------------------------------------------------------- the display tab

  'roles.display.colour': 'Role colour',
  // Why a colour may be set and never seen: a member wears one role's colour,
  // and it is the highest coloured role they hold rather than the highest role
  // or the most recently given one.
  'roles.display.colourHint': 'Members wear the colour of the highest role they hold that has one.',
  // The swatch that clears the colour. Not "black" and not "transparent": a
  // member with no coloured role wears whatever the theme's default text
  // colour is, which changes with the theme.
  'roles.display.noColour': 'No colour',

  'roles.display.hoist': 'Display role members separately',
  'roles.display.hoistHint': 'Members holding this role get their own heading in the member list, under the highest hoisted role they hold.',
  // "@mention" is the verb form of the token and stays in Latin script for the
  // same reason `@everyone` does -- it names a gesture with a literal spelling.
  'roles.display.mentionable': 'Allow anyone to @mention this role',
  // `{permission}` is `perms.mention_everyone.label`, handed in already
  // translated so this sentence and the switch on the Permissions tab cannot
  // drift apart.
  'roles.display.mentionableHint': 'Without it, only members with {permission} can ping it.',

  // ------------------------------------------------------------ the palette
  //
  // The names of the twelve preset swatches. A swatch is a button whose entire
  // content is a fill, so the name is the only thing a screen reader has to go
  // on and "Use #eb459e" would be a hex code spelled out one character at a
  // time. The hex values are data and stay in the code.
  //
  // These are colour names in the ordinary sense -- translate them the way a
  // paint chart would, not the way a CSS keyword list would. The two greens
  // and the two yellows are told apart rather than both called Green, and a
  // language that has only one everyday word for a pair should qualify one of
  // them ("light green") rather than repeat itself: two buttons with the same
  // accessible name are two buttons nobody can choose between by voice.
  'roles.colour.indigo': 'Indigo',
  'roles.colour.green': 'Green',
  'roles.colour.yellow': 'Yellow',
  'roles.colour.pink': 'Pink',
  'roles.colour.red': 'Red',
  'roles.colour.teal': 'Teal',
  'roles.colour.orange': 'Orange',
  'roles.colour.purple': 'Purple',
  'roles.colour.blue': 'Blue',
  'roles.colour.grey': 'Grey',
  'roles.colour.emerald': 'Emerald',
  'roles.colour.gold': 'Gold',

  // --------------------------------------------------- the permissions tab

  'roles.permissions.search': 'Search permissions',

  // The one switch on this screen that cannot be undone by another switch.
  // `{permission}` is `perms.administrator.label`, so the notice names the
  // control the reader just touched in exactly the words it is labelled with.
  // Both halves matter and neither is decoration: it grants everything, *and*
  // it walks past the channel overwrites somebody carefully set up. Do not
  // shorten this to one of them.
  'roles.permissions.adminNotice': '{permission} is every permission, and it ignores channel overwrites.',
  'roles.permissions.noMatch': 'No permission matches “{query}”.',

  // ------------------------------------------------------- the members tab

  // The accessible name of the search box, and separately its placeholder.
  // They differ here where they do not on the roles list, because the box does
  // two things -- it finds people to hand the role to, and the placeholder has
  // to say what to type -- and the name is the one that is read aloud.
  'roles.members.search': 'Search members to add',
  'roles.members.searchPlaceholder': 'Search members by name',

  // The heading over the search results. `{query}` is data.
  'roles.members.matching': 'Matching “{query}”',
  // Nobody matched. Deliberately about the guild rather than about the search:
  // this list is answered by the guild's own server across every member it
  // has, not by whatever the member list happened to have loaded, so "no
  // results" would understate what was just checked.
  'roles.members.noMatch': 'Nobody in this guild answers to that.',

  // The heading over the people who hold the role. `{role}` is the role's own
  // name, `#` the number of holders. Plural for the same reason
  // `roles.list.title` is: English does not inflect the heading, and a
  // language that does has nowhere else to say so.
  //
  // The count is what the server returned for this page, and the page asks for
  // a hundred; a guild with more holders than that is a real case and a
  // translator should not promise the number is the total.
  'roles.members.holding': '{count, plural, one {Holding {role} - #} other {Holding {role} - #}}',

  'roles.members.empty.title': 'Nobody holds this role',
  'roles.members.empty.body': 'Search above to hand it to somebody.',

  // The button that hands the role over. `common.remove` is the other half --
  // the same button, on a row of somebody who already has it.
  'roles.members.add': 'Add',
  // "That member" rather than the name: the row is still on screen with the
  // name on it, and a toast that repeats it is a toast that has to be read to
  // find out it said nothing new.
  'roles.members.addFailed': 'Could not add that member',
  'roles.members.removeFailed': 'Could not remove that member',

  // ---------------------------------------------------- channel overwrites

  // What an overwrite is, in the two sentences somebody needs before touching
  // the grid. "Narrows or widens" is both directions on purpose: an overwrite
  // is not a restriction mechanism, it is an exception mechanism, and a reader
  // who thinks it can only take things away will not find the control that
  // gives a single role access to a single private channel.
  'roles.overwrite.hint': 'An overwrite narrows or widens one role’s permissions inside one channel. Threads inherit their parent channel.',

  // The two pickers that say which overwrite is being edited. One-word field
  // labels, each naming the thing chosen below it.
  'roles.overwrite.channel': 'Channel',
  'roles.overwrite.role': 'Role',

  // The three states a permission can be in for this role in this channel.
  //
  // They are written as whole phrases rather than as the bare words "Inherit",
  // "Allow" and "Deny", and that is the important decision in this group. Each
  // one is read aloud on its own, out of the context of the row it sits in, so
  // a screen reader meeting "Allow" has been told a verb and not a state. The
  // phrase has to survive being heard alone -- and it must NOT be assembled
  // from the permission's name, because a sentence glued together in
  // JavaScript ("Allow" + " " + "Manage Messages") has word order baked into
  // it that is English's and nobody else's.
  //
  // So: the permission is named once, by the control's own accessible name
  // (`roles.overwrite.control`), and the state is a complete phrase that names
  // no permission at all. Together a screen reader says "Manage Messages in
  // this channel, Allow in this channel" -- two whole things, in either order,
  // in any language.
  //
  // Neutral is spelled "inherit from the role" rather than "neutral" or
  // "default" because that is what it does: the permission falls through to
  // whatever the role grants guild-wide, which may be on or off. "Default"
  // would suggest off.
  'roles.overwrite.inherit': 'Inherit from the role',
  'roles.overwrite.allow': 'Allow in this channel',
  'roles.overwrite.deny': 'Deny in this channel',

  // The accessible name of one row's tri-state control. `{permission}` is the
  // translated label from `perms.<bit>.label`; this is the only place the
  // permission's name is spoken, so it has to name it in full rather than
  // relying on the visible text beside it.
  'roles.overwrite.control': '{permission} in this channel',

  // The one button that writes the grid. Named for what it saves, because this
  // pane holds one overwrite at a time and the reader has just switched
  // channel and role twice to get to it.
  'roles.overwrite.save': 'Save overwrite',
  'roles.overwrite.saved': 'Overwrite saved.',
  'roles.overwrite.saveFailed': 'Could not save overwrite',
};
