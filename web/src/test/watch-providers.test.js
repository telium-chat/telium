import { describe, expect, it } from 'vitest';
import {
  WATCH_PROVIDERS, embedUrl, hostOf, narrow, providerById, sourceFor, trustsOrigin,
} from '../lib/watch/providers.js';
import { RATES, readNote, readSource, readTimeline } from '../lib/watch/protocol.js';

describe('what a pasted link turns out to be', () => {
  it('reads the shapes a YouTube link is copied in', () => {
    const id = 'dQw4w9WgXcQ';
    for (const url of [
      `https://www.youtube.com/watch?v=${id}`,
      `https://youtu.be/${id}`,
      `https://m.youtube.com/watch?v=${id}&feature=share`,
      `https://www.youtube.com/shorts/${id}`,
      `https://www.youtube.com/live/${id}`,
      `https://www.youtube.com/embed/${id}`,
    ]) {
      expect(sourceFor(url)).toMatchObject({ provider: 'youtube', id });
    }
  });

  it('keeps the moment a link was shared at, however it was written', () => {
    const id = 'dQw4w9WgXcQ';
    expect(sourceFor(`https://youtu.be/${id}?t=90`).start).toBe(90);
    expect(sourceFor(`https://www.youtube.com/watch?v=${id}&t=1h2m3s`).start).toBe(3723);
    expect(sourceFor(`https://www.youtube.com/watch?v=${id}&t=nonsense`).start).toBe(0);
  });

  it('keeps the token an unlisted Vimeo video is addressed by', () => {
    expect(sourceFor('https://vimeo.com/123456789/abc123')).toMatchObject({
      provider: 'vimeo', id: '123456789', hash: 'abc123',
    });
    expect(sourceFor('https://vimeo.com/123456789?h=abc123').hash).toBe('abc123');
    expect(sourceFor('https://vimeo.com/123456789').hash).toBeNull();
  });

  it('takes a video file for what it is and nothing else', () => {
    expect(sourceFor('https://files.example.org/a.mp4')).toMatchObject({ provider: 'file' });
    expect(sourceFor('https://files.example.org/a.m3u8').hls).toBe(true);
    expect(sourceFor('https://example.org/watch/great-film')).toBeNull();
  });

  it('refuses anything that is not a video on a service it can drive', () => {
    expect(sourceFor('http://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBeNull();
    expect(sourceFor('https://www.youtube.com/watch?v=short')).toBeNull();
    expect(sourceFor('https://www.youtube.com/feed/subscriptions')).toBeNull();
    expect(sourceFor('https://not-youtube.example/watch?v=dQw4w9WgXcQ')).toBeNull();
    expect(sourceFor('javascript:alert(1)')).toBeNull();
    expect(sourceFor('')).toBeNull();
    expect(sourceFor(null)).toBeNull();
  });
});

describe('the URL a frame is actually pointed at', () => {
  it('embeds YouTube on the host that does not set advertising cookies', () => {
    const url = new URL(embedUrl(sourceFor('https://youtu.be/dQw4w9WgXcQ?t=30')));
    expect(url.hostname).toBe('www.youtube-nocookie.com');
    expect(url.pathname).toBe('/embed/dQw4w9WgXcQ');
    expect(url.searchParams.get('enablejsapi')).toBe('1');
    expect(url.searchParams.get('autoplay')).toBe('0');
    expect(url.searchParams.get('start')).toBe('30');
    expect(hostOf(sourceFor('https://youtu.be/dQw4w9WgXcQ'))).toBe('www.youtube-nocookie.com');
  });

  it('names this origin as the one that may drive the player', () => {
    const url = new URL(embedUrl(sourceFor('https://youtu.be/dQw4w9WgXcQ')));
    expect(url.searchParams.get('origin')).toBe(window.location.origin);
  });

  it('says nothing rather than `file://` where the renderer was loaded off disk', () => {
    const real = window.location.origin;
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, origin: 'file://' },
    });
    try {
      const url = new URL(embedUrl(sourceFor('https://youtu.be/dQw4w9WgXcQ')));
      expect(url.searchParams.get('origin')).toBe('');
    } finally {
      Object.defineProperty(window, 'location', {
        configurable: true,
        value: { ...window.location, origin: real },
      });
    }
  });

  it('asks Vimeo not to track the session', () => {
    const url = new URL(embedUrl(sourceFor('https://vimeo.com/123456789/abc123')));
    expect(url.hostname).toBe('player.vimeo.com');
    expect(url.searchParams.get('dnt')).toBe('1');
    expect(url.searchParams.get('h')).toBe('abc123');
  });

  it('names the host a file would really be fetched from, since there is no embed', () => {
    expect(hostOf(sourceFor('https://files.example.org/a.mp4'))).toBe('files.example.org');
  });

  it('trusts exactly the origin its own player speaks from', () => {
    const youtube = sourceFor('https://youtu.be/dQw4w9WgXcQ');
    expect(trustsOrigin(youtube, 'https://www.youtube-nocookie.com')).toBe(true);
    expect(trustsOrigin(youtube, 'https://www.youtube.com')).toBe(false);
    expect(trustsOrigin(youtube, 'https://player.vimeo.com')).toBe(false);
    expect(trustsOrigin(youtube, 'null')).toBe(false);
    expect(trustsOrigin(sourceFor('https://files.example.org/a.mp4'), 'https://files.example.org'))
      .toBe(false);
  });
});

