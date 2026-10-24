// Locale preference, resolution and the active locale.
// English is bundled, others are dynamic imports; nothing switches until the catalogue lands, else English would flash.

import { formatList, languageName } from './intl.js';

export const LOCALES = [
  {
    tag: 'en',
    endonym: 'English',
    dir: 'ltr',
    load: null,
  },
  {
    tag: 'de',
    endonym: 'Deutsch',
    dir: 'ltr',
    load: () => import('./catalog/de.js'),
  },
  {
    tag: 'ja',
    endonym: '日本語',
    dir: 'ltr',
    load: () => import('./catalog/ja.js'),
  },
  {
    tag: 'ar',
    endonym: 'العربية',
    dir: 'rtl',
    load: () => import('./catalog/ar.js'),
  },
  {
    tag: 'fr',
    endonym: 'Français',
    dir: 'ltr',
    load: () => import('./catalog/fr.js'),
  },
  // Machine-assisted first pass no human has read, which is why none has an entry in `catalog/stamps.json`.
  {
    tag: 'es',
    endonym: 'Español',
    dir: 'ltr',
    load: () => import('./catalog/es.js'),
  },
  {
    tag: 'pt',
    endonym: 'Português',
    dir: 'ltr',
    load: () => import('./catalog/pt.js'),
  },
  {
    tag: 'zh-Hans',
    // The script is what a reader recognises; `zh` alone would be ambiguous.
    endonym: '简体中文',
    dir: 'ltr',
    load: () => import('./catalog/zh-Hans.js'),
  },
  {
    tag: 'ru',
    endonym: 'Русский',
    dir: 'ltr',
    load: () => import('./catalog/ru.js'),
  },
  {
    tag: 'ko',
    endonym: '한국어',
    dir: 'ltr',
    load: () => import('./catalog/ko.js'),
  },
];

export const FALLBACK = 'en';

const byTag = new Map(LOCALES.map((locale) => [locale.tag, locale]));

/// Run-time-only locales (pseudolocales, fixtures): must resolve but never appear in the language menu.
const runtimeLocales = new Map();

/// The catalogue is registered separately via `registerCatalog`, which depends on this module and not the reverse.
export function registerLocale(tag, { dir } = {}) {
  runtimeLocales.set(tag.toLowerCase(), { tag, endonym: tag, dir: dir || directionOf(tag), load: null });
  return tag;
}

function entryFor(tag) {
  return byTag.get(tag) || runtimeLocales.get(String(tag || '').toLowerCase());
}

/// Uses `Intl.Locale.getTextInfo` where available; the literal list is the fallback.
const RTL_LANGUAGES = new Set(['ar', 'arc', 'ckb', 'dv', 'fa', 'he', 'khw', 'ks', 'ps', 'sd', 'ug', 'ur', 'yi']);

export function directionOf(tag) {
  const known = byTag.get(tag) || runtimeLocales.get(String(tag || '').toLowerCase());
  if (known) return known.dir;
  try {
    const info = new Intl.Locale(tag).getTextInfo?.();
    if (info?.direction) return info.direction;
  } catch {}
  return RTL_LANGUAGES.has(String(tag).toLowerCase().split('-')[0]) ? 'rtl' : 'ltr';
}

/// BCP-47 lookup, truncating a subtag at a time.
function lookup(tag) {
  let candidate = String(tag || '').trim();
  if (!candidate) return null;
  // Browsers are inconsistent about case (`en-US`, seen as `en-us`).
  candidate = candidate.toLowerCase();
  for (;;) {
    const hit = LOCALES.find((locale) => locale.tag.toLowerCase() === candidate)
      || runtimeLocales.get(candidate);
    if (hit) return hit.tag;
    const cut = candidate.lastIndexOf('-');
    if (cut < 0) return null;
    candidate = candidate.slice(0, cut);
  }
}

export function deviceLanguages() {
  if (typeof navigator === 'undefined') return [FALLBACK];
  if (navigator.languages?.length) return [...navigator.languages];
  return navigator.language ? [navigator.language] : [FALLBACK];
}

export function resolveLocale(preference = 'auto') {
  if (preference && preference !== 'auto') {
    const chosen = lookup(preference);
    if (chosen) return chosen;
  }
  for (const candidate of deviceLanguages()) {
    const hit = lookup(candidate);
    if (hit) return hit;
  }
  return FALLBACK;
}

let active = FALLBACK;
let activeDir = 'ltr';
const listeners = new Set();

export function activeLocale() { return active; }
export function activeDirection() { return activeDir; }

export function onLocaleChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/// A counter, not the tag, so reloading the same locale's catalogue (HMR) also repaints.
let version = 0;
export function localeVersion() { return version; }

function notify() {
  version += 1;
  for (const fn of [...listeners]) {
    try { fn(active); } catch (e) { console.error('locale listener failed', e); }
  }
}

export function applyDocument(locale) {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = locale;
  document.documentElement.dir = directionOf(locale);
}

/// `load` is injected so the catalogue registry can depend on this module; a failed load keeps the previous language.
export async function activate(preference, load) {
  const next = resolveLocale(preference);
  if (next === active && version > 0) return active;
  if (next !== FALLBACK) {
    try {
      await load(next);
    } catch (e) {
      console.error(`Telium could not load the ${next} translation; staying in ${active}.`, e);
      return active;
    }
  }
  active = next;
  activeDir = directionOf(next);
  applyDocument(next);
  notify();
  return active;
}

export function localeOptions(autoLabel) {
  return [
    ['auto', autoLabel],
    ...LOCALES.map((locale) => [locale.tag, locale.endonym || languageName(locale.tag)]),
  ];
}

export function listLanguages(tags, locale = active) {
  return formatList(locale, tags.map((tag) => entryFor(tag)?.endonym || languageName(tag)));
}
