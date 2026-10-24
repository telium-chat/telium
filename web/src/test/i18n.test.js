import {
  afterEach, beforeAll, describe, expect, it, vi,
} from 'vitest';
import {
  clearMissedKeys, formatPattern, missedKeys, setLocale, t, tParts,
} from '../lib/i18n/index.js';
import {
  activate, activeDirection, activeLocale, applyDocument, registerLocale, resolveLocale,
} from '../lib/i18n/locale.js';
import { EN, completeness, registerCatalog } from '../lib/i18n/catalog/index.js';
import { installPseudo } from '../lib/i18n/pseudo.js';
import {
  byteParts, formatDuration, formatList, formatNumber, formatRelative,
} from '../lib/i18n/intl.js';

beforeAll(() => {
  registerLocale('qq', { dir: 'ltr' });
  registerCatalog('qq', { 'common.save': 'QQSAVE', 'common.cancel': 'QQCANCEL' });
  installPseudo('xx-rtl');
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await setLocale('en');
  clearMissedKeys();
});

describe('resolving what language to speak', () => {
  it('falls back to English for a language nobody has written', () => {
    vi.stubGlobal('navigator', { languages: ['is-IS', 'is'] });
    expect(resolveLocale('auto')).toBe('en');
  });

  it('serves a region variant from the base language, ignoring case', () => {
    vi.stubGlobal('navigator', { languages: ['QQ-AT'] });
    expect(resolveLocale('auto')).toBe('qq');
  });

  it('honours an explicit choice over the device', () => {
    vi.stubGlobal('navigator', { languages: ['qq'] });
    expect(resolveLocale('en')).toBe('en');
  });

  it('falls through a stale preference to the device rather than to English', () => {
    vi.stubGlobal('navigator', { languages: ['qq-DE'] });
    expect(resolveLocale('sv-SE')).toBe('qq');
  });

  it('survives having no navigator at all', () => {
    vi.stubGlobal('navigator', undefined);
    expect(resolveLocale('auto')).toBe('en');
  });
});

describe('switching language', () => {
  it('writes lang and dir onto the document', () => {
    applyDocument('ar');
    expect(document.documentElement.lang).toBe('ar');
    expect(document.documentElement.dir).toBe('rtl');
    applyDocument('en');
    expect(document.documentElement.dir).toBe('ltr');
  });

  it('sets the direction for a right-to-left locale', async () => {
    await setLocale('xx-rtl');
    expect(activeDirection()).toBe('rtl');
    expect(document.documentElement.dir).toBe('rtl');
  });

  it('answers translated keys from the locale and the rest in English', async () => {
    await setLocale('qq');
    expect(activeLocale()).toBe('qq');
    expect(t('common.save')).toBe('QQSAVE');
    expect(t('common.close')).toBe(EN['common.close']);
  });

  it('stays in the language it has when the catalogue will not load', async () => {
    const complain = vi.spyOn(console, 'error').mockImplementation(() => {});
    registerLocale('qr');
    await setLocale('qq');
    const stayed = await activate('qr', () => Promise.reject(new Error('chunk gone')));
    expect(stayed).toBe('qq');
    expect(activeLocale()).toBe('qq');
    expect(complain).toHaveBeenCalled();
    complain.mockRestore();
  });
});

describe('completeness', () => {
  it('counts translated, missing and extra keys against English', () => {
    registerCatalog('zz-stale', { 'common.save': 'x', 'common.renamedAway': 'y' });
    const status = completeness('zz-stale');
    expect(status.translated).toBe(1);
    expect(status.total).toBe(Object.keys(EN).length);
    expect(status.missing).toContain('common.close');
    expect(status.extra).toEqual(['common.renamedAway']);
  });
});

describe('a key nothing has', () => {
  it('renders as a word, records the key, and complains once', () => {
    const complain = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(t('nowhere.at.all.submitButton')).toBe('Submit button');
    t('nowhere.at.all.submitButton');
    expect(missedKeys()).toContain('nowhere.at.all.submitButton');
    expect(complain).toHaveBeenCalledTimes(1);
    complain.mockRestore();
  });
});

