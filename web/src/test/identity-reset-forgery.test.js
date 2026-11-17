import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { getCiphersuiteFromName, getCiphersuiteImpl } from 'ts-mls';
import {
  identityAnchorPayload,
  identityRotationPayload,
  immutableIdentityId,
  pinIdentity,
  readIdentityPin,
  verifyIdentityDocument,
} from '../lib/identity-continuity.js';
import { keepSecret } from '../lib/mls-store.js';
import { Trust } from '../lib/verify.js';
import { b64, unb64 } from '../lib/util.js';

const SUITE = 'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519';
const USER = '@alice:example.test';

let cs;
beforeAll(async () => {
  cs = await getCiphersuiteImpl(getCiphersuiteFromName(SUITE));
});
beforeEach(() => {
  localStorage.clear();
});

async function root() {
  const pair = await cs.signature.keygen();
  return { pub: b64(pair.publicKey), secret: pair.signKey, raw: pair.publicKey };
}
const sign = async (secret, payload) => b64(await cs.signature.sign(secret, payload));

async function anchored(genesis) {
  const id = immutableIdentityId(genesis.pub);
  return {
    exists: true,
    user_id: USER,
    immutable_id: id,
    genesis_key: genesis.pub,
    anchor_signature: await sign(genesis.secret, identityAnchorPayload(USER, id, genesis.pub)),
    current_key: genesis.pub,
    sequence: 0,
    current_policy_version: 0,
    recovery_policies: [],
    transitions: [],
  };
}

/// `signNew: false` leaves the new root's signature unusable, as a server that does not hold the new key would.
async function rotated(from, to, { signNew = true } = {}) {
  const doc = await anchored(from);
  const payload = identityRotationPayload(doc.immutable_id, 1, from.pub, to.pub);
  return {
    ...doc,
    current_key: to.pub,
    sequence: 1,
    transitions: [{
      sequence: 1,
      previous_key: from.pub,
      new_key: to.pub,
      new_key_signature: signNew ? await sign(to.secret, payload) : 'AAAA',
      authorization_kind: 'existing_root',
      authorization: { kind: 'existing_root', signature: await sign(from.secret, payload) },
    }],
  };
}

function homeServing(identityDoc, current) {
  return {
    crossSigning: async () => ({
      exists: true,
      identity_key: current.pub,
      sealed_secret: 'x',
      devices: [],
      signatures: [],
      requests: [],
      revocations: [],
    }),
    identityContinuity: async () => identityDoc,
    putCrossSigning: async () => ({}),
  };
}

/// A device on an account that has really rotated once (genesis -> current), pinned at that checkpoint.
async function rotatedAccount() {
  const genesis = await root();
  const current = await root();
  const real = await verifyIdentityDocument(cs, await rotated(genesis, current), USER);
  expect(real.valid).toBe(true);
  expect(pinIdentity(USER, real).ok).toBe(true);
  return { genesis, current, realId: real.immutableId };
}

describe('a changed identity is never accepted on the device\'s say-so unless it is a fresh reset', () => {
  it('startOnce refuses a forged chain that ends at the real current key, with the server holding the genesis', async () => {
    const { current, realId } = await rotatedAccount();
    await keepSecret(USER, current.secret);
    const forgedGenesis = await root();
    // Grandfathered below the pinned sequence: the server needs only its own signatures.
    const forged = await rotated(forgedGenesis, current, { signNew: false });

    const trust = new Trust(homeServing(forged, current), { userId: USER, deviceId: 'd1' });
    await trust.start(cs, null, null, 'device_custody');

    expect(trust.identityMismatch).toBe(true);
    expect(trust.canSign).toBe(false);
    expect(readIdentityPin(USER).immutableId).toBe(realId);
    expect(trust.identityHistoryKeys.has(forgedGenesis.pub)).toBe(false);
  });

  it('startOnce refuses a fresh-looking genesis for a key that was not made on this device', async () => {
    const { current, realId } = await rotatedAccount();
    // The server serves a one-key identity whose key is one this device holds only via the server's sealed copy: no pending record.
    await keepSecret(USER, current.secret);
    const fresh = await anchored(current);
    const trust = new Trust(homeServing(fresh, current), { userId: USER, deviceId: 'd1' });
    await trust.start(cs, null, null, 'device_custody');
    expect(trust.identityMismatch).toBe(true);
    expect(readIdentityPin(USER).immutableId).toBe(realId);
  });

  it('adoptSecret refuses the same forged chain', async () => {
    const { current, realId } = await rotatedAccount();
    const forgedGenesis = await root();
    const forged = await rotated(forgedGenesis, current, { signNew: false });

    const trust = new Trust(homeServing(forged, current), { userId: USER, deviceId: 'd2' });
    await trust.start(cs, null, null, 'device_custody');
    expect(trust.continuity.reason).toBe('immutable-id-changed');
    await trust.adoptSecret(current.secret, current.pub);

    expect(readIdentityPin(USER).immutableId).toBe(realId);
    expect(trust.continuity.valid).toBe(false);
    expect(trust.identityHistoryKeys.has(forgedGenesis.pub)).toBe(false);
  });

  it('adoptSecret still takes a genuine reset: sequence 0, genesis is the current key', async () => {
    const { realId } = await rotatedAccount();
    const fresh = await root();
    const doc = await anchored(fresh);
    const trust = new Trust(homeServing(doc, fresh), { userId: USER, deviceId: 'd2' });
    await trust.start(cs, null, null, 'device_custody');
    expect(trust.continuity.reason).toBe('immutable-id-changed');
    await trust.adoptSecret(fresh.secret, fresh.pub);

    expect(readIdentityPin(USER).immutableId).toBe(doc.immutable_id);
    expect(readIdentityPin(USER).immutableId).not.toBe(realId);
    expect(trust.continuity.valid).toBe(true);
  });
});
