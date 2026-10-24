// Cross-signing: one key per account, with domain-separated payloads (`telium-device-sig` vs `telium-user-sig`), signing MLS leaf keys. Device-held by default; verifying a person covers all their devices. The SAS can't be steered: the responder commits before seeing the initiator's contribution.

import { heldSecret, keepSecret } from './mls.js';
import {
  deviceRevocationPayload,
  ensureOwnIdentityContinuity,
  identityRotationPayload,
  pinIdentity,
  pinnedIdentity,
  recoveryPolicyPayload,
  verifiedRevocations,
  verifyIdentityDocument,
} from './identity-continuity.js';
import { clearPinConflict, markPinVerified, pinConflict } from './identity-pins.js';
import { open as unseal, seal } from './vault.js';
import { b64, unb64 } from './util.js';

export { SAS_EMOJI, VERIFY_TIMEOUT, Verification, emojiFor } from './verify-sas.js';

const te = new TextEncoder();
const DEVICE_SEAL = 'device-v1:';
const RECOVERY_SEAL = 'recovery-v1:';

// Every signature is over a string that says what it means (domain separation).

/// Network, timeout, 408/429/5xx.
function unanswered(e) {
  const status = e?.status;
  return !status || status === 408 || status === 429 || status >= 500;
}

function devicePayload(userId, deviceId, mlsKey) {
  return te.encode(`telium-device-sig:v1|${userId}|${deviceId}|${mlsKey}`);
}

function userPayload(signer, subject, identityKey) {
  return te.encode(`telium-user-sig:v1|${signer}|${subject}|${identityKey}`);
}

function userIdentityPayload(signer, subject, immutableId, identityKey) {
  return te.encode(
    `telium-user-sig:v2|${signer}|${subject}|${immutableId}|${identityKey}`,
  );
}

export class Trust {
  constructor(home, { userId, deviceId, recovery = null }) {
    this.home = home;
    this.userId = userId;
    this.deviceId = deviceId;
    this.recovery = recovery;
    this.cs = null;
    this.identityKey = null;
    this.signKey = null;
    this.immutableId = null;
    this.continuity = null;
    this.identityHistoryKeys = new Set();
    this.own = new Map();
    this.signed = new Map();
    // Mirrors the cooldown in `routes/dm.rs`.
    this.requests = new Map();
    this.peers = new Map();
    // Revoked device keys per account; read synchronously by the MLS engine.
    this.revoked = new Map();
    this.onSecretAdopted = null;
    this.onRecoveryAdopted = null;
    this.identityMismatch = false;
  }

  get ready() { return !!this.identityKey; }

  /// Whether `userId`'s root has revoked the device key `mlsKey` (base64).
  isRevokedKey(userId, mlsKey) {
    return Boolean(mlsKey && this.revoked.get(userId)?.has(mlsKey));
  }

  /// False while a self-custody vault is locked.
  get canSign() { return !!this.signKey; }

  get recoveryPolicy() {
    if (!this.continuity?.valid) return null;
    return this.continuity.recoveryPolicies?.get(
      Number(this.continuity.currentPolicyVersion || 0),
    ) || null;
  }

