// A homeserver can route an address and store these documents but cannot make a different root the same person: every root must follow a locally verified transition chain.

import { sha256 } from '@noble/hashes/sha2.js';
import { b64url, storage, unb64 } from './util.js';
import { PIN_PREFIX, pinsChanged } from './identity-pins.js';

const te = new TextEncoder();
const ANCHOR_DOMAIN = 'telium-identity-anchor:v1';
const POLICY_DOMAIN = 'telium-identity-recovery-policy:v1';
const ROTATE_DOMAIN = 'telium-identity-rotate:v1';
const REVOKE_DOMAIN = 'telium-device-revoke:v1';
const ID_DOMAIN = te.encode('telium-identity-id:v1\0');

function concat(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

const hex = (bytes) => [...bytes].map((v) => v.toString(16).padStart(2, '0')).join('');

export function immutableIdentityId(identityKey) {
  const raw = unb64(identityKey);
  if (raw.length !== 32) throw new Error('identity key must be 32 bytes');
  return 'tid:' + hex(sha256(concat(ID_DOMAIN, raw)));
}

export function identityAnchorPayload(userId, immutableId, identityKey) {
  return te.encode(`${ANCHOR_DOMAIN}|${userId}|${immutableId}|${identityKey}`);
}

function canonicalGuardians(guardians) {
  return [...guardians].sort((a, b) => (
    String(a.immutable_id).localeCompare(String(b.immutable_id))
    || String(a.user_id).localeCompare(String(b.user_id))
    || String(a.identity_key).localeCompare(String(b.identity_key))
  ));
}

export function recoveryPolicyPayload(
  immutableId,
  version,
  identitySequence,
  threshold,
  guardians,
) {
  const rows = canonicalGuardians(guardians).map((g) => [
    g.user_id, g.immutable_id, g.identity_key,
  ]);
  const body = JSON.stringify([threshold, rows]);
  return te.encode(
    `${POLICY_DOMAIN}|${immutableId}|${version}|${identitySequence}|${body}`,
  );
}

export function identityRotationPayload(
  immutableId,
  sequence,
  previousKey,
  newKey,
) {
  return te.encode(
    `${ROTATE_DOMAIN}|${immutableId}|${sequence}|${previousKey}|${newKey}`,
  );
}

/// Names the immutable identity as well as the address, so a statement can't be replayed against another identity that later holds the address.
export function deviceRevocationPayload(userId, immutableId, deviceId, mlsKey) {
  return te.encode(`${REVOKE_DOMAIN}|${userId}|${immutableId}|${deviceId}|${mlsKey}`);
}

/// Only revocations signed by a root in the verified chain count. A server can withhold one but cannot invent one.
export async function verifiedRevocations(cs, userId, rows, continuity) {
  const out = new Set();
  if (!continuity?.valid || !continuity.immutableId || !continuity.keys) return out;
  const roots = new Set([...continuity.keys.values()]);
  for (const r of rows || []) {
    if (!r?.mls_key || !r.signature || !r.signer_key || !r.device_id) continue;
    if (r.immutable_id !== continuity.immutableId || !roots.has(r.signer_key)) continue;
    const payload = deviceRevocationPayload(userId, continuity.immutableId, r.device_id, r.mls_key);
    if (await verifies(cs, r.signer_key, payload, r.signature)) out.add(r.mls_key);
  }
  return out;
}

async function verifies(cs, publicKey, payload, signature) {
  try {
    return await cs.signature.verify(
      unb64(publicKey),
      payload,
      unb64(signature),
    );
  } catch {
    return false;
  }
}

function transitionAuthorization(row) {
  const auth = row?.authorization || {};
  if (auth.kind) return auth;
  return { ...auth, kind: row?.authorization_kind || null };
}

/// `legacyThrough`: highest sequence accepted before transitions carried the new root's signature; later ones must have it. Defaults to this client's pin.
export async function verifyIdentityDocument(cs, document, expectedUserId = null, { legacyThrough } = {}) {
  if (!document?.exists) return { exists: false, valid: true, keys: new Map() };
  const documentUserId = document.user_id || null;
  if (!documentUserId) {
    return { exists: true, valid: false, reason: 'missing-user', keys: new Map() };
  }
  if (expectedUserId && documentUserId !== expectedUserId) {
    return { exists: true, valid: false, reason: 'wrong-user', keys: new Map() };
  }

  const immutableId = document.immutable_id;
  const genesisKey = document.genesis_key;
  if (!immutableId || !genesisKey || immutableIdentityId(genesisKey) !== immutableId) {
    return { exists: true, valid: false, reason: 'invalid-genesis', keys: new Map() };
  }
  if (
    !document.anchor_signature
    || !(await verifies(
      cs,
      genesisKey,
      identityAnchorPayload(documentUserId, immutableId, genesisKey),
      document.anchor_signature,
    ))
  ) {
    return { exists: true, valid: false, reason: 'invalid-anchor', keys: new Map() };
  }

  const transitions = [...(document.transitions || [])]
    .sort((a, b) => Number(a.sequence) - Number(b.sequence));
  const policyRows = [...(document.recovery_policies || [])];
  const policies = new Map(
    policyRows.map((p) => [Number(p.version), p]),
  );
  if (policies.size !== policyRows.length) {
    return {
      exists: true,
      valid: false,
      reason: 'duplicate-recovery-policy-version',
      keys: new Map(),
    };
  }
  const keys = new Map([[0, genesisKey]]);
  const validPolicies = new Map();
  let current = genesisKey;
  let sequence = 0;

  const verifyPolicy = async (version) => {
    if (validPolicies.has(version)) return validPolicies.get(version);
    const policy = policies.get(Number(version));
    if (!policy) return null;
    const policyVersion = Number(policy.version);
    const policySequence = Number(policy.identity_sequence);
    if (
      !Number.isSafeInteger(policyVersion)
      || policyVersion < 1
      || policyVersion !== Number(version)
      || !Number.isSafeInteger(policySequence)
      || policySequence < 0
    ) return null;
    const signer = keys.get(policySequence);
    if (!signer) return null;
    const guardians = canonicalGuardians(policy.guardians || []);
    const threshold = Number(policy.threshold);
    if (
      guardians.length < 2
      || guardians.length > 5
      || !Number.isSafeInteger(threshold)
      || threshold < 2
      || threshold > guardians.length
    ) return null;

    const guardianUsers = new Set();
    const guardianIdentities = new Set();
    const guardianKeys = new Set();
    for (const guardian of guardians) {
      if (
        !guardian?.user_id
        || !guardian?.immutable_id
        || !guardian?.identity_key
        || guardian.user_id === documentUserId
        || guardian.immutable_id === immutableId
      ) return null;
      let rawKey;
      try { rawKey = unb64(guardian.identity_key); }
      catch { return null; }
      if (rawKey.length !== 32) return null;
      const keyId = hex(rawKey);
      if (
        guardianUsers.has(guardian.user_id)
        || guardianIdentities.has(guardian.immutable_id)
        || guardianKeys.has(keyId)
      ) return null;
      guardianUsers.add(guardian.user_id);
      guardianIdentities.add(guardian.immutable_id);
      guardianKeys.add(keyId);
    }

    const payload = recoveryPolicyPayload(
      immutableId,
      policyVersion,
      policySequence,
      threshold,
      guardians,
    );
    if (!(await verifies(cs, signer, payload, policy.signature))) return null;
    const verified = { ...policy, guardians, threshold };
    validPolicies.set(Number(version), verified);
    return verified;
  };

  for (const transition of transitions) {
    const next = sequence + 1;
    if (
      Number(transition.sequence) !== next
      || transition.previous_key !== current
      || !transition.new_key
    ) {
      return { exists: true, valid: false, reason: 'broken-chain', keys };
    }

    const payload = identityRotationPayload(
      immutableId,
      next,
      current,
      transition.new_key,
    );
    // Both ends of a rotation sign it, so the chain can't be pointed at a key the account doesn't hold.
    const grandfathered = next <= Number(
      legacyThrough ?? readIdentityPin(documentUserId)?.sequence ?? 0,
    );
    if (
      !grandfathered
      && !(await verifies(cs, transition.new_key, payload, transition.new_key_signature))
    ) {
      return { exists: true, valid: false, reason: 'bad-new-root-signature', keys };
    }
    const auth = transitionAuthorization(transition);
    if (auth.kind === 'existing_root') {
      if (!(await verifies(cs, current, payload, auth.signature))) {
        return { exists: true, valid: false, reason: 'bad-root-signature', keys };
      }
    } else if (auth.kind === 'guardians') {
      const activePolicies = [...policies.values()]
        .filter((p) => Number(p.identity_sequence) <= sequence)
        .sort((a, b) => Number(b.version) - Number(a.version));
      const active = activePolicies[0] || null;
      if (!active || Number(auth.policy_version) !== Number(active.version)) {
        return { exists: true, valid: false, reason: 'superseded-recovery-policy', keys };
      }
      const policy = await verifyPolicy(Number(auth.policy_version));
      if (!policy) {
        return { exists: true, valid: false, reason: 'bad-recovery-policy', keys };
      }
      const byId = new Map(
        policy.guardians.map((g) => [g.immutable_id, g]),
      );
      const approved = new Set();
      for (const approval of auth.approvals || []) {
        const guardian = byId.get(approval.guardian_immutable_id);
        if (!guardian || approved.has(guardian.immutable_id)) continue;
        if (await verifies(cs, guardian.identity_key, payload, approval.signature)) {
          approved.add(guardian.immutable_id);
        }
      }
      if (approved.size < policy.threshold) {
        return { exists: true, valid: false, reason: 'insufficient-guardians', keys };
      }
    } else {
      return { exists: true, valid: false, reason: 'unknown-authorization', keys };
    }

    sequence = next;
    current = transition.new_key;
    keys.set(sequence, current);
  }

  if (
    Number(document.sequence) !== sequence
    || document.current_key !== current
  ) {
    return { exists: true, valid: false, reason: 'head-mismatch', keys };
  }

  for (const version of [...policies.keys()].sort((a, b) => a - b)) {
    if (!(await verifyPolicy(version))) {
      return { exists: true, valid: false, reason: 'bad-recovery-policy', keys };
    }
  }

  // Policy versions are an append-only revocation clock: a server must not be able to delete a newer policy and make an older guardian set look current.
  const policyVersions = [...validPolicies.keys()].sort((a, b) => a - b);
  const currentPolicyVersion = Number(document.current_policy_version || 0);
  const latestPolicyVersion = policyVersions.at(-1) || 0;
  if (
    !Number.isSafeInteger(currentPolicyVersion)
    || currentPolicyVersion < 0
    || policyVersions.some((version, index) => version !== index + 1)
    || currentPolicyVersion !== latestPolicyVersion
  ) {
    return { exists: true, valid: false, reason: 'policy-head-mismatch', keys };
  }

  return {
    exists: true,
    valid: true,
    immutableId,
    genesisKey,
    currentKey: current,
    sequence,
    keys,
    recoveryPolicies: validPolicies,
    currentPolicyVersion,
  };
}

export function readIdentityPin(userId) {
  const raw = storage.get(PIN_PREFIX + userId, null);
  // v1 stored only the immutable id as a JSON string; upgrade the pin in place.
  if (typeof raw === 'string') {
    return {
      immutableId: raw,
      sequence: null,
      currentKey: null,
      policyVersion: null,
      policySignature: null,
    };
  }
  if (!raw || typeof raw !== 'object' || !raw.immutableId) return null;
  return raw;
}

function checkpoint(identity) {
  if (typeof identity === 'string') {
    return {
      immutableId: identity,
      sequence: null,
      currentKey: null,
      policyVersion: null,
      policySignature: null,
    };
  }
  const immutableId = identity?.immutableId || null;
  const sequence = Number(identity?.sequence);
  const policyVersion = Number(identity?.currentPolicyVersion);
  const currentPolicy = Number.isSafeInteger(policyVersion) && policyVersion > 0
    ? identity?.recoveryPolicies?.get?.(policyVersion)
    : null;
  return {
    immutableId,
    sequence: Number.isSafeInteger(sequence) && sequence >= 0 ? sequence : null,
    currentKey: identity?.currentKey || null,
    policyVersion: Number.isSafeInteger(policyVersion) && policyVersion >= 0
      ? policyVersion
      : null,
    policySignature: currentPolicy?.signature || null,
  };
}

export function pinIdentity(userId, identity) {
  const key = PIN_PREFIX + userId;
  const next = checkpoint(identity);
  const pinned = readIdentityPin(userId);

  if (!next.immutableId) {
    return { ok: false, reason: 'missing-immutable-id', pinned };
  }
  if (pinned?.immutableId && pinned.immutableId !== next.immutableId) {
    return {
      ok: false,
      reason: 'immutable-id-changed',
      pinned: pinned.immutableId,
      received: next.immutableId,
    };
  }

  if (pinned?.sequence != null && next.sequence != null) {
    if (next.sequence < pinned.sequence) {
      return { ok: false, reason: 'identity-sequence-rollback', pinned, received: next };
    }
    const pinnedKeyInChain = identity?.keys?.get?.(pinned.sequence) || null;
    if (
      pinned.currentKey
      && (
        (next.sequence === pinned.sequence && next.currentKey !== pinned.currentKey)
        || (next.sequence > pinned.sequence && pinnedKeyInChain !== pinned.currentKey)
      )
    ) {
      return { ok: false, reason: 'identity-chain-fork', pinned, received: next };
    }
  }

  if (pinned?.policyVersion != null && next.policyVersion != null) {
    if (next.policyVersion < pinned.policyVersion) {
      return { ok: false, reason: 'recovery-policy-rollback', pinned, received: next };
    }
    if (pinned.policyVersion > 0 && pinned.policySignature) {
      const oldPolicy = identity?.recoveryPolicies?.get?.(pinned.policyVersion);
      if (!oldPolicy || oldPolicy.signature !== pinned.policySignature) {
        return { ok: false, reason: 'recovery-policy-fork', pinned, received: next };
      }
    }
    if (
      next.policyVersion > pinned.policyVersion
      && pinned.sequence != null
      && identity?.recoveryPolicies
    ) {
      for (const [version, policy] of identity.recoveryPolicies) {
        if (
          Number(version) > pinned.policyVersion
          && Number(policy.identity_sequence) < pinned.sequence
        ) {
          return {
            ok: false,
            reason: 'retired-root-recovery-policy',
            pinned,
            received: next,
          };
        }
      }
    }
  }

  // Don't discard a richer checkpoint when an old caller supplies only a bare id.
  const merged = {
    immutableId: next.immutableId,
    sequence: next.sequence ?? pinned?.sequence ?? null,
    currentKey: next.currentKey ?? pinned?.currentKey ?? null,
    policyVersion: next.policyVersion ?? pinned?.policyVersion ?? null,
    policySignature: next.policySignature ?? pinned?.policySignature ?? null,
    verified: pinned?.verified === true,
  };
  const before = storage.get(key, null);
  storage.set(key, merged);
  if (JSON.stringify(before) !== JSON.stringify(merged)) pinsChanged();
  return { ok: true, pinned: merged.immutableId, checkpoint: merged };
}

export function pinnedIdentity(userId) {
  return readIdentityPin(userId)?.immutableId || null;
}

export async function ensureOwnIdentityContinuity(
  home,
  cs,
  userId,
  identityKey,
  signKey,
) {
  let doc;
  try {
    doc = await home.identityContinuity();
  } catch (e) {
    if (e?.status === 404) {
      return pinnedIdentity(userId)
        ? { supported: false, valid: false, reason: 'continuity-disappeared' }
        : { supported: false, valid: true };
    }
    throw e;
  }

  if (!doc?.exists) {
    if (!signKey || !identityKey) {
      return { supported: true, valid: false, reason: 'cannot-anchor' };
    }
    const immutableId = immutableIdentityId(identityKey);
    const signature = b64url(await cs.signature.sign(
      signKey,
      identityAnchorPayload(userId, immutableId, identityKey),
    ));
    doc = await home.anchorIdentity({
      immutable_id: immutableId,
      identity_key: identityKey,
      signature,
    });
  }

  const verified = await verifyIdentityDocument(cs, doc, userId);
  if (!verified.valid) return { supported: true, ...verified };
  const pin = pinIdentity(userId, verified);
  if (!pin.ok) {
    return {
      supported: true,
      ...verified,
      valid: false,
      reason: pin.reason || 'identity-checkpoint-rejected',
      pinned: pin.pinned,
    };
  }
  if (identityKey && verified.currentKey !== identityKey) {
    return {
      supported: true,
      ...verified,
      valid: false,
      reason: 'cross-signing-head-mismatch',
    };
  }
  return { supported: true, ...verified };
}
