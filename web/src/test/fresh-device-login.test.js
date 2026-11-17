// Release gate: "log in with only your password on a brand-new device and everything works". Against the built
// telium-server binary (see real-home.js). See https://docs.telium.chat/security/key-custody-design/ for the custody model these tests pin down.
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
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { Mls, wipe } from '../lib/mls.js';
import { Backup } from '../lib/backup.js';
import { load as loadVault, seal } from '../lib/vault.js';
import { Trust } from '../lib/verify.js';
import { b64 } from '../lib/util.js';
import { trustMethods } from '../lib/store/trust.js';
import { sessionMethods } from '../lib/store/session.js';
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

/// Sign-in now creates the vault and the account key itself (lib/store/session.js createCustody), through its own client, so
/// a fault in those writes has to be injected at `fetch`. The write reaches the server first; then either the answer is
/// lost (503) or never comes (the tab is gone). It fires once, on the first PUT to `path`, and is removed afterwards.
function faultAt(path, mode) {
  const fault = { hit: false, mode };
  fault.reached = new Promise((resolve) => { fault.landed = resolve; });
  const before = globalThis.fetch;
  fault.remove = () => { if (globalThis.fetch === wrapped) globalThis.fetch = before; };
  const wrapped = async (input, init) => {
    const method = String(init?.method || input?.method || 'GET').toUpperCase();
    const url = String(input?.url || input);
    const answer = await before(input, init);
    if (fault.hit || method !== 'PUT' || !url.endsWith(path)) return answer;
    fault.hit = true;
    fault.landed();
    if (mode === 'lost') {
      return new Response(JSON.stringify({ message: 'the answer was lost' }), {
        status: 503, headers: { 'content-type': 'application/json' },
      });
    }
    return new Promise(() => {});
  };
  globalThis.fetch = wrapped;
  return fault;
}

/// The app's own sign-in (lib/store/session.js): what it leaves in memory is all a first start gets.
async function signIn(user, password, { register = false } = {}) {
  const store = Object.assign(Object.create(sessionMethods), {
    cryptoCleanup: Promise.resolve(),
    disposed: false,
    me: null,
    emit() {},
  });
  const resp = await store.signIn(server.base, user, password, { register });
  return {
    resp,
    account: server.wrap({ ...resp, access_token: store.session.home.token }),
    wrappers: {
      recoveryWrapper: store.authRecoveryWrapper,
      accountRecoveryWrapper: store.accountRecoveryWrapper,
    },
  };
}

