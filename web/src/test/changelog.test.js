import { describe, expect, it } from 'vitest';
import {
  cacheChangelog, cachedChangelog, cacheIsFresh, fetchChangelog, FETCH_ERRORS,
  hasUnreadChangelog, markRead, parseChangelog, readMarker, refreshChangelog,
} from '../lib/changelog.js';

const SAMPLE = `
<!--
contract comment, skipped by the parser
-->

# Telium changelog

## 15 October 2026

- Feedback came in-app: **Settings → Help & feedback**.
- The desktop address field opens the web client.

### Fixed

- A DM frame from a forgotten session no longer stalls delivery.

## 14 October 2026

Everything in this section is a paragraph, not a bullet.

## Older still

- the oldest entry
`;

const store = () => {
  const data = new Map();
  return {
    get: (key, fallback) => (data.has(key) ? JSON.parse(data.get(key)) : fallback),
    set: (key, value) => { data.set(key, JSON.stringify(value)); },
  };
};

const fetchReturning = (body, ok = true) => async () => ({
  ok,
  arrayBuffer: async () => new TextEncoder().encode(body).buffer,
});

describe('parseChangelog', () => {
  it('splits sections, bullets, subheadings and paragraphs', () => {
    const parsed = parseChangelog(SAMPLE);
    expect(parsed.latest).toBe('15 October 2026');
    expect(parsed.sections.map((s) => s.heading)).toEqual([
      '15 October 2026', '14 October 2026', 'Older still',
    ]);
    const first = parsed.sections[0].blocks;
    expect(first.filter((b) => b.kind === 'bullet')).toHaveLength(3);
    expect(first.some((b) => b.kind === 'subheading' && b.text === 'Fixed')).toBe(true);
    expect(parsed.sections[1].blocks).toEqual([
      { kind: 'para', text: 'Everything in this section is a paragraph, not a bullet.' },
    ]);
  });

  it('skips everything before the first section', () => {
    const parsed = parseChangelog(SAMPLE);
    expect(JSON.stringify(parsed)).not.toContain('contract comment');
    expect(JSON.stringify(parsed)).not.toContain('Telium changelog');
  });

  it('sees nothing in nothing', () => {
    expect(parseChangelog('')).toBe(null);
    expect(parseChangelog('   \n  ')).toBe(null);
    expect(parseChangelog('no headings at all, just prose')).toBe(null);
  });
});

describe('fetchChangelog', () => {
  it('returns the text on success', async () => {
    const result = await fetchChangelog({ fetchImpl: fetchReturning(SAMPLE) });
    expect(result.text).toBe(SAMPLE);
  });

  it('answers unreachable for a refused or failing response', async () => {
    const refused = await fetchChangelog({ fetchImpl: fetchReturning('', false) });
    expect(refused.error).toBe(FETCH_ERRORS.unreachable);
    const thrown = await fetchChangelog({
      fetchImpl: async () => { throw new Error('down'); },
    });
    expect(thrown.error).toBe(FETCH_ERRORS.unreachable);
  });

  it('answers unreachable when the fetch never comes back inside the timeout', async () => {
    const stuck = await fetchChangelog({
      fetchImpl: () => new Promise(() => {}),
      timeoutMs: 1,
    });
    expect(stuck.error).toBe(FETCH_ERRORS.unreachable);
  });

  it('refuses a body over the cap rather than rendering it', async () => {
    const big = await fetchChangelog({
      fetchImpl: fetchReturning('x'.repeat(300 * 1024)),
      maxBytes: 256 * 1024,
    });
    expect(big.error).toBe(FETCH_ERRORS.tooLarge);
  });
});

describe('the read marker and the cache', () => {
  it('a saved copy does not disturb what has been read, and marking read keeps the copy', () => {
    const s = store();
    cacheChangelog(SAMPLE, s);
    expect(readMarker(s)).toBe(null);
    expect(cachedChangelog(s).latest).toBe('15 October 2026');

    markRead('14 October 2026', null, s);
    expect(readMarker(s)).toBe('14 October 2026');
    expect(cachedChangelog(s).latest).toBe('15 October 2026');

    const NEWER = SAMPLE.replace('15 October 2026', '16 October 2026');
    cacheChangelog(NEWER, s);
    expect(readMarker(s)).toBe('14 October 2026');
    expect(cachedChangelog(s).latest).toBe('16 October 2026');
  });

  it('the badge is a known latest that differs from what was read', () => {
    expect(hasUnreadChangelog({ latest: 'A' }, null)).toBe(true);
    expect(hasUnreadChangelog({ latest: 'A' }, 'A')).toBe(false);
    expect(hasUnreadChangelog({ latest: 'B' }, 'A')).toBe(true);
    expect(hasUnreadChangelog(null, null)).toBe(false);
    expect(hasUnreadChangelog(null, 'A')).toBe(false);
  });

  it('a fresh cache spares the network, a stale one does not', async () => {
    const s = store();
    cacheChangelog(SAMPLE, s);
    expect(cacheIsFresh(s)).toBe(true);

    const row = JSON.parse(JSON.stringify(s.get('telium.changelog.v1')));
    row.at = Date.now() - 7 * 60 * 60 * 1000;
    s.set('telium.changelog.v1', row);
    expect(cacheIsFresh(s)).toBe(false);
  });
});

describe('refreshChangelog', () => {
  it('fetches, parses, caches, and answers with the parsed changelog', async () => {
    const s = store();
    let calls = 0;
    const parsed = await refreshChangelog(
      { fetchImpl: () => { calls += 1; return fetchReturning(SAMPLE)(); } },
      s,
    );
    expect(parsed.latest).toBe('15 October 2026');
    expect(cachedChangelog(s)).not.toBe(null);
    expect(calls).toBe(1);
  });

  it('a failed fetch answers null and caches nothing', async () => {
    const s = store();
    const parsed = await refreshChangelog({ fetchImpl: async () => ({ ok: false }) }, s);
    expect(parsed).toBe(null);
    expect(cachedChangelog(s)).toBe(null);
  });

  it('two callers asking together share one fetch', async () => {
    let calls = 0;
    const fetchImpl = () => {
      calls += 1;
      return fetchReturning(SAMPLE)();
    };
    const [a, b] = await Promise.all([
      refreshChangelog({ fetchImpl }),
      refreshChangelog({ fetchImpl }),
    ]);
    expect(calls).toBe(1);
    expect(a.latest).toBe('15 October 2026');
    expect(b.latest).toBe('15 October 2026');
  });
});
