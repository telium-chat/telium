// The voice surfaces: the call itself, and everything drawn around it.
//
// One namespace covers eleven files, because they are one subject. The
// connection bar in the sidebar (`views/VoiceBar.jsx`), the stage and its dock
// (`views/CallStage.jsx`), the voice channel page (`views/VoiceView.jsx`), the
// ringing card (`views/IncomingCall.jsx`), the floating picture
// (`views/PersistentMediaMiniView.jsx`), the two dialogs, the watch-together
// player, the desktop device panel, and the two hooks underneath them all
// (`hooks/useVoice.jsx`, `hooks/useWatch.jsx`) are the same call described
// from nine places at once. Somebody translating "Mute" for the dock and
// "Mute" for the sidebar in two different weeks will produce two different
// words for one button, and a person looking at both at the same time -- which
// is the normal case, because the bar and the dock are on screen together --
// will reasonably conclude that they do different things.
//
// -------------------------------------------------- what is *not* in here
//
// A great deal of what a call puts on screen is not language, and this file is
// deliberately not where it goes:
//
//   * Codec, protocol and product names. Opus, VP9, AV1, WebRTC, SFU, ICE,
//     TURN, LiveKit, PipeWire, venmic, Chromium, Android, Telium. These are
//     names, not words; the precedent is the SAS emoji names in `lib/verify.js`
//     which are also left alone, and for the same reason -- a name that has
//     been translated is a name that no longer matches the documentation, the
//     log line or the thing the person is looking at.
//
//   * Labels the operating system or the browser hands us. Android's audio
//     routes ("Bluetooth", "Earpiece", and the automatic route's own label)
//     arrive from the platform already localised to the system language, and
//     `navigator.mediaDevices` device labels are whatever the OS calls that
//     microphone. `voice.route.option` and `voice.devices.unnamedMic` below
//     exist precisely so that those strings travel as *values* through a
//     sentence this file owns, instead of being concatenated onto a prefix.
//
//   * Region identifiers. `eu-west`, `staging` and whatever else a deployment
//     publishes are names it chose. `voice.call.movedRegion` interpolates one;
//     the region picker draws them raw.
//
//   * `displayAudioFailureReason()` from `lib/screenShare.js`, which is a
//     diagnostic composed by the native Linux desktop-audio bridge. It goes
//     into `voice.share.desktopAudioFailed` as data.
//
//   * Watch provider names and the hostnames they resolve to, which are
//     brands and DNS names respectively.
//
//   * Resolution and frame-rate numerals, and the `SCREEN_SHARE_QUALITIES`
//     labels ("1080p (Full HD)") that carry them.
//
// ------------------------------------------------------- tokens and arms
//
// Many keys here are a `select` on a machine token rather than a sentence with
// a value in it. The tokens -- `serverMuted`, `androidDenied`, `environment`,
// `stopWatching`, `no-audio-worklet` -- are computed in the components from
// call state, from DOM exception names, or from the capability probe in
// `lib/denoise.js`. They are vocabulary, not text. A translator who translates
// an arm *name* has not changed a word on screen; they have deleted a branch,
// and the message silently falls through to `other`.
//
// The reason they are one message with arms rather than four keys is that in
// every one of these cases the arms are alternative states of a single control
// drawn in a single place, usually a fixed-width square or a pill. Whoever
// chooses the word for "Unmute" needs "Mute" and "Muted by a moderator" in
// front of them to keep the three the same length. Split across three keys in
// a translation tool they arrive on different days in alphabetical order.
//
// --------------------------------------------------------------- plurals
//
// Four keys count things: `voice.room.inVoice`, `voice.room.watching`,
// `voice.incoming.groupSize` and `voice.watch.waitingForMany`. All four go
// through `plural` even where English would not need it, because English
// needing two arms is a fact about English. Japanese needs one arm, Polish
// needs three and Arabic needs six, and none of that is knowable from the
// component -- which is exactly why the component no longer decides.

