import { afterEach, describe, expect, it, vi } from 'vitest';
import { chooseGuildVoiceRegion, clearRegionProbes } from '../lib/voiceRegion.js';
import { relayWillNotServe } from '../hooks/useVoice.jsx';

const probeFrom = (table) => vi.fn(async (endpoint) => table[endpoint] ?? null);

const guild = ({ regions = [], directory = [], states = [] } = {}) => ({
  regions: async () => ({ regions, default: regions[0]?.name ?? null }),
  voiceDirectory: async () => ({ entries: directory.map((url) => ({ url, reachable: true })) }),
  voiceStates: async () => states,
});

afterEach(() => {
  clearRegionProbes();
  vi.restoreAllMocks();
});

describe('choosing a relay after one refused the call', () => {
  const near = 'https://near.example';
  const mid = 'https://mid.example';
  const far = 'https://far.example';
  const api = guild({ directory: [near, mid, far] });
  const probe = probeFrom({ [near]: 10, [mid]: 40, [far]: 90 });

  it('takes the closest relay that has not refused', async () => {
    expect(await chooseGuildVoiceRegion(api, 'c1', 'auto', { probe, exclude: [near] })).toBe(mid);
    expect(await chooseGuildVoiceRegion(api, 'c1', 'auto', { probe, exclude: [near, mid] })).toBe(far);
  });

  it('answers null, never auto, when every relay has refused', async () => {
    expect(await chooseGuildVoiceRegion(api, 'c1', 'auto', { probe, exclude: [near, mid, far] })).toBeNull();
  });

  it('still tries a relay when none answers a probe', async () => {
    const silent = probeFrom({});
    expect(await chooseGuildVoiceRegion(api, 'c1', 'auto', { probe: silent, exclude: [near] })).toBe(mid);
  });

  it('keeps a hand-picked relay: the person chose it', async () => {
    expect(await chooseGuildVoiceRegion(api, 'c1', 'eu', { probe, exclude: ['eu'] })).toBe('eu');
  });
});

describe('which join failures move the call to another relay', () => {
  const refusal = (status, code) => Object.assign(new Error(`SFU /session returned ${status}`), {
    status, body: { error: 'x', code },
  });

  it('moves for a relay that cannot verify or will not serve this server, or cannot be reached', () => {
    expect(relayWillNotServe(refusal(403, 'sfu_origin_unverified'))).toBe(true);
    expect(relayWillNotServe(refusal(403, 'sfu_bad_signature'))).toBe(true);
    expect(relayWillNotServe(refusal(403, 'origin_blocked'))).toBe(true);
    expect(relayWillNotServe(Object.assign(new TypeError('fetch failed'), { relayUnreachable: true }))).toBe(true);
  });

  it('does not move for anything else', () => {
    expect(relayWillNotServe(refusal(503, 'relay_full'))).toBe(false);
    expect(relayWillNotServe(refusal(403, undefined))).toBe(false);
    expect(relayWillNotServe(new TypeError('x is undefined'))).toBe(false);
    expect(relayWillNotServe(null)).toBe(false);
  });
});
