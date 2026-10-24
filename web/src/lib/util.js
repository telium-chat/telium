
import { RICH_ACTIVITY_PREFIX, richActivityOf } from './activity.js';
import { EMOJI_RE, isPictorial } from './emoji.js';
import {
  t, date as fmtDate, time as fmtTime, relative as fmtRelative, bytes as fmtBytes,
} from './i18n/index.js';

export function shortName(userId) {
  const m = /^@([^:]+):(.+)$/.exec(userId || '');
  return m ? m[1] : userId || '';
}

const GONE = new Set(['left', 'removed']);

export function participants(convo) {
  return (convo?.members || []).filter((m) => !GONE.has(m?.state));
}

export function conversationName(convo, me) {
  if (!convo) return '';
  const others = participants(convo).filter((m) => m.user_id !== me);
  // Plural rules live in the catalogue, see `common.convo.group`.
  if (convo.kind === 'gc') return t('common.convo.group', { count: others.length + 1 });
  return shortName(others[0]?.user_id || '');
}

/// `kind` is a CSS class and glyph key (stays English); `verb` is spoken text, hence the getter.
const ACTIVITY_KINDS = {
  0: { kind: 'playing', get verb() { return t('common.activity.playing'); } },
  1: { kind: 'streaming', get verb() { return t('common.activity.streaming'); } },
  2: { kind: 'listening', get verb() { return t('common.activity.listening'); } },
  3: { kind: 'watching', get verb() { return t('common.activity.watching'); } },
  5: { kind: 'competing', get verb() { return t('common.activity.competing'); } },
};

export function activityKind(type) {
  return ACTIVITY_KINDS[type] || ACTIVITY_KINDS[0];
}

export function activityStatus(presence) {
  const rich = richActivityOf(presence);
  const raw = typeof presence?.activity === 'string' ? presence.activity.trim() : '';
  const legacy = raw && !raw.startsWith(RICH_ACTIVITY_PREFIX)
    ? [...raw].slice(0, 128).join('')
    : '';
  const name = rich?.name || legacy;
  if (!name) return null;
  return { ...activityKind(rich?.type), name };
}

export function activityLine(presence) {
  const status = activityStatus(presence);
  // Catalogue-joined so languages can reorder `{verb}` and `{name}`.
  return status ? t('common.activity.line', { verb: status.verb, name: status.name }) : '';
}

export function statusLine(presence) {
  return presence?.custom_status || activityLine(presence);
}

const LEADING_CUSTOM = /^<[a-zA-Z0-9_.-]{1,32}:[A-Z0-9]{26}(?:@[a-zA-Z0-9.-]+)?>/;

export function splitStatus(line) {
  const text = String(line || '').trim();
  if (!text) return { emoji: '', text: '' };
  const custom = LEADING_CUSTOM.exec(text);
  if (custom) return { emoji: custom[0], text: text.slice(custom[0].length).trim() };
  EMOJI_RE.lastIndex = 0;
  const m = EMOJI_RE.exec(text);
  if (m && m.index === 0 && isPictorial(m[0])) {
    return { emoji: m[0], text: text.slice(m[0].length).trim() };
  }
  return { emoji: '', text };
}

export function domainOf(userId) {
  const m = /^@([^:]+):(.+)$/.exec(userId || '');
  return m ? m[2] : '';
}

export function timeOf(ms) {
  return fmtTime(ms, 'short');
}

export function dayOf(ms) {
  return fmtDate(ms, 'medium');
}

const DAY_MS = 24 * 60 * 60 * 1000;

/// Compares local calendar days, not 24-hour differences, which drift across DST.
export function beforeToday(ms, now = Date.now()) {
  return dayNumber(now) - dayNumber(ms) >= 1;
}

function dayNumber(ms) {
  const at = new Date(ms);
  return Date.UTC(at.getFullYear(), at.getMonth(), at.getDate()) / DAY_MS;
}

/// `fmtRelative` returns null inside its "just now" window.
export function relative(ms) {
  return fmtRelative(ms) ?? t('format.justNow');
}

export function bytes(n) {
  return fmtBytes(n);
}

export function tint(seed) {
  let hash = 0;
  for (let i = 0; i < (seed || '').length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  return `hsl(${Math.abs(hash) % 360} 45% 55%)`;
}

export const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

export function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

export function classes(...parts) {
  return parts.filter(Boolean).join(' ');
}

export function b64(bytes) {
  let binary = '';
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function unb64(s) {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

export function b64url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export class Emitter {
  constructor() { this.handlers = new Map(); }

  on(event, fn) {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event).add(fn);
    return () => this.handlers.get(event)?.delete(fn);
  }

  emit(event, payload) {
    for (const fn of [...(this.handlers.get(event) || [])]) {
      try { fn(payload); } catch (e) { console.error('handler failed', event, e); }
    }
    for (const fn of [...(this.handlers.get('*') || [])]) {
      try { fn(event, payload); } catch (e) { console.error('handler failed', event, e); }
    }
  }
}

export const storage = {
  get(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
    catch { return fallback; }
  },
  set(key, value) { localStorage.setItem(key, JSON.stringify(value)); },
  remove(key) { localStorage.removeItem(key); },
};

export function colourOf(value) {
  const n = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(n) || n <= 0) return null;
  return `#${(n & 0xffffff).toString(16).padStart(6, '0')}`;
}

export function themeOf(value) {
  if (!Array.isArray(value) || value.length !== 2) return null;
  if (!value.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffffff)) return null;
  return value.map((n) => `#${n.toString(16).padStart(6, '0')}`);
}

export function colourToInt(css) {
  const m = /^#?([0-9a-fA-F]{6})$/.exec((css || '').trim());
  return m ? parseInt(m[1], 16) : 0;
}
