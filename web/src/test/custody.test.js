import { beforeEach, describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { Backup } from '../lib/backup.js';
import { heldRecoveryKeyring, rememberRecoveryKeyring } from '../lib/device-secrets.js';
import {
  load, recoveryKeyCiphertext, replaceRetiredVault, seal, writeOpaque,
} from '../lib/vault.js';

const te = new TextEncoder();
const td = new TextDecoder();
const b64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const USER = '@alice:test.example';

class FakeVaultHome {
  constructor() {
    this.held = null;
    this.rows = new Map();
    this.clock = 0;
    this.puts = 0;
  }

  async vault() {
    if (!this.held) return { exists: false };
    return {
      exists: true,
      mode: this.held.mode,
      ciphertext: this.held.ciphertext,
      independent_ciphertext: this.held.independent_ciphertext || null,
    };
  }

  async putVault(body) {
    // Kept as sent, so a test can say the client never sends a server-held key.
    this.held = {
      mode: body.mode,
      ciphertext: body.ciphertext,
      escrow_key: body.escrow_key || null,
      independent_ciphertext: body.independent_ciphertext || null,
    };
  }

  async setVaultMode(body) {
    this.modes = [...(this.modes || []), body];
    const before = this.held?.independent_ciphertext || null;
    this.held = {
      mode: body.mode,
      ciphertext: body.ciphertext,
      escrow_key: body.escrow_key || null,
      independent_ciphertext: body.clear_independent ? null : body.independent_ciphertext || before,
    };
  }

  async putBackup(items) {
    this.puts += 1;
    for (const item of items) {
      this.clock += 1;
      this.rows.set(`${item.scope}/${item.item}`, { ...item, updated_at: this.clock });
    }
    return { stored: items.length };
  }

  async backup({ scope, after = 0, limit = 256 } = {}) {
    const rows = [...this.rows.values()]
      .filter((r) => (!scope || r.scope === scope) && r.updated_at > after)
      .sort((a, b) => a.updated_at - b.updated_at)
      .slice(0, limit);
    return {
      scope,
      items: rows,
      cursor: rows.length ? rows[rows.length - 1].updated_at : after,
      complete: rows.length < limit,
    };
  }

  async dropBackup(scope) {
    for (const [key, row] of [...this.rows]) {
      if (!scope || row.scope === scope) this.rows.delete(key);
    }
    return { ok: true };
  }
}

let home;
let wrapper;

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  home = new FakeVaultHome();
  wrapper = crypto.getRandomValues(new Uint8Array(32));
});

const here = (opaqueWrapper = wrapper) => load(home, USER, opaqueWrapper);

async function mirror(backup, scope, item, value) {
  backup.queue(scope, item, value);
  await backup.flush();
}

describe('key custody', () => {
  it('creates OPAQUE custody by default and restores on a genuinely new device', async () => {
    const first = await here();
    expect(first.mode).toBe('opaque_custody');
    expect(first.created).toBe(true);
    expect(first.raw).toHaveLength(32);
    expect(home.held.mode).toBe('opaque_custody');
    expect(home.held.escrow_key).toBe(null);

    globalThis.indexedDB = new IDBFactory();
    const fresh = await here();
    expect(fresh.mode).toBe('opaque_custody');
    expect(b64(fresh.raw)).toBe(b64(first.raw));
  });

  it('does not open an OPAQUE vault with a different export-derived wrapper', async () => {
    await here();
    globalThis.indexedDB = new IDBFactory();
    const stranger = crypto.getRandomValues(new Uint8Array(32));
    const fresh = await here(stranger);
    expect(fresh.locked).toBe(true);
    expect(fresh.key).toBe(null);
  });

  it('uses the generated account recovery key as a second cryptographic wrapper', async () => {
    const recoveryKeyWrapper = crypto.getRandomValues(new Uint8Array(32));
    const first = await load(home, USER, wrapper, recoveryKeyWrapper);
    expect(first.recoveryKey).toBe(true);
    expect(home.held.independent_ciphertext).toMatch(/^k1\./);

    globalThis.indexedDB = new IDBFactory();
    const newPasswordWrapper = crypto.getRandomValues(new Uint8Array(32));
    const locked = await load(home, USER, newPasswordWrapper);
    expect(locked.locked).toBe(true);
    expect(locked.needs_recovery_key).toBe(true);

    // `reseal`: the wrapper is made from the password typed at this sign-in (a stale one is never sealed under).
    const recovered = await load(
      home, USER, newPasswordWrapper, recoveryKeyWrapper, { reseal: true },
    );
    expect(recovered.recoveryKey).toBe(true);
    expect(b64(recovered.raw)).toBe(b64(first.raw));

    globalThis.indexedDB = new IDBFactory();
    const healed = await load(home, USER, newPasswordWrapper);
    expect(b64(healed.raw)).toBe(b64(first.raw));
  });

  it('never creates trusted-device custody without the password-derived wrapper', async () => {
    // It used to make a `device_custody` vault here (the no-OPAQUE fallback). Now: locked, nothing written.
    const first = await load(home, USER, null);
    expect(first.mode).toBe('none');
    expect(first.locked).toBe(true);
    expect(first.needs_password).toBe(true);
    expect(first.key).toBe(null);
    expect(home.held).toBe(null);
    globalThis.indexedDB = new IDBFactory();
    const fresh = await load(home, USER, null);
    expect(fresh.needs_device).toBe(true);
    expect(fresh.key).toBe(null);
  });
});

