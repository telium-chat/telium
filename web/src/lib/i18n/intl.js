// Locale-bound number, date, duration and size formatting.

const caches = new Map();

function memo(kind, locale, options, build) {
  let cache = caches.get(kind);
  if (!cache) { cache = new Map(); caches.set(kind, cache); }
  const key = `${locale}|${JSON.stringify(options)}`;
  let hit = cache.get(key);
  if (hit === undefined) {
    // A malformed tag (e.g. from an older client's synced preference) throws RangeError; fall back to the browser default.
    try { hit = build(locale, options); } catch { hit = build(undefined, options); }
    cache.set(key, hit);
  }
  return hit;
}

const NUMBER_STYLES = {
  plain: {},
  integer: { maximumFractionDigits: 0 },
  compact: { notation: 'compact', compactDisplay: 'short', maximumFractionDigits: 1 },
  percent: { style: 'percent', maximumFractionDigits: 0 },
  fixed1: { minimumFractionDigits: 1, maximumFractionDigits: 1 },
  fixed3: { minimumFractionDigits: 3, maximumFractionDigits: 3 },
};

export function formatNumber(locale, value, style = 'plain') {
  const options = NUMBER_STYLES[style] || NUMBER_STYLES.plain;
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  return memo('number', locale, options, (l, o) => new Intl.NumberFormat(l, o)).format(n);
}

export function pluralCategory(locale, value) {
  return memo('plural', locale, { type: 'cardinal' }, (l, o) => new Intl.PluralRules(l, o))
    .select(Number(value) || 0);
}

export function pluralCategories(locale) {
  return memo('plural', locale, { type: 'cardinal' }, (l, o) => new Intl.PluralRules(l, o))
    .resolvedOptions().pluralCategories;
}

