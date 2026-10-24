// What is left to translate, per language, printed.
//
// The community workflow described in `docs/translating.md` rests on three
// answers: how much of a language is done, which keys are not done, and which
// of the done ones were translated against an English sentence that has since
// been reworded. The first two are computed from the catalogues themselves and
// are never recorded anywhere, because a recorded number is a number that is
// wrong the moment somebody adds a string -- and adding strings is what every
// branch that touches the UI does. The third cannot be computed, because the
// information it needs (what the English used to say when the translation was
// written) is genuinely not in the tree unless somebody puts it there; that is
// what `catalog/stamps.json` and `--accept` below are for.
//
// Run it with `node scripts/i18n-status.mjs` from `web/`. No dependencies, no
// build step, no dev server: it imports the catalogues the same way the app
// does and diffs them against English. A translator who has never run this
// repository's test suite can still run this, and that is a requirement rather
// than a nicety -- a workflow whose first step is "install the toolchain" is a
// workflow that filters for contributors instead of for translators.
//
// ------------------------------------------------------------------ the flags
//
// (no flags)   the fraction per language, and the per-namespace breakdown,
//              which is the unit somebody actually sits down and translates.
// --missing    every untranslated key, grouped by namespace.
// --stale      every translated key whose English has changed since it was
//              last accepted, and every translated key nobody has ever
//              accepted (reported separately -- see below).
// --accept TAG record current English for everything TAG translates. A claim,
//              not a formality; read the long note above `accept()`.
// --ns NAME    with --accept, stamp only that namespace and leave the rest of
//              the language's stamps exactly as they were. The unit a person
//              actually reads in one sitting is a namespace, not a language.
// --strict     exit non-zero when a language has keys English does not.
// --only TAG   restrict the report to one language.
//
// ---------------------------------------------------------------- --strict
//
// `--strict` makes it exit non-zero when a language has keys English does not.
// Deliberately *only* that, and not incompleteness, and not staleness: a
// partial translation is the normal, shippable state of every language here
// and a CI job that failed on it would be a CI job that failed forever. A
// stale key is a real defect but it renders a fluent sentence that is merely
// out of date, which is a thing to fix in the next pass and not a thing to
// stop a release for. A key English does not have is a different matter -- a
// typo, or a key renamed on the English side and left behind -- and it is dead
// weight a tool will keep asking translators to maintain until somebody
// notices.
//
// `src/test/i18n-coverage.test.js` asserts the same thing inside the test
// suite, which is where it actually gates a merge. This flag exists so the
// answer is available to anybody who has not got a test runner in front of
// them.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EN } from '../src/lib/i18n/catalog/en/index.js';
import { LOCALES } from '../src/lib/i18n/locale.js';

/// Where the acceptance stamps live, resolved defensively.
///
/// Run from a shell -- which is the only way the CLI below is ever used --
/// `import.meta.url` is a `file:` URL, and deriving the path from it rather
/// than from the working directory means `node web/scripts/i18n-status.mjs`
/// works from anywhere in the tree, which matters because a translator has no
/// reason to know that `web/` is special.
///
/// The two contortions are both deliberate. The URL is read into `HERE` first
/// because Vite pattern-matches the literal expression
/// `new URL('...', import.meta.url)` and rewrites it into a *served asset*
/// URL -- and this module is imported by `src/test/i18n-stamps.test.js`, so
/// that the test and the script cannot drift apart on what a fingerprint is.
/// Through a variable the pattern does not match and the value survives. And
/// the scheme is still checked, because a bundler is entitled to hand back
/// something that is not a disk path at all; the working directory is the
/// right answer in that case, since the suite always runs with `web/` as its
/// cwd -- the same assumption every filesystem-reading test in `src/test`
/// already makes.
const HERE = import.meta.url;
const STAMPS = HERE.startsWith('file:')
  ? join(dirname(fileURLToPath(HERE)), '..', 'src', 'lib', 'i18n', 'catalog', 'stamps.json')
  : join(process.cwd(), 'src', 'lib', 'i18n', 'catalog', 'stamps.json');

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const value = (flag) => {
  const at = argv.indexOf(flag);
  return at === -1 ? null : argv[at + 1] || null;
};