  /// Creates the key on first use; legacy unprefixed rows are opened once and moved to the current form.
  async start(cs, recoveryKey, mlsKey, mode = 'device_custody') {
    this.cs = cs;
    const doc = await this.home.crossSigning();
    for (const d of doc.devices || []) this.own.set(d.device_id, d);
    const ownRevocations = doc.revocations || [];
    const storedSignatures = doc.signatures || [];
    // Pending asks are taken as given; a dishonest one only greys out a button.
    for (const r of doc.requests || []) {
      if (r?.subject) this.requests.set(r.subject, r);
    }
    let identityKeyText = doc.identity_key || null;

    const held = await heldSecret(this.userId);
    const recoveryKeys = this.recovery?.openers?.length
      ? this.recovery.openers
      : recoveryKey ? [recoveryKey] : [];
    const openWithRecovery = async (blob) => {
      for (const key of recoveryKeys) {
        try { return await unseal(key, blob); }
        catch { /* try the next key in the account's retired ring */ }
      }
      return null;
    };

    if (doc.exists) {
      this.identityKey = unb64(doc.identity_key);
      const stored = String(doc.sealed_secret || '');
      const deviceWrapped = stored.startsWith(DEVICE_SEAL);
      const recoveryWrapped = stored.startsWith(RECOVERY_SEAL);

      if (held) {
        this.signKey = held;
      } else if (recoveryWrapped && recoveryKeys.length) {
        this.signKey = await openWithRecovery(stored.slice(RECOVERY_SEAL.length));
      } else if (!deviceWrapped && !recoveryWrapped && recoveryKeys.length) {
        // The original format used the MLS recovery key; try the whole ring in case it rotated.
        this.signKey = await openWithRecovery(stored);
      }

      if (this.signKey) {
        // A homeserver can swap the public identity row but not make our secret match; check the pair.
        const probe = te.encode(`telium-crosssign-key-binding:v1|${this.userId}`);
        const proof = await this.cs.signature.sign(this.signKey, probe);
        const matches = await this.cs.signature.verify(
          this.identityKey, probe, proof,
        ).catch(() => false);
        if (!matches) {
          this.signKey = null;
          this.identityMismatch = true;
        }
      }

      if (this.signKey) {
        await keepSecret(this.userId, this.signKey);
        const wantRecovery = (mode === 'opaque_custody' || mode === 'self_custody') && recoveryKey;
        if (wantRecovery && !recoveryWrapped) {
          await this.home.putCrossSigning({
            identity_key: b64(this.identityKey),
            sealed_secret: RECOVERY_SEAL + await seal(recoveryKey, this.signKey),
          });
        } else if (!wantRecovery && !deviceWrapped) {
          const throwaway = crypto.getRandomValues(new Uint8Array(32));
          await this.home.putCrossSigning({
            identity_key: b64(this.identityKey),
            sealed_secret: DEVICE_SEAL + await seal(throwaway, this.signKey),
          });
        }
      }
    } else if (recoveryKey) {
      const pair = await cs.signature.keygen();
      this.identityKey = pair.publicKey;
      this.signKey = pair.signKey;
      await keepSecret(this.userId, pair.signKey);
      if (mode === 'opaque_custody' || mode === 'self_custody') {
        identityKeyText = b64(pair.publicKey);
        await this.home.putCrossSigning({
          identity_key: identityKeyText,
          sealed_secret: RECOVERY_SEAL + await seal(recoveryKey, pair.signKey),
        });
      } else {
        const throwaway = crypto.getRandomValues(new Uint8Array(32));
        identityKeyText = b64(pair.publicKey);
        await this.home.putCrossSigning({
          identity_key: identityKeyText,
          sealed_secret: DEVICE_SEAL + await seal(throwaway, pair.signKey),
        });
      }
    }

    if (this.identityKey && identityKeyText) {
      try {
        const continuity = await ensureOwnIdentityContinuity(
          this.home,
          this.cs,
          this.userId,
          identityKeyText,
          this.signKey,
        );
        this.continuity = continuity;
        this.immutableId = continuity.immutableId || null;
        this.identityHistoryKeys = new Set(
          continuity.keys ? [...continuity.keys.values()] : [],
        );
        if (continuity.supported && !continuity.valid) {
          this.signKey = null;
          this.identityMismatch = true;
        }
      } catch {
        // Transient failure: fail closed if already pinned.
        if (pinnedIdentity(this.userId)) {
          this.signKey = null;
          this.identityMismatch = true;
        }
      }
    }

    // Re-check each stored signature so the homeserver can't invent who we verified; legacy accounts accept only the current key.
    if (!this.identityMismatch) {
      for (const s of storedSignatures) {
        const signerKey = s.signer_key || identityKeyText;
        if (!signerKey || !s.signature) continue;
        if (this.identityHistoryKeys.size) {
          if (!this.identityHistoryKeys.has(signerKey)) continue;
        } else if (!identityKeyText || signerKey !== identityKeyText) {
          continue;
        }
        const payload = s.subject_identity_id
          ? userIdentityPayload(
            this.userId, s.subject, s.subject_identity_id, s.subject_key,
          )
          : userPayload(this.userId, s.subject, s.subject_key);
        const valid = await this.cs.signature.verify(
          unb64(signerKey),
          payload,
          unb64(s.signature),
        ).catch(() => false);
        if (!valid) continue;
        this.signed.set(s.subject, {
          subject_key: s.subject_key,
          subject_identity_id: s.subject_identity_id || null,
          signer_key: signerKey,
          signed_at: s.signed_at,
        });
      }
    }

    if (this.continuity?.valid) {
      const gone = await verifiedRevocations(this.cs, this.userId, ownRevocations, this.continuity);
      this.revoked.set(this.userId, gone);
      for (const [id, d] of this.own) if (gone.has(d.mls_key)) this.own.delete(id);
    }

    if (this.canSign && mlsKey) await this.vouchForOwnDevice(this.deviceId, mlsKey);
    return this;
  }

