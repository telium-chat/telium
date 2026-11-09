import { describe, expect, it } from 'vitest';
import { brandMarkUrl, markUrlFor } from '../lib/brand-mark.js';

describe('brand mark in a packaged desktop renderer', () => {
  it('uses the packaged renderer/brand asset, independent of the document route', () => {
    const entry = 'file:///tmp/.mount_Telium/resources/app.asar/renderer/assets/index-BHmKnswn.js';
    expect(markUrlFor('desktop', entry)).toBe(
      'file:///tmp/.mount_Telium/resources/app.asar/renderer/brand/telium-mark-gradient.svg',
    );
    // Navigating to /channels/... must not affect this asset URL. There is no
    // dependence on document URL or location.pathname.
    expect(markUrlFor('desktop', entry)).toBe(markUrlFor('desktop', entry));
  });

  it('keeps the canonical web URL for browsers and other native shells', () => {
    const entry = 'https://telium.chat/assets/index-abc123.js';
    expect(markUrlFor('web', entry)).toBe('/brand/telium-mark-gradient.svg');
    expect(markUrlFor('android', entry)).toBe('/brand/telium-mark-gradient.svg');
  });

  it('defaults to the web mark when tests do not set a desktop build runtime', () => {
    expect(brandMarkUrl).toBe('/brand/telium-mark-gradient.svg');
  });
});
