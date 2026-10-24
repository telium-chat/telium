// Recovery keyring for portable MLS history. Custody modes: opaque_custody (server stores it under a key derived from OPAQUE's client-only exportKey; may add an independent passphrase copy), device_custody (trusted devices hold it and transfer over sibling verification), self_custody (legacy passphrase; migrated into opaque_custody), escrowed (legacy; homeserver can read history; leaving rotates the live key).

import { gcm } from '@noble/ciphers/aes.js';
import { pbkdf2Async } from '@noble/hashes/pbkdf2.js';
import { sha256 } from '@noble/hashes/sha2.js';
import {
  heldRecoveryKeyring,
  pinOutOfEscrow,
  pinnedOutOfEscrow,
  rememberRecoveryKeyring,
  unpinOutOfEscrow,
} from './device-secrets.js';
import { b64, unb64 } from './util.js';

const KEY_BYTES = 32;
const ITERATIONS = 600_000;
const LEGACY_SALT = 'telium/vault/v1';
const PASSPHRASE_FORMAT = 'p2';
const RECOVERY_KEY_FORMAT = 'k1';
const PASSPHRASE_SALT_BYTES = 16;
const MAX_RETIRED = 8;

const te = new TextEncoder();
const td = new TextDecoder();
const asBytes = (value) => value instanceof Uint8Array ? value : new Uint8Array(value);

function importKey(raw) {
  const key = new Uint8Array(asBytes(raw));
  if (key.length !== KEY_BYTES) throw new Error('AES-256-GCM key must be 32 bytes');
  return key;
}

async function fromPassphrase(passphrase, salt = te.encode(LEGACY_SALT)) {
  return pbkdf2Async(
    sha256,
    te.encode(passphrase),
    salt,
    { c: ITERATIONS, dkLen: KEY_BYTES },
  );
}

async function sealIndependentPassphrase(passphrase, bytes) {
  const salt = crypto.getRandomValues(new Uint8Array(PASSPHRASE_SALT_BYTES));
  const sealed = await seal(await fromPassphrase(passphrase, salt), bytes);
  return PASSPHRASE_FORMAT + '.' + b64(salt) + '.' + sealed;
}

