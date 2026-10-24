import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getCiphersuiteFromName, getCiphersuiteImpl } from 'ts-mls';
import {
  immutableIdentityId,
  identityAnchorPayload,
  identityRotationPayload,
  pinIdentity,
  recoveryPolicyPayload,
  verifyIdentityDocument,
} from '../lib/identity-continuity.js';
import { b64url } from '../lib/util.js';

const SUITE = 'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519';

let cs;

beforeAll(async () => {
  cs = await getCiphersuiteImpl(getCiphersuiteFromName(SUITE));
});

beforeEach(() => {
  localStorage.clear();
});

async function root() {
  const pair = await cs.signature.keygen();
  return {
    public: b64url(pair.publicKey),
    secret: pair.signKey,
  };
}

async function sign(secret, payload) {
  return b64url(await cs.signature.sign(secret, payload));
}

async function anchorSignature(userId, pair, immutable = immutableIdentityId(pair.public)) {
  return sign(
    pair.secret,
    identityAnchorPayload(userId, immutable, pair.public),
  );
}

describe('immutable identity continuity', () => {
  it('keeps one immutable id across an authorized root rotation', async () => {
    const first = await root();
    const second = await root();
    const immutable = immutableIdentityId(first.public);
    const payload = identityRotationPayload(
      immutable, 1, first.public, second.public,
    );
    const doc = {
      exists: true,
      user_id: '@alice:example.test',
      immutable_id: immutable,
      genesis_key: first.public,
      anchor_signature: await anchorSignature('@alice:example.test', first, immutable),
      current_key: second.public,
      sequence: 1,
      current_policy_version: 0,
      recovery_policies: [],
      transitions: [{
        sequence: 1,
        previous_key: first.public,
        new_key: second.public,
        new_key_signature: await sign(second.secret, payload),
        authorization_kind: 'existing_root',
        authorization: {
          kind: 'existing_root',
          signature: await sign(first.secret, payload),
        },
      }],
    };

    const verified = await verifyIdentityDocument(cs, doc);
    expect(verified.valid).toBe(true);
    expect(verified.immutableId).toBe(immutable);
    expect(verified.currentKey).toBe(second.public);
    expect([...verified.keys.values()]).toEqual([first.public, second.public]);
  });

  it('rejects a homeserver rollback to an older valid identity root', async () => {
    const first = await root();
    const second = await root();
    const immutable = immutableIdentityId(first.public);
    const rotate = identityRotationPayload(
      immutable, 1, first.public, second.public,
    );
    const current = await verifyIdentityDocument(cs, {
      exists: true,
      user_id: '@alice:example.test',
      immutable_id: immutable,
      genesis_key: first.public,
      anchor_signature: await anchorSignature('@alice:example.test', first, immutable),
      current_key: second.public,
      sequence: 1,
      current_policy_version: 0,
      recovery_policies: [],
      transitions: [{
        sequence: 1,
        previous_key: first.public,
        new_key: second.public,
        new_key_signature: await sign(second.secret, rotate),
        authorization_kind: 'existing_root',
        authorization: {
          kind: 'existing_root',
          signature: await sign(first.secret, rotate),
        },
      }],
    });
    expect(current.valid).toBe(true);
    expect(pinIdentity('@alice:example.test', current).ok).toBe(true);

    const replayed = await verifyIdentityDocument(cs, {
      exists: true,
      user_id: '@alice:example.test',
      immutable_id: immutable,
      genesis_key: first.public,
      anchor_signature: await anchorSignature('@alice:example.test', first, immutable),
      current_key: first.public,
      sequence: 0,
      current_policy_version: 0,
      recovery_policies: [],
      transitions: [],
    });
    expect(replayed.valid).toBe(true);
    const pin = pinIdentity('@alice:example.test', replayed);
    expect(pin.ok).toBe(false);
    expect(pin.reason).toBe('identity-sequence-rollback');
  });

  it('rejects a replay that resurrects an older guardian policy', async () => {
    const alice = await root();
    const guardians = await Promise.all([root(), root(), root(), root()]);
    const immutable = immutableIdentityId(alice.public);
    const rows = guardians.map((g, index) => ({
      user_id: `@guardian${index}:example.test`,
      immutable_id: `tid:guardian-${index}`,
      identity_key: g.public,
    }));
    const policy1 = {
      version: 1,
      identity_sequence: 0,
      threshold: 2,
      guardians: rows.slice(0, 3),
    };
    policy1.signature = await sign(
      alice.secret,
      recoveryPolicyPayload(
        immutable, 1, 0, 2, policy1.guardians,
      ),
    );
    const policy2 = {
      version: 2,
      identity_sequence: 0,
      threshold: 2,
      guardians: rows.slice(1, 4),
    };
    policy2.signature = await sign(
      alice.secret,
      recoveryPolicyPayload(
        immutable, 2, 0, 2, policy2.guardians,
      ),
    );

    const current = await verifyIdentityDocument(cs, {
      exists: true,
      user_id: '@alice:example.test',
      immutable_id: immutable,
      genesis_key: alice.public,
      anchor_signature: await anchorSignature('@alice:example.test', alice, immutable),
      current_key: alice.public,
      sequence: 0,
      current_policy_version: 2,
      recovery_policies: [policy1, policy2],
      transitions: [],
    });
    expect(current.valid).toBe(true);
    expect(pinIdentity('@alice:example.test', current).ok).toBe(true);

    const replayed = await verifyIdentityDocument(cs, {
      exists: true,
      user_id: '@alice:example.test',
      immutable_id: immutable,
      genesis_key: alice.public,
      anchor_signature: await anchorSignature('@alice:example.test', alice, immutable),
      current_key: alice.public,
      sequence: 0,
      current_policy_version: 1,
      recovery_policies: [policy1],
      transitions: [],
    });
    expect(replayed.valid).toBe(true);
    const pin = pinIdentity('@alice:example.test', replayed);
    expect(pin.ok).toBe(false);
    expect(pin.reason).toBe('recovery-policy-rollback');
  });

  it('rejects a newly appearing policy signed by a root already retired at the checkpoint', async () => {
    const first = await root();
    const second = await root();
    const guardians = await Promise.all([root(), root(), root()]);
    const immutable = immutableIdentityId(first.public);
    const rotatePayload = identityRotationPayload(
      immutable, 1, first.public, second.public,
    );
    const transition = {
      sequence: 1,
      previous_key: first.public,
      new_key: second.public,
      new_key_signature: await sign(second.secret, rotatePayload),
      authorization_kind: 'existing_root',
      authorization: {
        kind: 'existing_root',
        signature: await sign(first.secret, rotatePayload),
      },
    };

    const current = await verifyIdentityDocument(cs, {
      exists: true,
      user_id: '@alice:example.test',
      immutable_id: immutable,
      genesis_key: first.public,
      anchor_signature: await anchorSignature('@alice:example.test', first, immutable),
      current_key: second.public,
      sequence: 1,
      current_policy_version: 0,
      recovery_policies: [],
      transitions: [transition],
    });
    expect(current.valid).toBe(true);
    expect(pinIdentity('@alice:example.test', current).ok).toBe(true);

    const rows = guardians.map((g, index) => ({
      user_id: `@guardian${index}:example.test`,
      immutable_id: `tid:guardian-${index}`,
      identity_key: g.public,
    }));
    const policy = {
      version: 1,
      identity_sequence: 0,
      threshold: 2,
      guardians: rows,
      signature: await sign(
        first.secret,
        recoveryPolicyPayload(immutable, 1, 0, 2, rows),
      ),
    };
    const later = await verifyIdentityDocument(cs, {
      exists: true,
      user_id: '@alice:example.test',
      immutable_id: immutable,
      genesis_key: first.public,
      anchor_signature: await anchorSignature('@alice:example.test', first, immutable),
      current_key: second.public,
      sequence: 1,
      current_policy_version: 1,
      recovery_policies: [policy],
      transitions: [transition],
    });
    expect(later.valid).toBe(true);

    const pin = pinIdentity('@alice:example.test', later);
    expect(pin.ok).toBe(false);
    expect(pin.reason).toBe('retired-root-recovery-policy');
  });

  it('rejects a policy head that omits or lies about the latest policy version', async () => {
    const alice = await root();
    const guardians = await Promise.all([root(), root(), root()]);
    const immutable = immutableIdentityId(alice.public);
    const rows = guardians.map((g, index) => ({
      user_id: `@guardian${index}:example.test`,
      immutable_id: `tid:guardian-${index}`,
      identity_key: g.public,
    }));
    const policy = {
      version: 1,
      identity_sequence: 0,
      threshold: 2,
      guardians: rows,
      signature: await sign(
        alice.secret,
        recoveryPolicyPayload(immutable, 1, 0, 2, rows),
      ),
    };
    const verified = await verifyIdentityDocument(cs, {
      exists: true,
      user_id: '@alice:example.test',
      immutable_id: immutable,
      genesis_key: alice.public,
      anchor_signature: await anchorSignature('@alice:example.test', alice, immutable),
      current_key: alice.public,
      sequence: 0,
      current_policy_version: 0,
      recovery_policies: [policy],
      transitions: [],
    });
    expect(verified.valid).toBe(false);
    expect(verified.reason).toBe('policy-head-mismatch');
  });

  it('rejects an identity document whose account anchor signature is forged', async () => {
    const first = await root();
    const attacker = await root();
    const immutable = immutableIdentityId(first.public);
    const forged = await sign(
      attacker.secret,
      identityAnchorPayload('@alice:example.test', immutable, first.public),
    );
    const verified = await verifyIdentityDocument(cs, {
      exists: true,
      user_id: '@alice:example.test',
      immutable_id: immutable,
      genesis_key: first.public,
      anchor_signature: forged,
      current_key: first.public,
      sequence: 0,
      current_policy_version: 0,
      recovery_policies: [],
      transitions: [],
    }, '@alice:example.test');

    expect(verified.valid).toBe(false);
    expect(verified.reason).toBe('invalid-anchor');
  });

  it('rejects a continuity document for a different account address', async () => {
    const first = await root();
    const immutable = immutableIdentityId(first.public);
    const verified = await verifyIdentityDocument(cs, {
      exists: true,
      user_id: '@mallory:example.test',
      immutable_id: immutable,
      genesis_key: first.public,
      anchor_signature: await anchorSignature('@mallory:example.test', first, immutable),
      current_key: first.public,
      sequence: 0,
      current_policy_version: 0,
      recovery_policies: [],
      transitions: [],
    }, '@alice:example.test');

    expect(verified.valid).toBe(false);
    expect(verified.reason).toBe('wrong-user');
  });

  it('rejects a homeserver replacement with no authorized transition', async () => {
    const first = await root();
    const attacker = await root();
    const immutable = immutableIdentityId(first.public);
    const doc = {
      exists: true,
      user_id: '@alice:example.test',
      immutable_id: immutable,
      genesis_key: first.public,
      anchor_signature: await anchorSignature('@alice:example.test', first, immutable),
      current_key: attacker.public,
      sequence: 0,
      current_policy_version: 0,
      recovery_policies: [],
      transitions: [],
    };

    const verified = await verifyIdentityDocument(cs, doc);
    expect(verified.valid).toBe(false);
    expect(verified.reason).toBe('head-mismatch');
  });

  it('rejects a superseded guardian policy even if its old threshold still signs', async () => {
    const alice = await root();
    const recovered = await root();
    const guardians = await Promise.all([root(), root(), root(), root()]);
    const immutable = immutableIdentityId(alice.public);
    const rows = guardians.map((g, index) => ({
      user_id: `@guardian${index}:example.test`,
      immutable_id: `tid:guardian-${index}`,
      identity_key: g.public,
    }));
    const oldRows = rows.slice(0, 3);
    const newRows = rows.slice(1, 4);
    const oldPolicyPayload = recoveryPolicyPayload(immutable, 1, 0, 2, oldRows);
    const newPolicyPayload = recoveryPolicyPayload(immutable, 2, 0, 2, newRows);
    const rotatePayload = identityRotationPayload(
      immutable, 1, alice.public, recovered.public,
    );
    const approvals = await Promise.all(
      guardians.slice(0, 2).map(async (g, index) => ({
        guardian_immutable_id: oldRows[index].immutable_id,
        signature: await sign(g.secret, rotatePayload),
      })),
    );

    const verified = await verifyIdentityDocument(cs, {
      exists: true,
      user_id: '@alice:example.test',
      immutable_id: immutable,
      genesis_key: alice.public,
      anchor_signature: await anchorSignature('@alice:example.test', alice, immutable),
      current_key: recovered.public,
      sequence: 1,
      current_policy_version: 2,
      recovery_policies: [
        {
          version: 1,
          identity_sequence: 0,
          threshold: 2,
          guardians: oldRows,
          signature: await sign(alice.secret, oldPolicyPayload),
        },
        {
          version: 2,
          identity_sequence: 0,
          threshold: 2,
          guardians: newRows,
          signature: await sign(alice.secret, newPolicyPayload),
        },
      ],
      transitions: [{
        sequence: 1,
        previous_key: alice.public,
        new_key: recovered.public,
        new_key_signature: await sign(recovered.secret, rotatePayload),
        authorization_kind: 'guardians',
        authorization: {
          kind: 'guardians',
          policy_version: 1,
          approvals,
        },
      }],
    });

    expect(verified.valid).toBe(false);
    expect(verified.reason).toBe('superseded-recovery-policy');
  });

  it('rejects a recovery policy whose guardian slots share one signing key', async () => {
    const alice = await root();
    const shared = await root();
    const third = await root();
    const immutable = immutableIdentityId(alice.public);
    const guardians = [
      {
        user_id: '@guardian-a:example.test',
        immutable_id: 'tid:guardian-a',
        identity_key: shared.public,
      },
      {
        user_id: '@guardian-b:example.test',
        immutable_id: 'tid:guardian-b',
        identity_key: shared.public,
      },
      {
        user_id: '@guardian-c:example.test',
        immutable_id: 'tid:guardian-c',
        identity_key: third.public,
      },
    ];
    const payload = recoveryPolicyPayload(
      immutable, 1, 0, 2, guardians,
    );
    const verified = await verifyIdentityDocument(cs, {
      exists: true,
      user_id: '@alice:example.test',
      immutable_id: immutable,
      genesis_key: alice.public,
      anchor_signature: await anchorSignature('@alice:example.test', alice, immutable),
      current_key: alice.public,
      sequence: 0,
      current_policy_version: 1,
      recovery_policies: [{
        version: 1,
        identity_sequence: 0,
        threshold: 2,
        guardians,
        signature: await sign(alice.secret, payload),
      }],
      transitions: [],
    });

    expect(verified.valid).toBe(false);
    expect(verified.reason).toBe('bad-recovery-policy');
  });

  it('requires the configured two of three guardian signatures', async () => {
    const alice = await root();
    const recovered = await root();
    const guardians = await Promise.all([root(), root(), root()]);
    const immutable = immutableIdentityId(alice.public);
    const guardianRows = guardians.map((g, index) => ({
      user_id: `@guardian${index}:example.test`,
      immutable_id: `tid:guardian-${index}`,
      identity_key: g.public,
    }));
    const policyPayload = recoveryPolicyPayload(
      immutable, 1, 0, 2, guardianRows,
    );
    const rotatePayload = identityRotationPayload(
      immutable, 1, alice.public, recovered.public,
    );

    const makeDoc = async (count) => ({
      exists: true,
      user_id: '@alice:example.test',
      immutable_id: immutable,
      genesis_key: alice.public,
      anchor_signature: await anchorSignature('@alice:example.test', alice, immutable),
      current_key: recovered.public,
      sequence: 1,
      current_policy_version: 1,
      recovery_policies: [{
        version: 1,
        identity_sequence: 0,
        threshold: 2,
        guardians: guardianRows,
        signature: await sign(alice.secret, policyPayload),
      }],
      transitions: [{
        sequence: 1,
        previous_key: alice.public,
        new_key: recovered.public,
        new_key_signature: await sign(recovered.secret, rotatePayload),
        authorization_kind: 'guardians',
        authorization: {
          kind: 'guardians',
          policy_version: 1,
          approvals: await Promise.all(
            guardians.slice(0, count).map(async (g, index) => ({
              guardian_immutable_id: guardianRows[index].immutable_id,
              signature: await sign(g.secret, rotatePayload),
            })),
          ),
        },
      }],
    });

    expect((await verifyIdentityDocument(cs, await makeDoc(1))).valid).toBe(false);
    const accepted = await verifyIdentityDocument(cs, await makeDoc(2));
    expect(accepted.valid).toBe(true);
    expect(accepted.currentKey).toBe(recovered.public);
  });
});