const strict = has('--strict');
const verbose = has('--missing');
const wantStale = has('--stale');
const accepting = has('--accept') ? value('--accept') : null;
// Restricts `--accept` to one namespace. See the note above `accept()`: a
// person accepts what they have read, and what they have read is `voice.*`,
// not "German".
const acceptNs = value('--ns');
const only = value('--only');

/// A short, stable fingerprint of an English pattern.
///
/// FNV-1a, thirty-two bits, eight hex characters, written out here rather than
/// imported from `node:crypto` for one reason: this file is the one piece of
/// the workflow a translator runs, and the stamps it writes are read back by a
/// browser test. Keeping the hash to twelve lines of arithmetic means the same
/// function can run in both places without a polyfill argument, and means the
/// committed `stamps.json` is reproducible by anybody with any JavaScript.
///
/// Thirty-two bits is plenty. A collision would cause one reworded English
/// sentence to go unflagged in one language -- the same outcome as not having
/// this mechanism at all, for one key, which is the failure mode it is safe to
/// have. It is not a security primitive and nothing downstream treats it as
/// one.
export function fingerprint(pattern) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < pattern.length; i += 1) {
    hash ^= pattern.charCodeAt(i);
    // The FNV prime, multiplied in 16-bit halves because `*` on a value this
    // size silently goes through a double and loses the low bits.
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function readStamps() {
  try {
    const parsed = JSON.parse(readFileSync(STAMPS, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    // A missing or unreadable stamp file is not an error. It means nothing has
    // been accepted yet, which is the state every language starts in and the
    // state a fresh clone of a fork may well be in.
    return {};
  }
}

/// Load a language's catalogue the way the app does.
///
/// `messages`, always -- `loadCatalog` in `catalog/index.js` reads
/// `module.messages || module.default` and `i18n-coverage.test.js` reads
/// `.messages`, so a file that exports its catalogue under any other name is a
/// language that reports fine here and throws in the browser.
///
/// That is a real trap and it is why this does not just take the first object
/// it finds. A translator's first patch is a new file copied from an existing
/// one and renamed, and the rename that matters is the *file*, not the export;
/// a tool that silently accepted `export const fr = {...}` would hand somebody
/// a green report and a broken build. So the wrong name is reported as the
/// error it is, by name, with the fix in the sentence.
async function catalogFor(locale) {
  const module = await locale.load();
  if (module.messages && typeof module.messages === 'object') return module.messages;
  const other = Object.entries(module).find(([, v]) => v && typeof v === 'object');
  if (other) {
    console.log(`  ! ${locale.tag} exports its catalogue as \`${other[0]}\`, not \`messages\`.`);
    console.log(`    The app loads \`messages\`; rename the export or this language will not load.`);
    return other[1];
  }
  return null;
}

const keys = Object.keys(EN).sort();
const namespaces = [...new Set(keys.map((key) => key.split('.')[0]))].sort();
const stamps = readStamps();
let failed = false;

// -------------------------------------------------------------------- --accept
//
// Recording the English a translation was made against.
//
// This is the only part of the workflow that writes anything down, and it is
// written down because it cannot be derived: once an English sentence is
// reworded, the tree no longer contains what it used to say, so nothing can
// tell whether the German next to it was written against the old wording or
// the new one. Git knows, in principle, but "in principle" means walking the
// history of two files and correlating two independent edit streams per key,
// which is slow, fragile across rebases, and impossible on a shallow clone --
// and a translator working from a ZIP of the repository has no history at all.
//
// So: one stamp per language per key, holding the fingerprint of the English
// that the translator saw. `--stale` diffs it against today's English.
//
// Per language rather than one shared map of English fingerprints, which is
// the cheaper design and the wrong one: a single map records "English changed
// since somebody last regenerated this file", which is true of every key after
// any UI branch lands and says nothing about whether any particular
// translation is behind. The question a translator asks is "what do *I* have
// to look at", and that question has a different answer per language.
//
// Running `--accept de` is a *claim*: it says a human has looked at every key
// German translates and is happy with it against the English as it stands
// today. It is not a formality to clear a warning. Accepting a language you
// have not read replaces a list of things to check with silence, which is
// strictly worse than the warning it removed.
//
// Which is exactly why `--accept de --ns voice` exists. A language is not the
// unit anybody reads: 670 German keys is a week, and a flag whose only setting
// is "all of it" pushes an honest person towards either never accepting
// anything or accepting more than they read. A namespace is one sitting. With
// `--ns`, every stamp outside that namespace is carried through untouched --
// not re-stamped, not dropped -- so accepting `voice` says nothing at all
// about `auth`, and `--stale` keeps reporting `auth` as *unknown*, which is
// what it honestly is. Without `--ns` the behaviour is unchanged and the whole
// language is replaced, dead stamps and all.
async function accept(tag) {
  const locale = LOCALES.find((l) => l.tag === tag);
  if (!locale || !locale.load) {
    console.error(`--accept: ${tag} is not a translated language in LOCALES.`);
    process.exit(1);
  }
  const catalog = await catalogFor(locale);
  if (!catalog) {
    console.error(`--accept: ${tag} exports no catalogue object.`);
    process.exit(1);
  }

  if (acceptNs && !keys.some((key) => key.startsWith(`${acceptNs}.`))) {
    console.error(`--ns: "${acceptNs}" is not a namespace English has.`);
    process.exit(1);
  }
  const inScope = (key) => !acceptNs || key.startsWith(`${acceptNs}.`);

  const before = stamps[tag] || {};
  // Stamps outside the accepted namespace are carried through verbatim. They
  // are somebody else's claim about a different sitting and this run has no
  // opinion on them; rewriting them here would be forging a signature.
  const after = acceptNs
    ? Object.fromEntries(Object.entries(before).filter(([key]) => !inScope(key)))
    : {};
  const carried = Object.keys(after).length;
  let added = 0;
  let refreshed = 0;
  for (const key of keys) {
    if (!inScope(key)) continue;
    if (typeof catalog[key] !== 'string') continue;
    const mark = fingerprint(EN[key]);
    if (!Object.hasOwn(before, key)) added += 1;
    else if (before[key] !== mark) refreshed += 1;
    after[key] = mark;
  }
  // Stamps for keys the language no longer translates, and for keys English no
  // longer has, are dropped rather than carried: a stamp with nothing on
  // either side of it is a line a future reader has to work out the meaning
  // of, and the answer is always "nothing".
  const dropped = Object.keys(before).filter((key) => !Object.hasOwn(after, key)).length;

  const next = { ...stamps, [tag]: after };
  const ordered = {};
  for (const t of Object.keys(next).sort()) {
    ordered[t] = Object.fromEntries(Object.keys(next[t]).sort().map((k) => [k, next[t][k]]));
  }
  writeFileSync(STAMPS, `${JSON.stringify(ordered, null, 2)}\n`);

  const scope = acceptNs ? `${tag} ${acceptNs}.*` : tag;
  console.log(`Accepted ${scope}: ${Object.keys(after).length - carried} keys stamped against today's English.`);
  console.log(`  ${added} newly stamped, ${refreshed} re-accepted after an English change, ${dropped} dropped.`);
  if (carried) console.log(`  ${carried} stamp(s) outside ${acceptNs}.* left exactly as they were.`);
  console.log(`\nWritten to src/lib/i18n/catalog/stamps.json. Commit it with the translation.`);
}

if (accepting) {
  await accept(accepting);
  process.exit(0);
}

// ---------------------------------------------------------------- the report

console.log(`English: ${keys.length} keys in ${namespaces.length} namespaces.\n`);

const summary = [];

for (const locale of LOCALES) {
  // English is the manifest, not a translation of itself.
  if (!locale.load) continue;
  if (only && locale.tag !== only) continue;

  const catalog = await catalogFor(locale);
  if (!catalog) {
    console.log(`${locale.tag}: no catalogue object exported from its chunk.`);
    failed = true;
    continue;
  }

  const missing = keys.filter((key) => typeof catalog[key] !== 'string');
  const extra = Object.keys(catalog).filter((key) => !Object.hasOwn(EN, key));
  const done = keys.length - missing.length;
  const percent = (done / keys.length) * 100;
  summary.push({ tag: locale.tag, endonym: locale.endonym, done, percent });

  console.log(`${locale.tag} (${locale.endonym}, ${locale.dir}): ${done}/${keys.length} — ${percent.toFixed(1)}%  ${bar(percent)}`);

  // The per-namespace breakdown, printed by default rather than behind a flag.
  //
  // "You are 21% done" tells a translator nothing they can act on. "errors is
  // 4/61 and it is the namespace people read when something has gone wrong"
  // tells them what to do this evening. A namespace is the unit somebody
  // finishes in one sitting; a flat list of keys in key order is a list nobody
  // finishes at all.
  for (const ns of namespaces) {
    const inNs = keys.filter((key) => key.startsWith(`${ns}.`));
    const hit = inNs.filter((key) => typeof catalog[key] === 'string').length;
    if (!inNs.length) continue;
    const pad = ' '.repeat(Math.max(0, 14 - ns.length));
    const mark = hit === inNs.length ? '✓' : ' ';
    console.log(`  ${mark} ${ns}${pad}${String(hit).padStart(4)}/${String(inNs.length).padEnd(4)} ${bar((hit / inNs.length) * 100, 20)}`);
  }

  if (extra.length) {
    failed = true;
    console.log(`\n  ${extra.length} key(s) English does not have:`);
    for (const key of extra) console.log(`    ${key}`);
  }

  if (verbose && missing.length) {
    console.log(`\n  ${missing.length} still in English:`);
    // Grouped by namespace, which is the unit a person actually sits down and
    // translates: "the whole of `migration`" is a session, "three hundred keys
    // in key order" is a list nobody finishes.
    const byNamespace = new Map();
    for (const key of missing) {
      const ns = key.split('.')[0];
      if (!byNamespace.has(ns)) byNamespace.set(ns, []);
      byNamespace.get(ns).push(key);
    }
    for (const [ns, group] of [...byNamespace].sort()) {
      console.log(`    ${ns} (${group.length})`);
      for (const key of group) console.log(`      ${key}`);
    }
  } else if (missing.length) {
    console.log(`\n  ${missing.length} still in English. Pass --missing to list them.`);
  }

  if (wantStale) {
    const mine = stamps[locale.tag] || {};
    const translated = keys.filter((key) => typeof catalog[key] === 'string');
    const stale = translated.filter((key) => Object.hasOwn(mine, key) && mine[key] !== fingerprint(EN[key]));
    const unstamped = translated.filter((key) => !Object.hasOwn(mine, key));

    if (stale.length) {
      console.log(`\n  ${stale.length} translated against English that has since changed:`);
      // Both sides printed, because the useful question is never "is this
      // stale" but "is this still right". Plenty of English rewordings are
      // punctuation, and a translator who can see both can close half of these
      // without opening an editor.
      for (const key of stale) {
        console.log(`    ${key}`);
        console.log(`      English now: ${EN[key]}`);
        console.log(`      ${locale.tag} has:    ${catalog[key]}`);
      }
    } else {
      console.log(`\n  Nothing stale: every stamped key matches today's English.`);
    }

    // Reported apart from staleness, and the distinction is the honest one. A
    // key nobody ever accepted is not known to be wrong; it is unknown. Folding
    // the two together would either invent a defect that may not exist or hide
    // one that does, and a translator deciding where to spend an hour needs to
    // know which pile a key is in.
    if (unstamped.length) {
      console.log(`  ${unstamped.length} translated but never accepted (unknown, not stale). Run --accept ${locale.tag} once you have read them.`);
    }
  }

  console.log('');
}

if (summary.length > 1) {
  console.log('Summary');
  for (const row of summary.sort((a, b) => b.percent - a.percent)) {
    // The endonym goes last and is not padded. A column of names written in
    // Japanese, Arabic and Latin cannot be aligned by counting characters --
    // the glyphs are different widths and `padEnd` counts code units -- so the
    // numbers are aligned and the names simply follow.
    console.log(`  ${row.tag.padEnd(4)} ${String(row.done).padStart(4)}/${keys.length}  ${row.percent.toFixed(1).padStart(5)}%  ${row.endonym}`);
  }
  // Said out loud on every run, because it is the thing a newcomer gets wrong.
  // Every number above is a shippable state; none of them is a failing grade.
  console.log('\nEvery language above ships as it is. A key no catalogue has renders in English.');
}

/// A fixed-width bar, because a column of percentages is a column nobody reads.
function bar(percent, width = 28) {
  const filled = Math.round((percent / 100) * width);
  return `${'█'.repeat(filled)}${'·'.repeat(Math.max(0, width - filled))}`;
}

if (strict && failed) process.exit(1);