const DATE_STYLES = {
  medium: { year: 'numeric', month: 'short', day: 'numeric' },
  short: { year: 'numeric', month: 'numeric', day: 'numeric' },
  long: { year: 'numeric', month: 'long', day: 'numeric' },
  full: { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' },
  dayMonth: { month: 'short', day: 'numeric' },
};

const TIME_STYLES = {
  /// Not `hour12: false`: 14:30 vs 2:30 PM is the locale's business.
  short: { hour: 'numeric', minute: '2-digit' },
  withSeconds: { hour: 'numeric', minute: '2-digit', second: '2-digit' },
};

export function formatDate(locale, at, style = 'medium') {
  const date = asDate(at);
  if (!date) return '';
  const options = DATE_STYLES[style] || DATE_STYLES.medium;
  return memo('date', locale, options, (l, o) => new Intl.DateTimeFormat(l, o)).format(date);
}

function dateFormatter(locale, options) {
  return memo('date', locale, options, (l, o) => new Intl.DateTimeFormat(l, o));
}

export function localeDateOrder(locale) {
  const parts = dateFormatter(locale, { year: '2-digit', month: 'numeric', day: 'numeric' })
    .formatToParts(new Date(2026, 8, 27));
  return parts.find((part) => part.type === 'day' || part.type === 'month')?.type === 'day'
    ? 'dmy'
    : 'mdy';
}

export function formatDateOrdered(locale, at, order, { year = true, time } = {}) {
  const value = asDate(at);
  if (!value) return '';
  const options = {
    month: 'numeric',
    day: 'numeric',
    ...(year ? { year: '2-digit' } : {}),
    ...(time ? TIME_STYLES[time] : {}),
  };
  const formatter = dateFormatter(locale, options);
  const parts = formatter.formatToParts(value);
  const values = {};
  const slots = [];
  parts.forEach((part, index) => {
    if (part.type === 'day' || part.type === 'month' || part.type === 'year') {
      values[part.type] = part.value;
      slots.push(index);
    }
  });
  const sequence = (order === 'mdy' ? ['month', 'day', 'year'] : ['day', 'month', 'year'])
    .filter((type) => values[type] !== undefined);
  if (!slots.length || sequence.length !== slots.length) return formatter.format(value);
  sequence.forEach((type, slot) => {
    parts[slots[slot]] = { ...parts[slots[slot]], value: values[type] };
  });
  return parts.map((part) => part.value).join('');
}

export function formatTime(locale, at, style = 'short') {
  const date = asDate(at);
  if (!date) return '';
  const options = TIME_STYLES[style] || TIME_STYLES.short;
  return memo('date', locale, options, (l, o) => new Intl.DateTimeFormat(l, o)).format(date);
}

export function formatDateTime(locale, at, { date = 'medium', time = 'short' } = {}) {
  const value = asDate(at);
  if (!value) return '';
  const options = {
    ...(DATE_STYLES[date] || DATE_STYLES.medium),
    ...(TIME_STYLES[time] || TIME_STYLES.short),
  };
  return memo('date', locale, options, (l, o) => new Intl.DateTimeFormat(l, o)).format(value);
}

function asDate(at) {
  if (at === null || at === undefined || at === '') return null;
  const date = at instanceof Date ? at : new Date(typeof at === 'string' ? at : Number(at));
  return Number.isNaN(date.getTime()) ? null : date;
}

/// Weeks are absent on purpose: "3 weeks ago" and "last month" describe the same instant.
const UNITS = [
  ['year', 365 * 24 * 3600_000],
  ['month', 30 * 24 * 3600_000],
  ['day', 24 * 3600_000],
  ['hour', 3600_000],
  ['minute', 60_000],
];

/// Forty-five seconds, matching CLDR's rounding: at 50 seconds `Intl` already says "1 minute ago".
const JUST_NOW_MS = 45_000;

export function formatRelative(locale, at, { now = Date.now(), style = 'narrow' } = {}) {
  const date = asDate(at);
  if (!date) return '';
  const delta = date.getTime() - now;
  if (Math.abs(delta) < JUST_NOW_MS) return null;
  const options = { numeric: 'auto', style };
  const formatter = memo('relative', locale, options, (l, o) => new Intl.RelativeTimeFormat(l, o));
  for (const [unit, size] of UNITS) {
    if (Math.abs(delta) >= size) {
      // Truncated, not rounded: rounding up can put a timestamp in the future.
      return formatter.format(Math.trunc(delta / size), unit);
    }
  }
  return formatter.format(Math.trunc(delta / 1000), 'second');
}

/// 1024 not 1000: changing it would restate every file size, upload limit and quota.
const KIB = 1024;

export function byteParts(locale, n) {
  const value = Number(n) || 0;
  if (value < KIB) return { value: formatNumber(locale, Math.round(value), 'integer'), unit: 'b' };
  for (const [unit, power] of [['kb', 1], ['mb', 2], ['gb', 3]]) {
    if (value < KIB ** (power + 1)) {
      return { value: formatNumber(locale, value / KIB ** power, 'fixed1'), unit };
    }
  }
  return { value: formatNumber(locale, value / KIB ** 4, 'fixed1'), unit: 'tb' };
}

/// Not `Intl.DurationFormat`: missing in Firefox.
export function formatDuration(locale, seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const pad = (n) => memo(
    'number',
    locale,
    { minimumIntegerDigits: 2, useGrouping: false },
    (l, o) => new Intl.NumberFormat(l, o),
  ).format(n);
  const lead = formatNumber(locale, hours || minutes, 'integer');
  return hours ? `${lead}:${pad(minutes)}:${pad(secs)}` : `${lead}:${pad(secs)}`;
}

export function formatList(locale, items, type = 'conjunction') {
  const parts = (items || []).map((item) => String(item)).filter(Boolean);
  if (parts.length === 0) return '';
  const options = { style: 'long', type };
  return memo('list', locale, options, (l, o) => new Intl.ListFormat(l, o)).format(parts);
}

export function languageName(tag) {
  try {
    return new Intl.DisplayNames([tag], { type: 'language' }).of(tag) || tag;
  } catch { return tag; }
}