export const voice = {
  // ----------------------------------------------- the sidebar connection bar

  // The fallback name for the room when neither a channel nor a conversation
  // can supply one. It is one word because it sits in a 2.5rem-tall card above
  // the user strip and shares the line with an elapsed timer.
  'voice.bar.channel': 'Voice',
  // Said for a direct call, where there is no guild to name underneath.
  'voice.bar.directMessage': 'Direct message',

  // The two states of the line beside the signal meter. "Voice connected" is
  // two words doing one job: it says which subsystem is up, because this bar
  // appears in a sidebar next to several other things that could be connected
  // or not. A bare "Connected" would be ambiguous in exactly the moment it is
  // read.
  'voice.bar.connecting': 'Connecting…',
  'voice.bar.connected': 'Voice connected',

  // The meter's tooltip. Two answers, and they are genuinely different
  // answers: a round trip that has not been measured yet is not a bad one.
  //
  // `{ms}` is already rounded to a whole number by the caller. The unit is
  // separated by a space because that is the SI convention and it is the
  // convention in every language this catalogue currently has; a locale that
  // writes it differently changes it here.
  'voice.bar.measuring': 'Measuring',
  'voice.bar.ping': '{ms} ms',

  // The panel the meter opens, and the two rows it reports. The title
  // borrows the meter's own word: this client says ping wherever it says this
  // number, so a panel called "Latency" would read as a second, related
  // feature rather than as the same one with a history behind it.
  //
  // The rows are named in full rather than abbreviated. There is a line each
  // for them at the foot of a 220px panel, and somebody meeting "Average"
  // for the first time has less to work out than somebody meeting "Avg".
  //
  // The second row is the newest sample, under the average of the window --
  // that order because it is the order the questions come in: how has this
  // call been, and how is it now. It is also the number the meter's tooltip
  // says, which is a sentence a pointer is shown for as long as it rests and
  // no longer; here it stays as long as the panel is open.
  'voice.bar.pingHistory': 'Ping history',
  'voice.bar.pingAvg': 'Average',
  'voice.bar.pingLast': 'Last ping',

  'voice.bar.disconnect': 'Disconnect',
  'voice.bar.toolbar': 'Voice controls',

  // Four squares in a 2x2 grid, and two of them can be in a state where the
  // press would do nothing. A moderator's mute is not yours to lift, and the
  // way out of deafened is the square next to this one -- so in those two
  // states the square names the reason instead of naming an action.
  //
  // `muted` here means "muted *because* deafened", which is the only state in
  // which the microphone square is shut by the headphone square. It is a state
  // and not an offer, so it is an adjective -- and it is deliberately the bare
  // word, because the headphone square beside it is already saying why.
  //
  // `serverMuted` and `serverDeafened` name the server rather than "a
  // moderator": the roster flag is set by whatever holds the authority in that
  // room, which may be a moderator, an automod rule or the guild's own
  // configuration, and the square has room for two words. Keep them short --
  // these four squares are a fixed-width 2x2 and the longest arm sets the
  // truncation for all of them.
  'voice.bar.mic': '{state, select, serverMuted {Server muted} muted {Muted} unmute {Unmute} other {Mute}}',
  'voice.bar.deafen': '{state, select, serverDeafened {Server deafened} undeafen {Undeafen} other {Deafen}}',

  // Deliberately the same words as the dock's equivalents below. They are the
  // same two buttons in two places and a person can see both at once.
  'voice.bar.videoStart': 'Turn on camera',
  'voice.bar.videoStop': 'Turn off camera',
  'voice.bar.shareStart': 'Share screen',
  'voice.bar.shareStop': 'Stop sharing',

  // ------------------------------------------------------------- the dock

  // The round bar of controls under the stage. Every one of these is a tooltip
  // and an accessible name at once, so they are imperatives: what pressing it
  // will do, not what is currently true.
  'voice.dock.camera': '{on, select, yes {Turn off camera} other {Turn on camera}}',
  'voice.dock.mic': '{muted, select, yes {Unmute} other {Mute}}',
  'voice.dock.deafen': '{deafened, select, yes {Undeafen} other {Deafen}}',
  'voice.dock.share': '{on, select, yes {Stop sharing} other {Share screen}}',
  'voice.dock.disconnect': 'Disconnect',
  // Phones only, and only while the camera is on. The arm is named after the
  // `facingMode` value currently in force, so `environment` means the back
  // camera is live and the press goes to the front one.
  'voice.dock.flip': '{facing, select, environment {Switch to the front camera} other {Switch to the back camera}}',
  // "Watch together" is the feature's name -- `voice.watch.title` spells it
  // that way, `voice.watch.startFailed` says "start watching together", and
  // this is the third place it is said. It used to say "End watch party" in
  // the `yes` arm, which named the same feature a second way in the one place
  // a person is most likely to be looking for the first: the button they are
  // about to press to stop it. A translator reading only this key had no way
  // to know the two were the same thing and would reasonably coin a second
  // noun, so the second name would then exist in every language rather than
  // just in English. "End" rather than "Stop" because the press runs
  // `watch.end`, which is `voice.watch.end`'s "End for everyone" -- it takes
  // the session away from the room, not just from you.
  'voice.dock.watch': '{on, select, yes {End watching together} other {Watch together}}',

  // ----------------------------------------------------------- the stage

  // The centre of the call. `emptyTitle` and `join` are defaults: a caller
  // that knows better -- a DM, where "voice" is the wrong noun -- passes its
  // own words in, and the stage uses these when nobody does.
  'voice.stage.emptyTitle': 'Nobody is here yet',
  'voice.stage.join': 'Join voice',
  'voice.stage.rejoin': 'Rejoin',
  'voice.stage.controls': 'Call controls',

  // Autoplay. Browsers hold a call's audio until the page has been interacted
  // with, and the person cannot tell that from a call that has gone silent, so
  // this is said rather than left to be discovered.
  'voice.stage.audioBlocked': 'Your browser is holding this call’s audio until you interact with the page.',
  'voice.stage.resumeAudio': 'Play audio',

  // The name under a picture, and the name on the button that puts a share on
  // the stage. Both branch on whose it is rather than interpolating "You",
  // because "You's screen" is what interpolation gives you and because several
  // languages inflect the possessive differently for the first person.
  //
  // `shareName` and `cameraName` are the *bare* forms, used where an icon has
  // already said "screen" or "camera"; `voice.screen.label` and
  // `voice.tile.cameraLabel` below are the full forms used as accessible names
  // where nothing else says it.
  'voice.stage.shareName': '{mine, select, yes {Your screen} other {{who}}}',
  'voice.stage.cameraName': '{mine, select, yes {Your camera} other {{who}}}',
  // Screen-reader-only, beside a dot. The dot means the share started while
  // you were looking at something else; a shape is not a word, so the word
  // goes in the button's own name.
  'voice.stage.newShare': 'New',

  // Shown once, above a call that the relay cannot listen to. Worth a sentence
  // rather than a padlock because it is the claim the whole media path exists
  // to make -- see docs/calls.md.
  'voice.stage.sealedNotice': 'This call is end-to-end encrypted. The server carries it without being able to hear it.',

  // ------------------------------------------------------------- the tiles

  // One person, one square. The two labels below are accessible names on the
  // video element itself and are the only thing a screen reader has to go on,
  // which is why they name the medium as well as the person.
  'voice.tile.cameraLabel': '{mine, select, yes {Your camera} other {{who}\'s camera}}',
  // Expanding is a verb about a person, not about a rectangle, and the two
  // directions are not the same sentence with a different verb: you expand a
  // *video* and you return a *person* to the grid. English can build both from
  // a name plus a suffix; that is a fact about English possessives, and the
  // moment the name moves inside the sentence -- as it must in a language that
  // puts the object first -- the join has to be the catalogue's to make.
  'voice.tile.expand': '{mine, select, yes {Expand your video} other {Expand {who}\'s video}}',
  'voice.tile.collapse': '{mine, select, yes {Return your video to the grid} other {Return {who} to the grid}}',

  // Two states drawn as a coloured glyph on the name plate, with the word
  // repeated for anything that cannot see the glyph. Adjectives, not verbs:
  // they describe the person, they are not buttons.
  'voice.tile.muted': 'Muted',
  'voice.tile.deafened': 'Deafened',

  // Pills in the corner of a tile. All four are room for about two short
  // words; the layout drops them entirely on a compact tile rather than
  // truncating, so length is a matter of taste here and not of breakage.
  'voice.tile.noMic': 'No microphone',
  'voice.tile.camera': 'Camera on',
  // "Your pick" is the tile you expanded, still chosen, while a screen share
  // has temporarily taken the stage. It is possessive because the whole point
  // is that the choice is still yours and is one click from being given up.
  'voice.tile.yourPick': 'Your pick',

  'voice.tile.more': 'More',
  // The one name for this feature, in the one place it is a control. The
  // browser API behind it is called Picture-in-Picture and the key still says
  // `pip` so that grepping either half finds the other, but nothing a person
  // reads says that: the three user-visible strings (this, `screen.noVideo`,
  // `screen.noPip`, `error.pip`) all say "pop out", in the noun form here and
  // in the verb form there. They used to say three different things -- "Pop
  // out", "picture in picture", "pop the video out" -- which reads in English
  // as one feature described loosely and reads in translation as three
  // features, because a translator working key by key has no way to see that
  // the menu item and the failure message are about the same button. German
  // had already noticed and unified on "Bild-in-Bild"; Arabic had concluded
  // from the English that the split was deliberate and kept two nouns.
  'voice.tile.pip': 'Pop out',
  // Two sliders in the tile's menu, and they have to be told apart at a glance
  // because a person turning down someone's screen share almost always wants
  // to keep hearing them talk.
  'voice.tile.volume': 'Volume',
  'voice.tile.screenAudio': 'Screen audio',
  'voice.tile.screenAudioVolume': 'Screen audio volume',
  'voice.tile.screenAudioVolumeFor': "{name}'s screen audio volume",

  // The consent button on somebody's share in an SFU room, where watching is
  // what actually asks the server to forward the picture. Three arms rather
  // than two: a tile narrow enough that a labelled button and a quality picker
  // would overlap the name plate drops to the bare verb.
  'voice.tile.watchGate': '{state, select, stop {Stop} stopWatching {Stop watching} other {Watch}}',

  // ------------------------------------------------------- the screen share

  'voice.screen.label': '{mine, select, yes {Your screen} other {{who}\'s screen}}',
  'voice.screen.fullscreen': 'Fullscreen',
  'voice.screen.resetZoom': 'Reset zoom',
  'voice.screen.stopSharing': 'Stop sharing',

  // The four ways fullscreen and picture-in-picture can refuse. These are
  // thrown as `Error`s and land in a toast through `reportError`, so they are
  // sentences and not developer strings -- the distinction that decides
  // whether something in this migration got translated at all.
  'voice.screen.noScreen': 'There is no screen to show.',
  'voice.screen.noFullscreen': 'This browser will not go fullscreen.',
  'voice.screen.noVideo': 'There is no video to pop out.',
  'voice.screen.noPip': 'This browser cannot pop a video out.',

  // The four rungs of `WATCH_QUALITIES`, whose tokens live in
  // `lib/screenShare.js` and whose words live here. The module that computes
  // bitrate ladders is imported by tests that never mount a component, so it
  // cannot hold a table of English and stay honest about German.
  'voice.quality.label': 'Stream quality',
  'voice.quality.auto': 'Auto',
  'voice.quality.low': 'Low',
  'voice.quality.medium': 'Medium',
  'voice.quality.high': 'High',

  // The pill on a tile that is sharing, naming which encoder bet is in force.
  // `live` is the fallback for a share that started before presets existed or
  // from a client that does not send one.
  'voice.preset.detail': 'Detail',
  'voice.preset.motion': 'Motion',
  'voice.preset.live': 'Live',

  // --------------------------------------------------------- the chat toggle

  // The button that opens the channel's text beside the stage. The visible
  // word is the noun; the accessible name and tooltip are the action, which is
  // why they are two keys and not one.
  'voice.chat.label': 'Chat',
  'voice.chat.toggle': '{open, select, yes {Close chat} other {Open chat}}',

  // The same button when the badge beside it is lit. These are whole sentences
  // rather than the toggle plus a fragment because the badge is the only reason
  // anyone presses this in a hurry, and a name glued together out of two keys
  // fixes the order English happens to want -- a language that puts the count
  // first has nowhere to put it. `{count}` is a real plural rather than an `s`,
  // which is what makes the Arabic and Japanese forms possible at all.
  'voice.chat.toggleMentions': '{open, select, yes {Close chat} other {Open chat}}, {count, plural, one {# mention} other {# mentions}}',
  'voice.chat.toggleUnread': '{open, select, yes {Close chat} other {Open chat}}, unread',

  // ------------------------------------------------- Android's output picker

  // Phones only. Android owns this list: it decides what an output is called
  // and hands over a label already in the system language. Every one of those
  // labels goes through `option` as a value.
  //
  // The tick is a prefix rather than a checkmark column because the sheet is a
  // plain menu; `selected` and `other` are the two arms rather than a boolean
  // so that a language which marks the current choice some other way -- a
  // word, a bracket, a different glyph -- can.
  'voice.route.title': 'Audio output',
  'voice.route.finding': 'Finding outputs…',
  'voice.route.option': '{state, select, selected {✓ {label}} other {{label}}}',
  // Only ever shown before the bridge answers. Once it has, its own
  // `automatic_label` replaces this.
  'voice.route.automatic': 'Automatic',
  'voice.route.unsupported': 'This device does not offer an output picker.',

  // -------------------------------------------- the desktop device panel

  // The popup on the desktop build for choosing the microphone, the
  // suppressor and the output. Its trigger shows `title`; the tooltip on that
  // trigger is `open`, which says what the panel is *for* rather than
  // repeating its name.
  'voice.devices.title': 'Audio devices',
  'voice.devices.subtitle': 'What this call listens to, and where it plays.',
  'voice.devices.open': 'Choose the microphone and output',
  'voice.devices.refreshing': 'Refreshing…',

  'voice.devices.input': 'Microphone',
  'voice.devices.output': 'Output',
  // "System default" rather than "Default": the default is not Telium's, it is
  // the one the operating system is currently pointing at, and saying so is
  // what makes the other entries in the list worth reading.
  'voice.devices.defaultMic': 'System default',
  'voice.devices.defaultSpeakers': 'System default',

  // A device the OS refused to name -- which is what an un-permissioned
  // browser reports for every device it has. The number is this entry's
  // position in the list and the id is the first six characters of the
  // hardware identifier, which is enough to tell two of them apart across a
  // refresh. Both are values in a sentence rather than pieces glued together,
  // because a language that counts after the noun, or that would rather put
  // the identifier first, needs to be able to say so.
  'voice.devices.unnamedMic': 'Microphone {n} ({id})',
  'voice.devices.unnamedOutput': 'Output {n} ({id})',

  // What sits between the microphone and the network. Three options, and the
  // middle one names the *browser* because that is exactly the distinction: it
  // is WebRTC's own suppressor, which costs nothing and is already there.
  'voice.devices.noise': 'Noise suppression',
  'voice.devices.noiseOff': 'Off',
  'voice.devices.noiseBrowser': 'Browser',
  // One option, two states, one message. It used to be the word plus an
  // appended parenthesis, which reads as an aside in English and as a second
  // sentence stuck on the end in a language that would rather say "measuring
  // the neural model" as one phrase or put the qualifier first.
  'voice.devices.noiseNeural': '{state, select, measuring {Neural (measuring…)} other {Neural}}',

  'voice.devices.noSinkId': 'This browser cannot choose an output; it follows the system.',

  // Two failures from the microphone-switching path. Both are thrown, both
  // reach a toast, and both are about a running call rather than a setting --
  // which is why neither of them is phrased as advice.
  'voice.devices.micPublishFailed': 'The call did not publish the new microphone.',
  'voice.devices.micSwitchUnsupported': 'This call cannot change microphone while it is running.',

  // --------------------------------------------- why the neural model cannot

  // The nine refusals from `neuralCapability()` and `probeNeural()` in
  // `lib/denoise.js`, keyed by the machine reason the probe returns -- the
  // same shape as `errors.mfa_required`, and for the same reason: a build that
  // meets a reason it has never heard of falls through to `voice.noise.cannot`
  // rather than putting a machine token on screen.
  //
  // The hyphens in these key segments are unusual for this catalogue and are
  // deliberate: they are the probe's own vocabulary, spelled exactly as it
  // spells it, so that grepping either half finds the other.
  'voice.noise.reason.no-audio-worklet': 'This browser cannot run audio processing off the main thread.',
  'voice.noise.reason.no-audio-context': 'This browser does not expose the Web Audio API.',
  'voice.noise.reason.insecure-context': 'Audio processing needs a secure (https) connection.',
  'voice.noise.reason.no-wasm': 'This browser will not run WebAssembly on this page.',
  'voice.noise.reason.one-core': 'This device has too few CPU cores to spare one for the model.',
  'voice.noise.reason.no-48k': 'This device’s audio hardware will not run at 48 kHz.',
  'voice.noise.reason.too-slow': 'This device is not fast enough to run the model in real time.',
  // These two used to say "the noise-cancellation model", which was the third
  // name in this namespace for two different things. The feature is "Noise
  // suppression" (`voice.devices.noise`); the optional thing that can fail to
  // load is the neural model, which is the word on the card the person picked
  // (`voice.devices.noiseNeural`) and the word the other seven reasons here
  // already use. "Noise cancellation" named neither of them and was easy to
  // read as a fourth setting that had been turned off somewhere.
  'voice.noise.reason.load-failed': 'The neural model could not be loaded.',
  'voice.noise.reason.no-measurement': 'The neural model could not be measured.',
  'voice.noise.cannot': 'This device cannot run the neural model.',
  // Said once, when a call gives up on the neural model mid-flight and writes
  // the preference back to `browser`. The second half is the part worth
  // saying: something is still suppressing noise, so the person does not go
  // looking for a setting that is already correct.
  'voice.noise.fellBack': 'The neural model could not keep up, so this call switched to the browser’s noise suppression.',

  // ---------------------------------------------------- joining and leaving

  // The microphone refusal, and the single most important sentence in this
  // file: it is what somebody reads when a call has connected and they cannot
  // be heard.
  //
  // It was three fragments joined by a semicolon -- a cause, a semicolon, and
  // a consequence -- which is a decision about English clause order pretending
  // to be a string concatenation. The consequence is repeated in full in every
  // arm on purpose: a language that inflects the second clause according to
  // the first, or that puts the consequence before the cause, needs all of it
  // to move. Repetition here is the cost of the sentence being translatable at
  // all, and it is cheap.
  //
  // `androidDenied` is separate from `denied` because the remedy is somewhere
  // else entirely: a browser permission lives in the site settings, an Android
  // one lives in the system's app settings, and pointing at the wrong one
  // wastes the only sentence we get.
  'voice.call.noMic': '{reason, select, androidDenied {Microphone permission was refused. Allow Telium the microphone in Android’s app settings; you can hear the call but not speak in it.} denied {Microphone permission was refused. Allow it in your browser’s site permissions; you can hear the call but not speak in it.} missing {No microphone was found on this device; you can hear the call but not speak in it.} other {The microphone could not be opened; you can hear the call but not speak in it.}}',

  // The camera's version of the same three refusals. Shorter, because a camera
  // that will not open is not the emergency a microphone that will not open
  // is: the call still works.
  'voice.call.cameraRefused': '{reason, select, androidDenied {Camera permission was refused. Allow Telium the camera in Android’s app settings.} denied {Camera permission was refused. Allow it in your browser’s site permissions.} missing {No camera was found on this device.} other {The camera could not be opened.}}',

  // Four things a call's transport can simply not be able to do. Phrased as
  // facts about this call rather than as errors, because there is nothing to
  // retry and nothing to fix.
  'voice.call.noCameraSupport': 'This call cannot carry video.',
  'voice.call.noScreenShareSupport': 'This call cannot carry a screen share.',
  'voice.call.noFlipSupport': 'This call cannot switch cameras.',
  'voice.call.noAlternateCamera': 'This device has no other camera to switch to.',

  // Sealing a conversation's call. Both are thrown before a single packet
  // moves, and both mean the call is not going to happen rather than that
  // something went wrong during it.
  'voice.call.noKeys': 'This conversation has no call keys yet, so the call cannot be sealed.',
  'voice.call.sfuAddressUnknown': 'This conversation does not say which SFU to call.',
  // A guild's server offered an SFU without end-to-end encryption. Refused
  // outright: the alternative is a call the server can listen to.
  'voice.call.sfuNotEncrypted': 'This server did not offer an end-to-end encrypted call, so you were not connected.',

  // The call moved while you were in it. Three separate things can move -- the
  // transport, the region, the room -- and they are three messages because
  // they are three different facts, and because a person who sees the same
  // sentence twice assumes the second one is a repaint.
  //
  // `mode` is a token and not the server's own `mode` string: the component
  // narrows anything that is not an SFU to `mesh`, so a third transport
  // arriving later does not quietly render as itself.
  'voice.call.moved': '{mode, select, sfu {The call moved onto an SFU.} other {The call moved to direct connections.}}',
  'voice.call.movedRegion': 'Voice moved to the {region} region.',
  'voice.call.movedTo': 'Moved to {channel}.',
  // The name for a channel this client has not loaded. Lower case because it
  // is dropped into the middle of `movedTo`, which is the only place it is
  // ever used.
  'voice.call.someVoiceChannel': 'another voice channel',
  'voice.call.shareStoppedOnMove': 'Your screen share stopped when the call moved.',

  // ------------------------------------------------- refusing to dial at all

  // The three codes from `refusalCode()` in `lib/callmode.js`. That function
  // used to return a finished English sentence; it now returns a code, and the
  // wording happens here, where the reader's language is known.
  //
  // These are about the *posture* the person chose in their privacy settings,
  // not about a failure, so each one names the requirement and then says what
  // was on offer instead. A call is never quietly downgraded to get it
  // through; that is the whole point of the check, and the sentence has to
  // make it obvious that the refusal was deliberate.
  'voice.refusal.nothing': 'There is no voice server to call.',
  'voice.refusal.sfu': 'Your call privacy asks for an SFU, and this call has none.',
  'voice.refusal.relay': 'Your call privacy asks for at least a relay, and this call offers neither a relay nor an SFU.',

  // ----------------------------------------------------- the ringing card

  // What the card says when a call arrives while you are looking at something
  // else. The caller's own name is drawn above; these are the second line and
  // the two buttons.
  'voice.incoming.title': 'Incoming call',
  // A group call names the room. When the room has no name, the size is the
  // only thing that distinguishes it from a two-person call, so it is counted
  // -- through a plural, because "1 people" is the sentence that proves nobody
  // ever read the number.
  'voice.incoming.groupSize': '{count, plural, one {Group call · # person} other {Group call · # people}}',
  // The card's own accessible name and its two icon buttons, each in two
  // whole forms rather than one form with a hole in it.
  //
  // There used to be a `voice.incoming.someone` reading "Someone", handed in
  // as `{caller}` whenever the ring carried no name we could resolve. That is
  // a placeholder wearing a person's clothes: "Call from Someone" reads as a
  // name the call actually claimed, which is the one thing it did not, and a
  // person who sees it reasonably concludes the client lost the name rather
  // than never having had it. It is also unfixable in translation -- Arabic
  // and German both have to decline or gender a word there, and neither has a
  // word for this non-person to decline.
  //
  // So the absence is now a `select` on a machine token and each arm is a
  // finished sentence. A translator can therefore write the unnamed form as
  // the sentence their language actually uses for it, which in most of them
  // is not "call from <something>" at all. The caller stays *inside* the
  // named arm rather than after it, for the original reason: two icon buttons
  // side by side are told apart by their first word in some languages and by
  // their last in others.
  'voice.incoming.fromWho': '{named, select, yes {Call from {caller}} other {Incoming call}}',
  'voice.incoming.answer': '{named, select, yes {Answer call from {caller}} other {Answer call}}',
  'voice.incoming.decline': '{named, select, yes {Decline call from {caller}} other {Decline call}}',
  'voice.incoming.joinFailed': 'Could not answer the call',

  // ------------------------------------------------- the call log in chat
  //
  // A conversation's chat keeps a short local log of its calls: how each one
  // started and how it ended. Local, because no server holds this -- the
  // roster is ephemeral voice state, and the log is this device's memory of
  // it. Each entry is one centred line in the timeline rather than a message:
  // it cannot be replied to, reacted to or edited, and the caller is named
  // inside the sentence rather than above it.
  //
  // `duration` arrives preformatted (`3:07`) because a duration is a number
  // with a colon in it rather than a sentence, and localising the digits
  // without reordering the sentence is the formatter's job, not the
  // catalogue's.
  'voice.log.incoming': 'Incoming call',
  'voice.log.outgoing': 'Outgoing call',
  'voice.log.missed': 'Missed call',
  'voice.log.ended': 'Call ended',
  'voice.log.endedDuration': 'Call ended · {duration}',
  // The caller's half of ringing: shown over the stage while this device is
  // alone in a call it placed, until somebody joins or it is cancelled.
  'voice.log.ringing': 'Ringing…',
  'voice.log.ringingHint': 'Waiting for them to pick up.',
  'voice.log.cancel': 'Cancel',

  // ------------------------------------------------- the floating mini view

  // The picture that follows you around once you navigate away from a call
  // that has video in it.
  'voice.mini.call': 'Call',
  'voice.mini.region': 'Call mini view',
  'voice.mini.next': 'Next',
  'voice.mini.expand': 'Expand call',
  'voice.mini.hide': 'Hide',

  // The label under that picture, and the only place in the client where the
  // medium and the person are said together with no icon to help. Four keys
  // rather than two with a `select`, because the mini view builds a list of
  // rows and reads each row's label from the row itself; keeping them separate
  // keeps the two media distinguishable in a translation tool, where they
  // would otherwise be four arms of two messages with no context at all.
  'voice.media.screenMine': 'Your screen',
  'voice.media.screenOther': '{who}\'s screen',
  'voice.media.cameraMine': 'Your camera',
  'voice.media.cameraOther': '{who}\'s camera',

  // ------------------------------------------------- the voice channel page

  // A channel that has gone while somebody was looking at it. Said rather than
  // drawn empty: a room with no name, nobody in it and a join button that
  // cannot work is a worse answer than the truth.
  'voice.room.goneTitle': 'This voice channel is gone',
  'voice.room.goneBody': 'It was deleted, or you can no longer see it.',

  // The three hints the page hands to the stage. `emptyBody` is what an empty
  // room says under its heading; `joinHint` sits under the join button and is
  // the one warning anybody gets that pressing it opens a microphone;
  // `staleHint` is for the case where this tab believes it is in a call that
  // no connection on this tab is actually holding.
  'voice.room.emptyBody': 'Join to open it.',
  'voice.room.joinHint': 'Opens your microphone.',
  'voice.room.staleHint': 'Nothing on this tab is connected. Rejoin, or disconnect to clear it.',

  // The mobile header's subtitle, and the accessible name of the row of faces
  // on the desktop header. The number lives in the name of the row because the
  // faces *are* the count for anyone who can see them, and are nothing at all
  // for anyone who cannot.
  'voice.room.inVoice': '{count, plural, one {# in voice} other {# in voice}}',
  'voice.room.empty': 'Nobody here',
  // The overflow chip at the end of a stack of faces. A bare "+3" rather than
  // a sentence: it is drawn inside a circle the size of an avatar.
  //
  // The plus stays on the left in every language and the element is what says
  // so: both chips that draw this carry `ltr-notation`, because a plus sign is
  // bidi-neutral and an Arabic paragraph would otherwise lay this out as
  // «٣+». Do not "fix" it here by adding isolate characters to the pattern --
  // the long note in `utilities.css` says why that repair does not survive a
  // catalogue being edited by hand. The digits are still localised; only their
  // order is pinned.
  'voice.room.more': '+{count}',
  // The accessible name of a stack of watcher faces on somebody's share. The
  // count and the noun cannot be separated -- see the plurals note in the
  // header -- which is why this is one message and not a number beside a word.
  'voice.room.watching': '{count, plural, one {# person watching} other {# people watching}}',

  'voice.room.chatTitle': 'Channel chat',
  'voice.room.minimize': 'Minimize',

  // What the voice room is doing right now, as opposed to its topic's standing
  // description of what the room is for. Anyone in the call (or holding
  // CONNECT) may write it; everyone who can see the channel reads it under
  // the channel's name.
  'voice.status.label': 'Voice status',
  'voice.status.placeholder': 'What is this room doing right now?',
  'voice.status.set': 'Set voice status',
  'voice.status.edit': 'Edit voice status',
  'voice.status.clear': 'Clear',
  'voice.status.save': 'Save status',
  'voice.status.hint': '{count} of {max} characters',
  'voice.status.tooLong': 'Keep it under {max} characters.',
  'voice.status.saveFailed': 'Could not set the voice status',
  'voice.status.clearFailed': 'Could not clear the voice status',

  // Four things the watcher list can fail at. All four are `reportError`
  // contexts, which `errors.context` joins to whatever the server or the
  // browser said went wrong -- so they are noun phrases describing the
  // attempt, never complete sentences, and never end in punctuation.
  'voice.room.readFailed': 'Could not read who is watching',
  'voice.room.watchFailed': 'Could not start watching',
  'voice.room.unwatchFailed': 'Could not stop watching',
  'voice.room.qualityFailed': 'Could not change the stream quality',

  // ------------------------------------------------------- the region picker

  // Which of a deployment's voice servers carries the call. The region names
  // themselves are identifiers the deployment published and are drawn exactly
  // as they arrive.
  'voice.region.title': 'Voice region',
  'voice.region.subtitle': 'Where this call is carried. Closer is usually quieter.',
  'voice.region.loading': 'Loading regions',
  'voice.region.none': 'This server does not publish voice regions.',
  'voice.region.auto': 'Automatic',
  'voice.region.autoHint': 'Let the server pick the closest healthy region.',
  'voice.region.unhealthy': 'Not accepting calls right now.',

  // --------------------------------------------------- the share dialog

  'voice.share.title': 'Share your screen',
  'voice.share.choose': 'Choose what to share',
  'voice.share.contentLabel': 'What you are sharing',

  // The two encoder bets, keyed by the `value` of the presets in
  // `lib/screenShare.js`. The tokens stay there next to the bitrate ladders
  // they configure; the words are here. Each pair is a promise and its price,
  // in that order, because the price is what makes the choice a choice.
  'voice.share.content.detail.label': 'A document or code',
  'voice.share.content.detail.description': 'Sharp text. Fewer frames a second, every pixel kept.',
  'voice.share.content.motion.label': 'A game or video',
  'voice.share.content.motion.description': 'Smooth motion. Softens before it stutters when the link tightens.',

  // Audio, which is the thing people discover is missing halfway through
  // playing somebody a video.
  'voice.share.audio': 'Share the sound too',
  // Two hints under that switch, chosen from what the engine can actually do.
  // They are different facts: one browser can capture a tab's audio but not a
  // whole screen's, another cannot capture any at all, and telling somebody
  // the second when the first is true costs them a working feature.
  'voice.share.audioUnlikely': 'This browser can take the sound of a tab, but not of a whole screen or window.',
  'voice.share.noCapture': 'This browser cannot capture the sound of what you share.',
  // Said after the fact, when a share started with no audio track on it and
  // the browser is one that could have provided one. The quoted phrase is the
  // browser's own wording in its picker; a translator should use whatever that
  // picker says in their language, and should leave it alone if it is not
  // translated there either.
  'voice.share.pickTabAudio': 'No sound came with that. Pick a tab and tick “Share tab audio” to bring it along.',
  // Whatever the native Linux desktop-audio bridge said. A PipeWire or venmic
  // diagnostic this client did not compose and cannot translate, carried in
  // the one slot the sentence has for it.
  'voice.share.desktopAudioFailed': 'Could not share desktop audio: {reason}',

  // The collapsed advanced row and the two strips inside it. `summary` is the
  // current setting drawn on the row itself; the middle dot is a separator and
  // not punctuation, and a language that separates differently should change
  // it here.
  'voice.share.quality': 'Quality',
  'voice.share.summary': '{quality} · {fps} fps',
  'voice.share.resolution': 'Resolution',
  'voice.share.frameRate': 'Frames a second',

  // ------------------------------------------------------- watch together

  // Everyone plays the same thing themselves, and Telium carries only the
  // position and the play button. That distinction is the whole feature and
  // most of the words below exist to make it before somebody agrees to it.
  'voice.watch.title': 'Watch together',
  'voice.watch.subtitle': 'Everyone plays it themselves, in time with each other.',
  'voice.watch.url': 'Link',
  'voice.watch.urlPlaceholder': 'Paste a link',
  // The last alternative in a list of provider names, built with
  // `Intl.ListFormat` -- so this is only ever the final item and never carries
  // its own comma or conjunction.
  'voice.watch.orFile': 'a direct video file',
  'voice.watch.noEmbeds': 'This build has no watch providers, and direct files are turned off.',
  'voice.watch.start': 'Start',

  // The consent sentence, in the dialog and again on the card. One sentence
  // with the host emphasised inside it, not three nodes glued together: the
  // old form put the provider, a full stop, a clause and a bare "." in source
  // order, which is an assumption about English word order dressed up as
  // markup.
  'voice.watch.connects': 'Playing from <b>{provider}</b> connects this browser to <b>{host}</b>.',
  'voice.watch.consentHost': 'This connects your browser to <b>{host}</b>.',
  // Chosen from `connectsTo().kind`, which stays in `lib/watch/player.js`
  // because it is the privacy contract the watch gate is tested against. The
  // two cases are genuinely different: a file is fetched by each person from
  // wherever it lives, and an embed runs a player the provider serves.
  'voice.watch.noteFile': 'Each person fetches the file themselves, from wherever it is hosted.',
  'voice.watch.noteFrame': 'The player runs in a frame from {provider}, which sees this browser much as opening it in a tab would.',
  'voice.watch.proxyNote': 'Telium does not proxy it. The connection is yours.',
  'voice.watch.connectTo': 'Connect to {host}',
  'voice.watch.notNow': 'Not now',

  // What happens to the two bytes Telium *does* carry. Sealed in a room with
  // end-to-end encryption; visible to the relay otherwise. Said in both
  // places, because consenting to a connection and consenting to a relay
  // seeing your scrubbing are two different consents.
  'voice.watch.sealed': 'Only the position and the play button travel through Telium, and they are sealed end to end.',
  'voice.watch.relayed': 'The position and the play button travel through Telium’s relay, which can read them.',
  'voice.watch.relayedConsent': 'The position and the play button are relayed through Telium, which can read them.',
  'voice.watch.sealedLabel': 'Sealed end to end',

  // A link that no adapter can drive. Three lines, in the order somebody needs
  // them: what is wrong, why, and what to do instead.
  'voice.watch.unsyncable': 'That link cannot be kept in time.',
  'voice.watch.unsyncableWhy': 'Telium can only drive players it knows how to talk to, and this is not one of them.',
  'voice.watch.unsyncableInstead': 'Share your screen instead, and play it yourself.',
  'voice.watch.unplayable': 'That link cannot be played here.',

  // The line above the player. `who` is a name or "You"; `what` is the
  // provider's own name, or a phrase when the source is a bare file, because
  // the registry calls that "Direct video file" and nobody says that out loud.
  'voice.watch.you': 'You',
  'voice.watch.aVideo': 'a video',
  'voice.watch.started': '{who} started {what}',
  'voice.watch.opening': 'Opening {provider}…',
  'voice.watch.thePlayer': 'the player',

  // Somebody is still buffering. One name is worth saying; several are worth
  // counting, and the count goes through a plural for the usual reason.
  'voice.watch.waitingFor': 'Waiting for {who}',
  'voice.watch.waitingForMany': '{count, plural, one {Waiting for # person} other {Waiting for # people}}',
  // Said once, when the wait has gone on long enough that carrying on is
  // kinder than stopping. Deliberately not an apology and deliberately not an
  // error: it is a decision the room made.
  'voice.watch.gaveUpWaiting': 'Someone is still buffering, so playback went on without them.',

  // The control bar. Both transport buttons name the *room* rather than the
  // player, because that is the surprising half: pressing pause here pauses it
  // for everybody.
  'voice.watch.playAll': 'Play for everyone',
  'voice.watch.pauseAll': 'Pause for everyone',
  'voice.watch.position': 'Position',
  // Elapsed, then total, in that order, in every language -- this is a
  // timecode readout and not a sentence, and a reader glancing at it is asking
  // "how far in am I", which is the left-hand half. Every character in the
  // pattern is bidi-neutral or weak, so an Arabic paragraph would resolve the
  // whole run right to left and silently swap the two halves. The span that
  // draws it carries `ltr-notation`; see the note there before changing either
  // this pattern or that class.
  'voice.watch.elapsedOf': '{at} / {duration}',
  'voice.watch.speed': 'Speed',
  // The multiplication sign, not the letter x. It is a number and its unit.
  'voice.watch.rate': '{rate}×',
  // Two words for one button, chosen by whether this is your session. Ending
  // it takes it away from everybody; leaving it does not.
  'voice.watch.end': 'End for everyone',
  'voice.watch.leave': 'Leave',
  'voice.watch.startFailed': 'Could not start watching together',

  // ------------------------------------------------------------- failures

  // Everything in this section is a `reportError` context: the first half of
  // `errors.context`, joined to whatever actually went wrong. They are noun
  // phrases in the past-attempt sense -- "Could not do the thing" -- and none
  // of them ends in a full stop, because a colon and a second clause follow.
  //
  // They are worded from the person's side of the call, not the code's. "Could
  // not update your voice state" is what a failed `voiceState` request means
  // to somebody who pressed Mute and watched it spring back.
  'voice.error.join': 'Could not join the call',
  'voice.error.leave': 'Could not leave the call cleanly',
  'voice.error.trouble': 'The call ran into trouble',
  'voice.error.voiceState': 'Could not update your voice state',
  'voice.error.cameraOn': 'Could not turn the camera on',
  'voice.error.cameraOff': 'Could not turn the camera off',
  'voice.error.flipCamera': 'Could not switch cameras',
  'voice.error.shareScreen': 'Could not share the screen',
  'voice.error.stopStream': 'Could not stop the screen share',
  'voice.error.streamState': 'Could not update the screen share',
  'voice.error.resumeAudio': 'Could not start the call audio',
  'voice.error.fullscreen': 'Could not go fullscreen',
  'voice.error.pip': 'Could not pop the video out',
  // The two halves of following a call that moved underneath you. Separate,
  // because one is a new server and the other is a new region, and knowing
  // which failed is the difference between waiting and rejoining.
  'voice.error.followServer': 'Could not follow the call to its new server',
  'voice.error.followRegion': 'Could not follow the call to its new region',
  'voice.error.rekey': 'Could not re-key the call',
  // The device panel's four. `readRoutes` and `switchOutput` are shared with
  // Android's output sheet, which asks the same two questions of a different
  // implementation.
  'voice.error.listDevices': 'Could not list the audio devices',
  'voice.error.switchMic': 'Could not switch the microphone',
  'voice.error.switchOutput': 'Could not switch the output',
  'voice.error.readRoutes': 'Could not read the audio outputs',
  // "Noise suppression" is the feature and "the neural model" is the thing
  // that may not load; see `voice.noise.reason.load-failed`. These two sit
  // next to each other in the same toast queue, so naming the second one
  // after the first would have made two different failures read as one.
  'voice.error.noiseChange': 'Could not change noise suppression',
  'voice.error.noiseModel': 'Could not check the neural model',
};
