import { afterEach, describe, expect, it } from 'vitest';
import {
  THEME_ERRORS, applyMarketTheme, applyMarketThemeFromPrefs, checkThemeUrls, copyThemeForEditing,
  downloadTheme, exportThemeCss, installTheme, installedTheme, isLocalThemeId, localThemes,
  parseThemeMeta, rewriteAssetUrls, saveLocalTheme, scanThemeCss, usableTheme,
} from '../lib/themes.js';

const parseThemeMetaName = (css) => parseThemeMeta(css)?.name;
import { setThemeStrings, t, themeMayReword } from '../lib/i18n/index.js';

const HEADER = `/**
 * @name Policy Test
 * @author tester
 * @description Exercises the network policy.
 * @website https://example.org/not-a-fetch
 */
`;

const CDN = 'https://cdn.jsdelivr.net/gh/telium-chat/themes@main/themes/policy-test/';
const opts = { prefixes: ['https://cdn.jsdelivr.net/gh/telium-chat/themes@main/', 'https://raw.githubusercontent.com/telium-chat/themes/main/'], base: 'http://localhost:3000/' };
const check = (body, assets = {}) => checkThemeUrls(HEADER + body, assets, opts);

const store = () => {
  const data = new Map();
  return {
    get: (key, fallback) => (data.has(key) ? JSON.parse(data.get(key)) : fallback),
    set: (key, value) => { data.set(key, JSON.stringify(value)); },
  };
};

const styleTag = () => document.getElementById('telium-market-theme');

afterEach(() => {
  applyMarketTheme(null);
  setThemeStrings(null);
});

describe('network policy', () => {
  it('allows the catalog, data: URLs, relative paths and the header comment', () => {
    expect(check(`body { background: url(${CDN}bg.png) }`).ok).toBe(true);
    expect(check(`body { background: url("data:image/svg+xml,<svg/>") }`).ok).toBe(true);
    expect(check(`body { background: url(bg.png) }`).ok).toBe(true);
    expect(check(`/* url(https://evil.example/x.png) */ body { color: red }`).ok).toBe(true);
  });

  it('blocks a foreign host and names it', () => {
    const verdict = check(`body { background: url(https://evil.example/pixel.png) }`);
    expect(verdict.ok).toBe(false);
    expect(verdict.blocked).toEqual(['evil.example']);
  });

  it('sees through escapes, case and protocol-relative URLs', () => {
    expect(check(`body { background: \\75 rl(https://evil.example/a) }`).ok).toBe(false);
    expect(check(`body { background: URL(https://evil.example/a) }`).ok).toBe(false);
    expect(check(`body { background: url(//evil.example/a) }`).ok).toBe(false);
    expect(check(`body { background: url("\\68ttps://evil.example/a") }`).ok).toBe(false);
    expect(check(`body { background: url(https:evil.example/a) }`).ok).toBe(false);
  });

  it('refuses @import, escaped or not, even from an allowed host', () => {
    expect(check(`@import url(${CDN}other.css);`).ok).toBe(false);
    expect(check(`@\\69mport "${CDN}other.css";`).imports).toBe(1);
  });

  it('checks bare strings, which image-set() and custom properties can fetch', () => {
    expect(check(`body { background: image-set("https://evil.example/a.png" 1x) }`).ok).toBe(false);
    expect(check(`:root { --bg: "https://evil.example/a.png" }`).ok).toBe(false);
  });

  it('does not let a quote game hide a string', () => {
    expect(check(`.a { content: "x\\"" "https://evil.example/a"; }`).ok).toBe(false);
  });

  it('ignores attribute-selector operands and plain text', () => {
    expect(check(`a[href^="https://github.com"] { color: red }`).ok).toBe(true);
    expect(check(`.x::before { content: "Note: see https://example.org" }`).ok).toBe(true);
  });

  it('scopes jsDelivr to this repository on main', () => {
    expect(check(`body { background: url(https://cdn.jsdelivr.net/gh/attacker/repo@main/x.png) }`).ok).toBe(false);
    expect(check(`body { background: url(https://cdn.jsdelivr.net/gh/telium-chat/themes@0123abc/x.png) }`).ok).toBe(false);
    expect(check(`body { background: url(${CDN}../../../../attacker/repo@main/x.png) }`).ok).toBe(false);
    expect(check(`body { background: url(${CDN}%2e%2e/%2e%2e/%2e%2e/%2e%2e/attacker/x.png) }`).ok).toBe(false);
  });

  it('allows a theme its own declared asset URLs', () => {
    const assets = { 'bg.png': 'https://assets.example/bg.png' };
    expect(check(`body { background: url(bg.png) }`, assets).ok).toBe(true);
    const rewritten = rewriteAssetUrls(`body { background: url(bg.png) }`, assets);
    expect(checkThemeUrls(rewritten, assets, opts).ok).toBe(true);
  });

  it('passes the official Midnight Glass wallpaper rule', () => {
    const assets = { 'background.svg': `${CDN}background.svg` };
    const css = `${HEADER}body { background: url('background.svg') center / cover no-repeat fixed, oklch(16% 0.03 250); }`;
    expect(checkThemeUrls(rewriteAssetUrls(css, assets), assets, opts).ok).toBe(true);
  });

  it('lets fonts ship as theme assets through @font-face', () => {
    const assets = { 'inter.woff2': `${CDN}inter.woff2` };
    const css = `${HEADER}@font-face { font-family: Inter; src: url(inter.woff2) format("woff2"); }\n:root { --font-sans: Inter, sans-serif; }`;
    const rewritten = rewriteAssetUrls(css, assets);
    expect(rewritten).toContain(`url(${CDN}inter.woff2)`);
    expect(checkThemeUrls(rewritten, assets, opts).ok).toBe(true);
  });

  it('refuses to inject a blocked theme at all', () => {
    const verdict = applyMarketTheme(`${HEADER}body { background: url(https://evil.example/p.png) }`);
    expect(verdict.ok).toBe(false);
    expect(styleTag()).toBeNull();
  });

  it('a stored theme that fails the policy is not usable and drops its strings', () => {
    const storageImpl = store();
    installTheme('sneaky', `${HEADER}body { background: url(https://evil.example/p.png) }`, storageImpl, {
      strings: { 'settings.theme.preset.graphite.name': 'Hijacked' },
    });
    expect(installedTheme('sneaky', storageImpl)).toBeTruthy();
    expect(usableTheme('sneaky', storageImpl)).toBeNull();
    applyMarketThemeFromPrefs('sneaky', storageImpl);
    expect(styleTag()).toBeNull();
    expect(t('settings.theme.preset.graphite.name')).toBe('Graphite');
  });
});

