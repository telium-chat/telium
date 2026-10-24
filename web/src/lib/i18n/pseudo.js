// Pseudolocales for finding structural i18n bugs without a translator.
// Never touch a placeholder: walk the parsed pattern, not the source.

import { parse } from './format.js';
import { EN, registerCatalog } from './catalog/index.js';
import { registerLocale } from './locale.js';

/// Latin Extended lookalikes: Cyrillic or Greek ones would show tofu.
const ACCENTS = {
  a: 'á', b: 'ƀ', c: 'ç', d: 'ð', e: 'é', f: 'ƒ', g: 'ĝ', h: 'ĥ', i: 'î',
  j: 'ĵ', k: 'ķ', l: 'ĺ', m: 'ɱ', n: 'ñ', o: 'ø', p: 'þ', q: ' q', r: 'ŕ',
  s: 'ŝ', t: 'ţ', u: 'ú', v: 'ṽ', w: 'ŵ', x: 'ẋ', y: 'ý', z: 'ž',
  A: 'Á', B: 'Ɓ', C: 'Ç', D: 'Ð', E: 'É', F: 'Ƒ', G: 'Ĝ', H: 'Ĥ', I: 'Î',
  J: 'Ĵ', K: 'Ķ', L: 'Ĺ', M: 'Ṁ', N: 'Ñ', O: 'Ø', P: 'Þ', Q: 'Q', R: 'Ŕ',
  S: 'Ŝ', T: 'Ţ', U: 'Ú', V: 'Ṽ', W: 'Ŵ', X: 'Ẋ', Y: 'Ý', Z: 'Ž',
};

const KANA = [...'あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめも'];

const RTL_OPEN = '‫';
const RTL_CLOSE = '‬';

/// Short strings grow proportionally more, hence a floor of four characters.
function pad(text) {
  const letters = text.replace(/[^\p{L}]/gu, '').length;
  if (!letters) return text;
  const extra = Math.max(4, Math.round(letters * 0.4));
  return `${text}[${'·'.repeat(extra)}]`;
}

function accent(text) {
  return [...text].map((ch) => ACCENTS[ch] || ch).join('');
}

function kana(text) {
  let i = 0;
  return [...text].map((ch) => {
    if (!/\p{L}/u.test(ch)) return ch;
    const out = KANA[i % KANA.length];
    i += 1;
    return out;
  }).join('');
}

const TRANSFORMS = {
  'xx-long': (text) => pad(accent(text)),
  'xx-kana': (text) => kana(text),
  'xx-rtl': (text) => `${RTL_OPEN}${accent(text)}${RTL_CLOSE}`,
};

/// Walks the AST from `parse()` so it never re-derives what is a placeholder.
function transformPattern(source, transform) {
  const write = (nodes) => nodes.map((node) => {
    switch (node.type) {
      case 'text':
        // Re-escape with ICU quoting; double apostrophes first so they don't quote the escapes added below.
        return transform(node.value)
          .replace(/'/g, "''")
          .replace(/[{}#<]/g, (ch) => `'${ch}'`);

      case 'pound':
        return '#';

      case 'arg':
        return `{${node.name}}`;

      case 'format':
        return node.style
          ? `{${node.name}, ${node.kind}, ${node.style}}`
          : `{${node.name}, ${node.kind}}`;

      case 'tag':
        return `<${node.name}>${write(node.children)}</${node.name}>`;

      case 'plural':
      case 'select': {
        // Arm selectors are machine vocabulary: accenting `other` would match no arm and blank the screen.
        const offset = node.offset ? `offset:${node.offset} ` : '';
        const arms = [...node.branches.entries()]
          .map(([selector, body]) => `${selector} {${write(body)}}`)
          .join(' ');
        return `{${node.name}, ${node.type}, ${offset}${arms}}`;
      }

      default:
        return '';
    }
  }).join('');

  return write(parse(source));
}

export function pseudoCatalog(tag = 'xx-long', source = EN) {
  const transform = TRANSFORMS[tag];
  if (!transform) throw new Error(`no pseudolocale called ${tag}`);
  const out = {};
  for (const [key, pattern] of Object.entries(source)) {
    out[key] = transformPattern(pattern, transform);
  }
  return out;
}

/// Both halves are needed: with only the catalogue, `resolveLocale` falls through to the device language.
export function installPseudo(tag = 'xx-long') {
  const catalog = pseudoCatalog(tag);
  registerLocale(tag, { dir: tag === 'xx-rtl' ? 'rtl' : 'ltr' });
  registerCatalog(tag, catalog);
  return tag;
}

export const PSEUDO_TAGS = Object.keys(TRANSFORMS);
