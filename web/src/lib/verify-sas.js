import {
  decodeRecoveryTransfer,
  encodeRecoveryTransfer,
  open as unseal,
  seal,
} from './vault.js';
import { b64, unb64 } from './util.js';

const te = new TextEncoder();

/// 64-emoji alphabet; seven is 42 bits.
export const SAS_EMOJI = [
  ['\u{1F436}', 'Dog'], ['\u{1F431}', 'Cat'], ['\u{1F981}', 'Lion'], ['\u{1F40E}', 'Horse'],
  ['\u{1F984}', 'Unicorn'], ['\u{1F437}', 'Pig'], ['\u{1F418}', 'Elephant'], ['\u{1F430}', 'Rabbit'],
  ['\u{1F43C}', 'Panda'], ['\u{1F413}', 'Rooster'], ['\u{1F427}', 'Penguin'], ['\u{1F422}', 'Turtle'],
  ['\u{1F41F}', 'Fish'], ['\u{1F419}', 'Octopus'], ['\u{1F98B}', 'Butterfly'], ['\u{1F337}', 'Flower'],
  ['\u{1F333}', 'Tree'], ['\u{1F335}', 'Cactus'], ['\u{1F344}', 'Mushroom'], ['\u{1F30F}', 'Globe'],
  ['\u{1F319}', 'Moon'], ['☁️', 'Cloud'], ['\u{1F525}', 'Fire'], ['\u{1F34C}', 'Banana'],
  ['\u{1F34E}', 'Apple'], ['\u{1F353}', 'Strawberry'], ['\u{1F33D}', 'Corn'], ['\u{1F355}', 'Pizza'],
  ['\u{1F382}', 'Cake'], ['❤️', 'Heart'], ['\u{1F642}', 'Smiley'], ['\u{1F916}', 'Robot'],
  ['\u{1F3A9}', 'Hat'], ['\u{1F453}', 'Glasses'], ['\u{1F527}', 'Spanner'], ['\u{1F385}', 'Santa'],
  ['\u{1F44D}', 'Thumbs up'], ['☂️', 'Umbrella'], ['⌛', 'Hourglass'], ['⏰', 'Clock'],
  ['\u{1F381}', 'Gift'], ['\u{1F4A1}', 'Light bulb'], ['\u{1F4D5}', 'Book'], ['✏️', 'Pencil'],
  ['\u{1F4CE}', 'Paperclip'], ['✂️', 'Scissors'], ['\u{1F512}', 'Lock'], ['\u{1F511}', 'Key'],
  ['\u{1F528}', 'Hammer'], ['☎️', 'Telephone'], ['\u{1F3C1}', 'Flag'], ['\u{1F682}', 'Train'],
  ['\u{1F6B2}', 'Bicycle'], ['✈️', 'Aeroplane'], ['\u{1F680}', 'Rocket'], ['\u{1F3C6}', 'Trophy'],
  ['⚽', 'Ball'], ['\u{1F3B8}', 'Guitar'], ['\u{1F3BA}', 'Trumpet'], ['\u{1F514}', 'Bell'],
  ['⚓', 'Anchor'], ['\u{1F3A7}', 'Headphones'], ['\u{1F4C1}', 'Folder'], ['\u{1F4CC}', 'Pin'],
];

export const VERIFY_TIMEOUT = 5 * 60 * 1000;

/// Six bytes in, seven emoji out; the last two bits are dropped.
export function emojiFor(bytes) {
  let bits = 0n;
  for (let i = 0; i < 6; i += 1) bits = (bits << 8n) | BigInt(bytes[i] ?? 0);
  const out = [];
  for (let i = 0; i < 7; i += 1) {
    out.push(SAS_EMOJI[Number((bits >> BigInt(42 - 6 * (i + 1))) & 0x3fn)]);
  }
  return out;
}

