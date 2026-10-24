import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { generateAccountRecovery, recoveryVaultWrapper } from '../lib/account-recovery.js';
import { deriveSyncKey, isSealed, open, seal, syncKeys } from '../lib/sealed-sync.js';
import { KEYS, SyncStore, draftText } from '../lib/sync.js';
import { decodeRecoveryTransfer, encodeRecoveryTransfer, load } from '../lib/vault.js';

const USER = '@alice:a.example';

function fakeAccount(rows = {}) {
  const account = {
    rows,
    writes: [],
    api: {
      sync: vi.fn(async () => JSON.parse(JSON.stringify(account.rows))),
      syncPut: vi.fn(async (key, value) => {
        account.writes.push([key, value]);
        account.rows[key] = { value: JSON.parse(JSON.stringify(value)), updated_at: Date.now() };
        return { ok: true, key };
      }),
      syncDelete: vi.fn(async (key) => {
        delete account.rows[key];
        return { ok: true };
      }),
    },
  };
  return account;
}

function moved(account) {
  return fakeAccount(JSON.parse(JSON.stringify(account.rows)));
}

function keyring({ raw = crypto.getRandomValues(new Uint8Array(32)), retired = [], mode = 'opaque_custody' } = {}) {
  return { key: raw, raw, retired, openers: [raw, ...retired], mode };
}

async function device(account, ring, options) {
  localStorage.clear();
  const store = new SyncStore();
  await store.load(account.api);
  if (ring) await store.adoptKeyring(ring, options);
  return store;
}

async function forge(ring, key, v, n = 1000) {
  return { value: await seal(await syncKeys(ring), key, { n, t: Date.now() + 60_000, v }), updated_at: Date.now() };
}

function withTheme(store, theme) {
  store.set(KEYS.prefs, { ...store.get(KEYS.prefs), theme });
}

class FakeVaultHome {
  constructor() { this.held = null; }

  async vault() {
    if (!this.held) return { exists: false };
    return { exists: true, ...this.held };
  }

  async putVault(body) { this.held = { ...body }; }

  async setVaultMode(body) { this.held = { ...body }; }
}

let warn;
beforeEach(() => {
  localStorage.clear();
  globalThis.indexedDB = new IDBFactory();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
});