describe('scanThemeCss', () => {
  it('collects url bodies and strings, decoded', () => {
    const { refs, imports } = scanThemeCss(`a { b: url( x\\2e png ); c: 'y' }`);
    expect(refs).toEqual(['x.png', 'y']);
    expect(imports).toBe(0);
  });
});

describe('asset basenames', () => {
  it('resolves a relative path by its filename, as the validator accepts it', () => {
    const out = rewriteAssetUrls(`body { background: url(images/bg.svg) }`, { 'bg.svg': `${CDN}bg.svg` });
    expect(out).toContain(`url(${CDN}bg.svg)`);
  });

  it('never rewrites an absolute URL that happens to share a filename', () => {
    const out = rewriteAssetUrls(`body { background: url(https://x.example/bg.svg) }`, { 'bg.svg': `${CDN}bg.svg` });
    expect(out).toContain('https://x.example/bg.svg');
  });
});

describe('protected wording', () => {
  it('a theme cannot reword security, shared buttons or its own off switch', () => {
    expect(themeMayReword('settings.market.community')).toBe(true);
    expect(themeMayReword('common.cancel')).toBe(false);
    expect(themeMayReword('security.verify.title')).toBe(false);
    expect(themeMayReword('chat.encryption.anything')).toBe(false);
    expect(themeMayReword('settings.market.active')).toBe(false);
    setThemeStrings({ 'common.cancel': 'Confirm', 'settings.theme.preset.graphite.name': 'Graphite (glass)' });
    expect(t('common.cancel')).not.toBe('Confirm');
    expect(t('settings.theme.preset.graphite.name')).toBe('Graphite (glass)');
  });
});