describe('the history mirror', () => {
  it('is opaque to the server in the normal OPAQUE mode and restores on another device', async () => {
    const ring = await here();
    const backup = new Backup(home, ring);
    await mirror(backup, 'dm1', 'f1', { text: 'hello', attachments: [], reply: null });
    await mirror(backup, 'dm1', 'rx', [{ target: 'f1', emoji: '\u{1F44D}' }]);
    await mirror(backup, 'dm2', 'f9', { text: 'elsewhere' });

        globalThis.indexedDB = new IDBFactory();
    const recovered = await here();
    const fresh = new Backup(home, recovered);
    const rows = await fresh.restore('dm1');
    expect(rows.get('f1').text).toBe('hello');
    expect(rows.get('rx')).toHaveLength(1);
    expect(rows.has('f9')).toBe(false);
  });

  it('folds repeated writes of one row into a single upload', async () => {
    const backup = new Backup(home, await here());
    backup.queue('dm1', 'cx', { edits: {}, dead: [], pins: [] });
    backup.queue('dm1', 'cx', { edits: { f1: 'once' }, dead: [], pins: [] });
    backup.queue('dm1', 'cx', { edits: { f1: 'twice' }, dead: [], pins: [] });
    await backup.flush();

    expect(home.puts).toBe(1);
    expect(home.rows.size).toBe(1);
    expect((await backup.restore('dm1')).get('cx').edits.f1).toBe('twice');
  });

  it('does nothing without a recovery key', async () => {
    const backup = new Backup(home, null);
    expect(backup.enabled).toBe(false);
    backup.queue('dm1', 'f1', { text: 'nowhere' });
    await backup.flush();
    expect(home.rows.size).toBe(0);
    expect(await backup.restore('dm1')).toEqual(new Map());
  });

  it('keeps a failed upload for a later flush', async () => {
    const backup = new Backup(home, await here());
    const real = home.putBackup.bind(home);
    home.putBackup = async () => { throw new Error('sequencer unreachable'); };

    backup.queue('dm1', 'f1', { text: 'written while the server was down' });
    await expect(backup.flush()).rejects.toThrow(/unreachable/);
    expect(home.rows.size).toBe(0);

    home.putBackup = real;
    backup.blockedUntil = 0;
    await backup.flush();
    expect((await backup.restore('dm1')).get('f1').text)
      .toBe('written while the server was down');
  });

  it('skips a row no key on the ring opens rather than losing the rest', async () => {
    const backup = new Backup(home, await here());
    await mirror(backup, 'dm1', 'f1', { text: 'readable' });
    const stranger = crypto.getRandomValues(new Uint8Array(32));
    await home.putBackup([{
      scope: 'dm1',
      item: 'f2',
      ciphertext: await seal(stranger, te.encode('{"text":"nope"}')),
    }]);

    const rows = await backup.restore('dm1');
    expect(rows.get('f1').text).toBe('readable');
    expect(rows.has('f2')).toBe(false);
  });
});

