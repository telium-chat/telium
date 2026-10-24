// Twemoji images and a lazy picker catalogue. `twemoji.parse()` is avoided: it returns HTML.

import { KEYS } from './sync.js';
import { previewSpans } from './markdown-preview.js';

const CDN = 'https://cdn.jsdelivr.net/gh/jdecked/twemoji@15.1.0/assets/svg';

const ZWJ = 0x200d;
const VS16 = 0xfe0f;

/// Twemoji file names: lowercase hex joined by hyphens, variation selector dropped outside ZWJ sequences.
export function toCodePoints(seq) {
  const points = Array.from(seq, (c) => c.codePointAt(0));
  const joined = points.includes(ZWJ);
  return points
    .filter((p) => joined || p !== VS16)
    .map((p) => p.toString(16))
    .join('-');
}

export function emojiUrl(seq) {
  return `${CDN}/${toCodePoints(seq)}.svg`;
}

const KEYCAP = '[0-9#*]\\uFE0F?\\u20E3';
const FLAG = '\\p{RI}\\p{RI}';
const ATOM = '\\p{Extended_Pictographic}[\\u{1F3FB}-\\u{1F3FF}]?\\uFE0F?';
const SEQUENCE = `${ATOM}(?:\\u200D${ATOM})*`;

export const EMOJI_RE = new RegExp(`${KEYCAP}|${FLAG}|${SEQUENCE}`, 'gu');

// `Extended_Pictographic` also matches (c), arrows etc; require `Emoji_Presentation` or a variation selector.
const PICTURE_BY_DEFAULT = /^\p{Emoji_Presentation}/u;

export function isPictorial(seq) {
  if (seq.includes('\uFE0F') || seq.includes('\u20E3')) return true;
  if (/^\p{RI}/u.test(seq)) return true;
  return PICTURE_BY_DEFAULT.test(seq);
}

