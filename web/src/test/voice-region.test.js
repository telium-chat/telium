import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PROBE_LIMIT, PROBE_MARGIN_MS, chooseVoiceRegion, clearRegionProbes, pickRegion, probeRegion,
} from '../lib/voiceRegion.js';

const region = (name, sfu, healthy = true) => ({ name, sfu, healthy });

const probeFrom = (table) => vi.fn(async (endpoint) => table[endpoint] ?? null);

afterEach(() => {
  clearRegionProbes();
  vi.restoreAllMocks();
});

describe('probing one region', () => {
  it('asks the SFU health endpoint and keeps the fastest of the samples', async () => {
    let now = 0;
    const clock = () => now;
    const fetchImpl = vi.fn(async () => { now += now === 0 ? 90 : 30; return { ok: true }; });

    const rtt = await probeRegion('https://eu.example/', { rounds: 2, fetchImpl, clock });

    expect(rtt).toBe(30);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0][0]).toBe('https://eu.example/health');
  });

  it('tells the region nothing about who is asking', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true }));
    await probeRegion('https://eu.example', { rounds: 1, fetchImpl });

    const [, init] = fetchImpl.mock.calls[0];
    expect(init.method).toBe('GET');
    expect(init.credentials).toBe('omit');
    expect(init.referrerPolicy).toBe('no-referrer');
    expect(init.cache).toBe('no-store');
    expect(init.headers).toBeUndefined();
    expect(init.body).toBeUndefined();
  });

  it('counts an unhealthy answer as an answer, because it is a stopwatch', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 503 }));
    expect(await probeRegion('https://eu.example', { rounds: 1, fetchImpl })).not.toBeNull();
  });

  it('reports no measurement when the request is refused or blocked', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('CORS'); });
    expect(await probeRegion('https://eu.example', { rounds: 2, fetchImpl })).toBeNull();
    expect(await probeRegion('', { rounds: 1, fetchImpl })).toBeNull();
    expect(await probeRegion('https://eu.example', { rounds: 1, fetchImpl: null })).toBeNull();
  });
});

describe('picking between regions', () => {
  it('takes the lowest measured round trip', async () => {
    const probe = probeFrom({ 'https://eu': 120, 'https://us': 40, 'https://ap': 260 });
    const choice = await pickRegion(
      [region('eu', 'https://eu'), region('us', 'https://us'), region('ap', 'https://ap')],
      { fallback: 'eu', probe },
    );
    expect(choice.name).toBe('us');
    expect(choice.rtt).toBe(40);
    expect(choice.measured.map((m) => m.name)).toEqual(['us', 'eu', 'ap']);
  });

  it('defers to the server when every probe fails', async () => {
    const probe = probeFrom({});
    const choice = await pickRegion(
      [region('eu', 'https://eu'), region('us', 'https://us')],
      { fallback: 'eu', probe },
    );
    expect(choice).toBeNull();
  });

  it('still chooses on the regions that did answer', async () => {
    const probe = probeFrom({ 'https://us': 40 });
    const choice = await pickRegion(
      [region('eu', 'https://eu'), region('us', 'https://us')],
      { fallback: 'eu', probe },
    );
    expect(choice.name).toBe('us');
  });

  it('says nothing when the server was already going to pick the winner', async () => {
    const probe = probeFrom({ 'https://eu': 20, 'https://us': 200 });
    expect(await pickRegion(
      [region('eu', 'https://eu'), region('us', 'https://us')],
      { fallback: 'eu', probe },
    )).toBeNull();
  });

  it('will not move a guild for a difference nobody can hear', async () => {
    const near = PROBE_MARGIN_MS - 5;
    const probe = probeFrom({ 'https://eu': 100, 'https://us': 100 - near });
    expect(await pickRegion(
      [region('eu', 'https://eu'), region('us', 'https://us')],
      { fallback: 'eu', probe },
    )).toBeNull();

    const clear = probeFrom({ 'https://eu': 100, 'https://us': 100 - PROBE_MARGIN_MS - 1 });
    expect((await pickRegion(
      [region('eu', 'https://eu'), region('us', 'https://us')],
      { fallback: 'eu', probe: clear },
    )).name).toBe('us');
  });

  it('does not probe regions the server has already called unhealthy', async () => {
    const probe = probeFrom({ 'https://eu': 120, 'https://us': 10 });
    const choice = await pickRegion(
      [region('eu', 'https://eu'), region('us', 'https://us', false), region('ap', 'https://ap')],
      { fallback: 'eu', probe },
    );
    expect(probe.mock.calls.map((c) => c[0])).not.toContain('https://us');
    expect(choice).toBeNull();
  });

  it('has no opinion when there is nothing to choose between', async () => {
    const probe = probeFrom({ 'https://eu': 5 });
    expect(await pickRegion([region('eu', 'https://eu')], { fallback: 'eu', probe })).toBeNull();
    expect(await pickRegion([], { probe })).toBeNull();
    expect(await pickRegion(undefined, { probe })).toBeNull();
    expect(probe).not.toHaveBeenCalled();
  });

  it('keeps the burst bounded on a deployment with many regions', async () => {
    const many = Array.from({ length: 12 }, (_, i) => region(`r${i}`, `https://r${i}`));
    const probe = probeFrom({ 'https://r3': 10 });
    await pickRegion(many, { fallback: 'r0', probe });
    expect(probe).toHaveBeenCalledTimes(PROBE_LIMIT);
  });

  it('divides the budget between the rounds so the worst case is the budget', async () => {
    const probe = vi.fn(async () => 10);
    await pickRegion(
      [region('eu', 'https://eu'), region('us', 'https://us')],
      { fallback: 'eu', probe, budgetMs: 1_000, rounds: 4 },
    );
    expect(probe.mock.calls[0][1].timeoutMs).toBe(250);
    expect(probe.mock.calls[0][1].rounds).toBe(4);
  });
});