describe('the second copy of the vault', () => {
  it('survives a primary repair that does not mention it', async () => {
    const accountKey = crypto.getRandomValues(new Uint8Array(32));
    const first = await load(home, USER, wrapper, accountKey);
    const copy = home.held.independent_ciphertext;
    expect(copy).toMatch(/^k1\./);

    const handed = { ...first, independentCiphertext: undefined };
    const repaired = await writeOpaque(home, handed, USER, wrapper);
    expect(home.modes.at(-1)).not.toHaveProperty('independent_ciphertext');
    expect(home.modes.at(-1)).not.toHaveProperty('clear_independent');
    expect(home.held.independent_ciphertext).toBe(copy);
    expect(b64(repaired.raw)).toBe(b64(first.raw));

    globalThis.indexedDB = new IDBFactory();
    const elsewhere = await load(home, USER, null, accountKey);
    expect(elsewhere.recoveryKey).toBe(true);
    expect(b64(elsewhere.raw)).toBe(b64(first.raw));
  });

  it('keeps the flags the device already had when it was not told about the copy', async () => {
    const ring = await here();
    const out = await writeOpaque(
      home, { ...ring, independent: true, recoveryKey: true }, USER, wrapper,
    );
    expect(out.independent).toBe(true);
    expect(out.recoveryKey).toBe(true);
  });
});

class VersionedVaultHome extends FakeVaultHome {
  constructor() {
    super();
    this.version = 0;
    this.writes = [];
  }

  async vault() {
    const out = await super.vault();
    return out.exists ? { ...out, version: this.version } : out;
  }

  check(body) {
    this.writes.push(body);
    if (typeof body.expected_version === 'number' && body.expected_version !== this.version) {
      throw Object.assign(new Error('the vault changed'), {
        status: 409, body: { code: 'vault_version_conflict', version: this.version },
      });
    }
  }

  async putVault(body) {
    this.check(body);
    await super.putVault(body);
    this.version += 1;
    return { ok: true, version: this.version };
  }

  async setVaultMode(body) {
    this.check(body);
    await super.setVaultMode(body);
    this.version += 1;
    return { mode: body.mode, version: this.version };
  }
}

async function planted(target, mode, ring, sealWith) {
  const payload = te.encode(JSON.stringify({
    v: 2, key: b64(ring.raw), retired: (ring.retired || []).map((r) => b64(r)),
  }));
  target.held = {
    mode,
    ciphertext: await seal(sealWith, payload),
    escrow_key: null,
    independent_ciphertext: target.held?.independent_ciphertext || null,
  };
  target.version += 1;
}

const sameRaw = (a, b) => b64(a) === b64(b);