async function openIndependentPassphrase(passphrase, blob) {
  const text = String(blob);
  const prefix = PASSPHRASE_FORMAT + '.';
  if (!text.startsWith(prefix)) {
    // Legacy self-custody used one fixed salt; kept for read compatibility.
    return open(await fromPassphrase(passphrase), text);
  }
  const parts = text.split('.');
  if (parts.length !== 4 || !parts[1]) throw new Error('malformed recovery passphrase wrapper');
  const salt = unb64(parts[1]);
  if (salt.length !== PASSPHRASE_SALT_BYTES) {
    throw new Error('malformed recovery passphrase salt');
  }
  return open(
    await fromPassphrase(passphrase, salt),
    parts.slice(2).join('.'),
  );
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

// Any custody but escrow sets this device's escrow-exit pin (device-secrets.js).
async function remember(userId, ring, mode = null) {
  await rememberRecoveryKeyring(userId, ring).catch(() => {});
  if (mode && mode !== 'escrowed') await pinOutOfEscrow(userId);
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
    if (vault?.mode === 'escrowed' && vault.escrow_key) {
      return decodePayload(await open(importKey(unb64(vault.escrow_key)), vault.ciphertext));
    }
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

function rotatedFrom(current) {
  if (!current?.raw) throw new Error('the current recovery key is not loaded');
  if (current.mode !== 'escrowed') {
    return { raw: current.raw, retired: current.retired || [] };
  }
  return {
    raw: crypto.getRandomValues(new Uint8Array(KEY_BYTES)),
    retired: [current.raw, ...(current.retired || [])].slice(0, MAX_RETIRED),
  };
}

async function opaqueCiphertext(wrapper, ring) {
  if (!wrapper) throw new Error('secure account-password recovery is not available for this session');
  return seal(wrapper, encodePayload(ring));
}

// A lost version race restarts the load from the other device's write.
export async function load(
  home,
  passphrase = null,
  userId = null,
  recoveryWrapper = null,
  accountRecoveryWrapper = null,
) {
  try {
    return await loadOnce(home, passphrase, userId, recoveryWrapper, accountRecoveryWrapper);
  } catch (e) {
    if (!isVaultConflict(e)) throw e;
    return loadOnce(home, passphrase, userId, recoveryWrapper, accountRecoveryWrapper);
  }
}

async function loadOnce(home, passphrase, userId, recoveryWrapper, accountRecoveryWrapper) {
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
    // A write with no answer may have landed, so keep the ring locally; not on a refusal.
    const put = async (body) => {
      try {
        return await home.putVault({ ...body, expected_version: 0 });
      } catch (e) {
        if (unanswered(e)) await remember(userId, ring, body.mode);
        throw e;
      }
    };

    if (recoveryWrapper) {
      const independentCiphertext = accountRecoveryWrapper
        ? await sealRecoveryKey(accountRecoveryWrapper, encodePayload(ring))
        : null;
      const answer = await put({
        mode: 'opaque_custody',
        ciphertext: await opaqueCiphertext(recoveryWrapper, ring),
        independent_ciphertext: independentCiphertext,
      });
      await remember(userId, ring, 'opaque_custody');
      return {
        ...ring,
        mode: 'opaque_custody',
        independent: Boolean(independentCiphertext),
        recoveryKey: Boolean(independentCiphertext),
        created,
        version: versionOf(answer),
      };
    }

    if (passphrase) {
      const answer = await put({
        mode: 'self_custody',
        ciphertext: await seal(await fromPassphrase(passphrase), encodePayload(ring)),
      });
      await remember(userId, ring, 'self_custody');
      return { ...ring, mode: 'self_custody', independent: true, created, version: versionOf(answer) };
    }

    const throwaway = crypto.getRandomValues(new Uint8Array(KEY_BYTES));
    const answer = await put({
      mode: 'device_custody',
      ciphertext: await seal(throwaway, encodePayload(ring)),
    });
    await remember(userId, ring, 'device_custody');
    return { ...ring, mode: 'device_custody', created, version: versionOf(answer) };
  }

  if (vault.mode === 'opaque_custody') {
    const flags = {
      mode: 'opaque_custody',
      independent: Boolean(vault.independent_ciphertext),
      recoveryKey: isRecoveryKeyCiphertext(vault.independent_ciphertext),
      legacyIndependent: Boolean(vault.independent_ciphertext)
        && !isRecoveryKeyCiphertext(vault.independent_ciphertext),
    };

    if (recoveryWrapper) {
      let ring = null;
      try {
        ring = mergeHeld(decodePayload(await open(recoveryWrapper, vault.ciphertext)), local);
      } catch {
        // An independent recovery wrapper may still recover it.
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
        await remember(userId, ring, 'opaque_custody');
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
      if (recoveryWrapper) {
        primaryCiphertext = await opaqueCiphertext(recoveryWrapper, ring);
        current = versionOf(await writeMode(home, {
          mode: 'opaque_custody',
          ciphertext: primaryCiphertext,
          independent_ciphertext: vault.independent_ciphertext,
        }, { raw: ring.raw, version }));
      }
      await remember(userId, ring, 'opaque_custody');
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

    if (passphrase && vault.independent_ciphertext
      && !isRecoveryKeyCiphertext(vault.independent_ciphertext)) {
      const ring = mergeHeld(decodePayload(
        await openIndependentPassphrase(passphrase, vault.independent_ciphertext),
      ), local);
      let primaryCiphertext = vault.ciphertext;
      let current = version;
      // Independent recovery can heal the primary copy without rotating the key.
      if (recoveryWrapper) {
        primaryCiphertext = await opaqueCiphertext(recoveryWrapper, ring);
        current = versionOf(await writeMode(home, {
          mode: 'opaque_custody',
          ciphertext: primaryCiphertext,
          independent_ciphertext: vault.independent_ciphertext,
        }, { raw: ring.raw, version }));
      }
      await remember(userId, ring, 'opaque_custody');
      return {
        ...ring,
        mode: 'opaque_custody',
        independent: true,
        legacyIndependent: true,
        recoveryKey: false,
        independentCiphertext: vault.independent_ciphertext,
        primaryCiphertext,
        version: current,
      };
    }

    if (local) {
      await pinOutOfEscrow(userId);
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
      independent: Boolean(vault.independent_ciphertext),
      recoveryKey: hasRecoveryKey,
      legacyIndependent: Boolean(vault.independent_ciphertext) && !hasRecoveryKey,
      locked: true,
      recovery_failed: Boolean(recoveryWrapper),
      needs_recovery_key: hasRecoveryKey,
      needs_independent: Boolean(vault.independent_ciphertext) && !hasRecoveryKey,
      // A trusted sibling can hand over the keyring and repair the primary wrapper, so this is also a device-recovery state.
      needs_device: true,
      needs_password: !recoveryWrapper,
      version,
    };
  }

  if (vault.mode === 'device_custody') {
    if (!local) {
      return {
        key: null,
        openers: [],
        raw: null,
        retired: [],
        mode: 'device_custody',
        locked: true,
        needs_device: true,
        version,
      };
    }
    await pinOutOfEscrow(userId);
    const ring = { ...keyring(local), mode: 'device_custody', version };
    if (recoveryWrapper) {
      return setMode(
        home, ring, 'opaque_custody', null, userId, recoveryWrapper,
      );
    }
    return ring;
  }

  if (vault.mode === 'escrowed') {
    if (!vault.escrow_key) {
      throw new Error('the server did not return the escrow key it holds');
    }
    const wrapper = importKey(unb64(vault.escrow_key));
    const served = decodePayload(await open(wrapper, vault.ciphertext));

    // Escrow-exit pin: the server offers an escrowed ring with a different live key. Believing it would put a server-readable key in charge, so refuse and write the held ring back (not rotated: never exposed).
    if (local?.raw && !sameKey(served.raw, local.raw) && await pinnedOutOfEscrow(userId)) {
      const held = { ...keyring(local), mode: 'device_custody', version };
      try {
        const out = await setMode(
          home, held, recoveryWrapper ? 'opaque_custody' : 'device_custody',
          null, userId, recoveryWrapper,
        );
        return { ...out, downgradeRefused: true };
      } catch (e) {
        if (isVaultConflict(e)) throw e;
        console.warn('could not restore the held recovery key over an escrowed vault', e);
        return { ...held, mode: 'escrowed', downgradeRefused: true };
      }
    }

    const opened = { ...mergeHeld(served, local), mode: 'escrowed', version };
    await remember(userId, opened);

    if (recoveryWrapper) {
      return setMode(
        home, opened, 'opaque_custody', null, userId, recoveryWrapper,
      );
    }
    return opened;
  }

  if (vault.mode !== 'self_custody') {
    throw new Error('unknown recovery custody mode: ' + vault.mode);
  }

  if (local && recoveryWrapper) {
    const ring = { ...keyring(local), mode: 'self_custody', version };
    return setMode(
      home,
      ring,
      'opaque_custody',
      null,
      userId,
      recoveryWrapper,
      vault.ciphertext,
    );
  }

  if (!passphrase && local) {
    await pinOutOfEscrow(userId);
    return { ...keyring(local), mode: 'self_custody', independent: true, version };
  }
  if (!passphrase) {
    return {
      key: null,
      openers: [],
      raw: null,
      retired: [],
      mode: 'self_custody',
      independent: true,
      locked: true,
      version,
    };
  }

  const ring = {
    ...mergeHeld(decodePayload(
      await open(await fromPassphrase(passphrase), vault.ciphertext),
    ), local),
    mode: 'self_custody',
    independent: true,
    version,
  };
  await remember(userId, ring, 'self_custody');

  if (recoveryWrapper) {
    return setMode(
      home,
      ring,
      'opaque_custody',
      null,
      userId,
      recoveryWrapper,
      vault.ciphertext,
    );
  }
  return ring;
}

// independentCiphertext is passed only when migrating legacy self-custody; other moves keep the existing second copy (null would wipe it).
export async function setMode(
  home,
  current,
  mode,
  passphrase = null,
  userId = null,
  recoveryWrapper = null,
  independentCiphertext = null,
) {
  if (!current?.raw) throw new Error('the current recovery key is not loaded');
  const next = keyring(rotatedFrom(current));
  // Keep the rotated ring locally first: if the write lands but the answer is lost, the server holds a key that exists nowhere else.
  if (current.mode === 'escrowed') await remember(userId, next);

  if (mode === 'opaque_custody') {
    const primaryCiphertext = await opaqueCiphertext(recoveryWrapper, next);
    // A second copy sealed before leaving escrow holds only the server-readable key; clear it.
    const rotated = current.mode === 'escrowed';
    const carried = independentCiphertext
      || (rotated ? null : current.independentCiphertext || null);
    const answer = await writeMode(home, {
      mode,
      ciphertext: primaryCiphertext,
      // Otherwise absent (server keeps its copy); not resent from memory, which may be stale.
      ...(independentCiphertext
        ? { independent_ciphertext: independentCiphertext }
        : rotated ? { clear_independent: true } : {}),
    }, current, recoveryWrapper);
    await remember(userId, next, mode);
    // A copy it wasn't told about is still there, so existing flags stand.
    const cleared = !independentCiphertext && rotated;
    const kept = !independentCiphertext && !rotated;
    return {
      ...next,
      mode,
      independent: !cleared && (Boolean(carried) || (kept && Boolean(current.independent))),
      recoveryKey: !cleared
        && (isRecoveryKeyCiphertext(carried) || (kept && Boolean(current.recoveryKey))),
      legacyIndependent: !cleared && (carried
        ? !isRecoveryKeyCiphertext(carried)
        : kept && Boolean(current.legacyIndependent)),
      ...(carried ? { independentCiphertext: carried } : {}),
      primaryCiphertext,
      version: versionOf(answer),
    };
  }

  if (mode === 'self_custody') {
    if (!passphrase) throw new Error('self-custody needs a passphrase');
    const answer = await writeMode(home, {
      mode,
      ciphertext: await seal(await fromPassphrase(passphrase), encodePayload(next)),
      recovery_confirmed: true,
    }, current, recoveryWrapper);
    await remember(userId, next, mode);
    return { ...next, mode, independent: true, version: versionOf(answer) };
  }

  if (mode === 'device_custody') {
    const throwaway = crypto.getRandomValues(new Uint8Array(KEY_BYTES));
    const answer = await writeMode(home, {
      mode,
      ciphertext: await seal(throwaway, encodePayload(next)),
    }, current, recoveryWrapper);
    await remember(userId, next, mode);
    return { ...next, mode, version: versionOf(answer) };
  }

  if (mode !== 'escrowed') throw new Error('unknown recovery custody mode');
  const escrow = crypto.getRandomValues(new Uint8Array(KEY_BYTES));
  const answer = await writeMode(home, {
    mode,
    ciphertext: await seal(escrow, encodePayload(next)),
    escrow_key: b64(escrow),
  }, current, recoveryWrapper);
  // Chosen here: the escrow-exit pin no longer applies.
  await unpinOutOfEscrow(userId);
  await remember(userId, next);
  return { ...next, mode, version: versionOf(answer) };
}

export async function recoveryKeyCiphertext(current, wrapper) {
  if (!current?.raw) throw new Error('the current recovery key is not loaded');
  return sealRecoveryKey(wrapper, encodePayload(keyring(current)));
}

export async function setIndependentRecovery(
  home,
  current,
  passphrase,
  recoveryWrapper,
  userId = null,
) {
  if (!current?.raw) throw new Error('the current recovery key is not loaded');
  if (!passphrase) throw new Error('independent recovery needs a passphrase');
  const ring = keyring(current);
  const independentCiphertext = await sealIndependentPassphrase(
    passphrase,
    encodePayload(ring),
  );
  const primaryCiphertext = recoveryWrapper
    ? await opaqueCiphertext(recoveryWrapper, ring)
    : current.primaryCiphertext;
  if (!primaryCiphertext) {
    throw new Error('the normal account-password recovery wrapper is unavailable');
  }
  const answer = await writeMode(home, {
    mode: 'opaque_custody',
    ciphertext: primaryCiphertext,
    independent_ciphertext: independentCiphertext,
  }, current, recoveryWrapper);
  await remember(userId, ring, 'opaque_custody');
  return {
    ...ring,
    mode: 'opaque_custody',
    independent: true,
    independentCiphertext,
    primaryCiphertext,
    version: versionOf(answer),
  };
}

export async function removeIndependentRecovery(
  home,
  current,
  recoveryWrapper,
  userId = null,
) {
  if (!current?.raw) {
    throw new Error('secure account-password recovery is not available');
  }
  const ring = keyring(current);
  const primaryCiphertext = recoveryWrapper
    ? await opaqueCiphertext(recoveryWrapper, ring)
    : current.primaryCiphertext;
  if (!primaryCiphertext) {
    throw new Error('the normal account-password recovery wrapper is unavailable');
  }
  // Said, not implied: absent now means "keep it".
  const answer = await writeMode(home, {
    mode: 'opaque_custody',
    ciphertext: primaryCiphertext,
    clear_independent: true,
  }, current, recoveryWrapper);
  await remember(userId, ring, 'opaque_custody');
  return {
    ...ring,
    mode: 'opaque_custody',
    independent: false,
    recoveryKey: false,
    legacyIndependent: false,
    independentCiphertext: null,
    primaryCiphertext,
    version: versionOf(answer),
  };
}

export function encodeRecoveryTransfer(current) {
  if (!current?.raw) throw new Error('no recovery key is available to transfer');
  return encodePayload(current);
}

export function decodeRecoveryTransfer(bytes, mode = 'device_custody') {
  return { ...keyring(decodePayload(bytes)), mode };
}

export async function rememberDeviceRecovery(userId, current) {
  if (!current?.raw) return;
  await remember(userId, current);
}
