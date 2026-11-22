// Drives the real App shell end-to-end for the market theme: the fake server
// signs us in, the marketplace is seeded device-local, and prefs flip through
// the store exactly as a click would. Asserts what actually lands in the DOM.
import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { signedInApp } from './harness.jsx';
import { createFakeServer } from './fake-server.js';

const THEME_CSS = `/**
 * @name Midnight Glass
 * @author nova
 * @version 1.0.0
 * @description test
*/
:root { --background: oklch(8% 0.02 286); --accent: oklch(80% 0.2 100); }
`;

const installLocally = () => {
  localStorage.setItem('telium.themes.v1', JSON.stringify({
    installed: { 'midnight-glass': { meta: { name: 'Midnight Glass', author: 'nova', description: 'test' }, css: THEME_CSS, installedAt: Date.now() } },
    active: null,
  }));
};

describe('market theme applied through the real app shell', () => {
  it('activating a theme puts its css in a style tag and its tokens win over the scheme', async () => {
    installLocally();
    const { server, store, user } = await signedInApp(createFakeServer());
    void server;

    // A non-native scheme paints its palette as inline styles on <html> —
    // exactly what a user who touched the appearance knobs has. The theme
    // must win over that, so this is the interesting case, not the default.
    store.prefs.scheme = 'obsidian';
    store.savePrefs();

    // Through the pane the way a click would: seed prefs the way apply() does.
    store.prefs.marketTheme = 'midnight-glass';
    store.savePrefs();

    await waitFor(() => {
      const tag = document.getElementById('telium-market-theme');
      expect(tag).toBeTruthy();
      expect(tag.textContent).toBe(THEME_CSS);
    });

    // The point of the feature: the theme's values actually render. Inline
    // scheme vars on <html> would override any stylesheet, so with a theme
    // active they must be gone — and `data-scheme=market` keeps the derived
    // tokens (hover, link, focus) re-deriving from the theme's own accent.
    const root = document.documentElement;
    expect(root.style.getPropertyValue('--background')).toBe('');
    expect(root.dataset.scheme).toBe('market');
    const background = getComputedStyle(root).getPropertyValue('--background').trim();
    expect(background).toContain('oklch(8%');
    // jsdom does not resolve var() chains from stylesheets, so --link's
    // re-derivation (`--link: var(--accent)` in scheme.css) is asserted by
    // the data-scheme attribute above rather than a computed value here.

    // Deactivating restores the scheme machinery.
    store.prefs.marketTheme = null;
    store.savePrefs();
    await waitFor(() => expect(document.getElementById('telium-market-theme')).toBeNull());
    await waitFor(() => {
      expect(root.dataset.scheme).toBe('obsidian');
      expect(getComputedStyle(root).getPropertyValue('--background').trim()).not.toContain('oklch(8%');
    });
    void user;
    vi.restoreAllMocks();
  });
});