describe('what an operator left standing', () => {
  const all = WATCH_PROVIDERS.map((p) => p.id);

  it('gives a server that says nothing the built-in list', () => {
    expect(narrow(null)).toEqual(all);
    expect(narrow({})).toEqual(all);
    expect(narrow({ watch_together: { enabled: true, providers: [] } })).toEqual(all);
  });

  it('obeys a narrowing, and cannot be turned into a widening', () => {
    expect(narrow({ watch_together: { providers: ['youtube'] } })).toEqual(['youtube']);
    expect(narrow({ watch_together: { providers: ['youtube', 'netflix'] } })).toEqual(['youtube']);
  });

  it('lets an operator refuse the whole thing', () => {
    expect(narrow({ watch_together: { enabled: false } })).toEqual([]);
    expect(narrow({ watch_together: { enabled: false, providers: ['youtube'] } })).toEqual([]);
  });

  it('will not parse a link for a provider this server does not allow', () => {
    const url = 'https://youtu.be/dQw4w9WgXcQ';
    expect(sourceFor(url, { allowed: ['vimeo'] })).toBeNull();
    expect(sourceFor(url, { allowed: ['youtube'] })).toMatchObject({ provider: 'youtube' });
  });
});

describe('reading a note off the wire', () => {
  const line = { seq: 3, by: '@b:h', at: 1_000, position: 12, rate: 1, paused: false };

  it('rebuilds a source from its id rather than believing a URL', () => {
    const read = readSource({ provider: 'youtube', id: 'dQw4w9WgXcQ', url: 'https://evil.example/x' });
    expect(read).toEqual({ provider: 'youtube', id: 'dQw4w9WgXcQ', start: 0 });
    expect(new URL(embedUrl(read)).hostname).toBe('www.youtube-nocookie.com');
  });

  it('drops a source whose id is not one', () => {
    expect(readSource({ provider: 'youtube', id: '../../evil' })).toBeNull();
    expect(readSource({ provider: 'youtube', id: 'dQw4w9WgXcQ?x=1' })).toBeNull();
    expect(readSource({ provider: 'vimeo', id: 'abc' })).toBeNull();
    expect(readSource({ provider: 'netflix', id: '1' })).toBeNull();
    expect(readSource(null)).toBeNull();
  });

  it('round-trips a file URL through the parser that decides what is playable', () => {
    expect(readSource({ provider: 'file', url: 'https://files.example.org/a.mp4' }))
      .toMatchObject({ provider: 'file' });
    expect(readSource({ provider: 'file', url: 'https://files.example.org/a.exe' })).toBeNull();
    expect(readSource({ provider: 'file', url: 'javascript:alert(1)' })).toBeNull();
  });

  it('refuses a timeline that would wedge or throw inside a player', () => {
    expect(readTimeline(line)).toEqual(line);
    expect(readTimeline({ ...line, position: Infinity })).toBeNull();
    expect(readTimeline({ ...line, position: -5 })).toBeNull();
    expect(readTimeline({ ...line, rate: 0 })).toBeNull();
    expect(readTimeline({ ...line, rate: 37 })).toBeNull();
    expect(readTimeline({ ...line, seq: 'soon' })).toBeNull();
    for (const rate of RATES) expect(readTimeline({ ...line, rate }).rate).toBe(rate);
  });

  it('normalises the notes it knows and drops the rest', () => {
    expect(readNote({ k: 'line', id: 's1', timeline: line })).toMatchObject({ k: 'line', id: 's1' });
    expect(readNote({ k: 'ping', id: 's1', t0: 5 })).toEqual({ k: 'ping', id: 's1', t0: 5 });
    expect(readNote({ k: 'stall', id: 's1', on: 'yes' })).toEqual({ k: 'stall', id: 's1', on: true });
    expect(readNote({ k: 'end', id: 's1' })).toEqual({ k: 'end', id: 's1' });
    expect(readNote({ k: 'end' })).toBeNull();
    expect(readNote({ k: 'exec', id: 's1' })).toBeNull();
    expect(readNote('not an object')).toBeNull();
    expect(readNote({ k: 'state', id: 's1', timeline: line })).toBeNull();
  });
});

describe('the registry the rest of the client sees', () => {
  it('publishes the host a consent prompt has to name, and nothing to drive it with', () => {
    for (const entry of WATCH_PROVIDERS) {
      expect(providerById(entry.id)).not.toBeNull();
      expect(Object.keys(entry).sort()).toEqual(['embedHost', 'id', 'kind', 'name']);
    }
  });
});
