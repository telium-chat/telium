// ICU MessageFormat subset, no library.
// Strictly ICU, so swapping in `intl-messageformat` touches no catalogue entries.
// `<b>`/`<link>` tags are not ICU: parsed here and resolved by the caller, since splitting around a component hardcodes English word order.

const parsed = new Map();

export function parse(pattern) {
  const hit = parsed.get(pattern);
  if (hit) return hit;
  const ast = parseMessage(String(pattern), { at: 0 }, null);
  parsed.set(pattern, ast);
  return ast;
}

function parseMessage(source, cursor, until) {
  const parts = [];
  let literal = '';
  const flush = () => { if (literal) { parts.push({ type: 'text', value: literal }); literal = ''; } };

  while (cursor.at < source.length) {
    const ch = source[cursor.at];

    // ICU quoting: `''` is one apostrophe; `'` before a syntax character opens a literal run.
    if (ch === "'") {
      const next = source[cursor.at + 1];
      if (next === "'") { literal += "'"; cursor.at += 2; continue; }
      if (next === '{' || next === '}' || next === '#' || next === '<') {
        cursor.at += 1;
        while (cursor.at < source.length && source[cursor.at] !== "'") {
          literal += source[cursor.at];
          cursor.at += 1;
        }
        cursor.at += 1;
        continue;
      }
      literal += ch; cursor.at += 1; continue;
    }

    if (ch === '}') break;

    if (ch === '#') {
      flush(); parts.push({ type: 'pound' }); cursor.at += 1; continue;
    }

    if (ch === '<') {
      const tag = matchTag(source, cursor.at);
      if (!tag) { literal += ch; cursor.at += 1; continue; }
      if (tag.closing) {
        if (until && tag.name === until) { cursor.at = tag.end; break; }
        // A stray closing tag is a translator typo: render it as visible text.
        literal += source.slice(cursor.at, tag.end); cursor.at = tag.end; continue;
      }
      flush();
      cursor.at = tag.end;
      if (tag.selfClosing) { parts.push({ type: 'tag', name: tag.name, children: [] }); continue; }
      const children = parseMessage(source, cursor, tag.name);
      parts.push({ type: 'tag', name: tag.name, children });
      continue;
    }

    if (ch === '{') {
      flush();
      cursor.at += 1;
      parts.push(parseArgument(source, cursor));
      continue;
    }

    literal += ch;
    cursor.at += 1;
  }

  flush();
  return parts;
}

function matchTag(source, at) {
  const m = /^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\s*(\/?)>/.exec(source.slice(at));
  if (!m) return null;
  return {
    closing: m[1] === '/',
    name: m[2],
    selfClosing: m[3] === '/',
    end: at + m[0].length,
  };
}

function parseArgument(source, cursor) {
  const name = readUntil(source, cursor, [',', '}']).trim();
  if (source[cursor.at] === '}') { cursor.at += 1; return { type: 'arg', name }; }
  cursor.at += 1;
  const kind = readUntil(source, cursor, [',', '}']).trim();

  if (kind === 'plural' || kind === 'select') {
    cursor.at += 1;
    const { offset, branches } = parseBranches(source, cursor);
    if (source[cursor.at] === '}') cursor.at += 1;
    return { type: kind, name, offset, branches };
  }

  // The style is a preset name from `intl.js`, not an ICU skeleton.
  let style = null;
  if (source[cursor.at] === ',') { cursor.at += 1; style = readUntil(source, cursor, ['}']).trim(); }
  if (source[cursor.at] === '}') cursor.at += 1;
  return { type: 'format', name, kind, style };
}

function parseBranches(source, cursor) {
  const branches = new Map();
  let offset = 0;
  const skipSpace = () => { while (/\s/.test(source[cursor.at] || '')) cursor.at += 1; };
  for (;;) {
    skipSpace();
    if (cursor.at >= source.length || source[cursor.at] === '}') break;

    // A selector is a non-space, non-brace token: `offset:1` sits in selector position and reading to the brace swallows the first arm.
    let key = '';
    while (cursor.at < source.length && !/[\s{}]/.test(source[cursor.at])) {
      key += source[cursor.at];
      cursor.at += 1;
    }
    if (!key) break;
    if (key.startsWith('offset:')) { offset = Number(key.slice(7)) || 0; continue; }

    skipSpace();
    if (source[cursor.at] !== '{') break;
    cursor.at += 1;
    branches.set(key, parseMessage(source, cursor, null));
    if (source[cursor.at] === '}') cursor.at += 1;
  }
  return { offset, branches };
}

function readUntil(source, cursor, stops) {
  let out = '';
  while (cursor.at < source.length && !stops.includes(source[cursor.at])) {
    out += source[cursor.at];
    cursor.at += 1;
  }
  return out;
}

export function formatToParts(pattern, values, services) {
  const out = [];
  render(parse(pattern), values, services, out, null);
  return collapse(out);
}

export function format(pattern, values, services) {
  let out = '';
  for (const part of formatToParts(pattern, values, services)) {
    out += part.type === 'text' ? part.value : flattenTag(part);
  }
  return out;
}

function flattenTag(part) {
  let out = '';
  for (const child of part.children) out += child.type === 'text' ? child.value : flattenTag(child);
  return out;
}

function render(parts, values, services, out, plural) {
  for (const part of parts) {
    switch (part.type) {
      case 'text': out.push({ type: 'text', value: part.value }); break;
      case 'pound':
        out.push({ type: 'text', value: plural ? services.number(plural.value - plural.offset) : '#' });
        break;
      case 'arg': out.push({ type: 'text', value: stringify(values[part.name], services) }); break;
      case 'format': out.push({ type: 'text', value: formatted(part, values[part.name], services) }); break;
      case 'select': {
        const chosen = part.branches.get(String(values[part.name])) || part.branches.get('other') || [];
        render(chosen, values, services, out, plural);
        break;
      }
      case 'plural': {
        const value = Number(values[part.name]) || 0;
        const chosen = pluralBranch(part, value, services);
        render(chosen, values, services, out, { value, offset: part.offset });
        break;
      }
      case 'tag': {
        const children = [];
        render(part.children, values, services, children, plural);
        out.push({ type: 'tag', name: part.name, children: collapse(children) });
        break;
      }
      default: break;
    }
  }
}

/// Exact matches (`=0`) beat categories, per ICU.
function pluralBranch(part, value, services) {
  const exact = part.branches.get(`=${value}`);
  if (exact) return exact;
  const category = services.plural(value - part.offset);
  return part.branches.get(category) || part.branches.get('other') || [];
}

function formatted(part, value, services) {
  switch (part.kind) {
    case 'number': return services.number(value, part.style);
    case 'bytes': return services.bytes(value);
    case 'date': return services.date(value, part.style || 'medium');
    case 'time': return services.time(value, part.style || 'short');
    case 'dateTime': return services.dateTime(value, part.style || 'medium');
    case 'relative': return services.relative(value);
    default: return stringify(value, services);
  }
}

function stringify(value, services) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return services.number(value);
  // Isolated so a name's own direction cannot drag surrounding punctuation.
  return services.isolate ? services.isolate(String(value)) : String(value);
}

function collapse(parts) {
  const out = [];
  for (const part of parts) {
    const last = out[out.length - 1];
    if (part.type === 'text' && last && last.type === 'text') last.value += part.value;
    else out.push(part);
  }
  return out;
}