  /// Root-signed statement every client enforces. Without the signing key, or a signed MLS key, only the session ends.
  async revokeDevice(deviceId) {
    const device = this.own.get(deviceId);
    const mlsKey = device?.mls_key || null;
    if (!this.canSign || !this.immutableId || !mlsKey) {
      await this.home.revokeDevice(deviceId);
      return { signed: false };
    }
    const signature = b64(await this.cs.signature.sign(
      this.signKey, deviceRevocationPayload(this.userId, this.immutableId, deviceId, mlsKey),
    ));
    await this.home.revokeDevice(deviceId, { mls_key: mlsKey, signature });
    const gone = this.revoked.get(this.userId) || new Set();
    gone.add(mlsKey);
    this.revoked.set(this.userId, gone);
    for (const [id, d] of this.own) if (d.mls_key === mlsKey) this.own.delete(id);
    this.peers.delete(this.userId);
    return { signed: true, mlsKey };
  }

  /// Signed by both old and new roots. Without `recoveryKey` the new secret stays on this device.
  async rotateRoot({ recoveryKey = null } = {}) {
    if (!this.canSign || !this.continuity?.valid || !this.immutableId) {
      throw new Error('This device does not currently hold your identity signing key.');
    }
    const previous = b64(this.identityKey);
    const pair = await this.cs.signature.keygen();
    const next = b64(pair.publicKey);
    const sequence = Number(this.continuity.sequence || 0) + 1;
    const payload = identityRotationPayload(this.immutableId, sequence, previous, next);
    const sealed = recoveryKey
      ? RECOVERY_SEAL + await seal(recoveryKey, pair.signKey)
      : DEVICE_SEAL + await seal(crypto.getRandomValues(new Uint8Array(32)), pair.signKey);
    const deviceSignatures = [];
    for (const [deviceId, d] of this.own) {
      if (!d.mls_key || this.isRevokedKey(this.userId, d.mls_key)) continue;
      deviceSignatures.push({
        device_id: deviceId,
        mls_key: d.mls_key,
        signature: b64(await this.cs.signature.sign(
          pair.signKey, devicePayload(this.userId, deviceId, d.mls_key),
        )),
      });
    }
    const doc = await this.home.rotateIdentity({
      sequence,
      previous_key: previous,
      new_key: next,
      sealed_secret: sealed,
      authorization: {
        kind: 'existing_root',
        signature: b64(await this.cs.signature.sign(this.signKey, payload)),
      },
      new_key_signature: b64(await this.cs.signature.sign(pair.signKey, payload)),
      device_signatures: deviceSignatures,
    });
    const verified = await verifyIdentityDocument(this.cs, doc, this.userId);
    if (!verified.valid || verified.immutableId !== this.immutableId || verified.currentKey !== next) {
      throw new Error('The homeserver returned an invalid identity after rotation.');
    }
    const pin = pinIdentity(this.userId, verified);
    if (!pin.ok) throw new Error('The rotated identity does not continue the pinned one.');
    this.identityKey = pair.publicKey;
    this.signKey = pair.signKey;
    await keepSecret(this.userId, pair.signKey);
    this.continuity = { supported: true, ...verified };
    this.identityHistoryKeys = new Set([...verified.keys.values()]);
    for (const d of deviceSignatures) {
      this.own.set(d.device_id, { device_id: d.device_id, mls_key: d.mls_key, cross_sig: d.signature });
    }
    this.peers.delete(this.userId);
    return verified;
  }

  async adoptSecret(secret, identityKey) {
    this.signKey = secret;
    if (identityKey) this.identityKey = unb64(identityKey);
    await keepSecret(this.userId, secret);
    await this.onSecretAdopted?.(secret);
  }