export function splitEmoji(text) {
  const parts = [];
  let last = 0;
  let m;
  EMOJI_RE.lastIndex = 0;
  while ((m = EMOJI_RE.exec(text))) {
    if (!isPictorial(m[0])) continue;
    if (m.index > last) parts.push({ text: text.slice(last, m.index) });
    parts.push({ emoji: m[0] });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}

// Wire form: `<name:ULID>` or `<name:ULID@origin>`.
export const CUSTOM_EMOJI = '<[a-zA-Z0-9_.-]{1,32}:[A-Z0-9]{26}(?:@[a-zA-Z0-9.-]+)?>';

/// Fresh global matcher; a shared `/g` regex leaks `lastIndex`.
export const customEmojiRe = () => new RegExp(CUSTOM_EMOJI, 'g');

/// Cut where the renderer still recognises tokens; unicode first, since moving left can land inside a token.
export function clipContent(text, max) {
  const s = typeof text === 'string' ? text : '';
  if (s.length <= max) return s;
  let cut = max;
  // A copy: `matchAll` starts from the shared matcher's `lastIndex`.
  for (const m of s.matchAll(new RegExp(EMOJI_RE))) {
    if (m.index >= cut) break;
    if (m.index + m[0].length > cut) { cut = m.index; break; }
  }
  for (const m of s.matchAll(customEmojiRe())) {
    if (m.index >= cut) break;
    if (m.index + m[0].length > cut) { cut = m.index; break; }
  }
  // An astral non-emoji character is two code units; half is tofu.
  const tail = s.charCodeAt(cut);
  if (cut > 0 && tail >= 0xDC00 && tail <= 0xDFFF) cut -= 1;
  return s.slice(0, cut);
}

/// Custom emoji become `:name:` since they have no character.
export function toPlainText(wire) {
  const text = typeof wire === 'string' ? wire : '';
  if (!text.includes('<')) return text;
  return text.replace(customEmojiRe(), (token) => {
    const custom = parseCustomEmoji(token);
    return custom ? `:${custom.name}:` : token;
  });
}

const JUMBO_MAX = 6;

export function isJumbo(text) {
  const trimmed = text.trim();
  if (!trimmed) return false;

  // Custom ones first; `EMOJI_RE` would otherwise match inside a token.
  let count = 0;
  let rest = '';
  let last = 0;
  const re = customEmojiRe();
  let m;
  while ((m = re.exec(trimmed))) {
    count += 1;
    rest += trimmed.slice(last, m.index);
    last = m.index + m[0].length;
  }
  rest += trimmed.slice(last);

  const parts = splitEmoji(rest);
  count += parts.filter((p) => p.emoji).length;
  if (!count || count > JUMBO_MAX) return false;
  return parts.every((p) => p.emoji || !p.text.trim());
}

/// Emojibase group numbers in picker order; group 2 (components) is filtered out. Keys, not strings, since built at import.
export const GROUPS = [
  { id: 'recent', labelKey: 'chat.emoji.group.recent', icon: '\u{1F551}' },
  { id: 0, labelKey: 'chat.emoji.group.smileys', icon: '\u{1F600}' },
  { id: 1, labelKey: 'chat.emoji.group.people', icon: '\u{1F44B}' },
  { id: 3, labelKey: 'chat.emoji.group.nature', icon: '\u{1F33F}' },
  { id: 4, labelKey: 'chat.emoji.group.food', icon: '\u{1F355}' },
  { id: 5, labelKey: 'chat.emoji.group.travel', icon: '✈️' },
  { id: 6, labelKey: 'chat.emoji.group.activities', icon: '⚽' },
  { id: 7, labelKey: 'chat.emoji.group.objects', icon: '\u{1F4A1}' },
  { id: 8, labelKey: 'chat.emoji.group.symbols', icon: '\u{1F523}' },
  { id: 9, labelKey: 'chat.emoji.group.flags', icon: '\u{1F3C1}' },
];

export const SKIN_TONES = [
  { value: '', labelKey: 'chat.emoji.tone.default' },
  { value: '\u{1F3FB}', labelKey: 'chat.emoji.tone.light' },
  { value: '\u{1F3FC}', labelKey: 'chat.emoji.tone.mediumLight' },
  { value: '\u{1F3FD}', labelKey: 'chat.emoji.tone.medium' },
  { value: '\u{1F3FE}', labelKey: 'chat.emoji.tone.mediumDark' },
  { value: '\u{1F3FF}', labelKey: 'chat.emoji.tone.dark' },
];
let catalogue = null;
let pending = null;
let byShortcode = null;

/// Imported on first use so it lands in its own chunk.
export function loadEmoji() {
  if (catalogue) return Promise.resolve(catalogue);
  if (!pending) {
    pending = Promise.all([
      import('emojibase-data/en/compact.json'),
      import('emojibase-data/en/shortcodes/emojibase.json').catch(() => ({ default: {} })),
    ])
      .then(([data, codes]) => {
        const raw = data.default || data;
        const shortcodes = codes.default || codes;
        catalogue = raw
          .filter((e) => e.group !== undefined && e.group !== 2)
          .map((e) => {
            const short = [].concat(shortcodes[e.hexcode] || []);
            return {
              unicode: e.unicode,
              label: e.label,
              shortcode: short[0] || null,
              group: e.group,
              order: e.order ?? 0,
              search: `${e.label} ${short.join(' ')} ${(e.tags || []).join(' ')}`.toLowerCase(),
              tones: (e.skins || []).map((s) => ({ unicode: s.unicode, tone: s.tone })),
            };
          })
          .sort((a, b) => a.order - b.order);
        byShortcode = new Map();
        for (const e of raw) {
          for (const code of [].concat(shortcodes[e.hexcode] || [])) {
            if (!byShortcode.has(code)) byShortcode.set(code, e.unicode);
          }
        }
        return catalogue;
      })
      .catch(() => { pending = null; return []; });
  }
  return pending;
}

/// Emojibase carries the tone number on every skin variant; legacy string arrays still accepted.
export function withTone(entry, tone) {
  if (!tone || !entry.tones?.length) return entry.unicode;
  const at = SKIN_TONES.findIndex((option) => option.value === tone);
  if (at <= 0) return entry.unicode;

  if (typeof entry.tones[0] === 'string') {
    return entry.tones[at - 1] || entry.unicode;
  }

  const exact = entry.tones.find((variant) => {
    const tones = Array.isArray(variant.tone) ? variant.tone : [variant.tone];
    return tones.length > 0 && tones.every((value) => Number(value) === at);
  });
  return exact?.unicode || entry.unicode;
}

export function baseEmojiFor(list, value) {
  return (list || []).find((entry) => (
    entry.unicode === value
    || entry.tones?.some((variant) => (
      (typeof variant === 'string' ? variant : variant?.unicode) === value
    ))
  )) || null;
}

export function searchEmoji(list, query) {
  const q = query.trim().toLowerCase();
  if (!q) return list;
  const terms = q.split(/\s+/);
  return list.filter((e) => terms.every((t) => e.search.includes(t)));
}

// Recents are synced account data, passed in since `lib/` owns no singleton.

const RECENT_MAX = 36;

export function recentEmoji(sync) {
  const list = sync.get(KEYS.emojiRecent);
  return Array.isArray(list) ? list : [];
}

export function rememberEmoji(sync, value) {
  const list = [value, ...recentEmoji(sync).filter((e) => e !== value)].slice(0, RECENT_MAX);
  sync.set(KEYS.emojiRecent, list);
  return list;
}

export function emojiIn(wire) {
  const text = typeof wire === 'string' ? wire : '';
  if (!text) return [];
  const literal = literalMask(text);
  const found = [];
  // `splitEmoji` covers its input exactly and in order, so walking the parts walks the offsets.
  const unicodeIn = (from, to) => {
    let at = from;
    for (const part of splitEmoji(text.slice(from, to))) {
      if (part.emoji && !literal[at]) found.push(part.emoji);
      at += (part.emoji ?? part.text).length;
    }
  };
  const re = customEmojiRe();
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    unicodeIn(last, m.index);
    if (!literal[m.index]) found.push(m[0]);
    last = m.index + m[0].length;
  }
  unicodeIn(last, text.length);
  return found;
}

