import {
  BoldIcon, CodeIcon, ItalicIcon, QuoteIcon, SpoilerIcon, StrikeIcon,
} from '../../components/index.js';

export const FORMATS = [
  { id: 'bold', labelKey: 'chat.format.bold', icon: BoldIcon, before: '**', after: '**', chord: { key: 'b', shift: false } },
  { id: 'italic', labelKey: 'chat.format.italic', icon: ItalicIcon, before: '*', after: '*', chord: { key: 'i', shift: false } },
  { id: 'strike', labelKey: 'chat.format.strike', icon: StrikeIcon, before: '~~', after: '~~' },
  { id: 'code', labelKey: 'chat.format.code', icon: CodeIcon, before: '`', after: '`', chord: { key: 'e', shift: false } },
  { id: 'spoiler', labelKey: 'chat.format.spoiler', icon: SpoilerIcon, before: '||', after: '||', chord: { key: 'x', shift: true } },
  { id: 'block', labelKey: 'chat.format.block', icon: CodeIcon, before: '```\n', after: '\n```' },
  { id: 'quote', labelKey: 'chat.format.quote', icon: QuoteIcon, prefix: '> ' },
];

export function chordFor(event) {
  if (!(event.metaKey || event.ctrlKey) || event.altKey) return null;
  const key = String(event.key || '').toLowerCase();
  return FORMATS.find((f) => f.chord && f.chord.key === key && f.chord.shift === event.shiftKey)
    || null;
}

const APPLE = typeof navigator !== 'undefined'
  && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || '');

export function chordHint(format) {
  if (!format.chord) return null;
  const key = format.chord.key.toUpperCase();
  if (APPLE) return `${format.chord.shift ? '⇧' : ''}⌘${key}`;
  return `Ctrl+${format.chord.shift ? 'Shift+' : ''}${key}`;
}

function surroundEdit(value, start, end, before, after) {
  const selected = value.slice(start, end);
  const dressed = selected.startsWith(before)
    && selected.endsWith(after)
    && selected.length >= before.length + after.length;
  if (dressed) {
    const inner = selected.slice(before.length, selected.length - after.length);
    return { from: start, to: end, text: inner, select: [start, start + inner.length] };
  }
  const around = wrappingPair(value, start, end, before, after);
  if (around) {
    return {
      from: around.from,
      to: around.to,
      text: selected,
      select: [around.from, around.from + selected.length],
    };
  }
  const at = start + before.length;
  return {
    from: start,
    to: end,
    text: before + selected + after,
    select: [at, at + selected.length],
  };
}

function wrappingPair(value, start, end, before, after) {
  const openAt = start - before.length;
  const closeAt = end;
  if (openAt < 0 || closeAt + after.length > value.length) return null;
  if (value.slice(openAt, start) !== before) return null;
  if (value.slice(closeAt, closeAt + after.length) !== after) return null;
  if (countIn(value.slice(0, openAt), before) % 2 !== 0) return null;
  return { from: openAt, to: closeAt + after.length };
}

function countIn(text, needle) {
  let n = 0;
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + needle.length)) {
    n += 1;
  }
  return n;
}

function lineEdit(value, start, end, prefix) {
  const from = value.lastIndexOf('\n', start - 1) + 1;
  let stop = end;
  if (stop > from && value[stop - 1] === '\n') stop -= 1;
  const ends = value.indexOf('\n', stop);
  const to = ends === -1 ? value.length : ends;
  const lines = value.slice(from, to).split('\n');
  const marked = lines.every((line) => line.startsWith(prefix));
  const text = lines
    .map((line) => (marked ? line.slice(prefix.length) : prefix + line))
    .join('\n');
  return { from, to, text, select: [from, from + text.length] };
}

export function formatEdit(format, value, start, end) {
  if (format.prefix) return lineEdit(value, start, end, format.prefix);
  return surroundEdit(value, start, end, format.before, format.after);
}