  async vouchForOwnDevice(deviceId, mlsKey) {
    const key = typeof mlsKey === 'string' ? mlsKey : b64(mlsKey);
    const existing = this.own.get(deviceId);
    if (existing?.cross_sig && existing.mls_key === key) return;
    const signature = b64(await this.cs.signature.sign(
      this.signKey, devicePayload(this.userId, deviceId, key),
    ));
    await this.home.signDevice(deviceId, { mls_key: key, signature });
    this.own.set(deviceId, { device_id: deviceId, mls_key: key, cross_sig: signature });
    this.peers.delete(this.userId);
  }

  async vouchForUser(userId, identityKey) {
    const key = typeof identityKey === 'string' ? identityKey : b64(identityKey);
    const peer = await this.refresh(userId).catch(() => null);
    if (peer?.identityKey && peer.identityKey !== key) {
      throw new Error('The identity shown during verification no longer matches the published identity.');
    }

    const immutableId = peer?.continuityValid ? peer.immutableId : null;
    const payload = immutableId
      ? userIdentityPayload(this.userId, userId, immutableId, key)
      : userPayload(this.userId, userId, key);
    const signature = b64(await this.cs.signature.sign(this.signKey, payload));
    const signerKey = this.identityKey ? b64(this.identityKey) : null;
    await this.home.signUser(userId, {
      subject_key: key,
      subject_identity_id: immutableId,
      signer_key: signerKey,
      signature,
    });
    this.signed.set(userId, {
      subject_key: key,
      subject_identity_id: immutableId,
      signer_key: signerKey,
      signed_at: Date.now(),
    });
    this.requests.delete(userId);
    // A human checked this identity; the pin keeps it.
    if (immutableId) markPinVerified(userId, immutableId);
    else clearPinConflict(userId);
    const known = this.peers.get(userId);
    if (known) known.pinConflict = null;
  }

  async withdraw(userId) {
    await this.home.unsignUser(userId);
    this.signed.delete(userId);
  }

  /// Expiry is applied here since nothing pushes it; no `may_ask_again_at` means a refusal that stands until replaced.
  requestFor(userId) {
    const record = this.requests.get(userId);
    if (!record) return null;
    if (record.may_ask_again_at && record.may_ask_again_at <= Date.now()) {
      this.requests.delete(userId);
      return null;
    }
    return record;
  }

  noteRequest(record) {
    if (record?.subject) this.requests.set(record.subject, record);
  }

  clearRequest(userId) {
    this.requests.delete(userId);
  }

  /// null only for a legacy account with no root; otherwise a hard boolean so a server can't smuggle in an unsigned leaf.
  async verifyClaimedPackage(userId, deviceId, signatureKey) {
    const peer = await this.refresh(userId);
    if (peer?.continuityRejected) return false;
    if (peer?.continuityUnknown) {
      // Neither yes nor no: the caller must ask again.
      throw Object.assign(
        new Error(`Could not reach ${userId}'s identity to check this device.`),
        { unknown: true },
      );
    }
    // A missing key is "legacy" only if never expected; otherwise the server is hiding it.
    if (!peer?.identityKey) return this.expectsIdentity(userId) ? false : null;
    if (this.isRevokedKey(userId, signatureKey)) return false;
    const device = peer.devices.get(deviceId);
    return Boolean(
      device?.ok
      && device.mls_key === signatureKey
      && device.active !== false
    );
  }

  /// So a missing identity key is a change, not legacy.
  expectsIdentity(userId) {
    return this.signed.has(userId) || Boolean(pinnedIdentity(userId));
  }

