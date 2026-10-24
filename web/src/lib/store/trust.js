import * as vault from '../vault.js';
import { verification } from './shared.js';

export const trustMethods = {
  /// Fails closed: an outage must not become device trust.
  async startTrust() {
    // No IndexedDB means no local device identity: an expected degraded mode.
    if (typeof indexedDB === 'undefined') return null;
    if (!this.mls) return null;
    if (this.trust) return this.trust;
    if (this.trustStart) return this.trustStart;

    this.trustStart = (async () => {
      const { user_id: userId, device_id: deviceId } = this.session.home;
      const { Trust } = await verification();
      const trust = new Trust(this.home, {
        userId,
        deviceId,
        recovery: this.vault?.key ? this.vault : null,
      });
      try {
        await trust.start(
          this.mls.cs,
          this.vault?.key || null,
          await this.mls.leafKey(),
          this.custody?.mode || this.vault?.mode || 'device_custody',
        );
        this.trust = trust;

        trust.onRecoveryAdopted = async (ring) => {
          const mode = this.custody?.mode || this.vault?.mode || 'device_custody';
          let recovered = {
            ...ring,
            mode,
            locked: false,
            needs_device: false,
          };
          await vault.rememberDeviceRecovery(userId, recovered).catch(() => {});
          if (this.authRecoveryWrapper) {
            // Carry over what this device read about the second copy.
            const held = this.vault || {};
            recovered = await vault.setMode(
              this.home,
              {
                ...recovered,
                mode: recovered.mode || 'device_custody',
                independent: Boolean(held.independent),
                recoveryKey: Boolean(held.recoveryKey),
                legacyIndependent: Boolean(held.legacyIndependent),
                independentCiphertext: held.independentCiphertext || null,
              },
              'opaque_custody',
              null,
              userId,
              this.authRecoveryWrapper,
            ).catch(() => recovered);
            await this.refreshCustody().catch(() => {});
          }
          this.vault = recovered;
          trust.recovery = recovered;
          this.sync.adoptKeyring(recovered).catch(() => {});
          await this.mls.adoptRecoveryKey(recovered);
          this.emit('vault', recovered);

          // Device approval is the recovery ceremony: resume the open conversation so its GroupInfo can open.
          const id = this.route.conversationId;
          if (id) await this.openConversation(id).catch((e) => {
            console.warn('could not resume DM after trusted-device approval', e);
          });
        };

        this.emit('verify', { ready: true });
        return trust;
      } catch (e) {
        console.warn('cross-signing unavailable', e);
        return null;
      }
    })();

    try {
      return await this.trustStart;
    } finally {
      this.trustStart = null;
    }
  },

  async revokeDevice(deviceId) {
    const trust = this.trust || await this.startTrust().catch(() => null);
    const result = trust
      ? await trust.revokeDevice(deviceId)
      : (await this.home.revokeDevice(deviceId), { signed: false });
    if (result.signed && this.mls) {
      for (const convo of this.conversations || []) {
        await this.mls.removeRevoked(convo.id).catch((e) => {
          console.warn('could not take a revoked device out of', convo.id, e);
        });
      }
    }
    return result;
  },

  /// Only exception: a server predating identity continuity that this client never pinned.
  async verifyClaimedPackage(userId, deviceId, signatureKey) {
    const trust = await this.startTrust();
    if (trust) {
      return trust.verifyClaimedPackage(userId, deviceId, signatureKey);
    }

    const { pinnedIdentity } = await import('../identity-continuity.js');
    const selfId = this.session?.home?.user_id || null;
    if (selfId && pinnedIdentity(selfId)) {
      throw new Error(
        'Identity continuity is pinned for this account, but it could not be verified.',
      );
    }

    const domain = this.session?.home?.domain;
    let caps = domain ? this.caps.get(domain) : null;
    if (!caps) {
      try {
        caps = await this.home.capabilities();
        if (domain) this.caps.set(domain, caps);
      } catch (e) {
        if (e?.status === 404) return null;
        throw new Error('Could not verify encryption identity capabilities.');
      }
    }
    if (caps?.identity?.continuity) {
      throw new Error(
        'This homeserver requires immutable identity verification, but cross-signing is unavailable.',
      );
    }
    return null;
  },

  sendVerificationStep(toUser) {
    return async (payload, toDevice) => {
      try {
        const res = await this.home.sendVerification({
          to_user: toUser, to_device: toDevice || null, payload,
        });
        if (res?.request) {
          this.trust?.noteRequest(res.request);
          this.emit('verify', { requested: toUser });
        }
        return res;
      } catch (e) {
        // A cooldown refusal means our picture was stale; keep the server's sentence.
        if (e?.body?.code === 'verification_already_requested') {
          this.trust?.noteRequest({ subject: toUser, message: e.message });
          this.emit('verify', { requested: toUser });
        }
        throw e;
      }
    };
  },

  async startVerification(userId, deviceId = null) {
    if (!this.trust) throw new Error('encryption is not available on this device');
    const txn = `${this.session.home.device_id}:${Date.now().toString(36)}`;
    const { Verification } = await verification();
    const exchange = new Verification(this.trust, {
      peerUser: userId,
      peerDevice: deviceId,
      initiator: true,
      txn,
      send: this.sendVerificationStep(userId),
      mlsKey: await this.mls.leafKey(),
    });
    this.verifications.set(txn, exchange);
    await exchange.begin();
    this.emit('verify', { txn });
    return exchange;
  },

  async onVerification(d) {
    if (!this.trust) return;
    if (d.from_device === this.session.home.device_id) return;
    if (d.to_device && d.to_device !== this.session.home.device_id) return;

    // The server drops its row on these two steps (`deliver_verification`); mirror it or a failed handshake leaves the control greyed.
    if (d.payload?.step === 'accept' || d.payload?.step === 'done') {
      this.trust.clearRequest(d.from_user);
    }

    let exchange = this.verifications.get(d.payload?.txn);
    if (!exchange) {
      if (d.payload?.step !== 'start') return;
      const { Verification } = await verification();
      exchange = new Verification(this.trust, {
        peerUser: d.from_user,
        peerDevice: d.from_device,
        initiator: false,
        txn: d.payload.txn,
        send: this.sendVerificationStep(d.from_user),
        mlsKey: await this.mls.leafKey(),
      });
      this.verifications.set(d.payload.txn, exchange);
    }
    try { await exchange.handle(d); }
    catch (e) { exchange.cancel(e.message || 'the exchange failed'); }
    this.emit('verify', { txn: exchange.txn });
  },

  endVerification(txn) {
    const exchange = this.verifications.get(txn);
    if (!exchange) return;
    exchange.cancel('closed');
    this.verifications.delete(txn);
    this.emit('verify', { txn });
  },
};
