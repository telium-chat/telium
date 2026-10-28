// What the client says about its own age.
//
// Four sentences and three buttons, and the reason there are so few is the
// same reason `lib/version.js` says so little about a stale server: a notice
// that is always there is a notice nobody reads, and the day it finally
// matters it will be the same grey line it has been for six months. Everything
// in this namespace is written to be read *once*, by somebody who was doing
// something else.
//
// ------------------------------------------------------- the two situations
//
// There are exactly two, and flattening them is the mistake this namespace is
// shaped to prevent.
//
// The first is ordinary: a newer build exists. Nothing is wrong. The reader
// can ignore this for a week and lose nothing, and the copy should sound like
// that -- a fact, offered, in one line, with a way to act on it and a way to
// put it away.
//
// The second is that a server has refused to talk to this build at all (close
// code 4015, `lib/failure.js`). The reader is looking at a client that does
// not work and is entitled to know why in the same breath as being told what
// to do about it. That sentence has to carry both halves, because the surface
// it replaces -- a connection failure banner saying "update Telium" with
// nothing behind it -- is the one that sent people to a search engine.
//
// -------------------------------------------------- why the verbs differ
//
// The same news reaches four runtimes that can do four different things about
// it, and the button has to be honest about which. "Update" on a build that
// cannot update itself is a lie with a cursor on it: the reader clicks, and
// either nothing happens or they are dropped somewhere they did not ask to go.
//
//   * Electron desktop can fetch the artifact, check it against the
//     publisher's signature and put it in place. That, and only that, is
//     allowed to say something that sounds like installing.
//   * A browser tab is never meaningfully old -- the new bundle is already
//     cached by the service worker. It reloads.
//   * Android is installed by a store, and the store will do it whether or not
//     this sentence is here. The button opens the listing.
//   * A distro package or a self-built binary belongs to somebody else. There
//     is no button at all, only a link to the release, because a client that
//     silently overwrote a packaged file would be malware by the standards of
//     the person who packaged it.
//
// A translator should keep those four distinct. If a language has one verb
// that covers both "install this for me" and "go and get this yourself", it is
// the wrong verb for at least one of them here.
//
// --------------------------------------------------------- tone, and "Later"
//
// The dismiss button is "Later", not "Dismiss" and not "OK". "Dismiss" is what
// you do to a complaint; "OK" is an agreement to nothing. "Later" is the true
// description of what the button does -- the notice comes back, on a schedule
// that depends on how much it matters (`lib/updates.js`, `SNOOZE_MS`) -- and a
// translation that promises the notice is gone for good is promising something
// the code does not do.

export const updates = {
  // ------------------------------------------------------------- being behind

  // Names the version, because "an update is available" is the sentence every
  // piece of software on the reader's machine has shown them this month and it
  // has stopped carrying information. A number they can compare against the
  // one in their settings footer is a fact; "an update" is wallpaper.
  'updates.available': 'Telium {version} is available.',

  // Read in addition to the line above, never instead of it. A reader who is
  // four releases behind, where the fix was in the second of them, is a reader
  // with an unpatched hole regardless of what the newest release changed --
  // which is why `assess()` asks this of every release that was missed and not
  // only of the newest one.
  'updates.security': 'One of the releases you have missed fixes a security problem.',

  // ------------------------------------------------------- being refused

  // The server's own words are shown underneath this by the connection banner,
  // and they are better than anything written here could be: the server knows
  // which of the two ends is behind and it composed a remedy. This sentence's
  // job is only to say that the two facts on screen are one fact -- that the
  // thing refusing to connect and the thing offering an update are the same
  // situation. Naming the server would be wrong: several may have refused, and
  // the one the reader cares about is whichever they were trying to use.
  'updates.incompatible': 'This copy of Telium is too old to connect. Updating will fix it.',

  // ------------------------------------------------------------- the actions

  // Electron only. Says both halves because both happen and the second one
  // costs the reader their place: the app closes and reopens. A button that
  // said only "Install" and then vanished the window would be a button people
  // learn not to press.
  'updates.action.install': 'Install and restart',
  'updates.action.reload': 'Reload',
  'updates.action.store': 'Open the store',
  // For the runtimes that cannot install anything. Not a call to action --
  // there is nothing here for the client to do -- so it reads as what it is: a
  // link to the thing being talked about.
  'updates.action.page': 'What changed',
  'updates.action.later': 'Later',

  // ------------------------------------------------- why there is no button

  // Shown in place of an action, so it has to answer "then why are you telling
  // me" in the same breath. Both of these do, by naming who *can* act: a
  // package manager has an owner and a store has a queue, and in both cases
  // the reader now knows the shape of the next step even though this client
  // cannot take it for them.
  'updates.blocked.package': 'This build is installed by your system, so update it the way you installed it.',
  'updates.blocked.artifact': 'There is no download for this platform in this release.',

  // ------------------------------------------------------ while it installs

  // Present tense, and stays on screen alongside the bar: a bar without words
  // reads as decoration, and words without a bar made a multi-minute download
  // read as a hung button -- the complaint that put the bar there.
  'updates.state.downloading': 'Downloading Telium {version}…',
  // Under the line above, fed by the download's actual byte counts
  // (`electron/updater.cjs`). Bytes rather than a bare percentage: they let a
  // reader on a slow link estimate the wait, and they come from the transfer
  // itself, so they cannot quietly disagree with it. Absent when the endpoint
  // sends no size at all, which leaves the phase line alone.
  'updates.state.progress': '{received} of {total}',
  'updates.state.verifying': 'Checking the signature…',
  // Deliberately says the update is ready rather than that it is installed:
  // nothing has replaced anything until the app restarts, and a reader who
  // closed the window at this moment would be running the old build.
  'updates.state.ready': 'Telium {version} is ready. Restart to use it.',
  'updates.action.restart': 'Restart',
  // The failure sentence does not say why, and that is deliberate. The reasons
  // -- a truncated download, a signature that did not verify, a read-only
  // install directory -- are all things the reader cannot act on differently,
  // and the one that matters most is the one that must not be minimised into
  // an explanation somebody clicks past. It goes to the log in full; here it
  // says the outcome and offers the manual route, which always works.
  'updates.state.failed': 'That update could not be installed. Download it yourself instead.',

  // ------------------------------------------------- the settings footer

  // Not a banner. This is the line in the settings footer, read only by
  // somebody who went looking, and it exists because the alternative is a
  // build that silently never checks and never says why -- which is what a
  // fork gets if it rebuilds the client and forgets the two build variables.
  // It names the state rather than apologising for it: plenty of builds are
  // meant not to update themselves, and the reader is the only one who can
  // tell which kind theirs is.
  'updates.footer.unkeyed': 'This build has no update publisher configured, so it will not check for updates.',
  'updates.footer.current': 'Up to date.',
  'updates.footer.unreachable': 'Could not reach the update publisher.',
  // The loud one. A manifest that arrives and fails verification is not a
  // network problem and must never be worded as one: it means something
  // between this machine and the publisher is serving a file it did not sign.
  'updates.footer.forged': 'The update information did not carry a valid signature and was refused.',
  'updates.footer.checking': 'Checking for updates…',
};
