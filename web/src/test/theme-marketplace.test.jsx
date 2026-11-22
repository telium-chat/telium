import { useEffect } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { mount, signedInStore } from './harness.jsx';
import { useStore, useStoreEvent } from '../hooks/useStore.jsx';
import { applyMarketThemeFromPrefs } from '../lib/themes.js';
import { ThemeMarketplaceSection } from '../views/user-settings/ThemeMarketplaceSection.jsx';
import { AppearancePane } from '../views/user-settings/AppearancePane.jsx';
import { PRESETS } from '../lib/scheme.js';

const CATALOG = {
  generatedAt: '2026-11-20T00:00:00Z',
  themes: [
    {
      id: 'midnight-glass', name: 'Midnight Glass', author: 'nova', version: '2.0.0',
      description: 'A glassy dark theme.', tags: ['dark', 'glass'], downloads: 12400,
      thumbnailUrl: 'https://cdn.jsdelivr.net/gh/telium-chat/themes@main/themes/midnight-glass/thumbnail.svg',
      cssUrl: 'https://cdn.jsdelivr.net/gh/telium-chat/themes@main/themes/midnight-glass/midnight-glass.theme.css',
    },
    {
      id: 'solar-flare', name: 'Solar Flare', author: 'ray', version: '0.1.0',
      description: 'Warm light theme.', tags: ['light'], downloads: 930,
      thumbnailUrl: null,
      cssUrl: 'https://cdn.jsdelivr.net/gh/telium-chat/themes@main/themes/solar-flare/solar-flare.theme.css',
    },
  ],
};

const THEME_CSS = `/**
 * @name Midnight Glass
 * @author nova
 * @version 2.0.0
 * @description A glassy dark theme.
*/
:root { --background: oklch(16% 0.03 250); --accent: oklch(79% 0.125 210); }
`;

const json = (body) => async () => ({
  ok: true,
  arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(body)).buffer,
});

const seeded = (row) => localStorage.setItem('telium.themes.catalog.v1', JSON.stringify({ at: Date.now(), text: JSON.stringify(row) }));

const styleTag = () => document.getElementById('telium-market-theme');

// Mirrors the App.jsx wiring: the pane writes `prefs.marketTheme` and the app
// shell is what turns the synced id into a style tag. Mounting the section
// alone needs the same bridge or nothing would apply it.
function PaneWithPrefsBridge({ base = [], baseActiveId = null, baseLocked = false }) {
  const store = useStore();
  useStoreEvent('prefs');
  useEffect(() => { applyMarketThemeFromPrefs(store.prefs.marketTheme); });
  return (
    <ThemeMarketplaceSection
      base={base}
      baseActiveId={baseActiveId}
      baseLocked={baseLocked}
      onChooseBase={(id) => {
        const preset = PRESETS.find((entry) => entry.id === id);
        if (preset) {
          store.prefs.scheme = preset.id;
          store.prefs.theme = preset.mode;
          store.savePrefs();
        }
      }}
    />
  );
}

const boot = async (props = {}) => {
  const mounted = mount(<PaneWithPrefsBridge {...props} />, signedInStore());
  await mounted.findAllByText(/Midnight Glass|Graphite/);
  return mounted;
};

