import { describe, expect, it } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { b64url } from '../lib/util.js';
import {
  RECOMMENDATION_KIND,
  RECOMMENDATION_VERSION,
  canonicalRecommendationJson,
  chooseAccountHome,
  loadAccountHomeRecommendations,
  usableRecommendations,
  verifyRecommendationDocument,
} from '../lib/account-home-recommendations.js';

const seed = new Uint8Array(32).fill(7);
const publicKey = b64url(ed25519.getPublicKey(seed));

const signedDocument = (overrides = {}) => {
  const body = {
    kind: RECOMMENDATION_KIND,
    version: RECOMMENDATION_VERSION,
    publisher: 'telium.chat',
    generated_at: '2026-09-16T20:00:00.000Z',
    expires_at: '2026-09-16T22:00:00.000Z',
    criteria: {},
    servers: [
      { domain: 'alpha.example', api_origin: 'https://api.alpha.example', name: 'Alpha', weight: 1 },
      { domain: 'beta.example', api_origin: 'https://beta.example', name: 'Beta', weight: 2 },
      { domain: 'gamma.example', api_origin: 'https://accounts.gamma.example:8443', name: 'Gamma', weight: 3 },
    ],
    ...overrides,
  };
  const signature = ed25519.sign(new TextEncoder().encode(canonicalRecommendationJson(body)), seed);
  return { ...body, key_id: 'ed25519:test', signature: b64url(signature) };
};

const memoryStorage = () => {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
};

describe('account-home recommendation documents', () => {
  it('verifies the signed canonical body and rejects tampering', () => {
    const document = signedDocument();
    expect(verifyRecommendationDocument(document, publicKey)).toBe(true);
    expect(verifyRecommendationDocument({ ...document, publisher: 'mallory.example' }, publicKey)).toBe(false);
  });

  it('refuses expired documents before exposing candidates', () => {
    const document = signedDocument();
    expect(usableRecommendations(document, Date.parse('2026-09-16T21:00:00Z'))).toHaveLength(3);
    expect(usableRecommendations(document, Date.parse('2026-09-16T22:00:00Z'))).toEqual([]);
  });

  it('drops candidates whose signed API origin is missing or not HTTPS', () => {
    const document = signedDocument({
      servers: [
        { domain: 'ok.example', api_origin: 'https://api.ok.example', name: 'OK', weight: 1 },
        { domain: 'missing.example', name: 'Missing', weight: 1 },
        { domain: 'plain.example', api_origin: 'http://plain.example', name: 'Plain', weight: 1 },
      ],
    });
    expect(usableRecommendations(document, Date.parse('2026-09-16T21:00:00Z'))
      .map((server) => server.domain)).toEqual(['ok.example']);
  });

  it('loads candidates only after verifying the pinned key', async () => {
    const document = signedDocument();
    const result = await loadAccountHomeRecommendations({
      fetchImpl: async () => ({ ok: true, json: async () => document }),
      storageImpl: null,
      publicKey,
      nowMs: Date.parse('2026-09-16T21:00:00Z'),
    });
    expect(result.reason).toBeNull();
    expect(result.source).toBe('network');
    expect(result.servers.map((server) => server.domain)).toEqual([
      'alpha.example',
      'beta.example',
      'gamma.example',
    ]);
  });

  it('uses a still-valid signed cache when the catalogue network request fails', async () => {
    const document = signedDocument();
    const storageImpl = memoryStorage();
    const nowMs = Date.parse('2026-09-16T21:00:00Z');

    const first = await loadAccountHomeRecommendations({
      fetchImpl: async () => ({ ok: true, json: async () => document }),
      storageImpl,
      publicKey,
      nowMs,
    });
    expect(first.source).toBe('network');

    const cached = await loadAccountHomeRecommendations({
      fetchImpl: async () => { throw new Error('offline'); },
      storageImpl,
      publicKey,
      nowMs,
    });
    expect(cached.reason).toBeNull();
    expect(cached.source).toBe('cache');
    expect(cached.networkReason).toBe('unavailable');
    expect(cached.servers.map((server) => server.domain)).toEqual([
      'alpha.example',
      'beta.example',
      'gamma.example',
    ]);
  });

  it('never revives an expired signed cache', async () => {
    const document = signedDocument();
    const storageImpl = memoryStorage();
    await loadAccountHomeRecommendations({
      fetchImpl: async () => ({ ok: true, json: async () => document }),
      storageImpl,
      publicKey,
      nowMs: Date.parse('2026-09-16T21:00:00Z'),
    });

    const result = await loadAccountHomeRecommendations({
      fetchImpl: async () => { throw new Error('offline'); },
      storageImpl,
      publicKey,
      nowMs: Date.parse('2026-09-16T22:00:00Z'),
    });
    expect(result.servers).toEqual([]);
    expect(result.reason).toBe('unavailable');
    expect(result.source).toBeNull();
  });

  it('fails closed when the pinned key is missing or a signature is invalid', async () => {
    const document = signedDocument();
    const fetchImpl = async () => ({ ok: true, json: async () => document });

    await expect(loadAccountHomeRecommendations({ fetchImpl, storageImpl: null })).resolves.toMatchObject({
      servers: [],
      reason: 'no_pinned_key',
    });

    await expect(loadAccountHomeRecommendations({
      fetchImpl: async () => ({ ok: true, json: async () => ({ ...document, signature: 'AAAA' }) }),
      storageImpl: null,
      publicKey,
      nowMs: Date.parse('2026-09-16T21:00:00Z'),
    })).resolves.toMatchObject({ servers: [], reason: 'invalid_signature' });
  });
});

describe('local account-home selection', () => {
  const servers = [
    { domain: 'a.example', weight: 1000 },
    { domain: 'b.example', weight: 1 },
    { domain: 'c.example', weight: 1 },
  ];

  it('caps one independent operator/domain at half the draw space when alternatives exist', () => {
    expect(chooseAccountHome(servers, () => 0.49)?.domain).toBe('a.example');
    expect(chooseAccountHome(servers, () => 0.51)?.domain).toBe('b.example');
    expect(chooseAccountHome(servers, () => 0.99)?.domain).toBe('c.example');
  });

  it('caps multiple aliases from the same operator as one combined share', () => {
    const aliases = [
      { domain: 'a-one.example', operator_contact: 'https://operator-a.example', weight: 100 },
      { domain: 'a-two.example', operator_contact: 'https://operator-a.example', weight: 100 },
      { domain: 'b.example', operator_contact: 'https://operator-b.example', weight: 1 },
      { domain: 'c.example', operator_contact: 'https://operator-c.example', weight: 1 },
    ];

    expect(chooseAccountHome(aliases, () => 0.10)?.domain).toBe('a-one.example');
    expect(chooseAccountHome(aliases, () => 0.30)?.domain).toBe('a-two.example');
    expect(chooseAccountHome(aliases, () => 0.60)?.domain).toBe('b.example');
    expect(chooseAccountHome(aliases, () => 0.90)?.domain).toBe('c.example');
  });

  it('never selects a server that is not in the verified usable set', () => {
    const chosen = chooseAccountHome([{ domain: 'only.example', weight: 1 }], () => 0.9);
    expect(chosen?.domain).toBe('only.example');
    expect(chooseAccountHome([], () => 0.5)).toBeNull();
  });
});