  /// Each guardian must publish a valid continuity chain; signed with the current root.
  async setRecoveryGuardians(userIds, threshold = 2) {
    if (!this.canSign || !this.continuity?.valid || !this.immutableId) {
      throw new Error('This device does not currently hold your identity signing key.');
    }
    const ids = [...new Set((userIds || []).filter(Boolean))];
    if (ids.length < 2 || ids.length > 5) {
      throw new Error('Choose between 2 and 5 recovery guardians.');
    }
    if (threshold < 2 || threshold > ids.length) {
      throw new Error('Recovery threshold must be at least 2 and no more than the guardian count.');
    }
    if (ids.includes(this.userId)) {
      throw new Error('Your own account cannot be one of its recovery guardians.');
    }

    const guardians = [];
    for (const userId of ids) {
      const peer = await this.refresh(userId);
      if (
        !peer?.continuityValid
        || !peer.immutableId
        || !peer.identityKey
      ) {
        throw new Error(
          `${userId} does not yet publish a valid immutable Telium identity.`,
        );
      }
      const trusted = this.signed.get(userId);
      const historicalKeys = new Set(
        peer.continuity?.keys ? [...peer.continuity.keys.values()] : [],
      );
      const verifiedIdentity = trusted?.subject_identity_id === peer.immutableId
        || (
          !trusted?.subject_identity_id
          && trusted?.subject_key
          && historicalKeys.has(trusted.subject_key)
        );
      if (!verifiedIdentity) {
        throw new Error(
          `Verify ${userId} first before making them a recovery guardian.`,
        );
      }
      guardians.push({
        user_id: userId,
        immutable_id: peer.immutableId,
        identity_key: peer.identityKey,
      });
    }

    const version = Number(this.continuity.currentPolicyVersion || 0) + 1;
    const identitySequence = Number(this.continuity.sequence || 0);
    const payload = recoveryPolicyPayload(
      this.immutableId,
      version,
      identitySequence,
      threshold,
      guardians,
    );
    const signature = b64(await this.cs.signature.sign(this.signKey, payload));
    const doc = await this.home.setIdentityRecoveryPolicy({
      version,
      identity_sequence: identitySequence,
      threshold,
      guardians,
      signature,
    });

    const verified = await verifyIdentityDocument(this.cs, doc, this.userId);
    if (!verified.valid || verified.immutableId !== this.immutableId) {
      throw new Error('The homeserver returned an invalid identity recovery policy.');
    }
    this.continuity = { supported: true, ...verified };
    this.identityHistoryKeys = new Set([...verified.keys.values()]);
    return this.recoveryPolicy;
  }

  /// Checks cross-signatures locally rather than trusting the server's rows.
  async refresh(userId) {
    const doc = userId === this.userId
      ? {
        identity_key: this.identityKey ? b64(this.identityKey) : null,
        devices: [...this.own.values()],
      }
      : await this.home.deviceList(userId).catch((e) => {
        // Unfetchable is "unknown", distinct from fetched-but-invalid.
        throw unanswered(e) ? Object.assign(e ?? new Error('no answer'), { unknown: true }) : e;
      });
    const identityKey = doc.identity_key || null;

    let continuity = null;
    let continuityValid = false;
    let continuityRejected = false;
    let continuityUnknown = false;
    let immutableId = null;
    if (userId === this.userId && this.continuity?.valid) {
      continuity = this.continuity;
      continuityValid = true;
      immutableId = this.immutableId;
    } else {
      let identityDoc;
      let fetched = false;
      try {
        identityDoc = await this.home.identityDocument(userId);
        fetched = true;
      } catch (e) {
        // No answer: neither trusted nor changed.
        if (unanswered(e)) continuityUnknown = true;
        // A legacy homeserver with no continuity endpoint is usable until pinned.
        else if (e?.status !== 404 || pinnedIdentity(userId)) continuityRejected = true;
      }
      if (fetched) {
        try {
          continuity = await verifyIdentityDocument(this.cs, identityDoc, userId);
          if (continuity?.exists) {
            const pin = pinIdentity(userId, continuity);
            continuityValid = Boolean(
              continuity.valid
              && pin.ok
              && continuity.currentKey === identityKey,
            );
            continuityRejected = !continuityValid;
            immutableId = continuity.immutableId || null;
          } else if (pinnedIdentity(userId)) {
            continuityRejected = true;
          }
        } catch {
          // The document came back and does not check out.
          continuityRejected = true;
        }
      }
    }

    // Check revocations against the verified chain, not just `active` flags.
    let revoked = this.revoked.get(userId) || new Set();
    if (userId !== this.userId && continuityValid) {
      revoked = await verifiedRevocations(this.cs, userId, doc.revocations, continuity);
      this.revoked.set(userId, revoked);
    }
    const devices = new Map();
    for (const d of doc.devices || []) {
      if (d.mls_key && revoked.has(d.mls_key)) {
        devices.set(d.device_id, { ...d, ok: false, revoked: true });
        continue;
      }
      const ok = !continuityRejected
        && !continuityUnknown
        && d.active !== false
        && !!(identityKey && d.mls_key && d.cross_sig)
        && await this.cs.signature.verify(
          unb64(identityKey),
          devicePayload(userId, d.device_id, d.mls_key),
          unb64(d.cross_sig),
        ).catch(() => false);
      devices.set(d.device_id, { ...d, ok });
    }
    const entry = {
      identityKey,
      immutableId,
      continuity,
      continuityValid,
      continuityRejected,
      continuityUnknown,
      devices,
      // Devices pinned this person differently (identity-pins.js).
      pinConflict: userId === this.userId ? null : pinConflict(userId),
    };
    this.peers.set(userId, entry);

    const trusted = this.signed.get(userId);
    // An existing verification of exactly this identity wins later pin conflicts.
    if (
      userId !== this.userId && continuityValid && immutableId
      && trusted?.subject_identity_id === immutableId && !entry.pinConflict
    ) markPinVerified(userId, immutableId);
    const historicalKeys = new Set(
      continuity?.keys ? [...continuity.keys.values()] : [],
    );
    if (
      userId !== this.userId
      && this.canSign
      && continuityValid
      && trusted
      && !trusted.subject_identity_id
      && historicalKeys.has(trusted.subject_key)
    ) {
      // Upgrade a verification of a historical key; the chain proves the same identity.
      const signerKey = this.identityKey ? b64(this.identityKey) : null;
      const signature = b64(await this.cs.signature.sign(
        this.signKey,
        userIdentityPayload(
          this.userId,
          userId,
          immutableId,
          trusted.subject_key,
        ),
      ));
      const upgraded = {
        ...trusted,
        subject_identity_id: immutableId,
        signer_key: signerKey,
        signature,
      };
      await this.home.signUser(userId, {
        subject_key: trusted.subject_key,
        subject_identity_id: immutableId,
        signer_key: signerKey,
        signature,
      }).then(() => {
        this.signed.set(userId, upgraded);
      }).catch(() => {});
    }

    return entry;
  }

