// Recovery keyring for portable MLS history. One custody: opaque_custody (the server stores the ring under a key derived from
// OPAQUE's client-only exportKey, with a second copy under the account recovery key). device_custody, self_custody and escrowed
// are retired (key-custody design, phase 4): this client never writes them and refuses to read them. A device that still holds
// the ring of a retired device_custody vault converts it, once, while the password is in hand; every other retired vault is
// locked until the user starts a new vault on purpose (replaceRetiredVault).

import { gcm } from '@noble/ciphers/aes.js';
import {
  forgetRecoveryKeyring,
  heldRecoveryKeyring,
  rememberRecoveryKeyring,
} from './device-secrets.js';
import { b64, unb64 } from './util.js';

const KEY_BYTES = 32;
const RECOVERY_KEY_FORMAT = 'k1';
const MAX_RETIRED = 8;

const te = new TextEncoder();
const td = new TextDecoder();
const asBytes = (value) => value instanceof Uint8Array ? value : new Uint8Array(value);

function importKey(raw) {
  const key = new Uint8Array(asBytes(raw));
  if (key.length !== KEY_BYTES) throw new Error('AES-256-GCM key must be 32 bytes');
  return key;
}

function isRecoveryKeyCiphertext(blob) {
  return String(blob || '').startsWith(RECOVERY_KEY_FORMAT + '.');
}

async function sealRecoveryKey(wrapper, bytes) {
  if (!wrapper) throw new Error('account recovery key wrapper is unavailable');
  return RECOVERY_KEY_FORMAT + '.' + await seal(wrapper, bytes);
}

async function openRecoveryKey(wrapper, blob) {
  const text = String(blob || '');
  const prefix = RECOVERY_KEY_FORMAT + '.';
  if (!text.startsWith(prefix)) throw new Error('this vault is not wrapped by a recovery key');
  return open(wrapper, text.slice(prefix.length));
}

export async function seal(key, bytes) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = gcm(importKey(key), iv).encrypt(asBytes(bytes));
  return b64(iv) + '.' + b64(ct);
}

export async function open(key, blob) {
  const [iv, ct] = String(blob).split('.');
  if (!iv || !ct) throw new Error('malformed sealed blob');
  return gcm(importKey(key), unb64(iv)).decrypt(unb64(ct));
}

function encodePayload({ raw, retired = [] }) {
  return te.encode(JSON.stringify({
    v: 2,
    key: b64(raw),
    retired: retired.map((r) => b64(r)),
  }));
}

function decodePayload(bytes) {
  if (bytes.length === KEY_BYTES) return { raw: importKey(bytes), retired: [] };
  try {
    const doc = JSON.parse(td.decode(bytes));
    const raw = importKey(unb64(doc.key));
    const retired = (doc.retired || [])
      .map((r) => unb64(r))
      .filter((r) => r.length === KEY_BYTES)
      .map(importKey)
      .slice(0, MAX_RETIRED);
    return { raw, retired };
  } catch {
    throw new Error('the vault holds something this build does not understand');
  }
}

function keyring({ raw, retired = [] }) {
  const live = importKey(raw);
  const older = retired.map(importKey).slice(0, MAX_RETIRED);
  return {
    key: live,
    openers: [live, ...older],
    raw: live,
    retired: older,
  };
}

async function remember(userId, ring) {
  await rememberRecoveryKeyring(userId, ring).catch(() => {});
}

// Writes are compare-and-swap on `expected_version`; 409 vault_version_conflict if stale. A server too old to report a version writes unconditionally.

const VAULT_CONFLICT = 'vault_version_conflict';

// No answer, not a refusal: the request may have been carried out.
function unanswered(e) {
  const status = e?.status;
  return typeof status !== 'number' || status >= 500 || [408, 425, 429].includes(status);
}

export function isVaultConflict(e) {
  return e?.code === 'vault_changed'
    || (e?.status === 409 && e?.body?.code === VAULT_CONFLICT);
}

function versioned(body, version) {
  return typeof version === 'number' ? { ...body, expected_version: version } : body;
}

const versionOf = (answer) => (typeof answer?.version === 'number' ? answer.version : undefined);

