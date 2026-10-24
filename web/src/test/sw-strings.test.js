import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EN } from '../lib/i18n/catalog/index.js';

const SRC = join(process.cwd(), 'src');
const WORKER = readFileSync(join(SRC, 'sw.js'), 'utf8');
const PAGE = readFileSync(join(SRC, 'lib', 'serviceworker.js'), 'utf8');

function literal(source, pattern, what) {
  const match = source.match(pattern);
  if (!match) throw new Error(`could not find ${what}; has it been renamed or reformatted?`);
  // eslint-disable-next-line no-new-func
  return new Function(`return (${match[1]});`)();
}

const FALLBACK = literal(WORKER, /const FALLBACK = (\{[\s\S]*?\n\});/, 'FALLBACK in sw.js');

const MAPPING = (() => {
  const body = PAGE.match(/function swStrings\(\)\s*\{\s*return \{([\s\S]*?)\n {2}\};/);
  if (!body) throw new Error('could not find swStrings() in lib/serviceworker.js');
  const out = {};
  for (const line of body[1].split('\n')) {
    const m = line.match(/^\s*(\w+): t\('([^']+)'\),\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
})();

describe('the service worker and the catalogue', () => {
  it('posts a key for every sentence the worker can say', () => {
    expect(Object.keys(MAPPING).sort()).toEqual(Object.keys(FALLBACK).sort());
  });

  it('names keys that exist in English', () => {
    for (const key of Object.values(MAPPING)) {
      expect(EN, `${key} is posted to the service worker but is not in the catalogue`)
        .toHaveProperty(key);
    }
  });

  it('inlines the same English the catalogue does', () => {
    for (const [field, key] of Object.entries(MAPPING)) {
      expect(FALLBACK[field], `sw.js FALLBACK.${field} has drifted from ${key}`)
        .toBe(EN[key]);
    }
  });

  it('reads every field it was sent', () => {
    for (const field of Object.keys(MAPPING)) {
      expect(WORKER, `sw.js never reads words.${field}`).toContain(`words.${field}`);
    }
  });

  it('shows no notification built from a literal', () => {
    const allowed = /^(words|notification)\./;
    const calls = WORKER.match(/showNotification\([\s\S]*?\n {4,14}\}\);/g) || [];
    expect(calls.length, 'expected the push handler to still show notifications')
      .toBeGreaterThan(0);
    for (const call of calls) {
      const head = call.slice(0, call.indexOf('\n'));
      const title = head.match(/showNotification\(([^,]*),/)?.[1];
      expect(title, 'the notification title is a literal, not a translated string')
        .toMatch(allowed);
      const body = call.match(/^\s*body: (.*),$/m);
      expect(body?.[1], 'the notification body is a literal, not a translated string')
        .toMatch(allowed);
    }
  });
});
