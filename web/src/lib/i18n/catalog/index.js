// Where the strings are, and what happens when one of them is not there.
//
// A catalogue is a flat object of dotted key to ICU pattern. Flat, not nested,
// and that is a decision rather than laziness: a nested catalogue has to be
// walked to answer "does this locale have `auth.login.title`", walked again to
// diff two locales, and walked a third time by every translation tool, and
// each walk is a place to disagree about whether `auth.login` holding a string
// *and* a `.title` child is legal. A flat map has one answer to every question
// anyone asks of it, and `Object.keys(en).length` is the size of the job.
//
// English is assembled from a file per namespace under `en/`, because English
// is the one catalogue people *edit* -- a developer adding a screen adds
// strings, and a thousand-line file that every branch touches is a thousand-
// line file that every branch conflicts in. Every other language is one file,
// because a translator takes the whole language at once and nobody merges two
// halves of a German translation.
//
// ---------------------------------------------------------------- fallback
//
// The rule, in one sentence: a key that the active locale does not have is
// answered in English, and a key that English does not have is a bug that must
// be visible in development and inert in production.
//
// The second half matters more than it looks. The failure mode this is written
// against is a screen that reads `auth.login.title` where a heading should be
// -- which is what every naive `t()` does, and which is worse than useless
// because it is unreportable: the person seeing it cannot tell whether the app
// is broken, whether their account is broken, or whether they have been
// phished. So a missing key renders as the last segment of the key in
// sentence case ("Title"), which is wrong but is *shaped like a word*, and it
// throws in development and in tests so it never reaches anybody.

import { EN } from './en/index.js';
import { LOCALES } from '../locale.js';

/// Loaded catalogues, by tag. English is here from the first tick because
/// everything else falls back to it; nothing may ever evict it.
const loaded = new Map([['en', EN]]);

/// Catalogues registered at runtime rather than imported.
///
/// Two callers, and both are the kind that would otherwise need a build step:
/// the pseudolocale generator, which derives a catalogue from English at run
/// time, and tests, which stand up a two-string locale to assert a fallback
/// without shipping a language to do it. Kept separate from `loaded` only in
/// intent -- it is the same map -- but named in this comment so nobody
/// mistakes a test fixture for a shipped translation.
export function registerCatalog(tag, messages) {
  loaded.set(tag, messages);
}

export function isLoaded(tag) {
  return loaded.has(tag);
}

/// Pulls a locale's chunk in. Idempotent, and concurrent calls share one
/// request -- the settings pane can fire this from a `<Select>` while the
/// boot path is already firing it from the stored preference, and two
/// `import()`s of the same specifier would be two parses of the same JSON-ish
/// object for no reason.
const inFlight = new Map();

export function loadCatalog(tag) {
  if (loaded.has(tag)) return Promise.resolve(loaded.get(tag));
  const existing = inFlight.get(tag);
  if (existing) return existing;
  const entry = LOCALES.find((locale) => locale.tag === tag);
  if (!entry?.load) return Promise.reject(new Error(`no catalogue for ${tag}`));
  const promise = entry.load().then((module) => {
    // Named `messages`, always. A default export would work equally well for
    // the bundler and would make the shape of a translation file a thing you
    // have to open the file to learn.
    const messages = module.messages || module.default;
    if (!messages || typeof messages !== 'object') {
      throw new Error(`the ${tag} catalogue exports no messages`);
    }
    loaded.set(tag, messages);
    inFlight.delete(tag);
    return messages;
  }).catch((e) => { inFlight.delete(tag); throw e; });
  inFlight.set(tag, promise);
  return promise;
}

/// The English catalogue, which is also the list of every key that exists.
///
/// Exported rather than kept private because two things outside this module
/// need the whole of it: the pseudolocale, which transforms every entry, and
/// the completeness check, which cannot know what is missing without knowing
/// what there is.
export { EN };

/// Whether a key is one this build knows about at all.
export function hasMessage(key) {
  return Object.hasOwn(EN, key);
}

/// The pattern for a key in a locale, falling back to English.
///
/// Returns `null` -- not a string -- when English does not have it either, so
/// the caller can tell "this locale has not been translated yet" (normal,
/// silent, English on screen) from "somebody typed a key that does not exist"
/// (a bug, loud). Collapsing those two into one return value is how a typo in
/// a key becomes indistinguishable from an untranslated string and therefore
/// never gets fixed.
export function messageFor(tag, key) {
  const catalog = loaded.get(tag);
  const hit = catalog ? catalog[key] : undefined;
  if (typeof hit === 'string') return hit;
  const fallback = EN[key];
  return typeof fallback === 'string' ? fallback : null;
}

/// How much of this language is done, as a fraction and as the missing keys.
///
/// This is the number the community translation workflow runs on. A locale is
/// shippable long before it is complete -- every gap renders in English, which
/// is a worse sentence and not a broken screen -- so the useful question is
/// never "is it finished" but "what is left", and `missing` answers that in
/// the form a translator can paste into a tool.
///
/// Counted against English rather than against a manifest, because English is
/// the manifest: a key exists exactly when somebody wrote it into `en/`.
export function completeness(tag) {
  const catalog = loaded.get(tag);
  const keys = Object.keys(EN);
  if (!catalog) return { tag, loaded: false, translated: 0, total: keys.length, missing: keys, extra: [] };
  const missing = keys.filter((key) => typeof catalog[key] !== 'string');
  // Keys the translation has that English does not. Almost always a typo or a
  // key that was renamed on the English side and left behind here, and either
  // way it is dead weight that a tool will happily keep asking translators to
  // maintain. Reported rather than ignored for exactly that reason.
  const extra = Object.keys(catalog).filter((key) => !Object.hasOwn(EN, key));
  return {
    tag,
    loaded: true,
    translated: keys.length - missing.length,
    total: keys.length,
    missing,
    extra,
  };
}