describe('a vault two devices write', () => {
  beforeEach(() => {
    home = new VersionedVaultHome();
  });

  it('is never minted over a ring this device holds', async () => {
    const first = await here();
    expect(first.created).toBe(true);
    home.held = null;
    home.version = 0;
    const again = await here();
    expect(again.created).toBe(false);
    expect(sameRaw(again.raw, first.raw)).toBe(true);
    expect(home.writes.at(-1).expected_version).toBe(0);
    globalThis.indexedDB = new IDBFactory();
    expect(sameRaw((await here()).raw, first.raw)).toBe(true);
  });

  it('refuses to mint a vault over an account that already has an account key (vault_missing)', async () => {
    home.crossSigning = async () => ({ exists: true, identity_key: 'published-key' });
    // A brand-new device: no held ring, no vault on the server, but the account's identity key exists.
    await expect(here()).rejects.toMatchObject({ code: 'vault_missing' });
    expect(home.held).toBeNull();
    expect(home.writes).toHaveLength(0);
    expect(await heldRecoveryKeyring(USER)).toBeNull();
  });

  it('still creates the vault when the account has no account key yet', async () => {
    home.crossSigning = async () => ({ exists: false });
    const made = await here();
    expect(made.created).toBe(true);
    expect(home.held).not.toBeNull();
  });

  it('does not refuse a device that holds a ring, which uploads it rather than minting one', async () => {
    const first = await here();
    home.held = null;
    home.version = 0;
    home.crossSigning = async () => ({ exists: true, identity_key: 'published-key' });
    const again = await here();
    expect(again.created).toBe(false);
    expect(sameRaw(again.raw, first.raw)).toBe(true);
  });

  it('does not let two first devices each create a vault', async () => {
    const theirs = { raw: crypto.getRandomValues(new Uint8Array(32)), retired: [] };
    const read = home.vault.bind(home);
    let raced = false;
    home.vault = async () => {
      const out = await read();
      if (!raced) {
        raced = true;
        await planted(home, 'opaque_custody', theirs, wrapper);
      }
      return out;
    };
    const mine = await here();
    expect(home.writes.some((w) => w.expected_version === 0)).toBe(true);
    expect(sameRaw(mine.raw, theirs.raw)).toBe(true);
  });

  it('refuses a mode write against a version it did not read', async () => {
    const accountKey = crypto.getRandomValues(new Uint8Array(32));
    const ring = await here();
    await planted(home, 'opaque_custody', ring, wrapper);
    const out = await writeOpaque(home, ring, USER, wrapper, await recoveryKeyCiphertext(ring, accountKey));
    expect(home.writes.filter((w) => w.independent_ciphertext).length).toBe(2);
    expect(out.version).toBe(home.version);

    const other = { raw: crypto.getRandomValues(new Uint8Array(32)), retired: [] };
    await planted(home, 'opaque_custody', other, wrapper);
    await expect(writeOpaque(home, out, USER, wrapper, await recoveryKeyCiphertext(ring, accountKey)))
      .rejects.toMatchObject({ code: 'vault_changed' });
    expect(home.held.independent_ciphertext).toMatch(/^k1\./);
  });

  it('keeps a held key a server copy has lost, and puts it back', async () => {
    const first = await here();
    const other = { raw: crypto.getRandomValues(new Uint8Array(32)), retired: [] };
    await planted(home, 'opaque_custody', other, wrapper);
    const out = await here();
    expect(sameRaw(out.raw, other.raw)).toBe(true);
    expect(out.openers.some((k) => sameRaw(k, first.raw))).toBe(true);
    globalThis.indexedDB = new IDBFactory();
    const fresh = await here();
    expect(fresh.openers.some((k) => sameRaw(k, first.raw))).toBe(true);
  });
});