/// A brand-new device: nothing of any other device on disk, only the password typed.
async function freshDevice(on, userId, password) {
  const label = `fresh-${crypto.randomUUID()}`;
  // A browser storage nobody has used: no MLS state, no held ring, no account key, no pins.
  on(label);
  const { account, wrappers } = await signIn(userId, password);
  expect(wrappers.recoveryWrapper).toBeTruthy();
  expect(wrappers.accountRecoveryWrapper).toBeNull();
  return { ...await start(account, wrappers), label };
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

  async function signUp(on, { fault = null } = {}) {
    const password = `pw-${crypto.randomUUID()}`;
    on('alice-1');
    const faulty = fault && faultAt(fault.path, fault.mode);
    let resp; let account; let wrappers;
    try {
      ({ resp, account, wrappers } = await signIn(name('alice'), password, { register: true }));
    } finally { faulty?.remove(); }
    expect(resp.recovery_key).toBeTruthy();
    expect(wrappers.recoveryWrapper).toBeTruthy();
    expect(wrappers.accountRecoveryWrapper).toBeTruthy();
    return { password, reg: wrappers, account, fault: faulty };
  }

  const signUpWrappers = (reg) => reg;

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

  // Used to fail: the restored tab (no OPAQUE wrapper in memory) found no vault and created one in `device_custody`,
  // sealed under a throwaway key, with a `device-v1:` root, and the sign-up tab was closed before its own start ran.
  // Phase 1: sign-in creates the vault and the root before it saves the session, and a session without the OPAQUE
  // export key never creates custody (key-custody-design docs page, phase 1).
  it('two tabs, and the restored one creates the vault before the sign-up tab is closed', async () => {
    const on = browsers();
    const { password, account } = await signUp(on);
    const restored = await start(account);
    await gate(on, restored, password);
  });

  it('the answer to the first vault write is lost, and the device restarts from a restored session', async () => {
    const on = browsers();
    // The write lands and its answer is lost inside sign-in, which now makes the vault. Sign-in still finishes.
    const { password, reg, account, fault } = await signUp(on, { fault: { path: '/_telium/v1/vault', mode: 'lost' } });
    expect(fault.hit).toBe(true);
    const first = await start(account, signUpWrappers(reg));
    expect(first.vaultError).toBeFalsy();
    const alice1 = await start(account);
    await gate(on, alice1, password);
  });

  it('the answer to the account-key create is lost, and the device restarts from a restored session', async () => {
    const on = browsers();
    // The create lands and its answer is lost inside sign-in; the key was kept aside first, so the next start finds it.
    const { password, reg, account, fault } = await signUp(on, {
      fault: { path: '/_telium/v1/crosssigning', mode: 'lost' },
    });
    expect(fault.hit).toBe(true);
    const first = await start(account, signUpWrappers(reg));
    expect(first.trust?.canSign).toBe(true);
    const alice1 = await start(account);
    await gate(on, alice1, password);
  });

  // The tab is closed inside sign-in, which now makes the vault and the account key before it saves the session. The write
  // reaches the server, the answer never comes, and `save()` never runs, so no restored session can exist for this
  // sign-up: the user reopens by typing the password again on the same browser. That sign-in, and the restored session
  // it leaves behind, are what the gate runs on.
  async function closedInsideSignUp(on, path) {
    const password = `pw-${crypto.randomUUID()}`;
    const user = name('alice');
    on('alice-1');
    const fault = faultAt(path, 'closing');
    signIn(user, password, { register: true }).catch(() => {});
    await fault.reached;
    fault.remove();
    const { account, wrappers } = await signIn(user, password);
    return { password, account, wrappers };
  }

  it('the tab is closed while the account-key create is in flight, and reopens from a restored session', async () => {
    const on = browsers();
    const { password, account, wrappers } = await closedInsideSignUp(on, '/_telium/v1/crosssigning');
    expect((await account.api.crossSigning()).exists).toBe(true);
    await start(account, wrappers);
    const alice1 = await start(account);
    await gate(on, alice1, password);
  });

  // Used to fail: the vault write landed but the tab closed before the ring was remembered locally (it was kept only
  // on an unanswered *error*, not on a request that never returns), so the restored session was locked and device 1
  // could not sign. Phase 1: the ring is kept locally before the write is sent, as the account key is
  // (keepPendingSecret), and sign-in creates custody before saving the session (key-custody-design docs page).
  it('the tab is closed while the first vault write is in flight, and reopens from a restored session', async () => {
    const on = browsers();
    const { password, account, wrappers } = await closedInsideSignUp(on, '/_telium/v1/vault');
    await start(account, wrappers);
    const alice1 = await start(account);
    await gate(on, alice1, password);
  });

  // Used to fail: device 1 holds the root and restarts once while `GET /vault` fails (a 503). Its vault is null, so
  // Trust.start got no ring key and the `!wantRecovery && !deviceWrapped` branch of verify.js startOnce re-sealed the
  // server's `recovery-v1:` root as `device-v1:`, which a brand-new device cannot open. Phase 1 removes that branch:
  // the root is sealed only under AK and never downgraded (key-custody-design docs page, invariant I2).
  it('a device holding the root restarts while the vault read fails, then a new device signs in', async () => {
    const on = browsers();
    const { password, reg, account } = await signUp(on);
    const alice1 = await start(account, signUpWrappers(reg));
    const unreadable = new Proxy(account.api, {
      get(target, key) {
        if (key !== 'vault') return target[key];
        return async () => { throw Object.assign(new Error('no answer'), { status: 503 }); };
      },
    });
    const blip = await start(account, { api: unreadable });
    expect(blip.vaultError).toBeTruthy();
    await gate(on, alice1, password);
  });

  // Pre-#70 state: the root sealed under a throwaway key (`device-v1:`), as `device_custody` starts did. The client no
  // longer writes this (phase 1), so the state is put on the server directly, with the key device 1 holds.
  async function throwawaySealedRoot(account, alice1) {
    const doc = await account.api.crossSigning();
    await account.api.putCrossSigning({
      identity_key: doc.identity_key,
      sealed_secret: `device-v1:${await seal(crypto.getRandomValues(new Uint8Array(32)), alice1.trust.signKey)}`,
    });
    expect(String((await account.api.crossSigning()).sealed_secret)).toMatch(/^device-v1:/);
  }

  it('a legacy throwaway-sealed root is sealed properly once the device holding it restarts', async () => {
    const on = browsers();
    const { password, reg, account } = await signUp(on);
    await throwawaySealedRoot(account, await start(account, signUpWrappers(reg)));
    // The holder reopens from a restored session (no password typed) and reseals the root under the ring.
    const alice1 = await start(account);
    expect(String((await account.api.crossSigning()).sealed_secret)).toMatch(/^recovery-v1:/);
    await gate(on, alice1, password);
  });

  // Fails at `expect(alice2.trust.canSign).toBe(true)`: the root is throwaway-sealed (`device-v1:`) and its only copy
  // is on device 1, which has not run since. The ring is in opaque custody, so the new device opens the history keys,
  // but nothing it holds opens the root. No change on the new device alone can fix this state: it needs the holder to
  // run once (the test above) or, if the holder is gone, the #74 recovery-key reset. Kept as the gate's statement of
  // that limit; it is not expected to flip.
  it.fails('a legacy account whose root is throwaway-sealed and held only by its first device', async () => {
    const on = browsers();
    const { password, reg, account } = await signUp(on);
    const alice1 = await start(account, signUpWrappers(reg));
    await throwawaySealedRoot(account, alice1);
    await gate(on, alice1, password);
  });

  // Phase 2 (key-custody-design docs page): held roots are sealed under the account key, and sign-up does not finish until
  // the recovery copy is on the server.

  const recoveryCopyOpens = async (api) => {
    const served = await api.vault();
    expect(served.independent_ciphertext).toMatch(/^k1\./);
    return served;
  };

  it('sign-up leaves a recovery copy on the server that opens to the ring', async () => {
    const on = browsers();
    const { account, reg } = await signUp(on);
    const alice1 = await start(account, reg);
    await recoveryCopyOpens(account.api);
    expect(alice1.ring.recoveryKey).toBe(true);
  });

  /// Rewrites vault requests on their way to the server: `change(body)` returns the body to send, or null to drop the write
  /// with a 503 that never reaches it.
  function vaultWrites(change) {
    const before = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const method = String(init?.method || input?.method || 'GET').toUpperCase();
      const url = String(input?.url || input);
      if (method === 'PUT' && url.endsWith('/_telium/v1/vault') || method === 'PUT' && url.endsWith('/vault/mode')) {
        const sent = change(JSON.parse(init.body), url);
        if (!sent) {
          return new Response(JSON.stringify({ message: 'unavailable' }), {
            status: 503, headers: { 'content-type': 'application/json' },
          });
        }
        return before(input, { ...init, body: JSON.stringify(sent) });
      }
      return before(input, init);
    };
    return () => { globalThis.fetch = before; };
  }

  it('sign-up writes the recovery copy again when the first vault write left it out', async () => {
    const on = browsers();
    on('alice-1');
    let stripped = false;
    const restore = vaultWrites((body) => {
      if (stripped) return body;
      stripped = true;
      const { independent_ciphertext: _dropped, ...rest } = body;
      return rest;
    });
    let signedUp;
    try { signedUp = await signIn(name('alice'), `pw-${crypto.randomUUID()}`, { register: true }); } finally { restore(); }
    expect(stripped).toBe(true);
    const alice1 = await start(signedUp.account, signedUp.wrappers);
    await recoveryCopyOpens(signedUp.account.api);
    expect(alice1.ring.recoveryKey).toBe(true);
  });

  it('sign-up fails, and saves no session, when the recovery copy can never be written', async () => {
    const on = browsers();
    on('alice-1');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const restore = vaultWrites(() => null);
    try {
      await expect(signIn(name('alice'), `pw-${crypto.randomUUID()}`, { register: true }))
        .rejects.toMatchObject({ code: 'recovery_copy_unconfirmed' });
    } finally { restore(); warn.mockRestore(); }
    expect(localStorage.getItem('telium.session.v1')).toBeNull();
  });

  it('a device given the root by a sibling seals it under the ring, so the next new device can sign', async () => {
    const on = browsers();
    const { password, reg, account } = await signUp(on);
    const alice1 = await start(account, signUpWrappers(reg));
    await throwawaySealedRoot(account, alice1);
    // Device 2 signs in with the password: it holds the ring but cannot open the root.
    const alice2 = await freshDevice(on, alice1.userId, password);
    expect(alice2.trust.canSign).toBe(false);
    expect(String((await account.api.crossSigning()).sealed_secret)).toMatch(/^device-v1:/);
    // Emoji approval hands it the root (verify-sas.js adoptSecret).
    await alice2.trust.adoptSecret(alice1.trust.signKey, b64(alice1.trust.identityKey));
    expect(String((await account.api.crossSigning()).sealed_secret)).toMatch(/^recovery-v1:/);
    // Device 1 never runs again, and a third device with only the password signs.
    const alice3 = await freshDevice(on, alice1.userId, password);
    expect(alice3.trust.canSign).toBe(true);
  });

  it('a root handed over before the ring arrives is sealed when the ring does (onRecoveryAdopted)', async () => {
    const on = browsers();
    const { password, reg, account } = await signUp(on);
    const alice1 = await start(account, signUpWrappers(reg));
    await throwawaySealedRoot(account, alice1);
    // A restored session on a new device holding nothing: no ring, so nothing to seal under yet.
    const label = `sibling-${crypto.randomUUID()}`;
    on(label);
    const bare = await start(account);
    expect(bare.ring?.key).toBeFalsy();
    await bare.trust.adoptSecret(alice1.trust.signKey, b64(alice1.trust.identityKey));
    expect(String((await account.api.crossSigning()).sealed_secret)).toMatch(/^device-v1:/);
    // The ring then arrives from the sibling.
    await bare.trust.onRecoveryAdopted(alice1.ring);
    expect(String((await account.api.crossSigning()).sealed_secret)).toMatch(/^recovery-v1:/);
    const alice3 = await freshDevice(on, alice1.userId, password);
    expect(alice3.trust.canSign).toBe(true);
  });
});
