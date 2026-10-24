import { beforeEach, describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { Backup } from '../lib/backup.js';
import {
  load, open, recoveryKeyCiphertext, removeIndependentRecovery, seal,
  setIndependentRecovery, setMode,
} from '../lib/vault.js';

const te = new TextEncoder();
const td = new TextDecoder();
const b64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const USER = '@alice:test.example';
const PHRASE = 'correct horse battery staple';

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
      escrow_key: this.held.escrow_key || undefined,
      independent_ciphertext: this.held.independent_ciphertext || null,
    };
  }

  async putVault(body) {
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
      escrow_key: body.mode === 'escrowed' ? (body.escrow_key || null) : null,
      independent_ciphertext: body.mode !== 'opaque_custody'
        ? before
        : body.clear_independent ? null : body.independent_ciphertext || before,
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

  async operatorReads(scope, item) {
    if (!this.held?.escrow_key) return undefined;
    const wrapper = Uint8Array.from(atob(this.held.escrow_key), (c) => c.charCodeAt(0));
    const payload = await open(wrapper, this.held.ciphertext);
    const doc = JSON.parse(td.decode(payload));
    const row = this.rows.get(`${scope}/${item}`);
    if (!row) return undefined;
    for (const raw of [doc.key, ...(doc.retired || [])]) {
      const key = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0));
      try { return JSON.parse(td.decode(await open(key, row.ciphertext))); }
      catch {}
    }
    return undefined;
  }
}

let home;
let wrapper;

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  home = new FakeVaultHome();
  wrapper = crypto.getRandomValues(new Uint8Array(32));
});

