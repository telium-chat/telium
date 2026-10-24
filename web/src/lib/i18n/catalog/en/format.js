// The handful of strings that formatting itself needs.
//
// Everything else in this directory is a sentence somebody wrote for a screen.
// These are the seams where `Intl` stops: the places where the platform has a
// number but no words to put around it, and a language has to supply them.
//
// There are exactly two such seams and it is worth knowing why they are the
// only two, so nobody adds a third out of habit.
//
//   * **"just now".** CLDR has a phrase for every relative time except the one
//     that refuses to be relative. `Intl.RelativeTimeFormat` with
//     `numeric: 'auto'` will say "now" for a delta of zero, but the window this
//     client treats as now is 45 seconds wide (see `JUST_NOW_MS` in
//     `intl.js`), and `format(-30, 'second')` inside that window says
//     "30 seconds ago", which is both true and wrong: a message that landed
//     while you were reading the one above it did not happen "30 seconds ago",
//     it happened just now. So the window is ours and the words in it are ours.
//
//   * **Byte units.** `Intl.NumberFormat` has a `unit` style with
//     `kilobyte`/`megabyte`, and it is the wrong tool twice over. It formats
//     powers of 1000 and this client counts powers of 1024 -- which is what
//     every file manager, every upload limit and the server's own quota
//     arithmetic use -- so `Intl`'s "1.0 MB" and ours would name different
//     numbers of bytes. And its unit strings are not separable from its number
//     formatting, so a locale that writes the unit before the number (there are
//     some) could not be expressed without the pattern being a string in a
//     catalogue. Which is what these are.
//
// The `{value}` in each byte pattern arrives already formatted -- the decimal
// separator is `Intl`'s, so a German reader sees `1,5 MB` -- which is why the
// patterns interpolate it plainly rather than through `{value, number}`.

export const format = {
  'format.justNow': 'just now',

  // A plain space, not a non-breaking one, and that is a deliberate hold
  // rather than an oversight. `28.8\u00a0MB` is the better typography -- the
  // number and its unit are one token to a reader and wrapping between them in
  // a narrow file list looks like a rendering bug -- but the English output of
  // `bytes()` is pinned by assertions in `src/test/lib.test.js` and
  // `src/test/hosting-marketplace.test.jsx`, and a whitespace change that
  // breaks five unrelated tests is a change that belongs in its own commit
  // rather than buried in the one that moved every string in the client. The
  // unit is now a catalogue pattern, which is the part that matters: a
  // translator who needs a non-breaking space, or the unit before the number,
  // can have either without touching a line of code.
  'format.bytes.b': '{value} B',
  'format.bytes.kb': '{value} KB',
  'format.bytes.mb': '{value} MB',
  'format.bytes.gb': '{value} GB',
  'format.bytes.tb': '{value} TB',
};
