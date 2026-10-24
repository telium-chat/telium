import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import {
  Blocked, Delivery, Publisher, Unchecked, Urgency,
  artifactKey, assess, compareVersions, deliveryFor, fetchManifest, isNewer, noticeKey,
  parseManifest, publisherState, statementFor, updateNotice, urgencyOf,
  verifyManifestSignature,
} from '../lib/updates.js';

const desktop = createRequire(import.meta.url)('../../electron/updater.cjs');

const NOW = 1_700_000_000_000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const URL = 'https://downloads.example/clients.json';

const toUrlB64 = (bytes) => btoa(String.fromCharCode(...bytes))
  .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

const seed = new Uint8Array(32).fill(7);
const publicKey = toUrlB64(ed25519.getPublicKey(seed));

const manifestBytes = (document) => new TextEncoder().encode(JSON.stringify(document));

const sign = (bytes, withSeed = seed) => {
  const statement = statementFor(bytes);
  return {
    alg: 'ed25519',
    key_id: 'ed25519:test',
    statement,
    signature: toUrlB64(ed25519.sign(new TextEncoder().encode(statement), withSeed)),
  };
};

const release = (version, extra = {}) => ({
  version,
  released_at: NOW,
  security: false,
  page: 'https://releases.example/notes',
  artifacts: {
    'desktop-linux-x86_64-appimage': {
      url: `https://downloads.example/Telium_${version}.AppImage`,
      sha256: 'a'.repeat(64),
      size: 1024,
    },
  },
  ...extra,
});

const documentOf = (versions) => ({
  kind: 'telium.client_releases',
  version: 1,
  channel: 'stable',
  generated_at: NOW,
  releases: versions.map((v) => (typeof v === 'string' ? release(v) : release(v.version, v))),
});
const manifest = (versions) => parseManifest(manifestBytes(documentOf(versions)));

const configured = (over = {}) => assess({
  manifest: manifest(['2.0.0']),
  current: '1.0.0',
  runtime: 'desktop',
  publisher: Publisher.Configured,
  platform: 'linux-x86_64',
  ...over,
});

describe('comparing two versions', () => {
  const ORDERED = [
    ['1.0.0', '1.0.1'], ['1.0.9', '1.0.10'], ['1.9.0', '1.10.0'], ['1.9.0', '2.0.0'],
    ['0.9.9', '1.0.0'], ['1.0.0-rc.1', '1.0.0'], ['1.0.0-alpha', '1.0.0-beta'],
    ['1.0.0-rc.2', '1.0.0-rc.10'], ['1.0.0-1', '1.0.0-alpha'], ['1.0.0-rc', '1.0.0-rc.1'],
    ['v1.0.0', 'v1.0.1'], ['1.2', '1.2.1'],
  ];

  it('orders them the way semver says, in both implementations', () => {
    for (const [low, high] of ORDERED) {
      for (const cmp of [compareVersions, desktop.compareVersions]) {
        expect(cmp(low, high), `${low} < ${high}`).toBe(-1);
        expect(cmp(high, low), `${high} > ${low}`).toBe(1);
      }
      expect(isNewer(high, low)).toBe(true);
      expect(isNewer(low, high)).toBe(false);
    }
    for (const [a, b] of [['1.0.0', '1.0.0'], ['v1.0.0', '1.0.0'], ['1.2.0', '1.2']]) {
      expect(compareVersions(a, b)).toBe(0);
      expect(desktop.compareVersions(a, b)).toBe(0);
    }
  });

  it('treats nonsense as the oldest possible version rather than throwing', () => {
    expect(isNewer('1.0.0', '')).toBe(true);
    expect(isNewer('1.0.0', null)).toBe(true);
    expect(isNewer('not a version', '1.0.0')).toBe(false);
  });
});

describe('a build with no publisher key', () => {
  it('never fetches a manifest', async () => {
    let calls = 0;
    const fetchImpl = async () => { calls += 1; throw new Error('must not be called'); };
    for (const [url, key] of [['', ''], [URL, ''], ['', publicKey]]) {
      const result = await fetchManifest({ url, key, fetchImpl });
      expect(result.manifest).toBe(null);
      expect(result.error).toBe(Unchecked.NoKey);
    }
    expect(calls).toBe(0);
  });

  it('is never offered an install, and gets no banner, however good the manifest looks', () => {
    for (const publisher of [Publisher.Unkeyed, Publisher.Unconfigured]) {
      const state = configured({ manifest: manifest(['9.9.9']), publisher });
      expect(state.canInstall).toBe(false);
      expect(state.blocked).toBe(Blocked.NoKey);
      expect(state.latest).toBe(null);
      expect(state.behind).toBe(false);
      expect(updateNotice(state, { now: NOW })).toBe(null);
    }
  });

  it('still learns from a server that it is too old to connect', () => {
    const state = assess({
      manifest: null, current: '1.0.0', runtime: 'desktop', publisher: Publisher.Unkeyed, incompatible: true,
    });
    expect(state.incompatible).toBe(true);
    expect(state.canInstall).toBe(false);
    expect(state.blocked).toBe(Blocked.NoKey);
    expect(updateNotice(state, { now: NOW })).not.toBe(null);
  });

  it('is what an environment with no build variables resolves to', () => {
    expect(publisherState({})).toBe(Publisher.Unconfigured);
    expect(publisherState({ VITE_TELIUM_UPDATE_URL: URL })).toBe(Publisher.Unkeyed);
    expect(publisherState({ VITE_TELIUM_UPDATE_PUBLIC_KEY: publicKey })).toBe(Publisher.Unkeyed);
    expect(publisherState({ VITE_TELIUM_UPDATE_URL: URL, VITE_TELIUM_UPDATE_PUBLIC_KEY: publicKey }))
      .toBe(Publisher.Configured);
  });
});