// Phase 4: device_custody, self_custody and escrowed are retired. A vault still stored in one is never read as a key;
// the one exception is a device_custody vault whose ring this device holds, or whose recovery copy opens (L1h).
describe('a vault stored in a retired custody mode', () => {
  beforeEach(() => {
    home = new VersionedVaultHome();
  });

  const writesBefore = () => home.writes.length;

  async function retiredVault(mode, { ring = null, independent = null } = {}) {
    const served = ring || { raw: crypto.getRandomValues(new Uint8Array(32)), retired: [] };
    await planted(home, mode, served, crypto.getRandomValues(new Uint8Array(32)));
    home.held.independent_ciphertext = independent;
    return served;
  }

  it.each(['self_custody', 'escrowed'])('refuses %s, locked, and writes nothing, even with a ring held and the password in hand', async (mode) => {
    const held = { raw: crypto.getRandomValues(new Uint8Array(32)), retired: [] };
    await rememberRecoveryKeyring(USER, held);
    await retiredVault(mode);
    const before = writesBefore();
    const out = await here();
    expect(out.locked).toBe(true);
    expect(out.key).toBeNull();
    expect(out.retiredMode).toBe(mode);
    expect(out.needs_password).toBe(false);
    expect(home.writes.length).toBe(before);
    expect(home.held.mode).toBe(mode);
    const tokenOnly = await load(home, USER, null);
    expect(tokenOnly.retiredMode).toBe(mode);
    expect(tokenOnly.needs_password).toBe(true);
    expect(home.writes.length).toBe(before);
  });

  it('refuses device_custody on a device holding nothing, and with no password, and writes nothing', async () => {
    await retiredVault('device_custody');
    const before = writesBefore();
    const noRing = await here();
    expect(noRing.locked).toBe(true);
    expect(noRing.retiredMode).toBe('device_custody');
    await rememberRecoveryKeyring(USER, { raw: crypto.getRandomValues(new Uint8Array(32)), retired: [] });
    const noPassword = await load(home, USER, null);
    expect(noPassword.locked).toBe(true);
    expect(noPassword.retiredMode).toBe('device_custody');
    expect(noPassword.key).toBeNull();
    expect(home.writes.length).toBe(before);
    expect(home.held.mode).toBe('device_custody');
  });

  it('converts device_custody (L1h) when this device holds the ring and the password is in hand, without rotating it', async () => {
    const held = { raw: crypto.getRandomValues(new Uint8Array(32)), retired: [] };
    await rememberRecoveryKeyring(USER, held);
    await retiredVault('device_custody');
    // Not for a wrapper kept in memory from an earlier sign-in: it may be the old password's.
    const kept = await here();
    expect(kept.retiredMode).toBe('device_custody');
    expect(home.held.mode).toBe('device_custody');
    const out = await load(home, USER, wrapper, null, { reseal: true });
    expect(out.mode).toBe('opaque_custody');
    expect(out.locked).toBeUndefined();
    expect(sameRaw(out.raw, held.raw)).toBe(true);
    expect(out.retired).toEqual([]);
    expect(home.held.mode).toBe('opaque_custody');
    expect(home.writes.at(-1).expected_version).toBe(home.version - 1);
    globalThis.indexedDB = new IDBFactory();
    expect(sameRaw((await here()).raw, held.raw)).toBe(true);
  });

  it('converts device_custody from the recovery copy when the recovery key is in hand, and gives it the same ring', async () => {
    const accountKey = crypto.getRandomValues(new Uint8Array(32));
    const ring = { raw: crypto.getRandomValues(new Uint8Array(32)), retired: [] };
    const copy = await recoveryKeyCiphertext(ring, accountKey);
    await retiredVault('device_custody', { independent: copy });
    const out = await load(home, USER, wrapper, accountKey, { reseal: true });
    expect(out.mode).toBe('opaque_custody');
    expect(sameRaw(out.raw, ring.raw)).toBe(true);
    expect(out.hasRecoveryCopy).toBeUndefined();
    expect(home.held.mode).toBe('opaque_custody');
    expect(home.held.independent_ciphertext).toMatch(/^k1\./);
    const wrong = crypto.getRandomValues(new Uint8Array(32));
    await retiredVault('device_custody', { independent: copy });
    globalThis.indexedDB = new IDBFactory();
    const refused = await load(home, USER, wrapper, wrong, { reseal: true });
    expect(refused.hasRecoveryCopy).toBe(true);
    expect(refused.retiredMode).toBe('device_custody');
    expect(refused.key).toBeNull();
  });

  it('is replaced by a new vault only on purpose, and only at the version that was read', async () => {
    const old = await retiredVault('escrowed', { independent: 'k1.stale-copy-of-the-old-ring' });
    const made = await replaceRetiredVault(home, USER, wrapper);
    expect(made.mode).toBe('opaque_custody');
    expect(sameRaw(made.raw, old.raw)).toBe(false);
    expect(home.held.mode).toBe('opaque_custody');
    expect(home.held.independent_ciphertext).toBeNull();
    expect(home.writes.at(-1)).toMatchObject({ mode: 'opaque_custody', clear_independent: true });
    globalThis.indexedDB = new IDBFactory();
    expect(sameRaw((await here()).raw, made.raw)).toBe(true);

    await expect(replaceRetiredVault(home, USER, wrapper)).rejects.toMatchObject({ code: 'vault_not_retired' });

    const held = { raw: crypto.getRandomValues(new Uint8Array(32)), retired: [] };
    await rememberRecoveryKeyring(USER, held);
    await retiredVault('self_custody');
    const read = home.vault.bind(home);
    let raced = false;
    home.vault = async () => {
      const out = await read();
      if (!raced) {
        raced = true;
        await planted(home, 'opaque_custody', { raw: crypto.getRandomValues(new Uint8Array(32)) }, wrapper);
      }
      return out;
    };
    await expect(replaceRetiredVault(home, USER, wrapper)).rejects.toMatchObject({ status: 409 });
    expect(home.held.mode).toBe('opaque_custody');
    // A refused replace leaves the ring this device already held where it was.
    expect(sameRaw((await heldRecoveryKeyring(USER)).raw, held.raw)).toBe(true);
  });

  it('is replaced with a recovery copy under the recovery key when it is in hand', async () => {
    await retiredVault('device_custody');
    const accountKey = crypto.getRandomValues(new Uint8Array(32));
    const made = await replaceRetiredVault(home, USER, wrapper, accountKey);
    expect(made.recoveryKey).toBe(true);
    expect(home.held.independent_ciphertext).toMatch(/^k1\./);
  });
});