/// One write per message, in order, since recents are synced.
export function rememberEmojiIn(sync, wire) {
  const found = emojiIn(wire);
  if (!found.length) return recentEmoji(sync);
  const list = [];
  for (const value of [...found, ...recentEmoji(sync)]) {
    if (!list.includes(value)) list.push(value);
  }
  const next = list.slice(0, RECENT_MAX);
  sync.set(KEYS.emojiRecent, next);
  return next;
}

export function parseCustomEmoji(value) {
  const match = /^<([^:>]+):([^@>]+)(?:@([^>]+))?>$/.exec(String(value || ''));
  return match ? { name: match[1], id: match[2], origin: match[3] || '' } : null;
}

/// Custom guild emoji are excluded: they are per-guild.
const DEFAULT_QUICK = ['\u{1F44D}', '\u{1F602}', '❤️', '\u{1F525}', '\u{1F440}', '\u{1F389}'];

export function quickEmoji(sync, count = 6) {
  const seen = new Set();
  const out = [];
  for (const value of [...recentEmoji(sync), ...DEFAULT_QUICK]) {
    if (value.startsWith('<') || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
    if (out.length === count) break;
  }
  return out;
}

// Composer stand-in: IDEOGRAPHIC NUMBER ZERO plus a variation selector forms one grapheme cluster (one caret stop), full-width and monochrome so `color: transparent` hides it. `toWireText` restores tokens.

const STAND_IN_BASE = '〇';
const SELECTOR_FIRST = 0xE0100;
const SELECTOR_LAST = 0xE01EF;

const standInRe = () => new RegExp(`${STAND_IN_BASE}[\\u{E0100}-\\u{E01EF}]`, 'gu');

// Allocation is insertion-ordered and never released; past 240 selectors a token stays literal text.
const standInFor = new Map();
const tokenFor = new Map();

function allocate(token) {
  const seen = standInFor.get(token);
  if (seen) return seen;
  if (standInFor.size > SELECTOR_LAST - SELECTOR_FIRST) return null;
  const standIn = STAND_IN_BASE + String.fromCodePoint(SELECTOR_FIRST + standInFor.size);
  standInFor.set(token, standIn);
  tokenFor.set(standIn, token);
  return standIn;
}

/// Tokens inside code spans and fences stay literal.
function literalMask(text) {
  const mask = new Uint8Array(text.length);
  for (const span of previewSpans(text)) {
    if (!span.kinds.includes('code') && !span.kinds.includes('codeblock')) continue;
    for (let i = span.start; i < span.end; i += 1) mask[i] = 1;
  }
  return mask;
}

export function toDisplayText(wire) {
  const text = typeof wire === 'string' ? wire : '';
  if (!text.includes('<')) return text;

  const literal = literalMask(text);

  return text.replace(customEmojiRe(), (token, at) => {
    for (let i = at; i < at + token.length; i += 1) if (literal[i]) return token;
    return allocate(token) || token;
  });
}

/// An unknown stand-in resolves to nothing rather than travelling invisibly.
export function toWireText(display) {
  const text = typeof display === 'string' ? display : '';
  if (!text.includes(STAND_IN_BASE)) return text;
  return text.replace(standInRe(), (standIn) => tokenFor.get(standIn) ?? '');
}

export function hasStandIn(text) {
  return typeof text === 'string' && text.includes(STAND_IN_BASE) && standInRe().test(text);
}

export function splitStandIns(text) {
  const parts = [];
  if (typeof text !== 'string' || !text) return parts;
  const re = standInRe();
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    const token = tokenFor.get(m[0]);
    if (!token) continue;
    if (m.index > last) parts.push({ text: text.slice(last, m.index) });
    parts.push({ standIn: m[0], token, ...parseCustomEmoji(token) });
    last = m.index + m[0].length;
  }
  if (last < text.length || !parts.length) parts.push({ text: text.slice(last) });
  return parts;
}