describe('verifying a manifest signature', () => {
  const bytes = manifestBytes({ kind: 'telium.client_releases', version: 1, releases: [] });

  it('accepts one the publisher made, in both implementations', () => {
    expect(verifyManifestSignature(bytes, sign(bytes), publicKey)).toBe(true);
    expect(desktop.verifyManifestSignature(Buffer.from(bytes), sign(bytes), publicKey)).toBe(true);
    expect(desktop.statementFor(Buffer.from(bytes))).toBe(statementFor(bytes));
  });

  it('refuses missing keys, other keys, replays, and malformed signatures without throwing', () => {
    const good = sign(bytes);
    const other = manifestBytes({ kind: 'telium.client_releases', version: 1, releases: [1] });
    expect(verifyManifestSignature(bytes, good, '')).toBe(false);
    expect(verifyManifestSignature(bytes, good, null)).toBe(false);
    expect(verifyManifestSignature(bytes, sign(bytes, new Uint8Array(32).fill(9)), publicKey)).toBe(false);
    expect(verifyManifestSignature(other, good, publicKey)).toBe(false);
    expect(verifyManifestSignature(bytes, { ...good, signature: good.signature.slice(0, 40) }, publicKey)).toBe(false);
    for (const bad of [null, undefined, 'signed, honest', {}, { alg: 'none' }]) {
      expect(verifyManifestSignature(bytes, bad, publicKey)).toBe(false);
    }
  });

  it('signs a fixed ASCII line over a digest of the literal bytes', () => {
    const raw = new TextEncoder().encode('telium');
    const hex = [...sha256(raw)].map((b) => b.toString(16).padStart(2, '0')).join('');
    expect(statementFor(raw)).toBe(`telium-client-manifest-v1 sha256=${hex}`);
  });
});

describe('fetching a manifest', () => {
  const serve = (body, signature) => async (url) => (url.endsWith('.sig')
    ? { ok: true, text: async () => JSON.stringify(signature) }
    : { ok: true, arrayBuffer: async () => body, text: async () => body });
  const bytes = manifestBytes(documentOf(['2.0.0']));
  const fetchWith = (fetchImpl) => fetchManifest({ url: URL, key: publicKey, fetchImpl });

  it('returns a parsed manifest when everything checks out', async () => {
    const result = await fetchWith(serve(bytes, sign(bytes)));
    expect(result.error).toBe(null);
    expect(result.manifest.releases[0].version).toBe('2.0.0');
  });

  it('calls a bad signature forged (not unreachable), and never parses unverified bytes', async () => {
    const forged = await fetchWith(serve(bytes, sign(bytes, new Uint8Array(32).fill(3))));
    expect(forged.error).toBe(Unchecked.Forged);
    expect(forged.manifest).toBe(null);
    const junk = new TextEncoder().encode('{{{ not json at all');
    expect((await fetchWith(serve(junk, sign(bytes)))).error).toBe(Unchecked.Forged);
    expect((await fetchWith(async () => { throw new Error('offline'); })).error).toBe(Unchecked.Unreachable);
  });
});

describe('parsing a manifest', () => {
  const artifactsOf = (artifact) => manifest([{ version: '2.0.0', artifacts: { 'desktop-linux-x86_64-appimage': artifact } }])
    .releases[0].artifacts.size;

  it('drops non-https artifacts and pages, and artifacts with no usable digest', () => {
    expect(artifactsOf({ url: 'http://downloads.example/Telium.AppImage', sha256: 'a'.repeat(64) })).toBe(0);
    expect(artifactsOf({ url: 'https://downloads.example/Telium.AppImage', sha256: 'not a digest' })).toBe(0);
    expect(manifest([{ version: '2.0.0', page: 'javascript:alert(1)' }]).releases[0].page).toBe('');
  });

  it('refuses the wrong kind and sorts newest first', () => {
    expect(() => parseManifest(manifestBytes({ kind: 'telium.releases', version: 1, releases: [] }))).toThrow();
    expect(manifest(['1.0.0', '2.0.0', '1.5.0']).releases.map((r) => r.version)).toEqual(['2.0.0', '1.5.0', '1.0.0']);
  });
});