describe('sealed sync store', () => {
  it('seals every value it sends and never uploads plaintext', async () => {
    const account = fakeAccount();
    const ring = keyring();
    const a = await device(account, ring);

    withTheme(a, 'light');
    a.set(KEYS.prefs, { ...a.get(KEYS.prefs), voiceRegion: 'syd-region', muted: { c1: true } });
    a.set(KEYS.gifFavorites, ['https://gifs.example/wave.gif']);
    a.set(KEYS.savedStickers, [{ id: 's1', origin: 'guilds.example', name: 'wavey' }]);
    a.set(KEYS.drafts, {
      'channel:c1': { text: 'UNSENT-CHANNEL-DRAFT', at: Date.now() },
      'conversation:d1': { text: 'UNSENT-DM-DRAFT', at: Date.now() },
    });
    await a.push();

    expect(Object.keys(account.rows).sort()).toEqual([
      'drafts.v2', 'gif.favorites.v1', 'prefs.v1', 'stickers.saved.v1',
    ]);
    expect(account.writes.every(([, value]) => isSealed(value))).toBe(true);
    const stored = JSON.stringify(account.rows);
    for (const secret of ['light', 'syd-region', 'gifs.example', 'wavey', 'UNSENT-CHANNEL-DRAFT', 'UNSENT-DM-DRAFT']) {
      expect(stored).not.toContain(secret);
    }

    const keys = await syncKeys(ring);
    const { doc } = await open(keys, KEYS.prefs, account.rows[KEYS.prefs].value);
    expect(doc.v.theme).toBe('light');
    expect(doc.v.voiceRegion).toBeUndefined();
    expect(doc.n).toBe(1);
  });

  it('pads small values to one size, so the server cannot tell them apart', async () => {
    const account = fakeAccount();
    const a = await device(account, keyring());
    a.set(KEYS.emojiTone, '');
    a.set(KEYS.emojiRecent, ['+1', 'tada', 'wave', 'eyes']);
    withTheme(a, 'light');
    await a.push();
    const sizes = new Set(Object.values(account.rows).map((row) => row.value.ct.length));
    expect(sizes.size).toBe(1);
  });

  it('writes nothing until the keyring arrives, then seals what was held', async () => {
    const account = fakeAccount();
    const a = await device(account, null);
    withTheme(a, 'light');
    await a.push();
    expect(account.api.syncPut).not.toHaveBeenCalled();
    expect(a.get(KEYS.prefs).theme).toBe('light');

    await a.adoptKeyring(keyring());
    expect(isSealed(account.rows[KEYS.prefs].value)).toBe(true);
  });

  it('refuses a value that was tampered with and writes its own back', async () => {
    const account = fakeAccount();
    const a = await device(account, keyring());
    withTheme(a, 'light');
    await a.push();

    const row = account.rows[KEYS.prefs];
    const flipped = row.value.ct[5] === 'A' ? 'B' : 'A';
    row.value = { ...row.value, ct: row.value.ct.slice(0, 5) + flipped + row.value.ct.slice(6) };
    const tampered = row.value.ct;

    await a.load(account.api);
    expect(a.get(KEYS.prefs).theme).toBe('light');
    expect(warn).toHaveBeenCalledWith('sealed sync value refused', KEYS.prefs, expect.any(String));
    expect(account.rows[KEYS.prefs].value.ct).not.toBe(tampered);
  });

  it('refuses a value moved from one key to another', async () => {
    const account = fakeAccount();
    const ring = keyring();
    const a = await device(account, ring);
    withTheme(a, 'light');
    a.set(KEYS.emojiTone, '3');
    await a.push();

    account.rows[KEYS.emojiTone] = { ...account.rows[KEYS.prefs] };
    const b = await device(account, ring);
    expect(b.get(KEYS.prefs).theme).toBe('light');
    expect(b.get(KEYS.emojiTone)).not.toEqual(expect.objectContaining({ theme: 'light' }));
    expect(b.get(KEYS.emojiTone)).toBe('');
  });

  it('refuses a value moved from another account', async () => {
    const alice = fakeAccount();
    const bob = fakeAccount();
    const aliceRing = keyring();
    const bobDevice = await device(bob, keyring());
    withTheme(bobDevice, 'bobs-theme');
    await bobDevice.push();

    const aliceDevice = await device(alice, aliceRing);
    withTheme(aliceDevice, 'light');
    await aliceDevice.push();
    alice.rows[KEYS.prefs] = JSON.parse(JSON.stringify(bob.rows[KEYS.prefs]));

    const cached = await device(alice, aliceRing);
    expect(cached.get(KEYS.prefs).theme).toBe('dark');
    withTheme(cached, 'mine');
    await cached.push();
    expect(alice.rows[KEYS.prefs]).toEqual(bob.rows[KEYS.prefs]);

    const current = await device(alice, aliceRing, { current: true });
    expect(current.get(KEYS.prefs).theme).toBe('dark');
    withTheme(current, 'mine');
    await current.push();
    const keys = await syncKeys(aliceRing);
    const { doc } = await open(keys, KEYS.prefs, alice.rows[KEYS.prefs].value);
    expect(doc.v.theme).toBe('mine');
  });

  it('refuses an older value than it has seen, and repairs the server', async () => {
    const account = fakeAccount();
    const ring = keyring();
    const a = await device(account, ring);
    withTheme(a, 'light');
    await a.push();
    const older = JSON.parse(JSON.stringify(account.rows[KEYS.prefs]));
    withTheme(a, 'dim');
    await a.push();

    account.rows[KEYS.prefs] = older;
    await a.load(account.api);
    expect(a.get(KEYS.prefs).theme).toBe('dim');
    expect(warn).toHaveBeenCalledWith('sync rollback refused', KEYS.prefs, 1, '<', 2);
    const keys = await syncKeys(ring);
    const { doc } = await open(keys, KEYS.prefs, account.rows[KEYS.prefs].value);
    expect(doc.v.theme).toBe('dim');
    expect(doc.n).toBe(3);

    account.rows[KEYS.prefs] = older;
    const fresh = await device(account, ring);
    expect(fresh.get(KEYS.prefs).theme).toBe('light');
  });

  it('upgrades legacy plaintext in place and then refuses plaintext for good', async () => {
    const account = fakeAccount({
      [KEYS.prefs]: {
        value: { theme: 'light', muted: { c1: true }, collapsed: {}, voiceRegion: 'remote-region' },
        updated_at: 5,
      },
      [KEYS.emojiRecent]: { value: ['potato'], updated_at: 5 },
    });
    const ring = keyring();

    const a = await device(account, null);
    expect(a.get(KEYS.prefs).theme).toBe('light');
    expect(account.api.syncPut).not.toHaveBeenCalled();

    await a.adoptKeyring(ring);
    expect(isSealed(account.rows[KEYS.prefs].value)).toBe(true);
    expect(isSealed(account.rows[KEYS.emojiRecent].value)).toBe(true);
    expect(JSON.stringify(account.rows)).not.toContain('light');

    const b = await device(account, ring);
    expect(b.get(KEYS.prefs).theme).toBe('light');
    expect(b.get(KEYS.prefs).muted).toEqual({ c1: true });
    expect(b.get(KEYS.prefs).voiceRegion).toBeUndefined();
    expect(b.get(KEYS.emojiRecent)).toEqual(['potato']);

    account.rows[KEYS.prefs] = { value: { theme: 'planted', muted: {}, collapsed: {} }, updated_at: Date.now() + 1000 };
    await a.load(account.api);
    expect(a.get(KEYS.prefs).theme).toBe('light');
    expect(isSealed(account.rows[KEYS.prefs].value)).toBe(true);
    account.rows[KEYS.prefs] = { value: { theme: 'planted', muted: {}, collapsed: {} }, updated_at: Date.now() + 1000 };
    const c = await device(account, null);
    expect(c.get(KEYS.prefs).theme).toBe('dark');
    account.rows[KEYS.drafts] = { value: { 'channel:c1': { text: 'planted', at: Date.now() } }, updated_at: 1 };
    const d = await device(fakeAccount({ [KEYS.drafts]: account.rows[KEYS.drafts] }), null);
    expect(draftText(d.get(KEYS.drafts), 'channel:c1')).toBe('');
  });

  it('reseals under the new key when the keyring rotates', async () => {
    const account = fakeAccount();
    const old = keyring();
    const a = await device(account, old);
    withTheme(a, 'light');
    await a.push();

    const rotated = keyring({ retired: [old.raw] });
    const b = await device(account, rotated, { current: true });
    expect(b.get(KEYS.prefs).theme).toBe('light');
    const { kid } = await deriveSyncKey(rotated.raw);
    expect(account.rows[KEYS.prefs].value.kid).toBe(kid);

    const before = JSON.stringify(account.rows);
    const stale = await device(account, old);
    withTheme(stale, 'stale');
    await stale.push();
    expect(JSON.stringify(account.rows)).toBe(before);
  });

  it('reseals every key from its own copy on the device that rotated the keyring', async () => {
    const account = fakeAccount();
    const escrowed = keyring({ mode: 'escrowed' });
    const a = await device(account, escrowed, { current: true });
    withTheme(a, 'light');
    a.set(KEYS.emojiTone, '3');
    a.set(KEYS.savedStickers, [{ id: 's1', origin: 'guilds.example', name: 'wave' }]);
    a.set(KEYS.drafts, { 'channel:c1': { text: 'kept here', at: Date.now() } });
    await a.push();
    expect(account.rows[KEYS.drafts]).toBeUndefined();

    account.rows[KEYS.prefs] = await forge(escrowed, KEYS.prefs, { theme: 'planted', muted: {}, collapsed: {} });
    const rotated = keyring({ retired: [escrowed.raw] });
    await a.adoptKeyring(rotated, { current: true });

    expect(a.get(KEYS.prefs).theme).toBe('light');
    const { kid } = await deriveSyncKey(rotated.raw);
    expect(Object.keys(account.rows).sort()).toEqual([
      'drafts.v2', 'emoji.tone.v1', 'prefs.v1', 'stickers.saved.v1',
    ]);
    for (const row of Object.values(account.rows)) expect(row.value.kid).toBe(kid);
    const keys = await syncKeys(rotated);
    expect((await open(keys, KEYS.prefs, account.rows[KEYS.prefs].value)).doc.v.theme).toBe('light');
    expect(draftText((await open(keys, KEYS.drafts, account.rows[KEYS.drafts].value)).doc.v, 'channel:c1'))
      .toBe('kept here');
  });

  it('never takes drafts or saved stickers sealed under a retired key', async () => {
    const account = fakeAccount();
    const escrowed = keyring({ mode: 'escrowed' });
    const rotated = keyring({ retired: [escrowed.raw] });
    const a = await device(account, rotated, { current: true });
    a.set(KEYS.savedStickers, [{ id: 's1', origin: 'guilds.example', name: 'wave' }]);
    a.set(KEYS.drafts, { 'channel:c1': { text: 'mine', at: Date.now() } });
    await a.push();

    const plant = async (target) => {
      target.rows[KEYS.drafts] = await forge(escrowed, KEYS.drafts, {
        'channel:c1': { text: 'planted', at: Date.now() + 60_000 },
        'conversation:d1': { text: 'planted too', at: Date.now() + 60_000 },
      });
      target.rows[KEYS.savedStickers] = await forge(escrowed, KEYS.savedStickers, [
        { id: 'forged', origin: 'evil.example', name: 'forged' },
      ]);
    };
    await plant(account);
    await a.load(account.api);
    expect(draftText(a.get(KEYS.drafts), 'channel:c1')).toBe('mine');
    expect(draftText(a.get(KEYS.drafts), 'conversation:d1')).toBe('');
    expect(a.get(KEYS.savedStickers)).toEqual([{ id: 's1', origin: 'guilds.example', name: 'wave' }]);
    expect(warn).toHaveBeenCalledWith('retired-key sync value refused', KEYS.drafts);
    const { kid } = await deriveSyncKey(rotated.raw);
    expect(account.rows[KEYS.drafts].value.kid).toBe(kid);
    expect(account.rows[KEYS.savedStickers].value.kid).toBe(kid);

    const planted = fakeAccount();
    await plant(planted);
    const fresh = await device(planted, rotated);
    expect(draftText(fresh.get(KEYS.drafts), 'conversation:d1')).toBe('');
    expect(fresh.get(KEYS.savedStickers)).toEqual([]);
  });

  it('refuses any retired-key value once it has seen one under the live key', async () => {
    const account = fakeAccount();
    const escrowed = keyring({ mode: 'escrowed' });
    const rotated = keyring({ retired: [escrowed.raw] });
    const a = await device(account, rotated, { current: true });
    a.set(KEYS.emojiTone, '3');
    await a.push();

    account.rows[KEYS.prefs] = await forge(escrowed, KEYS.prefs, { theme: 'planted', muted: {}, collapsed: {} });
    await a.load(account.api);
    expect(a.get(KEYS.prefs).theme).toBe('dark');
    expect(warn).toHaveBeenCalledWith('retired-key sync value refused', KEYS.prefs);

    account.rows[KEYS.prefs] = await forge(escrowed, KEYS.prefs, { theme: 'planted', muted: {}, collapsed: {} });
    const fresh = await device(account, rotated);
    expect(fresh.get(KEYS.prefs).theme).toBe('dark');
    expect(fresh.get(KEYS.emojiTone)).toBe('3');

    account.rows = { [KEYS.prefs]: await forge(escrowed, KEYS.prefs, { theme: 'planted', muted: {}, collapsed: {} }) };
    const reloaded = new SyncStore();
    await reloaded.load(account.api);
    await reloaded.adoptKeyring(rotated);
    expect(reloaded.get(KEYS.prefs).theme).toBe('dark');
  });

  it('merges drafts per target across devices and carries a cleared one', async () => {
    const account = fakeAccount();
    const ring = keyring();
    const a = await device(account, ring);
    a.set(KEYS.drafts, { 'channel:c1': { text: 'from a', at: 1000 } });
    await a.push();

    localStorage.clear();
    const b = new SyncStore();
    b.set(KEYS.drafts, { 'conversation:d1': { text: 'from b', at: 2000 } });
    await b.load(account.api);
    await b.adoptKeyring(ring);
    expect(draftText(b.get(KEYS.drafts), 'channel:c1')).toBe('from a');
    expect(draftText(b.get(KEYS.drafts), 'conversation:d1')).toBe('from b');

    await a.load(account.api);
    expect(draftText(a.get(KEYS.drafts), 'conversation:d1')).toBe('from b');

    a.set(KEYS.drafts, { ...a.get(KEYS.drafts), 'channel:c1': { text: '', at: Date.now() } });
    await a.push();
    await b.load(account.api);
    expect(draftText(b.get(KEYS.drafts), 'channel:c1')).toBe('');
    expect(draftText(b.get(KEYS.drafts), 'conversation:d1')).toBe('from b');
  });

  it('keeps drafts on the device while the home can open the keyring', async () => {
    const account = fakeAccount();
    const a = await device(account, keyring({ mode: 'escrowed' }));
    a.set(KEYS.drafts, { 'channel:c1': { text: 'unsent', at: Date.now() } });
    withTheme(a, 'light');
    await a.push();
    expect(account.rows[KEYS.drafts]).toBeUndefined();
    expect(isSealed(account.rows[KEYS.prefs].value)).toBe(true);
  });

  it('deletes the legacy plaintext drafts key unread and keeps what this browser held', async () => {
    localStorage.setItem('telium.sync.v1', JSON.stringify({
      'drafts.v1': { value: { 'channel:local': 'device-local text' }, updated_at: 1 },
    }));
    const account = fakeAccount({
      'drafts.v1': { value: { 'channel:abc': 'legacy guild draft' }, updated_at: 123 },
    });
    const a = new SyncStore();
    await a.load(account.api);
    await a.adoptKeyring(keyring());

    expect(account.api.syncDelete).toHaveBeenCalledWith('drafts.v1');
    expect(account.rows['drafts.v1']).toBeUndefined();
    expect(account.writes.some(([key]) => key === 'drafts.v1')).toBe(false);
    expect(draftText(a.get(KEYS.drafts), 'channel:local')).toBe('device-local text');
    expect(draftText(a.get(KEYS.drafts), 'channel:abc')).toBe('');
    expect(localStorage.getItem('telium.sync.v1')).not.toContain('legacy guild draft');
    expect(isSealed(account.rows[KEYS.drafts].value)).toBe(true);
  });
});