/// The name must follow a space or start of text (not `12:30:45`); unknown names stay as typed; unchanged before the catalogue loads.
const SHORTCODE_RE = /(?<![\p{L}\p{N}_]):([a-z0-9_+-]{1,48}):/giu;

export function expandShortcodes(text) {
  if (!byShortcode || typeof text !== 'string' || !text.includes(':')) return text;
  let literal = null;
  return text.replace(SHORTCODE_RE, (run, name, at) => {
    const unicode = byShortcode.get(name.toLowerCase());
    if (!unicode) return run;
    literal ??= literalMask(text);
    return literal[at] ? run : unicode;
  });
}

export function mayHoldShortcode(text) {
  return typeof text === 'string' && new RegExp(SHORTCODE_RE.source, 'iu').test(text);
}

export function shortcodeBefore(text, caret) {
  if (!byShortcode || caret < 3 || text[caret - 1] !== ':') return null;
  const open = text.lastIndexOf(':', caret - 2);
  if (open < 0) return null;
  const run = text.slice(open, caret);
  const m = new RegExp(`^${SHORTCODE_RE.source}$`, 'iu').exec(run);
  if (!m) return null;
  if (open > 0 && /[\p{L}\p{N}_]/u.test(text[open - 1])) return null;
  const unicode = byShortcode.get(m[1].toLowerCase());
  if (!unicode || literalMask(text)[open]) return null;
  return { from: open, to: caret, unicode };
}