  /// Statuses: verified, unverified, unsigned (no cross-signing key), changed (key differs from the verified one). `leafKey` is the key the ratchet tree carries.
  statusFor(userId, deviceId, leafKey) {
    // Revocation outranks every other status.
    if (this.isRevokedKey(userId, leafKey)) return 'revoked';
    const peer = this.peers.get(userId);
    if (!peer) return 'unverified';

    // Checked before the missing key: a verified contact whose key vanished is "changed", not "unsigned".
    if (peer.continuityRejected) return 'changed';
    if (peer.pinConflict) return 'changed';
    if (peer.continuityUnknown) return 'unverified';
    if (!peer.identityKey) return this.expectsIdentity(userId) ? 'changed' : 'unsigned';

    if (userId === this.userId) {
      if (this.identityMismatch) return 'changed';
      if (this.immutableId && peer.immutableId && this.immutableId !== peer.immutableId) {
        return 'changed';
      }
    } else {
      const trusted = this.signed.get(userId);
      if (!trusted) return 'unverified';
      if (trusted.subject_identity_id) {
        if (
          !peer.continuityValid
          || trusted.subject_identity_id !== peer.immutableId
        ) return 'changed';
      } else if (peer.continuityValid && peer.continuity?.keys) {
        const historicalKeys = new Set([...peer.continuity.keys.values()]);
        if (!historicalKeys.has(trusted.subject_key)) return 'changed';
      } else if (trusted.subject_key !== peer.identityKey) {
        return 'changed';
      }
    }

    const device = peer.devices.get(deviceId);
    if (!device?.ok) return 'unverified';
    if (leafKey && device.mls_key !== leafKey) return 'unverified';
    return 'verified';
  }

  /// For someone else a server-published key isn't enough (their homeserver could inject a device); their identity must already be verified.
  async authorizedRejoinDevice(userId, deviceId, signatureKey = null) {
    const peer = await this.refresh(userId).catch(() => null);
    const device = peer?.devices?.get(deviceId);
    if (!device?.ok) return false;
    if (signatureKey && device.mls_key !== signatureKey) return false;
    if (this.isRevokedKey(userId, device.mls_key)) return false;
    if (userId === this.userId) return !this.identityMismatch;
    return this.statusFor(userId, deviceId, null) === 'verified';
  }

  async survey(devices) {
    const users = [...new Set(devices.map((d) => d.userId))];
    await Promise.all(users.map((u) => this.refresh(u).catch(() => {})));
    return devices.map((d) => ({
      ...d, status: this.statusFor(d.userId, d.deviceId, d.signatureKey),
    }));
  }
}
