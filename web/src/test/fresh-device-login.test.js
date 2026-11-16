// Release gate: "log in with only your password on a brand-new device and everything works". Against the built
// telium-server binary (see real-home.js). See docs/custody-design.md for the custody model these tests pin down.
//
// Every scenario ends in the same assertions (`freshDeviceWorks`): Alice's second device, given nothing but her
// password (no sibling device, no recovery key), signs itself, is accepted by Bob's continuity check, reads the DM
// history her first device saw, and exchanges new messages with Bob both ways.
//
// Each device is wired the way lib/store/lifecycle.js and lib/store/trust.js wire it: custody read before the vault
// load, the vault loaded with whatever wrappers that session holds in memory (a restored session holds none), an MLS
// engine with the history mirror (Backup), and `trustMethods.startTrust` choosing the seal through `custodyMode()`.
// Nothing here passes a custody mode by hand.
//
// Scenarios that fail today are `it.fails`, each with the assertion that fails and why. They are the custody bugs the
// single-path design removes; when one starts passing, vitest reports it and the marker comes off.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { Mls, wipe } from '../lib/mls.js';
import { Backup } from '../lib/backup.js';
import { load as loadVault } from '../lib/vault.js';
import { loginOpaque, registerOpaque } from '../lib/opaque-auth.js';
import { Trust } from '../lib/verify.js';
import { trustMethods } from '../lib/store/trust.js';
import { RealHome, haveServer } from './real-home.js';

const realFetch = globalThis.fetch;

let server;
let n = 0;
const name = (who) => `${who}${n += 1}`;

async function history(api, id) {
  const out = [];
  let after = 0;
  for (;;) {
    const page = (await api.dmHistory(id, { after, limit: 500 })).messages || [];
    out.push(...page);
    if (page.length < 500) return out;
    after = page.at(-1).seq;
  }
}

/// Each side runs in its own browser storage (`on`), as two people's devices do.
async function says(on, from, to, id, text) {
  on(from.label);
  await from.mls.send(id, text);
  on(to.label);
  const frames = await history(to.api, id);
  await to.mls.sync(id, frames);
  const last = frames.findLast((f) => f.kind === 'application');
  return to.mls.textOf(last.id);
}

// Each simulated device (or browser profile) keeps its own IndexedDB and localStorage; tabs of one browser share them.
function browsers() {
  const saved = new Map();
  let current = null;
  const snapshot = () => Object.fromEntries(
    Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)).map((k) => [k, localStorage.getItem(k)]),
  );
  return (label) => {
    if (current === label) return;
    if (current) saved.set(current, { db: globalThis.indexedDB, storage: snapshot() });
    current = label;
    const next = saved.get(label);
    globalThis.indexedDB = next?.db || new IDBFactory();
    localStorage.clear();
    for (const [k, v] of Object.entries(next?.storage || {})) localStorage.setItem(k, v);
  };
}

/// One app start for an account: `recoveryWrapper`/`accountRecoveryWrapper` are what that session holds in memory (a
/// sign-in or sign-up holds them, a restored session or second tab holds neither).
async function start(account, { api = account.api, recoveryWrapper = null, accountRecoveryWrapper = null } = {}) {
  // lifecycle.js kicks off refreshCustody() before vault.load and does not wait for it.
  const custodyRead = api.vaultMode().catch(() => null);
  let ring = null;
  let vaultError = null;
  try {
    ring = await loadVault(api, null, account.userId, recoveryWrapper, accountRecoveryWrapper);
  } catch (e) {
    // lifecycle.js: "key vault unavailable", and the engine starts without a recovery key.
    vaultError = e;
  }
  let custody = await custodyRead;
  // lifecycle.js refreshes custody again when the vault was created or its mode differs.
  if (ring && (ring.created || custody?.mode !== ring.mode)) custody = await api.vaultMode().catch(() => custody);
  const backup = new Backup(api, null);
  const mls = new Mls(api, { userId: account.userId, deviceId: account.deviceId, backup });
  if (ring) await mls.adoptRecoveryKey(ring);
  await mls.start();
  const store = Object.assign(Object.create(trustMethods), {
    home: api,
    mls,
    session: { home: { user_id: account.userId, device_id: account.deviceId } },
    vault: ring,
    custody,
    authRecoveryWrapper: recoveryWrapper,
    trust: null,
    trustStart: null,
    route: {},
    sync: { adoptKeyring: async () => {} },
    emit() {},
  });
  const trust = await store.startTrust();
  if (trust) mls.verifyClaimedPackage = (u, d, k) => trust.verifyClaimedPackage(u, d, k);
  return { ...account, api, ring, vaultError, custody, backup, mls, trust, store };
}

