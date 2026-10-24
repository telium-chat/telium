import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_EMBEDS, embedFor, forgetEmbeds, linksIn } from '../lib/embeds.js';

afterEach(() => { forgetEmbeds(); });

describe('linksIn', () => {
  it('finds the bare links in a line', () => {
    expect(linksIn('see https://a.example/x and http://b.example')).toEqual([
      'https://a.example/x', 'http://b.example',
    ]);
  });

  it('leaves the sentence\u2019s punctuation out of the URL', () => {
    expect(linksIn('read https://a.example.')).toEqual(['https://a.example']);
    expect(linksIn('(https://a.example/x)')).toEqual(['https://a.example/x']);
    expect(linksIn('"https://a.example/x", he said')).toEqual(['https://a.example/x']);
  });

  it('ignores a link inside code, which is quotation rather than reference', () => {
    expect(linksIn('`https://a.example`')).toEqual([]);
    expect(linksIn('```\nhttps://a.example\n```')).toEqual([]);
    expect(linksIn('`https://a.example` but https://b.example')).toEqual(['https://b.example']);
  });

  it('cards one link once, however many times it was pasted', () => {
    expect(linksIn('https://a.example https://a.example')).toEqual(['https://a.example']);
  });

  it('stops at the cap rather than drawing a wall of cards', () => {
    const many = ['https://1.example', 'https://2.example', 'https://3.example', 'https://4.example'];
    expect(linksIn(many.join(' '))).toHaveLength(MAX_EMBEDS);
    expect(linksIn(many.join(' '))).toEqual(many.slice(0, MAX_EMBEDS));
  });

  it('survives a message that is not a string', () => {
    expect(linksIn('')).toEqual([]);
    expect(linksIn(null)).toEqual([]);
    expect(linksIn(undefined)).toEqual([]);
    expect(linksIn('no links here')).toEqual([]);
  });
});

describe('embedFor', () => {
  const server = (base, answer) => ({ base, embed: vi.fn(async () => answer) });

  it('asks the guild server once per URL, however many renders there are', async () => {
    const api = server('https://guild.example', { status: 'ok', title: 'A page' });

    const first = await embedFor(api, 'https://a.example');
    const second = await embedFor(api, 'https://a.example');

    expect(first.title).toBe('A page');
    expect(second).toBe(first);
    expect(api.embed).toHaveBeenCalledTimes(1);
  });

  it('keys the cache by server as well as URL', async () => {
    const one = server('https://one.example', { status: 'ok', title: 'One' });
    const two = server('https://two.example', { status: 'ok', title: 'Two' });

    expect((await embedFor(one, 'https://a.example')).title).toBe('One');
    expect((await embedFor(two, 'https://a.example')).title).toBe('Two');
    expect(one.embed).toHaveBeenCalledTimes(1);
    expect(two.embed).toHaveBeenCalledTimes(1);
  });

  it('answers null for a refusal instead of rejecting, and does not ask again', async () => {
    const api = server('https://guild.example', { status: 'error' });

    expect(await embedFor(api, 'https://a.example')).toBe(null);
    expect(await embedFor(api, 'https://a.example')).toBe(null);
    expect(api.embed).toHaveBeenCalledTimes(1);
  });

  it('answers null for a thrown request rather than letting it reach a render', async () => {
    const api = { base: 'https://guild.example', embed: vi.fn(async () => { throw new Error('offline'); }) };
    await expect(embedFor(api, 'https://a.example')).resolves.toBe(null);
  });

  it('answers null with no server to ask', async () => {
    await expect(embedFor(null, 'https://a.example')).resolves.toBe(null);
  });

  it('lets a refusal expire, so a stranger cannot suppress a preview for the session', async () => {
    const api = server('https://guild.example', { status: 'error' });
    const clock = vi.spyOn(Date, 'now');

    clock.mockReturnValue(1_000_000);
    expect(await embedFor(api, 'https://a.example')).toBe(null);
    clock.mockReturnValue(1_000_000 + 4 * 60 * 1000);
    expect(await embedFor(api, 'https://a.example')).toBe(null);
    expect(api.embed).toHaveBeenCalledTimes(1);

    clock.mockReturnValue(1_000_000 + 6 * 60 * 1000);
    expect(await embedFor(api, 'https://a.example')).toBe(null);
    expect(api.embed).toHaveBeenCalledTimes(2);

    clock.mockRestore();
  });

  it('retries a request that never completed far sooner than one the server answered', async () => {
    const api = { base: 'https://guild.example', embed: vi.fn(async () => { throw new Error('rate limited'); }) };
    const clock = vi.spyOn(Date, 'now');

    clock.mockReturnValue(2_000_000);
    expect(await embedFor(api, 'https://a.example')).toBe(null);
    clock.mockReturnValue(2_000_000 + 20 * 1000);
    expect(await embedFor(api, 'https://a.example')).toBe(null);

    expect(api.embed).toHaveBeenCalledTimes(2);
    clock.mockRestore();
  });

  it('shares one request between rows rendering the same link in the same tick', async () => {
    const api = server('https://guild.example', { status: 'ok', title: 'A page' });

    const [one, two] = await Promise.all([
      embedFor(api, 'https://a.example'),
      embedFor(api, 'https://a.example'),
    ]);

    expect(one).toBe(two);
    expect(api.embed).toHaveBeenCalledTimes(1);
  });

  it('holds a bounded number of entries, so a rotating artwork URL cannot grow it forever', async () => {
    const api = server('https://guild.example', { status: 'ok', title: 'A page' });

    for (let i = 0; i < 600; i += 1) await embedFor(api, `https://a.example/${i}`);
    expect(api.embed).toHaveBeenCalledTimes(600);

    await embedFor(api, 'https://a.example/599');
    expect(api.embed).toHaveBeenCalledTimes(600);

    await embedFor(api, 'https://a.example/0');
    expect(api.embed).toHaveBeenCalledTimes(601);
  });

  it('forgets everything on sign-out, because a cached unfurl names what was read', async () => {
    const api = server('https://guild.example', { status: 'ok', title: 'A page' });

    await embedFor(api, 'https://a.example');
    forgetEmbeds();
    await embedFor(api, 'https://a.example');

    expect(api.embed).toHaveBeenCalledTimes(2);
  });
});