function sameKey(a, b) {
  if (!a || !b) return false;
  const x = asBytes(a);
  const y = asBytes(b);
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

function contains(ring, raw) {
  return [ring.raw, ...(ring.retired || [])].some((k) => sameKey(k, raw));
}

// Server's live key stays live, but a held key its copy lost is kept as an opener, since replacing the held ring would strand data sealed under it. `merged` says the server's copy is short.
function mergeHeld(server, local) {
  const ring = keyring(server);
  if (!local?.raw || contains(ring, local.raw)) return ring;
  const retired = [];
  for (const k of [local.raw, ...ring.retired, ...(local.retired || [])]) {
    if (!sameKey(k, ring.raw) && !retired.some((r) => sameKey(r, k))) retired.push(k);
  }
  return { ...keyring({ raw: ring.raw, retired }), merged: true };
}

async function openWith(vault, recoveryWrapper) {
  try {
    if (vault?.mode === 'opaque_custody' && recoveryWrapper) {
      return decodePayload(await open(recoveryWrapper, vault.ciphertext));
    }
  } catch {
    // Unopenable is the same as "cannot tell".
  }
  return null;
}

// On a version conflict re-read; if it opens to the same live key retry once, else refuse as `vault_changed` so the caller reloads rather than overwrites.
async function writeMode(home, body, current, recoveryWrapper = null) {
  try {
    return await home.setVaultMode(versioned(body, current.version));
  } catch (e) {
    if (!isVaultConflict(e) || typeof current.version !== 'number') throw e;
    const fresh = await home.vault();
    const ring = await openWith(fresh, recoveryWrapper);
    if (!ring || !sameKey(ring.raw, current.raw) || typeof fresh.version !== 'number') {
      throw Object.assign(
        new Error('the recovery vault changed on another device; reload it'),
        { code: 'vault_changed', status: 409, body: e.body },
      );
    }
    return home.setVaultMode(versioned(body, fresh.version));
  }
}

async function opaqueCiphertext(wrapper, ring) {
  if (!wrapper) throw new Error('secure account-password recovery is not available for this session');
  return seal(wrapper, encodePayload(ring));
}

// A lost version race restarts the load from the other device's write.
//
// `reseal` says `recoveryWrapper` was made from the password typed in this very sign-in. Only then may a vault the wrapper
// cannot open, but a recovery copy can, be sealed under that wrapper (a reset made before resets re-wrapped the vault).
// A wrapper kept in memory from an earlier sign-in may be the old password's, and sealing under it would undo a password
// change, so without `reseal` the ring is returned from the copy and nothing is written.
export async function load(
  home,
  userId = null,
  recoveryWrapper = null,
  accountRecoveryWrapper = null,
  { reseal = false } = {},
) {
  try {
    return await loadOnce(home, userId, recoveryWrapper, accountRecoveryWrapper, reseal);
  } catch (e) {
    if (!isVaultConflict(e)) throw e;
    return loadOnce(home, userId, recoveryWrapper, accountRecoveryWrapper, reseal);
  }
}

/// What a vault stored in a retired custody mode looks like to the rest of the app: locked, with `retired` naming the
/// mode so the UI can say so. Nothing is written.
function retiredVault(mode, version, recoveryWrapper) {
  return {
    key: null,
    openers: [],
    raw: null,
    retired: [],
    mode,
    retiredMode: mode,
    locked: true,
    needs_password: !recoveryWrapper,
    needs_device: false,
    version,
  };
}

async function loadOnce(home, userId, recoveryWrapper, accountRecoveryWrapper, reseal = false) {
  const vault = await home.vault();
  const version = typeof vault.version === 'number' ? vault.version : undefined;
  const local = await heldRecoveryKeyring(userId).catch(() => null);

  if (!vault.exists) {
    // A holding device uploads its ring rather than orphaning data under a new key. Version 0 means "only if none", so racing first devices don't each create one.
    const created = !local?.raw;
    const ring = keyring(local?.raw ? local : {
      raw: crypto.getRandomValues(new Uint8Array(KEY_BYTES)),
      retired: [],
    });
    // A start without the password-derived wrapper never creates custody: a restored session or second tab that wins
    // the race would make a vault nothing can ever open. It is locked until the password is typed.
    if (!recoveryWrapper) {
      return {
        key: null,
        openers: [],
        raw: null,
        retired: [],
        mode: 'none',
        locked: true,
        needs_device: true,
        needs_password: true,
        version,
      };
    }

    // No vault but an account key: this device would mint a ring that opens nothing the account already sealed (the root,
    // the history mirror). Stop with an error instead of creating one over it. A device that holds a ring is the
    // exception, since it uploads that ring rather than making a new one.
    if (created && typeof home.crossSigning === 'function') {
      const root = await home.crossSigning();
      if (root?.exists) {
        throw Object.assign(
          new Error('this account has an identity key but no recovery vault; not creating a new one over it'),
          { code: 'vault_missing' },
        );
      }
    }

    // The ring is kept on this device before the write is sent, as the account key is (keepPendingSecret): a tab closed
    // while the request is in flight, or an answer that never comes, then loses nothing. A refusal is different: the
    // account has another ring, so one this device only just made is dropped.
    const put = async (body) => {
      if (created) await rememberRecoveryKeyring(userId, ring).catch(() => {});
      try {
        return await home.putVault({ ...body, expected_version: 0 });
      } catch (e) {
        if (unanswered(e)) await remember(userId, ring);
        else if (created) await forgetRecoveryKeyring(userId);
        throw e;
      }
    };

    const independentCiphertext = accountRecoveryWrapper
      ? await sealRecoveryKey(accountRecoveryWrapper, encodePayload(ring))
      : null;
    const answer = await put({
      mode: 'opaque_custody',
      ciphertext: await opaqueCiphertext(recoveryWrapper, ring),
      independent_ciphertext: independentCiphertext,
    });
    await remember(userId, ring);
    return {
      ...ring,
      mode: 'opaque_custody',
      independent: Boolean(independentCiphertext),
      recoveryKey: Boolean(independentCiphertext),
      created,
      version: versionOf(answer),
    };
  }

  if (vault.mode !== 'opaque_custody') {
    return loadRetired(home, vault, version, local, userId, recoveryWrapper, accountRecoveryWrapper);
  }

  const flags = {
    mode: 'opaque_custody',
    independent: isRecoveryKeyCiphertext(vault.independent_ciphertext),
    recoveryKey: isRecoveryKeyCiphertext(vault.independent_ciphertext),
  };

  if (recoveryWrapper) {
    let ring = null;
    try {
      ring = mergeHeld(decodePayload(await open(recoveryWrapper, vault.ciphertext)), local);
    } catch {
      // The recovery key's copy may still recover it.
    }
    if (ring) {
      let primaryCiphertext = vault.ciphertext;
      let current = version;
      if (ring.merged) {
        // The server's copy lost a key this device holds; restore it, best effort.
        try {
          const sealed = await opaqueCiphertext(recoveryWrapper, ring);
          const answer = await home.setVaultMode(versioned(
            { mode: 'opaque_custody', ciphertext: sealed }, version,
          ));
          primaryCiphertext = sealed;
          current = versionOf(answer);
        } catch (e) {
          console.warn('could not return a held recovery key to the vault', e);
        }
      }
      await remember(userId, ring);
      return { ...ring, ...flags, primaryCiphertext, version: current };
    }
  }

  let recoveryKeyPayload = null;
  if (accountRecoveryWrapper && isRecoveryKeyCiphertext(vault.independent_ciphertext)) {
    try {
      recoveryKeyPayload = await openRecoveryKey(
        accountRecoveryWrapper, vault.independent_ciphertext,
      );
    } catch {
      // A migrated vault sealed under the old account's key is locked, not a reason to abandon the load.
    }
  }
  if (recoveryKeyPayload) {
    const ring = mergeHeld(decodePayload(recoveryKeyPayload), local);
    let primaryCiphertext = vault.ciphertext;
    let current = version;
    if (recoveryWrapper && reseal) {
      primaryCiphertext = await opaqueCiphertext(recoveryWrapper, ring);
      current = versionOf(await writeMode(home, {
        mode: 'opaque_custody',
        ciphertext: primaryCiphertext,
        independent_ciphertext: vault.independent_ciphertext,
      }, { raw: ring.raw, version }));
    }
    await remember(userId, ring);
    return {
      ...ring,
      mode: 'opaque_custody',
      independent: true,
      recoveryKey: true,
      independentCiphertext: vault.independent_ciphertext,
      primaryCiphertext,
      version: current,
    };
  }

  if (local) {
    return {
      ...keyring(local),
      ...flags,
      primaryCiphertext: vault.ciphertext,
      version,
    };
  }

  const hasRecoveryKey = isRecoveryKeyCiphertext(vault.independent_ciphertext);
  return {
    key: null,
    openers: [],
    raw: null,
    retired: [],
    mode: 'opaque_custody',
    independent: hasRecoveryKey,
    recoveryKey: hasRecoveryKey,
    locked: true,
    recovery_failed: Boolean(recoveryWrapper),
    needs_recovery_key: hasRecoveryKey,
    // A trusted sibling can hand over the keyring and repair the primary wrapper, so this is also a device-recovery state.
    needs_device: true,
    needs_password: !recoveryWrapper,
    version,
  };
}

/// A vault stored in a retired mode. Nothing is read from it as a key. The one thing that can still be saved is a
/// `device_custody` vault (L1h) when the password is in hand: its ring was never server-readable, so a device that holds
/// it (or a recovery key that opens the recovery copy) converts it to `opaque_custody` with the same ring, nothing rotated.
/// `self_custody` (a passphrase one offline guess from its key) and `escrowed` (a key the server held) are refused: a ring
/// that either could have exposed is not carried forward. Every refusal leaves the vault as it is and is locked.
async function loadRetired(home, vault, version, local, userId, recoveryWrapper, accountRecoveryWrapper) {
  if (vault.mode === 'device_custody' && recoveryWrapper) {
    let ring = local ? keyring(local) : null;
    if (!ring && accountRecoveryWrapper && isRecoveryKeyCiphertext(vault.independent_ciphertext)) {
      try {
        ring = keyring(decodePayload(await openRecoveryKey(accountRecoveryWrapper, vault.independent_ciphertext)));
      } catch {
        // Not this recovery key's copy; nothing here opens the vault.
      }
    }
    if (ring) {
      // The recovery key the account just enrolled gets its copy here too, or it resets the password and opens nothing.
      const independent = accountRecoveryWrapper
        ? await recoveryKeyCiphertext(ring, accountRecoveryWrapper)
        : null;
      return writeOpaque(home, { ...ring, version }, userId, recoveryWrapper, independent);
    }
  }
  return retiredVault(vault.mode, version, recoveryWrapper);
}

/// Writes the ring under the account password's wrapper as `opaque_custody`, with the same live key: nothing rotates. Also
/// the conversion of a retired vault (`current.version` is the row's). `independentCiphertext` is passed only to add or
/// replace the recovery copy; absent, the server keeps the one it has (null would wipe it).
export async function writeOpaque(
  home,
  current,
  userId = null,
  recoveryWrapper = null,
  independentCiphertext = null,
) {
  if (!current?.raw) throw new Error('the current recovery key is not loaded');
  const ring = keyring({ raw: current.raw, retired: current.retired || [] });
  const primaryCiphertext = await opaqueCiphertext(recoveryWrapper, ring);
  const answer = await writeMode(home, {
    mode: 'opaque_custody',
    ciphertext: primaryCiphertext,
    ...(independentCiphertext ? { independent_ciphertext: independentCiphertext } : {}),
  }, current, recoveryWrapper);
  await remember(userId, ring);
  const carried = independentCiphertext || current.independentCiphertext || null;
  return {
    ...ring,
    mode: 'opaque_custody',
    independent: Boolean(independentCiphertext) || Boolean(current.independent),
    recoveryKey: isRecoveryKeyCiphertext(independentCiphertext) || Boolean(current.recoveryKey),
    ...(carried ? { independentCiphertext: carried } : {}),
    primaryCiphertext,
    version: versionOf(answer),
  };
}

/// For a vault left in a retired mode that nothing can open: replaces it with a new ring under the account password (and
/// under the recovery key, when it is in hand). The old ring, and everything sealed under it (the history mirror, the old
/// GroupInfo), stays locked for good; the caller has said so to the user and asked. The row is replaced only at the version
/// that was read, so a vault another device converted in the meantime is not overwritten.
export async function replaceRetiredVault(home, userId, recoveryWrapper, accountRecoveryWrapper = null) {
  if (!recoveryWrapper) throw new Error('secure account-password recovery is not available for this session');
  const served = await home.vault();
  if (!served?.exists || served.mode === 'opaque_custody') {
    throw Object.assign(new Error('this account\'s vault is not in a retired mode'), { code: 'vault_not_retired' });
  }
  const ring = keyring({ raw: crypto.getRandomValues(new Uint8Array(KEY_BYTES)), retired: [] });
  const independentCiphertext = accountRecoveryWrapper
    ? await sealRecoveryKey(accountRecoveryWrapper, encodePayload(ring))
    : null;
  const primaryCiphertext = await opaqueCiphertext(recoveryWrapper, ring);
  // Kept here first, as at creation, so an answer that never comes leaves the ring findable.
  await rememberRecoveryKeyring(userId, ring).catch(() => {});
  let answer;
  try {
    answer = await home.setVaultMode(versioned({
      mode: 'opaque_custody',
      ciphertext: primaryCiphertext,
      // Without the recovery key in hand a copy of the old ring must not stay: it would not open this one.
      ...(independentCiphertext
        ? { independent_ciphertext: independentCiphertext }
        : { clear_independent: true }),
    }, typeof served.version === 'number' ? served.version : undefined));
  } catch (e) {
    if (!unanswered(e)) await forgetRecoveryKeyring(userId);
    throw e;
  }
  return {
    ...ring,
    mode: 'opaque_custody',
    independent: Boolean(independentCiphertext),
    recoveryKey: Boolean(independentCiphertext),
    ...(independentCiphertext ? { independentCiphertext } : {}),
    primaryCiphertext,
    created: true,
    version: versionOf(answer),
  };
}

/// The recovery copy `R` is on the server and opens, under the recovery key, to the ring this device holds (invariant I3).
/// Read back from the server, not taken from what was sent. A missing or mismatched copy is written (one compare-and-swap
/// write, which keeps the live key) and read back again; returns the ring with the new version, or throws when it still
/// is not there. Sign-up does not finish until this holds.
export async function confirmRecoveryCopy(home, ring, recoveryWrapper, accountRecoveryWrapper, userId = null) {
  if (!ring?.raw) throw new Error('the recovery vault is not unlocked');
  const confirmed = async () => {
    const served = await home.vault();
    if (!served?.exists || served.mode !== 'opaque_custody' || !isRecoveryKeyCiphertext(served.independent_ciphertext)) {
      return null;
    }
    try {
      const copy = decodePayload(await openRecoveryKey(accountRecoveryWrapper, served.independent_ciphertext));
      return sameKey(copy.raw, ring.raw) ? served : null;
    } catch {
      return null;
    }
  };
  let served = await confirmed();
  if (served) return { ...ring, version: typeof served.version === 'number' ? served.version : ring.version };
  const written = await writeOpaque(
    home,
    ring,
    userId,
    recoveryWrapper,
    await recoveryKeyCiphertext(ring, accountRecoveryWrapper),
  );
  served = await confirmed();
  if (!served) throw new Error('the homeserver did not keep the recovery copy');
  return written;
}

/// The ring sealed under a new password wrapper, for a password change (the recovery copy and everything else sealed under
/// the ring stay as they are).
export async function rewrapCiphertext(current, wrapper) {
  if (!current?.raw) throw new Error('the current recovery key is not loaded');
  return opaqueCiphertext(wrapper, keyring(current));
}

/// Same, from the server's recovery copy opened with the recovery key: for a reset, where no password is in hand. Throws
/// when the copy does not open, which stops the reset rather than leaving the vault under a password that is gone.
export async function rewrapFromRecoveryCopy(copy, wrapper) {
  let ring;
  try {
    ring = decodePayload(await openRecoveryKey(copy.wrapper, copy.ciphertext));
  } catch {
    throw Object.assign(
      new Error('That recovery key does not open this account\'s encrypted-message vault.'),
      { code: 'recovery_copy_unopenable' },
    );
  }
  return opaqueCiphertext(wrapper, keyring(ring));
}

export async function recoveryKeyCiphertext(current, wrapper) {
  if (!current?.raw) throw new Error('the current recovery key is not loaded');
  return sealRecoveryKey(wrapper, encodePayload(keyring(current)));
}

export function encodeRecoveryTransfer(current) {
  if (!current?.raw) throw new Error('no recovery key is available to transfer');
  return encodePayload(current);
}

export function decodeRecoveryTransfer(bytes) {
  return keyring(decodePayload(bytes));
}

export async function rememberDeviceRecovery(userId, current) {
  if (!current?.raw) return;
  await remember(userId, current);
}