async function newBob() {
  const bob = server.wrap((await server.register(name('bob'))).session);
  const mls = new Mls(bob.api, { userId: bob.userId, deviceId: bob.deviceId });
  await mls.start();
  const trust = new Trust(bob.api, { userId: bob.userId, deviceId: bob.deviceId });
  await trust.start(mls.cs, crypto.getRandomValues(new Uint8Array(32)), await mls.leafKey(), 'device_custody');
  mls.verifyClaimedPackage = (u, d, k) => trust.verifyClaimedPackage(u, d, k);
  return { ...bob, mls, trust, label: 'bob' };
}

/// Alice's first device founds a DM with Bob and both sides talk; what device 1 opened is mirrored for later devices.
async function talk(on, alice, bob) {
  on(alice.label);
  expect(alice.trust?.canSign).toBe(true);
  const { id } = await alice.api.createConversation({ kind: 'dm', members: [bob.userId] });
  const built = await alice.mls.establish(id, [bob.userId], { generation: 0 });
  await alice.api.sendFrame(id, {
    kind: 'welcome', ciphertext: built.welcome, epoch: built.epoch, start_over: true, generation: 0,
  });
  await alice.mls.sync(id, await history(alice.api, id));
  on(bob.label);
  await bob.mls.sync(id, await history(bob.api, id));
  expect(bob.mls.joined(id)).toBe(true);
  expect(await says(on, alice, bob, id, 'from the first device')).toBe('from the first device');
  expect(await says(on, bob, alice, id, 'heard you')).toBe('heard you');
  on(alice.label);
  await alice.backup.flush();
  const said = (await history(alice.api, id)).filter((f) => f.kind === 'application').map((f) => f.id);
  return { id, said };
}

/// A brand-new device: nothing of any other device on disk, only the password typed.
async function freshDevice(on, userId, password) {
  const label = `fresh-${crypto.randomUUID()}`;
  // A browser storage nobody has used: no MLS state, no held ring, no account key, no pins.
  on(label);
  const login = await loginOpaque(server.base, userId, password, 'new laptop');
  return { ...await start(server.wrap(login.session), { recoveryWrapper: login.recoveryWrapper }), label };
}

/// The release gate itself.
async function freshDeviceWorks(on, alice2, bob, { id, said }) {
  // Signs itself, with the published root, and Bob's continuity check accepts it.
  expect(alice2.ring?.raw).toBeTruthy();
  expect(alice2.trust).toBeTruthy();
  expect(alice2.trust.identityMismatch).toBeFalsy();
  expect(alice2.trust.canSign).toBe(true);
  const leaf = await alice2.mls.leafKey();
  on(bob.label);
  bob.trust.peers.clear();
  expect(await bob.trust.verifyClaimedPackage(alice2.userId, alice2.deviceId, leaf)).toBe(true);

  // Reads the existing history.
  on(alice2.label);
  const frames = await history(alice2.api, id);
  await alice2.mls.selfJoin(id, frames);
  await alice2.mls.sync(id, await history(alice2.api, id));
  expect(alice2.mls.joined(id)).toBe(true);
  expect(alice2.mls.errorFor(id)).toBeFalsy();
  expect(said.map((f) => alice2.mls.textOf(f))).toEqual(['from the first device', 'heard you']);

  // New messages both ways.
  on(bob.label);
  await bob.mls.sync(id, await history(bob.api, id));
  expect(bob.mls.epochOf(id)).toBe(alice2.mls.epochOf(id));
  expect(await says(on, alice2, bob, id, 'from the new device')).toBe('from the new device');
  expect(await says(on, bob, alice2, id, 'hello new device')).toBe('hello new device');
}