describe('a new device recovers the sealed store wherever the keyring is recovered', () => {
  it('by password, by recovery key after a move, and from a trusted device', async () => {
    const home = new FakeVaultHome();
    const opaque = crypto.getRandomValues(new Uint8Array(32));
    const recovery = generateAccountRecovery();
    const first = await load(home, null, USER, opaque, recovery.vaultWrapper);
    expect(first.created).toBe(true);

    const account = fakeAccount();
    const a = await device(account, first, { current: true });
    withTheme(a, 'light');
    a.set(KEYS.drafts, { 'conversation:d1': { text: 'half a thought', at: Date.now() } });
    a.set(KEYS.savedStickers, [{ id: 's1', origin: 'guilds.example', name: 'wave' }]);
    await a.push();

    globalThis.indexedDB = new IDBFactory();
    const byPassword = await load(home, null, USER, opaque, null);
    const b = await device(account, byPassword);
    expect(b.get(KEYS.prefs).theme).toBe('light');
    expect(draftText(b.get(KEYS.drafts), 'conversation:d1')).toBe('half a thought');
    expect(b.get(KEYS.savedStickers)).toEqual([{ id: 's1', origin: 'guilds.example', name: 'wave' }]);

    globalThis.indexedDB = new IDBFactory();
    const elsewhere = moved(account);
    const byRecoveryKey = await load(
      home, null, '@alice:b.example', crypto.getRandomValues(new Uint8Array(32)),
      recoveryVaultWrapper(recovery.text),
    );
    const c = await device(elsewhere, byRecoveryKey, { current: true });
    expect(c.get(KEYS.prefs).theme).toBe('light');
    expect(draftText(c.get(KEYS.drafts), 'conversation:d1')).toBe('half a thought');

    const handed = decodeRecoveryTransfer(encodeRecoveryTransfer(first), 'device_custody');
    const d = await device(account, handed);
    expect(d.get(KEYS.prefs).theme).toBe('light');

    const e = await device(account, keyring());
    expect(e.get(KEYS.prefs).theme).toBe('dark');
    expect(draftText(e.get(KEYS.drafts), 'conversation:d1')).toBe('');
  });
});