describe('the theme workshop', () => {
  beforeEach(() => {
    localStorage.clear();
    document.getElementById('telium-market-theme')?.remove();
  });

  it('one grid: community themes first, included themes below', async () => {
    seeded(CATALOG);
    vi.stubGlobal('fetch', json(CATALOG));
    await boot({ base: PRESETS, baseActiveId: 'graphite' });
    // Community block, then the included block, graphite marked in use.
    expect(screen.getByText('From the community')).toBeTruthy();
    expect(screen.getAllByText('12.4k downloads').length).toBeGreaterThan(0);
    expect(screen.getByText('Included with Telium')).toBeTruthy();
    expect(screen.getByText('Graphite')).toBeTruthy();
    expect(screen.getByText('In use')).toBeTruthy();
    // One action button per card: install for community, the included cards are buttons themselves.
    expect(screen.getAllByRole('button', { name: 'Install' }).length).toBe(2);
    // A two-theme catalog has no meaningful "top", so trending stays hidden.
    expect(screen.queryByText('Trending')).toBeNull();
  });

  it('install applies in one tap: card goes Install → Active, style tag lands, prefs sync', async () => {
    seeded(CATALOG);
    vi.stubGlobal('fetch', async (url) => {
      if (String(url).endsWith('.css')) {
        return { ok: true, arrayBuffer: async () => new TextEncoder().encode(THEME_CSS).buffer };
      }
      return { ok: false };
    });
    const { user, store } = await boot();
    await user.click(screen.getAllByRole('button', { name: 'Install' })[0]);
    await waitFor(() => expect(store.prefs.marketTheme).toBe('midnight-glass'));
    expect(styleTag()?.textContent).toBe(THEME_CSS);
    expect(screen.getAllByRole('button', { name: 'Active' }).length).toBeGreaterThan(0);
    const installed = JSON.parse(localStorage.getItem('telium.themes.v1'));
    expect(installed.installed['midnight-glass'].meta.name).toBe('Midnight Glass');
    // This device's own install shows immediately instead of waiting for the
    // hourly CDN refresh.
    expect(screen.getAllByText('12.4k downloads').length).toBeGreaterThan(0);
    // 12.4k + a couple of installs still rounds to 12.4k, so prove the bump
    // on a count small enough to move: install the second theme too.
    await user.click(screen.getAllByRole('button', { name: 'Install' })[0]);
    await waitFor(() => expect(store.prefs.marketTheme).toBe('solar-flare'));
    expect(screen.getAllByText('931 downloads').length).toBeGreaterThan(0);
  });

  it('a stale catalog URL self-heals: refresh once, retry through the fresh URL', async () => {
    // First catalog fetch (stale cache miss → refresh) returns the OLD host;
    // the css download at the old URL fails; the second catalog fetch returns
    // the NEW host and the retry succeeds through it.
    const stale = { ...CATALOG, themes: CATALOG.themes.map((t) => ({ ...t, cssUrl: t.cssUrl.replace('cdn.jsdelivr.net', 'dead.example.invalid') })) };
    let catalogFetches = 0;
    vi.stubGlobal('fetch', async (url) => {
      const u = String(url);
      if (u.endsWith('catalog.json')) {
        catalogFetches += 1;
        return json(catalogFetches === 1 ? stale : CATALOG)();
      }
      if (u.includes('dead.example.invalid')) return { ok: false, status: 404 };
      if (u.endsWith('.css')) {
        return { ok: true, arrayBuffer: async () => new TextEncoder().encode(THEME_CSS).buffer };
      }
      return { ok: false };
    });
    const { user, store } = await boot();
    await user.click(screen.getAllByRole('button', { name: 'Install' })[0]);
    await waitFor(() => expect(store.prefs.marketTheme).toBe('midnight-glass'));
    expect(styleTag()?.textContent).toBe(THEME_CSS);
    expect(catalogFetches).toBe(2);
  });

  it('tapping the active theme turns it off', async () => {
    seeded(CATALOG);
    localStorage.setItem('telium.themes.v1', JSON.stringify({
      installed: { 'midnight-glass': { meta: { name: 'Midnight Glass', author: 'nova', description: 'd' }, css: THEME_CSS, installedAt: Date.now() } },
      active: null,
    }));
    vi.stubGlobal('fetch', json(CATALOG));
    const { user, store } = await boot();
    store.prefs.marketTheme = 'midnight-glass';
    store.savePrefs();
    expect(styleTag()?.textContent).toBe(THEME_CSS);
    await user.click(screen.getAllByRole('button', { name: 'Active' })[0]);
    await waitFor(() => expect(store.prefs.marketTheme).toBeNull());
    expect(styleTag()).toBeNull();
    // Back to a plain Apply: the theme stays installed.
    expect(screen.getAllByRole('button', { name: 'Apply' }).length).toBeGreaterThan(0);
  });

  it('a base-theme card applies the included palette in one tap', async () => {
    seeded(CATALOG);
    vi.stubGlobal('fetch', json(CATALOG));
    const { user, store } = await boot({ base: PRESETS, baseActiveId: 'graphite' });
    await user.click(screen.getByText('Evergreen'));
    expect(store.prefs.scheme).toBe('evergreen');
    expect(store.prefs.theme).toBe('dark');
  });

  it('included themes are locked while a community theme is active', async () => {
    seeded(CATALOG);
    vi.stubGlobal('fetch', json(CATALOG));
    const { user, store } = mount(
      <PaneWithPrefsBridge base={PRESETS} baseActiveId="graphite" baseLocked />,
      signedInStore({ prefs: { marketTheme: 'midnight-glass', scheme: 'graphite', theme: 'dark' } }),
    );
    await screen.findByText(/Included with Telium/);
    expect(screen.getByText(/included themes are paused/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Evergreen/ }).disabled).toBe(true);
    await user.click(screen.getByText('Paper'));
    expect(store.prefs.scheme).toBe('graphite');
  });

  it('filters: Favorites narrows to starred', async () => {
    seeded(CATALOG);
    vi.stubGlobal('fetch', json(CATALOG));
    const { user } = await boot({ base: PRESETS, baseActiveId: 'graphite' });
    await user.click(screen.getAllByRole('button', { name: 'Keep Midnight Glass in your favorites' })[0]);
    await user.click(screen.getByRole('button', { name: 'Favorites' }));
    expect(screen.getAllByText('Midnight Glass').length).toBeGreaterThan(0);
    expect(screen.queryByText('Solar Flare')).toBeNull();
    expect(screen.queryByText('Included with Telium')).toBeNull();
  });

  it('the search field narrows the grid across community and included themes', async () => {
    seeded(CATALOG);
    vi.stubGlobal('fetch', json(CATALOG));
    const { user } = await boot({ base: PRESETS, baseActiveId: 'graphite' });
    await user.type(screen.getByLabelText('Search themes'), 'solar');
    expect(screen.queryByText('Midnight Glass')).toBeNull();
    expect(screen.queryByText('Graphite')).toBeNull();
    expect(screen.getByText('Solar Flare')).toBeTruthy();
    await user.click(screen.getByLabelText('Clear search'));
    expect((await screen.findAllByText('Midnight Glass')).length).toBeGreaterThan(0);
    expect(screen.getByText('Graphite')).toBeTruthy();
  });

  it('an unreachable catalog still shows the included themes and an honest error', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 0 }));
    const { user, store } = mount(
      <PaneWithPrefsBridge base={PRESETS} baseActiveId="graphite" />,
      signedInStore({ prefs: { scheme: 'graphite', theme: 'dark' } }),
    );
    expect(await screen.findByText(/could not be reached/)).toBeTruthy();
    expect(screen.getByText('Graphite')).toBeTruthy();
    vi.stubGlobal('fetch', json(CATALOG));
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect((await screen.findAllByText('Midnight Glass')).length).toBeGreaterThan(0);
    void store;
  });

  it('a theme file without its meta header is refused with an explanation', async () => {
    seeded(CATALOG);
    vi.stubGlobal('fetch', async (url) => {
      if (String(url).endsWith('.css')) return { ok: true, arrayBuffer: async () => new TextEncoder().encode(':root {}').buffer };
      return { ok: false };
    });
    const { user } = await boot();
    await user.click(screen.getAllByRole('button', { name: 'Install' })[0]);
    expect(await screen.findByText(/missing its name, author, or description/)).toBeTruthy();
    expect(styleTag()).toBeNull();
    expect(localStorage.getItem('telium.themes.v1')).toBeNull();
  });

  it('the whole pane is reachable as the Themes settings page', async () => {
    vi.stubGlobal('fetch', json(CATALOG));
    const mounted = mount(<AppearancePane />, signedInStore({ prefs: { scheme: 'graphite', theme: 'dark' } }));
    await mounted.findByText('Themes', { selector: 'h3' });
    expect(screen.getByText('Included with Telium')).toBeTruthy();
    expect(screen.getByText('From the community')).toBeTruthy();
  });
});