describe('download progress', () => {
  const css = `${HEADER}:root { --accent: red; }`;
  const body = (chunks) => new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });

  it('ignores a compressed Content-Length', async () => {
    const seen = [];
    await downloadTheme({
      id: 'compressed',
      cssUrl: 'https://cdn.example/x.css',
      onProgress: (p) => seen.push(p),
      fetchImpl: async () => ({
        ok: true,
        headers: { get: (name) => ({ 'content-length': '12', 'content-encoding': 'br' })[name] ?? null },
        body: body([css]),
      }),
    }, store());
    expect(seen.every((p) => p.total === null)).toBe(true);
  });

  it('drops to indeterminate once the body overruns its declared length', async () => {
    const seen = [];
    await downloadTheme({
      id: 'overrun',
      cssUrl: 'https://cdn.example/x.css',
      onProgress: (p) => seen.push(p),
      fetchImpl: async () => ({
        ok: true,
        headers: { get: (name) => (name === 'content-length' ? '40' : null) },
        body: body([css.slice(0, 30), css.slice(30)]),
      }),
    }, store());
    expect(seen[0].total).toBe(40);
    expect(seen.at(-1).total).toBeNull();
  });

  it('refuses a downloaded theme that breaks the policy', async () => {
    const outcome = await downloadTheme({
      id: 'tracker',
      cssUrl: 'https://cdn.example/x.css',
      fetchImpl: async () => ({ ok: true, arrayBuffer: async () => new TextEncoder().encode(`${HEADER}a{b:url(https://evil.example/p)}`).buffer }),
    }, store());
    expect(outcome.error).toBe(THEME_ERRORS.blocked);
    expect(outcome.blocked).toEqual(['evil.example']);
  });

  it('reports a full storage quota as quota, not a missing header', async () => {
    const full = { get: () => null, set: () => { throw new Error('QuotaExceededError'); } };
    const outcome = await downloadTheme({
      id: 'quota',
      cssUrl: 'https://cdn.example/x.css',
      fetchImpl: async () => ({ ok: true, arrayBuffer: async () => new TextEncoder().encode(css).buffer }),
    }, full);
    expect(outcome.error).toBe(THEME_ERRORS.quota);
  });
});

describe('local themes', () => {
  const css = `${HEADER}:root { --accent: red; }`;

  it('saves under an id the catalog can never use, and re-saves in place', () => {
    const storageImpl = store();
    const { theme } = saveLocalTheme(css, {}, storageImpl);
    expect(isLocalThemeId(theme.id)).toBe(true);
    expect(theme.id).not.toMatch(/^[a-z0-9][a-z0-9-]{2,39}$/);
    const again = saveLocalTheme(css.replace('red', 'blue'), { id: theme.id }, storageImpl);
    expect(again.theme.id).toBe(theme.id);
    expect(localThemes(storageImpl)).toHaveLength(1);
    expect(exportThemeCss(theme.id, storageImpl)).toContain('blue');
  });

  it('the same file gets the same id on every device, so sync never fights', () => {
    const laptop = store();
    const phone = store();
    const first = saveLocalTheme(css, {}, laptop).theme;
    const file = exportThemeCss(first.id, laptop);
    expect(file).toMatch(/@localId [a-z0-9-]+/);
    const second = saveLocalTheme(file, {}, phone).theme;
    expect(second.id).toBe(first.id);
    // Renaming in the editor keeps the id; re-importing replaces in place.
    const renamed = file.replace('@name Policy Test', '@name Renamed');
    expect(saveLocalTheme(renamed, { id: first.id }, laptop).theme.id).toBe(first.id);
    expect(saveLocalTheme(renamed, {}, phone).theme.id).toBe(first.id);
    expect(localThemes(phone)).toHaveLength(1);
    expect(parseThemeMetaName(exportThemeCss(first.id, phone))).toBe('Renamed');
  });

  it('holds a file from a friend to the same policy as the catalog', () => {
    const outcome = saveLocalTheme(`${HEADER}a { b: url(https://evil.example/p) }`, {}, store());
    expect(outcome.error).toBe(THEME_ERRORS.blocked);
    expect(saveLocalTheme(':root { --a: 1 }', {}, store()).error).toBe(THEME_ERRORS.noMeta);
    expect(saveLocalTheme(`${HEADER}${'x'.repeat(600 * 1024)}`, {}, store()).error).toBe(THEME_ERRORS.tooLarge);
  });

  it('Edit a copy renames the header and keeps the catalog images working', () => {
    const storageImpl = store();
    installTheme('midnight-glass', `${HEADER}body { background: url(bg.svg) }`, storageImpl, {
      assets: { 'bg.svg': `${CDN}bg.svg` },
    });
    const row = storageImpl.get('telium.themes.v1');
    row.installed['midnight-glass'].strings = { 'settings.market.community': 'Glass editions' };
    storageImpl.set('telium.themes.v1', row);
    const { theme } = copyThemeForEditing('midnight-glass', '(edited)', storageImpl);
    expect(theme.meta.name).toBe('Policy Test (edited)');
    expect(installedTheme(theme.id, storageImpl).strings).toEqual({ 'settings.market.community': 'Glass editions' });
    expect(exportThemeCss(theme.id, storageImpl)).toContain(`url(${CDN}bg.svg)`);
    expect(installedTheme('midnight-glass', storageImpl)).toBeTruthy();
  });
});
