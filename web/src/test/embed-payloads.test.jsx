import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StoreProvider } from '../hooks/useStore.jsx';
import { Embeds } from '../views/chat/Embeds.jsx';
import { embedFor, forgetEmbeds, proxiedAsset, readEmbed } from '../lib/embeds.js';

const BASE = 'https://guild.example';
const CAMO = `${BASE}/_telium/v1/camo/abc`;
const CLIP = `${BASE}/_telium/v1/camo/clip`;
const LINK = 'https://news.example/story';

const ok = (extra) => readEmbed({ status: 'ok', ...extra }, { base: BASE, url: LINK });

describe('an asset on a link card', () => {
  it.each([
    'https://tracker.example/pixel.gif',
    'https://tracker.example/_telium/v1/camo/abc',
    'http://guild.example/_telium/v1/camo/abc',
    'https://guild.example:8443/_telium/v1/camo/abc',
    'https://guild.example/anything/else',
    'https://guild.example/_telium/v1/camo',
    '/_telium/v1/camo/abc',
    '//tracker.example/_telium/v1/camo/abc',
    'data:image/svg+xml,<svg onload="alert(1)"/>',
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'java\tscript:alert(1)',
    '\u0000javascript:alert(1)',
    '  javascript:alert(1)  ',
    'blob:https://guild.example/1234',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    'https://user:pw@guild.example/_telium/v1/camo/abc',
    '',
    null, undefined, 42, {}, [], { toString: () => CAMO },
  ])('refuses %j', (image) => {
    expect(proxiedAsset(BASE, image)).toBeNull();
    expect(ok({ image }).image).toBeNull();
  });

  it('admits the answering server\'s own camo and media objects', () => {
    expect(ok({ image: CAMO }).image).toBe(CAMO);
    expect(proxiedAsset(BASE, `${BASE}/_telium/v1/media/abc`)).toBe(`${BASE}/_telium/v1/media/abc`);
  });

  it('applies the same rule to video and drops the type with a refused video', () => {
    expect(ok({ video: CLIP }).video).toBe(CLIP);
    const card = ok({ video: 'https://tracker.example/clip.mp4', video_type: 'video/mp4' });
    expect(card.video).toBeNull();
    expect(card.video_type).toBeNull();
  });

  it.each([
    ['video/mp4', 'video/mp4'],
    ['video/webm; codecs="vp9, opus"', 'video/webm; codecs="vp9, opus"'],
    ['prose', null],
    ['video/mp4"><script>alert(1)</script>', null],
    ['video/mp4; evil=1', null],
  ])('video_type %j -> %j', (video_type, expected) => {
    expect(ok({ video: CLIP, video_type }).video_type).toBe(expected);
  });
});

describe('what a link card is allowed to say', () => {
  it('links to the message URL and names its host, not the payload\'s claims', () => {
    const card = ok({ url: 'https://phish.test/collect', site: 'yourbank.example', title: 'Your bank' });
    expect(card.url).toBe(LINK);
    expect(card.site).toBe('news.example');
  });

  it.each([
    'javascript:alert(document.cookie)',
    'data:text/html,<script>alert(1)</script>',
    'telium://forward/a/b/c',
    '/settings/account',
    'not a url',
  ])('draws no card for the non-web link %j', (url) => {
    expect(readEmbed({ status: 'ok', title: 'x' }, { base: BASE, url })).toBeNull();
  });

  it('strips bidi overrides and invisible characters', () => {
    expect(ok({ title: 'Sign in‮moc.knabruoy‬', description: 'a​b﻿c' }))
      .toMatchObject({ title: 'Sign inmoc.knabruoy', description: 'abc' });
    expect(ok({ title: 'news­.example⁠ \u{E0041}\u{E0042}bank', description: 'a⁣b' }))
      .toMatchObject({ title: 'news.example bank', description: 'ab' });
  });

  it('bounds copy length and refuses unknown layouts', () => {
    const card = ok({ title: 'x'.repeat(100_000), description: 'y'.repeat(100_000) });
    expect(card.title.length).toBe(256);
    expect(card.description.length).toBe(512);
    expect(ok({ kind: 'iframe' }).kind).toBe('link');
    expect(ok({ kind: 'image' }).kind).toBe('image');
  });

  it.each([0, -16, 1e9, Number.POSITIVE_INFINITY, Number.NaN, '1e9', 'not a number', {}])(
    'refuses the video width %j',
    (video_width) => { expect(ok({ video_width }).video_width).toBeNull(); },
  );

  it('accepts a pixel count written as a string', () => {
    expect(ok({ video_width: '1280', video_height: '720' })).toMatchObject({ video_width: 1280, video_height: 720 });
  });

  it.each([[{ status: 'error' }], [{}], [null], ['ok'], [[{ status: 'ok' }]]])(
    'draws nothing for %j',
    (raw) => { expect(readEmbed(raw, { base: BASE, url: LINK })).toBeNull(); },
  );
});

const HOSTILE = {
  status: 'ok',
  kind: 'link',
  url: 'https://phish.test/collect',
  site: 'yourbank.example',
  title: 'Sign in to continue',
  image: 'https://tracker.example/pixel.gif',
  video: 'https://tracker.example/clip.mp4',
};

describe('the card as it is fetched and drawn', () => {
  it('normalises inside embedFor, so no caller sees a raw payload', async () => {
    forgetEmbeds();
    const card = await embedFor({ base: BASE, embed: vi.fn(async () => HOSTILE) }, LINK);
    expect(card).toMatchObject({ url: LINK, site: 'news.example', image: null, video: null });
    forgetEmbeds();
  });

  it('draws the words, links to the message URL, and loads nothing from the tracker', async () => {
    forgetEmbeds();
    const api = { base: BASE, embed: async () => ({ ...HOSTILE, url_hash: 'h1' }) };
    const store = { channels: new Map([['c1', { id: 'c1' }]]), apiForChannel: () => api, on: () => () => {} };
    const { container } = render(
      <StoreProvider store={store}>
        <Embeds msg={{ id: 'm1', channel_id: 'c1', content: `look at this ${LINK}` }} />
      </StoreProvider>,
    );
    await screen.findByText('Sign in to continue');
    expect(container.innerHTML).not.toContain('tracker.example');
    expect(container.querySelector('img')).toBeNull();
    const anchor = container.querySelector('a[href]');
    expect(anchor.getAttribute('href')).toBe(LINK);
    expect(anchor.getAttribute('rel')).toContain('noopener');
    expect(anchor.getAttribute('rel')).toContain('noreferrer');
    expect(screen.getByText('news.example')).toBeTruthy();
    expect(screen.queryByText('yourbank.example')).toBeNull();
  });
});
