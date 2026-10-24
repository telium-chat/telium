// Composer markdown preview: assigns visual treatments to each character so an overlay can paint the textarea's string. Not a parser or the message renderer.

/// One treatment per bit, so nesting needs no tree.
const BOLD = 1;
const ITALIC = 2;
const STRIKE = 4;
const CODE = 8;
const SPOILER = 16;
const QUOTE = 32;
const LINK = 64;
const MENTION = 128;
const MARKER = 512;
const CODEBLOCK = 1024;
/// Not a treatment: a claim. Mention names must not go italic, so passes step over it like code.
const RUN = 2048;

const KINDS = [
  [BOLD, 'bold'],
  [ITALIC, 'italic'],
  [STRIKE, 'strike'],
  [CODE, 'code'],
  [CODEBLOCK, 'codeblock'],
  [SPOILER, 'spoiler'],
  [QUOTE, 'quote'],
  [LINK, 'link'],
  [MENTION, 'mention'],
  [MARKER, 'marker'],
];

// A mention is its label bracketed by invisible sentinels (WORD JOINER plus variation selector; a trailing lone selector, so one backspace removes both). `lib/mentions.js` mints them.
export const RUN_OPEN = '\u2060';
export const RUN_FIRST = 0xE0100;
export const RUN_LAST = 0xE01EE;
export const RUN_CLOSE = '\u{E01EF}';

/// A complete run. A factory because a `/g` regex carries `lastIndex`.
export const runRe = () => new RegExp(
  `${RUN_OPEN}([\\u{E0100}-\\u{E01EE}])([^${RUN_OPEN}\\u{E01EF}\\n]{0,96})\\u{E01EF}`,
  'gu',
);

/// Half a run; nothing may leave the composer wearing one.
export const strayRunRe = () => new RegExp(`${RUN_OPEN}[\\u{E0100}-\\u{E01EF}]|${RUN_CLOSE}`, 'gu');

/// Longest first (`**` before `*`).
const DELIMITERS = [
  ['***', BOLD | ITALIC, true],
  ['**', BOLD, true],
  ['__', BOLD, true],
  ['~~', STRIKE, true],
  ['||', SPOILER, false],
  ['*', ITALIC, true],
  ['_', ITALIC, true],
];

const FENCE = '```';

/// Past this length we stop looking.
const CEILING = 20000;

const MAX_DEPTH = 4;

const isWord = (ch) => Boolean(ch) && /[\w]/.test(ch);
const isSpace = (ch) => Boolean(ch) && /\s/.test(ch);

function paint(marks, from, to, bits) {
  for (let i = from; i < to; i += 1) marks[i] |= bits;
}

/// `tight`: an opener followed by a space is not an opener. A closer with no space before wins; else the first with space before but not after.
function findClose(text, delim, from, to, tight, marks, lax) {
  const settle = lax.has(delim);
  let at = from;
  let loose = -1;
  while (at < to) {
    const found = text.indexOf(delim, at);
    if (found === -1 || found + delim.length > to) break;
    if (found === from || marks[found] & (CODE | RUN)) { at = found + 1; continue; }
    if (!tight || !isSpace(text[found - 1])) return found;
    const after = found + delim.length >= to ? '' : text[found + delim.length];
    if (!isSpace(after)) {
      if (settle) return found;
      if (loose === -1) loose = found;
    }
    at = found + 1;
  }
  lax.add(delim);
  return loose;
}

/// An n-backtick run closes on the next run of exactly n; unmatched is plain text.
function scanCodeSpans(text, from, to, marks) {
  let i = from;
  while (i < to) {
    if (text[i] !== '`') { i += 1; continue; }

    let width = 1;
    while (i + width < to && text[i + width] === '`') width += 1;

    let at = i + width;
    let close = -1;
    while (at < to) {
      if (text[at] !== '`') { at += 1; continue; }
      let run = 1;
      while (at + run < to && text[at + run] === '`') run += 1;
      if (run === width) { close = at; break; }
      at += run;
    }
    if (close === -1) { i += width; continue; }

    paint(marks, i, close + width, CODE);
    paint(marks, i, i + width, MARKER);
    paint(marks, close, close + width, MARKER);
    i = close + width;
  }
}

/// An unterminated fence runs to the end of the draft; one-liners go to the inline pass.
function scanFences(text, marks) {
  let lineStart = 0;
  let open = -1;
  while (lineStart <= text.length) {
    let lineEnd = text.indexOf('\n', lineStart);
    if (lineEnd === -1) lineEnd = text.length;

    let body = lineStart;
    while (body < lineEnd && text[body] === ' ') body += 1;
    const fence = text.startsWith(FENCE, body);

    if (open === -1) {
      const twin = fence ? text.indexOf(FENCE, body + FENCE.length) : -1;
      if (fence && (twin === -1 || twin + FENCE.length > lineEnd)) {
        open = lineStart;
        paint(marks, body, lineEnd, MARKER);
      }
    } else if (fence) {
      paint(marks, open, lineEnd, CODEBLOCK);
      paint(marks, body, lineEnd, MARKER);
      open = -1;
    }

    if (lineEnd === text.length) break;
    lineStart = lineEnd + 1;
  }
  if (open !== -1) paint(marks, open, text.length, CODEBLOCK);
}