const here = (phrase = null, opaqueWrapper = wrapper) =>
  load(home, phrase, USER, opaqueWrapper);

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
    const fresh = await here(null, stranger);
    expect(fresh.locked).toBe(true);
    expect(fresh.key).toBe(null);
  });

  it('uses the generated account recovery key as a second cryptographic wrapper', async () => {
    const recoveryKeyWrapper = crypto.getRandomValues(new Uint8Array(32));
    const first = await load(home, null, USER, wrapper, recoveryKeyWrapper);
    expect(first.recoveryKey).toBe(true);
    expect(home.held.independent_ciphertext).toMatch(/^k1\./);

    globalThis.indexedDB = new IDBFactory();
    const newPasswordWrapper = crypto.getRandomValues(new Uint8Array(32));
    const locked = await load(home, null, USER, newPasswordWrapper);
    expect(locked.locked).toBe(true);
    expect(locked.needs_recovery_key).toBe(true);

    const recovered = await load(
      home, null, USER, newPasswordWrapper, recoveryKeyWrapper,
    );
    expect(recovered.recoveryKey).toBe(true);
    expect(b64(recovered.raw)).toBe(b64(first.raw));

    globalThis.indexedDB = new IDBFactory();
    const healed = await load(home, null, USER, newPasswordWrapper);
    expect(b64(healed.raw)).toBe(b64(first.raw));
  });

  it('adds an independent passphrase without replacing normal password recovery', async () => {
    const primary = await here();
    const withIndependent = await setIndependentRecovery(
      home, primary, PHRASE, wrapper, USER,
    );
    expect(withIndependent.mode).toBe('opaque_custody');
    expect(withIndependent.independent).toBe(true);
    expect(home.held.independent_ciphertext).toMatch(/^p2\./);
    const firstSalt = home.held.independent_ciphertext.split('.')[1];

    await setIndependentRecovery(home, withIndependent, PHRASE, wrapper, USER);
    expect(home.held.independent_ciphertext.split('.')[1]).not.toBe(firstSalt);

    globalThis.indexedDB = new IDBFactory();
    const normal = await here();
    expect(b64(normal.raw)).toBe(b64(primary.raw));

    globalThis.indexedDB = new IDBFactory();
    const independent = await load(home, PHRASE, USER, null);
    expect(b64(independent.raw)).toBe(b64(primary.raw));
  });

  it('repairs a failed primary OPAQUE wrapper through independent recovery', async () => {
    const primary = await here();
    await setIndependentRecovery(home, primary, PHRASE, wrapper, USER);

    const current = home.held.ciphertext;
    const wrong = crypto.getRandomValues(new Uint8Array(32));
    home.held.ciphertext = await seal(wrong, te.encode('not the recovery keyring'));

    globalThis.indexedDB = new IDBFactory();
    const locked = await here();
    expect(locked.locked).toBe(true);
    expect(locked.needs_independent).toBe(true);
    expect(locked.needs_device).toBe(true);

    const repaired = await here(PHRASE);
    expect(repaired.mode).toBe('opaque_custody');
    expect(b64(repaired.raw)).toBe(b64(primary.raw));
    expect(home.held.ciphertext).not.toBe(current);

    globalThis.indexedDB = new IDBFactory();
    const clean = await here();
    expect(b64(clean.raw)).toBe(b64(primary.raw));
  });

  it('migrates legacy self-custody into OPAQUE while retaining the old passphrase as backup', async () => {
    const legacy = await load(home, PHRASE, USER, null);
    expect(legacy.mode).toBe('self_custody');

    globalThis.indexedDB = new IDBFactory();
    const opened = await load(home, PHRASE, USER, wrapper);
    expect(opened.mode).toBe('opaque_custody');
    expect(opened.independent).toBe(true);
    expect(home.held.independent_ciphertext).toBeTruthy();

    globalThis.indexedDB = new IDBFactory();
    expect(b64((await here()).raw)).toBe(b64(opened.raw));
  });

  it('rotates the live key while migrating away from legacy server escrow', async () => {
    const deviceOnly = await load(home, null, USER, null);
    const escrowed = await setMode(home, deviceOnly, 'escrowed', null, USER);
    const exposed = new Uint8Array(escrowed.raw);
    expect(home.held.escrow_key).toBeTruthy();

    globalThis.indexedDB = new IDBFactory();
    const migrated = await here();
    expect(migrated.mode).toBe('opaque_custody');
    expect(b64(migrated.raw)).not.toBe(b64(exposed));
    expect(b64(migrated.retired[0])).toBe(b64(exposed));
    expect(home.held.escrow_key).toBe(null);
  });

  it('keeps trusted-device custody as the no-OPAQUE compatibility fallback', async () => {
    const first = await load(home, null, USER, null);
    expect(first.mode).toBe('device_custody');
    globalThis.indexedDB = new IDBFactory();
    const fresh = await load(home, null, USER, null);
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

    expect(await home.operatorReads('dm1', 'f1')).toBeUndefined();

    globalThis.indexedDB = new IDBFactory();
    const recovered = await here();
    const fresh = new Backup(home, recovered);
    const rows = await fresh.restore('dm1');
    expect(rows.get('f1').text).toBe('hello');
    expect(rows.get('rx')).toHaveLength(1);
    expect(rows.has('f9')).toBe(false);
  });

  it('lets the operator read rows only in explicit legacy escrow', async () => {
    const primary = await here();
    const escrowed = await setMode(home, primary, 'escrowed', null, USER);
    const backup = new Backup(home, escrowed);
    await mirror(backup, 'dm1', 'f1', { text: 'legacy escrow can read this' });
    expect(await home.operatorReads('dm1', 'f1'))
      .toEqual({ text: 'legacy escrow can read this' });
  });

  it('closes future mirrored history to a retained legacy recovery key', async () => {
    const primary = await here();
    const escrowed = await setMode(home, primary, 'escrowed', null, USER);
    const backup = new Backup(home, escrowed);
    await mirror(backup, 'dm1', 'f1', { text: 'said while escrowed' });
    const oldRecovery = new Uint8Array(escrowed.raw);
    const oldRow = home.rows.get('dm1/f1');

    const taken = await setMode(
      home, escrowed, 'opaque_custody', null, USER, wrapper,
    );
    backup.rekey(taken);
    await mirror(backup, 'dm1', 'f2', { text: 'said after leaving escrow' });
    const newRow = home.rows.get('dm1/f2');

    expect(JSON.parse(td.decode(await open(oldRecovery, oldRow.ciphertext))).text)
      .toBe('said while escrowed');
    await expect(open(oldRecovery, newRow.ciphertext)).rejects.toThrow();

    const rows = await new Backup(home, taken).restore('dm1');
    expect(rows.get('f1').text).toBe('said while escrowed');
    expect(rows.get('f2').text).toBe('said after leaving escrow');
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
    const first = await load(home, null, USER, wrapper, accountKey);
    const copy = home.held.independent_ciphertext;
    expect(copy).toMatch(/^k1\./);

    const handed = { ...first, mode: 'device_custody', independentCiphertext: undefined };
    const repaired = await setMode(home, handed, 'opaque_custody', null, USER, wrapper);
    expect(home.modes.at(-1)).not.toHaveProperty('independent_ciphertext');
    expect(home.modes.at(-1)).not.toHaveProperty('clear_independent');
    expect(home.held.independent_ciphertext).toBe(copy);
    expect(b64(repaired.raw)).toBe(b64(first.raw));

    globalThis.indexedDB = new IDBFactory();
    const elsewhere = await load(home, null, USER, null, accountKey);
    expect(elsewhere.recoveryKey).toBe(true);
    expect(b64(elsewhere.raw)).toBe(b64(first.raw));
  });

  it('keeps the flags the device already had when it was not told about the copy', async () => {
    const ring = await here();
    const out = await setMode(
      home, { ...ring, mode: 'device_custody', independent: true, recoveryKey: true },
      'opaque_custody', null, USER, wrapper,
    );
    expect(out.independent).toBe(true);
    expect(out.recoveryKey).toBe(true);
  });

  it('clears a copy sealed before leaving escrow, because it holds the escrowed key', async () => {
    const accountKey = crypto.getRandomValues(new Uint8Array(32));
    const ring = await here();
    home.held.independent_ciphertext = await recoveryKeyCiphertext(ring, accountKey);
    const escrowed = await setMode(home, ring, 'escrowed', null, USER);
    expect(home.held.independent_ciphertext).toMatch(/^k1\./);

    const out = await setMode(home, escrowed, 'opaque_custody', null, USER, wrapper);
    expect(home.modes.at(-1).clear_independent).toBe(true);
    expect(home.held.independent_ciphertext).toBe(null);
    expect(out.recoveryKey).toBe(false);
    expect(b64(out.raw)).not.toBe(b64(escrowed.raw));
  });

  it('is removed only by saying so', async () => {
    const ring = await here();
    const withPhrase = await setIndependentRecovery(home, ring, PHRASE, wrapper, USER);
    expect(home.held.independent_ciphertext).toMatch(/^p2\./);
    const out = await removeIndependentRecovery(home, withPhrase, wrapper, USER);
    expect(home.modes.at(-1).clear_independent).toBe(true);
    expect(home.modes.at(-1)).not.toHaveProperty('independent_ciphertext');
    expect(home.held.independent_ciphertext).toBe(null);
    expect(out.independent).toBe(false);
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
    escrow_key: mode === 'escrowed' ? b64(sealWith) : null,
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
    const ring = await here();
    await planted(home, 'opaque_custody', ring, wrapper);
    const out = await setIndependentRecovery(home, ring, PHRASE, wrapper, USER);
    expect(home.writes.filter((w) => w.independent_ciphertext).length).toBe(2);
    expect(out.version).toBe(home.version);

    const other = { raw: crypto.getRandomValues(new Uint8Array(32)), retired: [] };
    await planted(home, 'opaque_custody', other, wrapper);
    await expect(removeIndependentRecovery(home, out, wrapper, USER))
      .rejects.toMatchObject({ code: 'vault_changed' });
    expect(home.held.independent_ciphertext).toMatch(/^p2\./);
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

  it('refuses an escrowed ring once this device has left escrow', async () => {
    const held = await here();
    const escrow = crypto.getRandomValues(new Uint8Array(32));
    const served = { raw: crypto.getRandomValues(new Uint8Array(32)), retired: [held.raw] };
    await planted(home, 'escrowed', served, escrow);

    const out = await here();
    expect(out.downgradeRefused).toBe(true);
    expect(sameRaw(out.raw, held.raw)).toBe(true);
    expect(home.held.mode).toBe('opaque_custody');
    expect(home.held.escrow_key).toBe(null);
    globalThis.indexedDB = new IDBFactory();
    expect(sameRaw((await here()).raw, held.raw)).toBe(true);
  });

  it('still leaves a legacy escrow the device has never been out of', async () => {
    const escrow = crypto.getRandomValues(new Uint8Array(32));
    const served = { raw: crypto.getRandomValues(new Uint8Array(32)), retired: [] };
    await planted(home, 'escrowed', served, escrow);
    const out = await here();
    expect(out.downgradeRefused).toBeUndefined();
    expect(out.mode).toBe('opaque_custody');
    expect(sameRaw(out.raw, served.raw)).toBe(false);
    expect(out.retired.some((k) => sameRaw(k, served.raw))).toBe(true);
  });
});
