import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EN } from '../lib/i18n/catalog/index.js';
import { LOCALES, FALLBACK } from '../lib/i18n/locale.js';
import { fingerprint } from '../../scripts/i18n-status.mjs';

const STAMPS = join(process.cwd(), 'src', 'lib', 'i18n', 'catalog', 'stamps.json');

async function catalogues() {
  const out = [];
  for (const locale of LOCALES) {
    if (locale.tag === FALLBACK || !locale.load) continue;
    const module = await locale.load();
    out.push({ ...locale, messages: module.messages || module.default || {} });
  }
  return out;
}

function namespaceOf(key) {
  return key.slice(0, key.indexOf('.')) || key;
}

function bar(fraction, width = 24) {
  const filled = Math.round(fraction * width);
  return '█'.repeat(filled) + '·'.repeat(width - filled);
}

describe('translation completeness', () => {
  it('reports how much of English each catalogue covers', async () => {
    const keys = Object.keys(EN);
    const namespaces = [...new Set(keys.map(namespaceOf))].sort();
    const lines = [`English: ${keys.length} keys in ${namespaces.length} namespaces.`, ''];

    for (const locale of await catalogues()) {
      const have = new Set(Object.keys(locale.messages));
      const done = keys.filter((key) => have.has(key));
      const fraction = keys.length ? done.length / keys.length : 1;
      lines.push(
        `${locale.tag}  ${String(done.length).padStart(5)}/${keys.length}  `
          + `${(fraction * 100).toFixed(1).padStart(5)}%  ${bar(fraction)}  ${locale.endonym}`,
      );
      const started = namespaces
        .map((ns) => {
          const total = keys.filter((key) => namespaceOf(key) === ns).length;
          const hit = done.filter((key) => namespaceOf(key) === ns).length;
          return { ns, hit, total };
        })
        .filter((row) => row.hit > 0);
      for (const row of started) {
        const mark = row.hit === row.total ? '✓' : ' ';
        lines.push(`      ${mark} ${row.ns.padEnd(14)} ${String(row.hit).padStart(4)}/${row.total}`);
      }
      lines.push('');
    }

    lines.push('Every catalogue above ships as it is. A key no catalogue has renders in English.');
    // eslint-disable-next-line no-console
    console.log(lines.join('\n'));

    expect(keys.length).toBeGreaterThan(0);
  });
});

describe('acceptance stamps', () => {
  const present = existsSync(STAMPS);
  const stamps = present ? JSON.parse(readFileSync(STAMPS, 'utf8')) : {};

  it('parses as an object of tag -> key -> fingerprint', () => {
    expect(typeof stamps).toBe('object');
    expect(Array.isArray(stamps)).toBe(false);
    for (const [tag, entries] of Object.entries(stamps)) {
      expect(typeof entries, `${tag} must map keys to fingerprints`).toBe('object');
      for (const [key, value] of Object.entries(entries)) {
        expect(value, `${tag}.${key}`).toMatch(/^[0-9a-f]{8}$/);
      }
    }
  });

  it('stamps only languages this client actually ships', () => {
    const shipped = new Set(LOCALES.map((locale) => locale.tag).filter((tag) => tag !== FALLBACK));
    for (const tag of Object.keys(stamps)) {
      expect(shipped.has(tag), `stamps.json has a "${tag}" block but LOCALES does not ship ${tag}`)
        .toBe(true);
    }
  });

  it('stamps only keys English still has', async () => {
    for (const [tag, entries] of Object.entries(stamps)) {
      const dead = Object.keys(entries).filter((key) => !(key in EN));
      expect(dead, `${tag} is stamped for keys English no longer has: ${dead.join(', ')}`)
        .toEqual([]);
    }
  });

  it('stamps only keys the language has actually translated', async () => {
    for (const locale of await catalogues()) {
      const entries = stamps[locale.tag] || {};
      const orphans = Object.keys(entries).filter((key) => !(key in locale.messages));
      expect(orphans, `${locale.tag} is stamped for keys it does not translate: ${orphans.join(', ')}`)
        .toEqual([]);
    }
  });

  it('agrees with the fingerprint function the script uses', () => {
    expect(fingerprint('')).toBe('811c9dc5');
    expect(fingerprint('Save')).toMatch(/^[0-9a-f]{8}$/);
    expect(fingerprint('Save')).not.toBe(fingerprint('Speichern'));
  });
});