function scanInline(text, from, to, marks, depth) {
  // Delimiters with nothing left to find, so a log full of asterisks isn't quadratic.
  const spent = new Set();
  const lax = new Set();
  let i = from;
  while (i < to) {
    if (marks[i] & (CODE | RUN)) { i += 1; continue; }

    let took = 0;
    for (const [delim, bits, tight] of DELIMITERS) {
      const width = delim.length;
      if (i + width > to) continue;
      if (!text.startsWith(delim, i)) continue;
      // Whitespace after an opener, or `_` mid-word, is not an opener.
      if (tight && isSpace(text[i + width])) continue;
      if (delim === '_' && isWord(text[i - 1])) continue;
      if (spent.has(delim)) continue;
      const close = findClose(text, delim, i + width, to, tight, marks, lax);
      if (close === -1) { spent.add(delim); continue; }
      if (delim === '_' && isWord(text[close + width])) continue;

      paint(marks, i, i + width, bits | MARKER);
      paint(marks, close, close + width, bits | MARKER);
      paint(marks, i + width, close, bits);
      if (depth < MAX_DEPTH) scanInline(text, i + width, close, marks, depth + 1);
      i = close + width;
      took = 1;
      break;
    }
    if (!took) i += 1;
  }
}

/// `@everyone`/`@here` must be the whole word; skipped inside code spans.
const PATTERNS = [
  [/https?:\/\/[^\s<>()]+/g, LINK],
  [/@(?:everyone|here)(?![\w.:@-])/g, MENTION],
];

function scanPatterns(text, from, to, marks) {
  const line = text.slice(from, to);
  for (const [pattern, bits] of PATTERNS) {
    pattern.lastIndex = 0;
    let hit = pattern.exec(line);
    while (hit) {
      const start = from + hit.index;
      const end = start + hit[0].length;
      let clean = true;
      for (let i = start; i < end; i += 1) if (marks[i] & (CODE | RUN)) { clean = false; break; }
      if (clean) paint(marks, start, end, bits);
      hit = pattern.exec(line);
    }
  }
}

/// Claimed first; a run inside a code span is left to the code span.
function scanRuns(text, from, to, marks) {
  const re = runRe();
  re.lastIndex = from;
  let m;
  while ((m = re.exec(text))) {
    const start = m.index;
    const end = start + m[0].length;
    if (start >= to) break;
    if (end > to) break;
    let clean = true;
    for (let i = start; i < end; i += 1) if (marks[i] & CODE) { clean = false; break; }
    if (clean) paint(marks, start, end, MENTION | RUN);
  }
}

export function previewSpans(text) {
  try {
    if (typeof text !== 'string' || !text) return [];
    if (text.length > CEILING) return [{ start: 0, end: text.length, kinds: [] }];

    const marks = new Uint16Array(text.length);

    // Fences first (they cross newlines).
    scanFences(text, marks);

    let lineStart = 0;
    while (lineStart <= text.length) {
      let lineEnd = text.indexOf('\n', lineStart);
      if (lineEnd === -1) lineEnd = text.length;

      if (!(marks[lineStart] & CODEBLOCK)) {
        let body = lineStart;
        while (body < lineEnd && text[body] === ' ') body += 1;
        if (text.startsWith('> ', body) || (text.startsWith('>', body) && body + 1 === lineEnd)) {
          const width = text.startsWith('> ', body) ? 2 : 1;
          paint(marks, lineStart, lineEnd, QUOTE);
          paint(marks, body, body + width, MARKER);
          body += width;
        }

        scanCodeSpans(text, body, lineEnd, marks);
        scanRuns(text, body, lineEnd, marks);
        scanInline(text, body, lineEnd, marks, 0);
        scanPatterns(text, body, lineEnd, marks);
      }

      if (lineEnd === text.length) break;
      lineStart = lineEnd + 1;
    }

    const spans = [];
    let start = 0;
    for (let i = 1; i <= text.length; i += 1) {
      if (i === text.length || marks[i] !== marks[start]) {
        spans.push({ start, end: i, kinds: kindsOf(marks[start]) });
        start = i;
      }
    }
    return spans;
  } catch {
    // Show unstyled text rather than nothing.
    return typeof text === 'string' && text
      ? [{ start: 0, end: text.length, kinds: [] }]
      : [];
  }
}

function kindsOf(bits) {
  if (!bits) return [];
  const out = [];
  for (const [bit, name] of KINDS) if (bits & bit) out.push(name);
  return out;
}