function concat(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function sasStartPayload(payload) {
  return te.encode(JSON.stringify([
    'telium-sas-start:v1',
    payload?.txn || null,
    payload?.step || null,
    payload?.from || null,
    payload?.pk || null,
  ]));
}

function sasIdentityPayload(txn, transcript, userId, deviceId, identityKey, mlsKey) {
  return te.encode(JSON.stringify([
    'telium-sas-identity:v1',
    txn,
    transcript,
    userId,
    deviceId,
    identityKey,
    mlsKey || null,
  ]));
}

const STEPS = ['start', 'accept', 'key', 'reveal', 'mac', 'secret', 'done', 'cancel'];

/// `initiator` decides who commits and who reveals. Order: start, accept (commitment), key (nonce), reveal; then emoji, then a MAC each way.
export class Verification {
  constructor(trust, { peerUser, peerDevice = null, initiator, txn, send, mlsKey = null }) {
    this.trust = trust;
    this.peerUser = peerUser;
    this.peerDevice = peerDevice;
    this.initiator = initiator;
    this.txn = txn;
    this.send = send;
    this.mlsKey = mlsKey;
    this.state = 'pending';
    this.emoji = [];
    this.reason = null;
    this.peerKeys = null;
    this.startedAt = Date.now();
    this.confirmed = false;
    this.pendingSecret = null;

    this.ephemeral = null;
    this.nonce = null;
    this.enc = null;
    this.secret = null;
    this.commitment = null;
    this.startFrame = null;
    this.prk = null;
  }

  get isSelf() { return this.peerUser === this.trust.userId; }

  get identity() { return `${this.trust.userId}|${this.trust.deviceId}`; }

  get peerIdentity() { return `${this.peerUser}|${this.peerDevice}`; }

  get live() { return this.state !== 'done' && this.state !== 'cancelled'; }

  /// With no device named it goes to all the peer's devices; the first to answer takes the exchange.
  async begin() {
    const pair = await this.trust.cs.hpke.generateKeyPair();
    this.ephemeral = pair;
    this.startFrame = {
      txn: this.txn,
      step: 'start',
      from: this.identity,
      pk: b64(await this.trust.cs.hpke.exportPublicKey(pair.publicKey)),
    };
    await this.send(this.startFrame, this.peerDevice);
    return this;
  }

  cancel(reason = 'cancelled') {
    if (!this.live) return;
    this.state = 'cancelled';
    this.reason = reason;
    this.send({ txn: this.txn, step: 'cancel', reason }, this.peerDevice).catch(() => {});
  }

  /// Nothing is written until the MAC exchange.
  async confirm() {
    if (this.state !== 'compare') return;
    this.confirmed = true;
    this.state = 'waiting';
    await this.sendMac();
    await this.settle();
  }

  async handle(envelope) {
    const payload = envelope.payload || {};
    if (payload.txn !== this.txn || !STEPS.includes(payload.step)) return false;
    if (envelope.from_user !== this.peerUser) return false;
    // After the first answer the exchange belongs to one device.
    if (this.peerDevice && envelope.from_device !== this.peerDevice) return false;
    if (this.live && Date.now() - this.startedAt > VERIFY_TIMEOUT) {
      this.cancel('timed out');
      return true;
    }

    switch (payload.step) {
      case 'start': return this.onStart(envelope, payload);
      case 'accept': return this.onAccept(envelope, payload);
      case 'key': return this.onKey(payload);
      case 'reveal': return this.onReveal(payload);
      case 'mac': return this.onMac(payload);
      case 'secret': return this.onSecret(payload);
      case 'done': return this.settle();
      case 'cancel':
        if (this.live) {
          this.state = 'cancelled';
          this.reason = payload.reason || 'the other device cancelled';
        }
        return true;
      default: return false;
    }
  }

  async onStart(envelope, payload) {
    if (this.initiator || this.startFrame) return false;
    this.peerDevice = envelope.from_device;
    if (payload.from !== this.peerIdentity) {
      this.cancel('the other device identified itself inconsistently');
      return true;
    }
    this.startFrame = payload;
    const peerPublic = await this.trust.cs.hpke.importPublicKey(unb64(payload.pk));
    const exported = await this.trust.cs.hpke.exportSecret(
      peerPublic, te.encode('telium-sas-kem:v1'), 32, te.encode(this.txn),
    );
    this.enc = exported.enc;
    this.secret = exported.secret;
    // Commit before the initiator's nonce is on the wire; commit to the semantic start frame, since a homeserver may re-serialize JSON.
    this.commitment = b64(await this.trust.cs.hash.digest(
      concat(this.enc, sasStartPayload(payload)),
    ));
    await this.send({ txn: this.txn, step: 'accept', commitment: this.commitment }, this.peerDevice);
    return true;
  }

  async onAccept(envelope, payload) {
    if (!this.initiator || this.nonce) return false;
    this.peerDevice = envelope.from_device;
    this.commitment = payload.commitment;
    this.nonce = this.trust.cs.rng.randomBytes(32);
    await this.send({ txn: this.txn, step: 'key', nonce: b64(this.nonce) }, this.peerDevice);
    return true;
  }

  async onKey(payload) {
    if (this.initiator || this.nonce) return false;
    this.nonce = unb64(payload.nonce);
    await this.send({ txn: this.txn, step: 'reveal', enc: b64(this.enc) }, this.peerDevice);
    await this.derive();
    return true;
  }

  async onReveal(payload) {
    if (!this.initiator || this.enc) return false;
    const enc = unb64(payload.enc);
    const opened = b64(await this.trust.cs.hash.digest(
      concat(enc, sasStartPayload(this.startFrame)),
    ));
    if (opened !== this.commitment) {
      this.cancel('the other device changed its answer');
      return true;
    }
    this.enc = enc;
    this.secret = await this.trust.cs.hpke.importSecret(
      this.ephemeral.privateKey, te.encode('telium-sas-kem:v1'), enc, 32, te.encode(this.txn),
    );
    await this.derive();
    return true;
  }

  /// Names both ends and every chosen value, so a relayed handshake yields different emoji per leg.
  transcript() {
    const a = this.initiator ? this.identity : this.peerIdentity;
    const b = this.initiator ? this.peerIdentity : this.identity;
    return JSON.stringify([a, b, this.startFrame.pk, b64(this.nonce), b64(this.enc)]);
  }

  async derive() {
    const { kdf } = this.trust.cs;
    this.prk = await kdf.extract(this.nonce, this.secret);
    const bytes = await kdf.expand(this.prk, te.encode(`telium-sas:v1|${this.transcript()}`), 6);
    this.emoji = emojiFor(bytes);
    this.state = 'compare';
  }

  macKeyFor(identity) {
    return this.trust.cs.kdf.expand(
      this.prk, te.encode(`telium-sas-mac:v1|${identity}|${this.transcript()}`), 32,
    );
  }

  async claim() {
    const identityKey = this.trust.identityKey ? b64(this.trust.identityKey) : null;
    const identityProof = identityKey && this.trust.canSign
      ? b64(await this.trust.cs.signature.sign(
        this.trust.signKey,
        sasIdentityPayload(
          this.txn,
          this.transcript(),
          this.trust.userId,
          this.trust.deviceId,
          identityKey,
          this.mlsKey,
        ),
      ))
      : null;
    return JSON.stringify({
      user: this.trust.userId,
      device: this.trust.deviceId,
      identity_key: identityKey,
      // The MAC proves liveness; this signature proves account authority.
      identity_proof: identityProof,
      can_sign: !!this.trust.canSign,
      can_recover: !!this.trust.recovery?.key,
      mls_key: this.mlsKey,
    });
  }

  async sendMac() {
    const content = await this.claim();
    const mac = b64(await this.trust.cs.hash.mac(
      await this.macKeyFor(this.identity), te.encode(content),
    ));
    await this.send({ txn: this.txn, step: 'mac', content, mac }, this.peerDevice);
  }

  async onMac(payload) {
    const ok = await this.trust.cs.hash.verifyMac(
      await this.macKeyFor(this.peerIdentity), unb64(payload.mac), te.encode(payload.content),
    );
    if (!ok) {
      this.cancel('the other device could not prove its keys');
      return true;
    }
    let claimed;
    try { claimed = JSON.parse(payload.content); }
    catch {
      this.cancel('the other device sent a malformed key claim');
      return true;
    }
    if (claimed.user !== this.peerUser || claimed.device !== this.peerDevice) {
      this.cancel('the other device attested to keys that are not its own');
      return true;
    }

    let identityProofValid = false;
    if (claimed.identity_key && claimed.identity_proof) {
      try {
        identityProofValid = await this.trust.cs.signature.verify(
          unb64(claimed.identity_key),
          sasIdentityPayload(
            this.txn,
            this.transcript(),
            claimed.user,
            claimed.device,
            claimed.identity_key,
            claimed.mls_key,
          ),
          unb64(claimed.identity_proof),
        ).catch(() => false);
      } catch {
        identityProofValid = false;
      }
    }
    if (claimed.can_sign && !identityProofValid) {
      this.cancel('the other device could not prove its account signing key');
      return true;
    }
    if (!this.isSelf && claimed.identity_key && !identityProofValid) {
      this.cancel('the other device does not hold the account identity it asked you to verify');
      return true;
    }

    this.peerKeys = { ...claimed, identity_proof_valid: identityProofValid };
    await this.settle();
    return true;
  }

  async settle() {
    if (!this.live || !this.confirmed || !this.peerKeys) return true;
    try {
      if (this.isSelf) {
        // Neither end holds the account key; say so rather than show a green tick.
        const mineCanHelp = this.trust.canSign || !!this.trust.recovery?.key;
        const peerCanHelp = this.peerKeys.can_sign || this.peerKeys.can_recover;
        if (!mineCanHelp && !peerCanHelp && !this.pendingSecret) {
          this.state = 'cancelled';
          this.reason = 'neither device holds this account\'s encrypted-DM recovery material yet';
          return true;
        }
        if (this.trust.canSign && this.peerKeys.mls_key) {
          await this.trust.vouchForOwnDevice(this.peerDevice, this.peerKeys.mls_key);
        }
        if (mineCanHelp && (!this.peerKeys.can_sign || !this.peerKeys.can_recover)) {
          await this.handOverSecret();
        }
        if (this.pendingSecret) await this.onSecret(this.pendingSecret);
      } else {
        if (!this.peerKeys.identity_key || !this.peerKeys.identity_proof_valid) {
          this.state = 'cancelled';
          this.reason = 'the other account did not prove an account identity key';
          return true;
        }
        await this.trust.vouchForUser(this.peerUser, this.peerKeys.identity_key);
      }
    } catch (e) {
      this.state = 'cancelled';
      this.reason = e.message || 'could not record the result';
      return true;
    }
    this.state = 'done';
    this.send({ txn: this.txn, step: 'done' }, this.peerDevice).catch(() => {});
    return true;
  }

  /// Derived from the same material as the emoji.
  wrapKey() {
    // vault.seal/open take the raw key, avoiding a SubtleCrypto import (needs a secure origin).
    return this.trust.cs.kdf
      .expand(this.prk, te.encode(`telium-sas-secret:v1|${this.transcript()}`), 32);
  }

  async handOverSecret() {
    const key = await this.wrapKey();
    await this.send({
      txn: this.txn,
      step: 'secret',
      identity_key: this.trust.identityKey ? b64(this.trust.identityKey) : null,
      sealed: this.trust.signKey ? await seal(key, this.trust.signKey) : null,
      sealed_recovery: this.trust.recovery?.key
        ? await seal(key, encodeRecoveryTransfer(this.trust.recovery))
        : null,
    }, this.peerDevice);
  }

  async onSecret(payload) {
    if (!this.isSelf) return false;
    // The handover can arrive before our own half finishes; hold it.
    if (!this.confirmed || !this.peerKeys) {
      this.pendingSecret = payload;
      return false;
    }
    this.pendingSecret = null;
    const key = await this.wrapKey();

    if (!this.trust.canSign && payload.sealed) {
      await this.trust.adoptSecret(
        await unseal(key, payload.sealed),
        payload.identity_key,
      );
    }

    if (!this.trust.recovery?.key && payload.sealed_recovery) {
      this.trust.recovery = decodeRecoveryTransfer(
        await unseal(key, payload.sealed_recovery),
        'device_custody',
      );
      await this.trust.onRecoveryAdopted?.(this.trust.recovery);
    }

    if (this.trust.canSign && this.mlsKey) {
      await this.trust.vouchForOwnDevice(this.trust.deviceId, this.mlsKey);
    }
    return true;
  }
}