describe.skipIf(!haveServer)('fresh device login (release gate)', () => {
  beforeAll(async () => { server = await RealHome.start(); });
  afterAll(async () => { await server?.stop(); });
  beforeEach(async () => {
    globalThis.fetch = realFetch;
    globalThis.indexedDB = new IDBFactory();
    localStorage.clear();
    await wipe();
  });

  async function signUp(on) {
    const password = `pw-${crypto.randomUUID()}`;
    on('alice-1');
    const reg = await registerOpaque(server.base, name('alice'), password, 'web');
    expect(reg.session.recovery_key_enrolled).toBe(true);
    return { password, reg, account: server.wrap(reg.session) };
  }

  const signUpWrappers = (reg) => ({
    recoveryWrapper: reg.recoveryWrapper,
    accountRecoveryWrapper: reg.accountRecovery.vaultWrapper,
  });

  async function gate(on, alice1, password) {
    alice1.label = 'alice-1';
    on('bob');
    const bob = await newBob();
    const convo = await talk(on, alice1, bob);
    const alice2 = await freshDevice(on, alice1.userId, password);
    await freshDeviceWorks(on, alice2, bob, convo);
  }

  it('signs up on one device, then a brand-new device with only the password reads and sends', async () => {
    const on = browsers();
    const { password, reg, account } = await signUp(on);
    const alice1 = await start(account, signUpWrappers(reg));
    expect(alice1.ring.mode).toBe('opaque_custody');
    await gate(on, alice1, password);
  });

  it('a later restart of the first device from a restored session does not undo it', async () => {
    const on = browsers();
    const { password, reg, account } = await signUp(on);
    await start(account, signUpWrappers(reg));
    // Reload: the session is restored from storage; the OPAQUE wrappers were memory only.
    const alice1 = await start(account);
    await gate(on, alice1, password);
  });

  // Two tabs of one browser share its storage; `delayed` slows every request of one of them, as a second tab's can be.
  const delayed = (api, ms) => new Proxy(api, {
    get(target, key) {
      const v = target[key];
      if (typeof v !== 'function') return v;
      return async (...args) => {
        await new Promise((r) => setTimeout(r, ms));
        return v.apply(target, args);
      };
    },
  });

  it('two tabs starting at once during sign-up, the signing-up tab first', async () => {
    const on = browsers();
    const { password, reg, account } = await signUp(on);
    const [signingUp] = await Promise.all([
      start(account, signUpWrappers(reg)),
      start(account, { api: delayed(account.api, 20) }),
    ]);
    await gate(on, signingUp, password);
  });

  it('two tabs starting at once during sign-up, the restored tab first', async () => {
    const on = browsers();
    const { password, reg, account } = await signUp(on);
    const [signingUp] = await Promise.all([
      start(account, { ...signUpWrappers(reg), api: delayed(account.api, 20) }),
      start(account),
    ]);
    await gate(on, signingUp, password);
  });

  // Fails at `expect(alice2.ring?.raw).toBeTruthy()`: the restored tab (no OPAQUE wrapper in memory) finds no vault
  // and creates one in `device_custody`, sealed under a throwaway key (vault.js loadOnce, `!vault.exists` branch), and
  // its Trust then seals the root with DEVICE_SEAL because custodyMode() reads `device_custody`. The sign-up tab is
  // closed before its own start runs, so nothing ever wraps the ring under the password. The brand-new device gets
  // `locked: true, needs_device: true`. Target design: a session with no OPAQUE export key never creates custody.
  it.fails('two tabs, and the restored one creates the vault before the sign-up tab is closed', async () => {
    const on = browsers();
    const { password, account } = await signUp(on);
    const restored = await start(account);
    await gate(on, restored, password);
  });

  it('the answer to the first vault write is lost, and the device restarts from a restored session', async () => {
    const on = browsers();
    const { password, reg, account } = await signUp(on);
    const lost = new Proxy(account.api, {
      get(target, key) {
        if (key !== 'putVault') return target[key];
        return async (body) => {
          await target.putVault(body);
          throw Object.assign(new Error('the answer was lost'), { status: 503 });
        };
      },
    });
    const first = await start(account, { ...signUpWrappers(reg), api: lost });
    expect(first.vaultError).toBeTruthy();
    const alice1 = await start(account);
    await gate(on, alice1, password);
  });

  it('the answer to the account-key create is lost, and the device restarts from a restored session', async () => {
    const on = browsers();
    const { password, reg, account } = await signUp(on);
    const lost = new Proxy(account.api, {
      get(target, key) {
        if (key !== 'putCrossSigning') return target[key];
        return async (body) => {
          await target.putCrossSigning(body);
          throw Object.assign(new Error('the answer was lost'), { status: 503 });
        };
      },
    });
    const first = await start(account, { ...signUpWrappers(reg), api: lost });
    expect(first.trust).toBeNull();
    const alice1 = await start(account);
    await gate(on, alice1, password);
  });

  it('the tab is closed while the account-key create is in flight, and reopens from a restored session', async () => {
    const on = browsers();
    const { password, reg, account } = await signUp(on);
    let landed;
    const reached = new Promise((r) => { landed = r; });
    const closing = new Proxy(account.api, {
      get(target, key) {
        if (key !== 'putCrossSigning') return target[key];
        // The request reaches the server; the tab is gone before the answer, so nothing after it runs.
        return async (body) => {
          await target.putCrossSigning(body);
          landed();
          return new Promise(() => {});
        };
      },
    });
    start(account, { ...signUpWrappers(reg), api: closing });
    await reached;
    expect((await account.api.crossSigning()).exists).toBe(true);
    const alice1 = await start(account);
    await gate(on, alice1, password);
  });

  // Fails at `expect(alice1.trust?.canSign).toBe(true)` in `talk`: the vault write landed but the tab closed before
  // the ring was remembered locally (vault.js only remembers on an unanswered *error*, not on a request that never
  // returns). The restored session holds no OPAQUE wrapper, so the vault loads `locked`, the Trust gets no key to seal
  // a root with and creates none, and device 1 cannot sign (or DM) until the password is typed again. Target design:
  // keep the ring locally before the write is sent, as the account key already is (keepPendingSecret).
  it.fails('the tab is closed while the first vault write is in flight, and reopens from a restored session', async () => {
    const on = browsers();
    const { password, reg, account } = await signUp(on);
    let landed;
    const reached = new Promise((r) => { landed = r; });
    const closing = new Proxy(account.api, {
      get(target, key) {
        if (key !== 'putVault') return target[key];
        return async (body) => {
          await target.putVault(body);
          landed();
          return new Promise(() => {});
        };
      },
    });
    start(account, { ...signUpWrappers(reg), api: closing });
    await reached;
    const alice1 = await start(account);
    await gate(on, alice1, password);
  });

  // Fails at `expect(alice2.trust.canSign).toBe(true)`: an account from before #70 has its root sealed under a
  // throwaway key (`device-v1:`). The ring is in opaque custody, so the new device opens history keys, but nothing it
  // holds opens the root, and the device that holds it has not been reopened since (the heal in #70 runs only then).
  // Target design: the "seal it properly now" migration step, run by whichever device holds the root, plus the #74
  // reset for accounts where no device does.
  it.fails('a legacy account whose root is throwaway-sealed and held only by its first device', async () => {
    const on = browsers();
    const { password, reg, account } = await signUp(on);
    const alice1 = await start(account, signUpWrappers(reg));
    // Reproduce the pre-#70 state: root re-sealed under a throwaway key, as `device_custody` starts did.
    const legacy = new Trust(account.api, { userId: account.userId, deviceId: account.deviceId, recovery: alice1.ring });
    await legacy.start(alice1.mls.cs, alice1.ring.key, await alice1.mls.leafKey(), 'device_custody');
    expect(String((await account.api.crossSigning()).sealed_secret)).toMatch(/^device-v1:/);
    await gate(on, alice1, password);
  });
});