describe('what a build can do about being behind', () => {
  const two = manifest(['2.0.0', '1.5.0']);

  it('offers an install only on the runtime that owns its own executable', () => {
    expect(deliveryFor('desktop')).toBe(Delivery.Install);
    expect(deliveryFor('android')).toBe(Delivery.Store);
    expect(deliveryFor('desktop-tauri')).toBe(Delivery.Package);
    expect(deliveryFor('web')).toBe(Delivery.Reload);
    expect(configured({ manifest: two }).canInstall).toBe(true);
    for (const runtime of ['android', 'desktop-tauri', 'web']) {
      const state = configured({ manifest: two, runtime });
      expect(state.behind, runtime).toBe(true);
      expect(state.canInstall, runtime).toBe(false);
      expect(state.blocked, runtime).toBe(Blocked.Runtime);
    }
  });

  it('names a missing artifact, and says nothing when nothing is newer', () => {
    const mac = configured({ manifest: two, platform: 'macos-aarch64' });
    expect(mac.behind).toBe(true);
    expect(mac.blocked).toBe(Blocked.NoArtifact);
    const current = configured({ manifest: two, current: '2.0.0' });
    expect(current.behind).toBe(false);
    expect(current.blocked).toBe(Blocked.None);
    expect(updateNotice(current, { now: NOW })).toBe(null);
  });

  it('notices a security release that is not the newest, unless already installed', () => {
    const withFix = manifest(['2.0.0', { version: '1.5.0', security: true }]);
    expect(urgencyOf(configured({ manifest: withFix }))).toBe(Urgency.Urgent);
    const has = configured({ manifest: withFix, current: '1.5.0' });
    expect(has.security).toBe(false);
    expect(urgencyOf(has)).toBe(Urgency.Quiet);
  });

  it('names the artifact key each runtime looks for, agreeing with the desktop shell', () => {
    expect(artifactKey('desktop', 'linux-x86_64')).toBe('desktop-linux-x86_64-appimage');
    expect(artifactKey('desktop', 'windows-x86_64')).toBe('desktop-windows-x86_64');
    expect(artifactKey('android', 'android-aarch64')).toBe('android-apk');
    expect(artifactKey('web', 'linux-x86_64')).toBe('');
    expect(artifactKey('desktop', 'linux-x86_64')).toBe(desktop.artifactKeyFor('linux', 'x64'));
    expect(artifactKey('desktop', 'windows-x86_64')).toBe(desktop.artifactKeyFor('win32', 'x64'));
    expect(artifactKey('desktop', 'macos-aarch64')).toBe(desktop.artifactKeyFor('darwin', 'arm64'));
  });
});

describe('the notice and how long it stays dismissed', () => {
  const behind = configured();
  const refused = configured({ incompatible: true });

  it('snoozes quiet news for days, security for hours, a refused client for an hour', () => {
    const notice = updateNotice(behind, { now: NOW });
    expect(notice.urgency).toBe(Urgency.Quiet);
    expect(notice.version).toBe('2.0.0');
    expect(notice.canInstall).toBe(true);
    expect(notice.snoozeMs).toBe(3 * DAY_MS);
    expect(updateNotice(configured({ manifest: manifest([{ version: '2.0.0', security: true }]) }), { now: NOW }).snoozeMs)
      .toBe(8 * HOUR_MS);
    const urgent = updateNotice(refused, { now: NOW });
    expect(urgent.incompatible).toBe(true);
    expect(urgent.urgency).toBe(Urgency.Urgent);
    expect(urgent.snoozeMs).toBe(HOUR_MS);
  });

  it('honours a dismissal only until it lapses, and only for the same news', () => {
    const key = noticeKey(behind);
    expect(updateNotice(behind, { now: NOW, dismissal: { key, until: NOW + 1000 } })).toBe(null);
    expect(updateNotice(behind, { now: NOW + 2000, dismissal: { key, until: NOW + 1000 } })).not.toBe(null);
    expect(noticeKey(refused)).not.toBe(key);
    expect(updateNotice(refused, { now: NOW, dismissal: { key, until: NOW + 1e9 } })).not.toBe(null);
  });

  it('keeps a reader who cannot install informed anyway', () => {
    const notice = updateNotice(configured({ runtime: 'desktop-tauri' }), { now: NOW });
    expect(notice.canInstall).toBe(false);
    expect(notice.delivery).toBe(Delivery.Package);
    expect(notice.page).toBe('https://releases.example/notes');
  });
});