describe('the pattern language', () => {
  it('substitutes a named argument, and a missing one as nothing', () => {
    expect(formatPattern('Hello {name}.', { name: 'Ada' }, 'en')).toBe('Hello Ada.');
    expect(formatPattern('Hello {name}.', {}, 'en')).toBe('Hello .');
  });

  it('chooses a select arm and falls to other', () => {
    const p = '{kind, select, dm {a direct message} other {somewhere}}';
    expect(formatPattern(p, { kind: 'dm' }, 'en')).toBe('a direct message');
    expect(formatPattern(p, { kind: 'nonsense' }, 'en')).toBe('somewhere');
  });

  it('prefers an exact match and applies the offset', () => {
    const p = '{n, plural, offset:1 =0 {nobody} one {and # other} other {and # others}}';
    expect(formatPattern(p, { n: 0 }, 'en')).toBe('nobody');
    expect(formatPattern(p, { n: 2 }, 'en')).toBe('and 1 other');
    expect(formatPattern(p, { n: 4 }, 'en')).toBe('and 3 others');
  });

  it('follows ICU apostrophe quoting', () => {
    expect(formatPattern("You don't have that.", {}, 'en')).toBe("You don't have that.");
    expect(formatPattern("Use '{'name'}' here.", {}, 'en')).toBe('Use {name} here.');
    expect(formatPattern("it''s", {}, 'en')).toBe("it's");
  });

  it('uses CLDR plural categories for the locale', () => {
    const p = '{n, plural, zero {ZERO} one {ONE} two {TWO} few {FEW} many {MANY} other {OTHER}}';
    expect([0, 1, 2, 3, 11, 100].map((n) => formatPattern(p, { n }, 'ar')))
      .toEqual(['ZERO', 'ONE', 'TWO', 'FEW', 'MANY', 'OTHER']);
    expect([0, 1, 2].map((n) => formatPattern(p, { n }, 'ja'))).toEqual(['OTHER', 'OTHER', 'OTHER']);
  });

  it('splits a tagged sentence into parts for React', () => {
    const parts = tParts('auth.server.noServer');
    const tag = parts.find((part) => part.type === 'tag' && part.name === 'a');
    expect(tag.children.map((child) => child.value).join('')).toBeTruthy();
    const text = parts.filter((part) => part.type === 'text').map((part) => part.value).join('');
    expect(text).not.toContain('<a>');
  });
});

describe('Intl formatting by locale', () => {
  it('formats numbers, sizes and lists in the locale', () => {
    expect(formatNumber('de', 1234.5, 'fixed1')).toBe('1.234,5');
    expect(formatNumber('ar-EG', 42, 'integer')).toBe('٤٢');
    expect(byteParts('en', 1024 * 1024 * 3.5)).toEqual({ value: '3.5', unit: 'mb' });
    expect(formatList('en', ['a', 'b', 'c'])).toBe('a, b, and c');
    expect(formatList('en', [])).toBe('');
  });

  it('writes a duration as a clock face and a relative time narrowly', () => {
    expect(formatDuration('en', 3725)).toBe('1:02:05');
    const now = Date.UTC(2026, 0, 2, 12, 0, 0);
    expect(formatRelative('en', now - 5 * 60_000, { now })).toBe('5m ago');
  });
});

describe('bidirectional isolation', () => {
  it('isolates an opposite-direction value and leaves a same-direction one alone', () => {
    const out = formatPattern('Deleted by {name}.', { name: 'مرحبا' }, 'en');
    expect(out.replace(/[⁨⁩]/g, '')).toBe('Deleted by مرحبا.');
    expect(out).toContain('⁨');
    expect(formatPattern('Deleted by {name}.', { name: 'Ada' }, 'en')).toBe('Deleted by Ada.');
    expect(formatPattern('حذفه {name}.', { name: 'Ada' }, 'ar')).toContain('⁨Ada⁩');
  });
});
