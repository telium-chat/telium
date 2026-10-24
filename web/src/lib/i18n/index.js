// The one door into the translation layer; nothing outside `lib/i18n/` imports its internals.
// Plain function so non-React code can use it; components also need `useT()` to repaint on a locale change.

import { format, formatToParts } from './format.js';
import {
  byteParts, formatDate, formatDateTime, formatDateOrdered, formatDuration, formatList,
  formatNumber, formatRelative, formatTime, localeDateOrder, pluralCategory, pluralCategories,
} from './intl.js';
import {
  activate, activeDirection, activeLocale, applyDocument, deviceLanguages, directionOf,
  FALLBACK, listLanguages, LOCALES, localeOptions, localeVersion, onLocaleChange, resolveLocale,
} from './locale.js';
import {
  completeness, EN, hasMessage, isLoaded, loadCatalog, messageFor, registerCatalog,
} from './catalog/index.js';

export {
  activeLocale, activeDirection, deviceLanguages, directionOf, FALLBACK, listLanguages,
  LOCALES, localeOptions, localeVersion, onLocaleChange, resolveLocale,
  completeness, hasMessage, isLoaded, registerCatalog, pluralCategories, EN,
};

const STRONG_RTL = /[\u0590-\u05ff\u0600-\u07bf\u0800-\u085f\u08a0-\u08ff\ufb1d-\ufdff\ufe70-\ufeff]/;

const STRONG_LTR = /[A-Za-z\u00c0-\u02af\u0370-\u058f\u0900-\u109f\u1e00-\u1fff\u2c00-\u2dff\u2e80-\ua4cf\ua500-\uabff\uac00-\ud7ff\uf900-\ufaff]/;

/// The marks are real characters (visible to `String.length`, `===`, `document.title`), so isolate only when needed.
function isolate(locale, text) {
  if (!text) return text;
  const wrong = directionOf(locale) === 'rtl' ? STRONG_LTR : STRONG_RTL;
  if (!wrong.test(text)) return text;
  return `\u2068${text}\u2069`;
}

const services = new Map();

function servicesFor(locale) {
  let bundle = services.get(locale);
  if (!bundle) {
    bundle = {
      number: (value, style) => formatNumber(locale, value, style),
      plural: (value) => pluralCategory(locale, value),
      date: (value, style) => formatDate(locale, value, style),
      time: (value, style) => formatTime(locale, value, style),
      relative: (value) => relativeIn(locale, value),
      bytes: (value) => bytesIn(locale, value),
      dateTime: (value, style) => formatDateTime(locale, value, { date: style }),
      isolate: (text) => isolate(locale, text),
    };
    services.set(locale, bundle);
  }
  return bundle;
}

/// Recorded rather than thrown: a typo should not white-screen a user.
const missed = new Set();

export function missedKeys() { return [...missed]; }
export function clearMissedKeys() { missed.clear(); }

function humanise(key) {
  const last = String(key).split('.').pop() || '';
  const words = last.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1).toLowerCase() : '';
}

function patternFor(key) {
  const pattern = messageFor(activeLocale(), key);
  if (pattern !== null) return pattern;
  if (!missed.has(key)) {
    missed.add(key);
    console.error(`i18n: no message for "${key}" in any catalogue, including English.`);
  }
  return null;
}

/// The key must be a literal: an assembled key cannot be extracted or counted.
export function t(key, values) {
  const pattern = patternFor(key);
  if (pattern === null) return humanise(key);
  return format(pattern, values || {}, servicesFor(activeLocale()));
}

export function tParts(key, values) {
  const pattern = patternFor(key);
  if (pattern === null) return [{ type: 'text', value: humanise(key) }];
  return formatToParts(pattern, values || {}, servicesFor(activeLocale()));
}

/// Null for server-named things (error code, permission): a missing key is a newer server, not a bug.
export function tOrNull(key, values) {
  if (!hasMessage(key)) return null;
  return t(key, values);
}

export function formatPattern(pattern, values, locale = activeLocale()) {
  return format(pattern, values || {}, servicesFor(locale));
}

export function n(value, style) { return formatNumber(activeLocale(), value, style); }
export function date(at, style) { return formatDate(activeLocale(), at, style); }
export function time(at, style) { return formatTime(activeLocale(), at, style); }
export function dateTime(at, options) { return formatDateTime(activeLocale(), at, options); }

export function dateOrder(pref) {
  if (pref === 'mdy' || pref === 'dmy') return pref;
  return localeDateOrder(activeLocale());
}

export function dateOrdered(at, order, opts) {
  return formatDateOrdered(activeLocale(), at, dateOrder(order), opts);
}

export function dateTimeOrdered(at, order) {
  return formatDateOrdered(activeLocale(), at, dateOrder(order), { time: 'short' });
}
export function duration(seconds) { return formatDuration(activeLocale(), seconds); }
export function list(items, type) { return formatList(activeLocale(), items, type); }

function relativeIn(locale, at) {
  const formatted = formatRelative(locale, at);
  if (formatted !== null) return formatted;
  const pattern = messageFor(locale, 'format.justNow');
  return pattern === null ? '' : format(pattern, {}, servicesFor(locale));
}

export function relative(at) { return relativeIn(activeLocale(), at); }

function bytesIn(locale, value) {
  const { value: amount, unit } = byteParts(locale, value);
  const pattern = messageFor(locale, `format.bytes.${unit}`);
  if (pattern === null) return amount;
  return format(pattern, { value: amount }, servicesFor(locale));
}

export function bytes(value) { return bytesIn(activeLocale(), value); }

/// Takes the preference so 'auto' re-resolves; stays on the previous locale if a catalogue fails to load.
export function setLocale(preference) {
  return activate(preference, loadCatalog);
}

export function markDocument(preference) {
  const locale = resolveLocale(preference);
  applyDocument(locale);
  return locale;
}

export function translationStatus() {
  return LOCALES.filter((locale) => locale.tag !== FALLBACK).map((locale) => completeness(locale.tag));
}