describe('the region a join asks for', () => {
  const api = (regions, fallback = 'eu') => ({
    regions: vi.fn(async () => ({ default: fallback, regions })),
  });

  it('leaves a deliberate choice alone and does not probe for it', async () => {
    const client = api([region('eu', 'https://eu'), region('us', 'https://us')]);
    const probe = probeFrom({ 'https://us': 5 });
    expect(await chooseVoiceRegion(client, 'us-west', { probe })).toBe('us-west');
    expect(client.regions).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
  });

  it('measures on auto and asks for the winner', async () => {
    const client = api([region('eu', 'https://eu'), region('us', 'https://us')]);
    const probe = probeFrom({ 'https://eu': 200, 'https://us': 20 });
    expect(await chooseVoiceRegion(client, 'auto', { probe })).toBe('us');
  });

  it('remembers the measurement so a rejoin does not pay for it again', async () => {
    const client = api([region('eu', 'https://eu'), region('us', 'https://us')]);
    const probe = probeFrom({ 'https://eu': 200, 'https://us': 20 });
    expect(await chooseVoiceRegion(client, 'auto', { probe })).toBe('us');
    expect(await chooseVoiceRegion(client, 'auto', { probe })).toBe('us');
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('measures a guild with its own regions separately from the server pool', async () => {
    const pool = api([region('eu', 'https://eu'), region('us', 'https://us')]);
    const guild = api([region('gc', 'https://gc'), region('gd', 'https://gd')]);
    const probe = probeFrom({ 'https://us': 20, 'https://eu': 200, 'https://gd': 5, 'https://gc': 90 });
    expect(await chooseVoiceRegion(pool, 'auto', { probe })).toBe('us');
    expect(await chooseVoiceRegion(guild, 'auto', { probe })).toBe('gd');
  });

  it('falls back to auto against a server that publishes no list', async () => {
    expect(await chooseVoiceRegion(null, 'auto')).toBe('auto');
    expect(await chooseVoiceRegion({}, 'auto')).toBe('auto');
    expect(await chooseVoiceRegion(
      { regions: async () => { throw new Error('404'); } }, 'auto',
    )).toBe('auto');
  });

  it('falls back to auto when nothing could be measured', async () => {
    const client = api([region('eu', 'https://eu'), region('us', 'https://us')]);
    expect(await chooseVoiceRegion(client, 'auto', { probe: probeFrom({}) })).toBe('auto');
  });
});
