// MLS (RFC 9420) for DMs: one group per conversation, one signature identity per device. Frames are processed in sequencer order (`sync` stops at the first unhandleable frame), and a sender can't decrypt its own PrivateMessage, so outgoing plaintext is kept by frame id. Typing is NOT encrypted: it is a plaintext gateway event.

import {
  createApplicationMessage, createCommit, createGroup, createProposal,
  createGroupInfoWithExternalPubAndRatchetTree, decodeGroupState, decodeMlsMessage,
  defaultLifetime, emptyPskIndex, encodeGroupState, encodeMlsMessage,
  generateKeyPackage, generateKeyPackageWithKey, getCiphersuiteFromName, getCiphersuiteImpl,
  joinGroup, joinGroupExternal, mlsExporter, processMessage,
} from 'ts-mls';
import { defaultClientConfig } from 'ts-mls/clientConfig.js';
import { decryptSenderData } from 'ts-mls/privateMessage.js';
import { ratchetTreeFromExtension } from 'ts-mls/groupInfo.js';
import { rejoinBody, rejoinKey } from './rejoin.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { open, seal } from './vault.js';
import { frameIdOf } from './frame-id.js';
import {
  dmNotificationId,
  sealDmNotificationHints,
} from './dm-notification-hints.js';
import {
  GROUPS, IDENTITY, OPENED, PACKAGES, all, del, exclusive, get, put, rows,
} from './mls-store.js';
import {
  CALL_SFU, DELETE, DELIVERED, EDIT, MESSAGE, PIN, REACTION, RECEIPT, TYPING,
  decodeBody, decodeMessage, encode64, encodeBody, pack, unpack, wire,
} from './mls-wire.js';
import {
  capabilities, clientsInTree, externalJoiner, externalJoinerKey, identityOf, isPolicyExtension,
  judgeCommit, leafIdentity, leafSignatureKey, leavesMissingPolicySupport, leavesOf,
  normalisePolicy, policyAllows, policyExtension, policyIn, sameBytes, samePolicy,
  supportsPolicy, usersInTree,
} from './mls-policy.js';

export { keepSecret, heldSecret, wipe, wipeScope } from './mls-store.js';
export { POLICY_RULES, POLICY_EXTENSION, normalisePolicy, policyAllows, judgeCommit } from './mls-policy.js';
export { encodeBody, decodeBody } from './mls-wire.js';
export { capabilities, decodeMessage, encode64, identityOf, wire };

/// The mandatory-to-implement ciphersuite.
const SUITE = 'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519';

/// Spare KeyPackages kept on the home server; each starts one conversation.
const STOCK = 12;

/// Paging limits for `catchUpTo` and `ownGroupInfoFrames`.
const HISTORY_PAGE = 500;
const HISTORY_PAGES = 40;

/// Keyed by account alone, not `userId|deviceId`: the server mints a device id per session, which orphaned state on re-login.
const SCOPE_MIGRATION = 1;

// Short so they can't collide with frame ids.
const RX = 'rx';
const CX = 'cx';

/// A number so it can't collide with a body.
const SIGNAL = 1;

const te = new TextEncoder();
const td = new TextDecoder();

function contiguousFrom(frames, through) {
  const sorted = [...frames].sort((a, b) => (a.seq || 0) - (b.seq || 0));
  const run = [];
  let next = through + 1;
  for (const frame of sorted) {
    if ((frame.seq || 0) < next) continue;
    if (frame.seq !== next) break;
    run.push(frame);
    next += 1;
  }
  return run;
}

/// A floor under the conversation's epoch.
function highestCommitEpoch(frames) {
  let high = -1;
  for (const f of frames || []) {
    if (f?.kind === 'commit' && Number.isFinite(Number(f.epoch))) high = Math.max(high, Number(f.epoch));
  }
  return high;
}

/// Compared only for equality, to detect another tab's write.
function newStamp() {
  return encode64(crypto.getRandomValues(new Uint8Array(12)));
}

/// Snapshot for devices that can't open the pinned frame.
const SNIPPET_MAX = 200;

/// Every member dials it.
function validSfu(text) {
  if (typeof text !== 'string' || !text || text.length > 512) return false;
  try {
    const url = new URL(text);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

/// ULIDs, so string order is time order.
function furthest(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return b > a ? b : a;
}

export class Mls {
  constructor(home, { userId, deviceId, recoveryKey = null, backup = null }) {
    this.home = home;
    this.userId = userId;
    this.deviceId = deviceId;
    // `identity` is the wire credential (fresh per session); `scope` keys on-disk rows by account so a re-login finds its history (issue #71).
    this.identity = `${userId}|${deviceId}`;
    this.scope = userId;
    // Device ids this profile has signed in from; their echoed frames are our own sends and must be stepped over.
    this.ownDevices = new Set([deviceId]);
    // Cached; authoritative version of `ownDevices` (see `ownSignatureKey`).
    this.ownLeafKey = undefined;
    // Opens our own GroupInfo frames to rejoin. Null (vault locked) leaves existing DMs working but new ones unreadable.
    this.recoveryKey = recoveryKey;
    // Newest first: writes use the head, reads try all (custody switch retires keys).
    this.openers = recoveryKey ? [recoveryKey] : [];
    // Mirror for opened bodies (lib/backup.js); null means history is lost at next sign-in.
    this.backup = backup;
    this.mirrored = new Set();
    this.published = new Map();
    this.rejoins = new Map();
    this.departed = new Map();
    // Newest GroupInfo the sequencer rejected as behind; `selfJoin` stops offering it.
    this.staleJoins = new Map();
    this.leftAt = new Map();
    this.cs = null;
    // Admission hook from Store/Trust: false rejects, null means legacy identity with no root, throwing fails closed.
    this.verifyClaimedPackage = null;
    // Revocation hook: `(userId, keyB64)`, synchronous.
    this.isRevokedKey = null;
    this.groups = new Map();
    this.joining = new Map();
    // Stamp of the row as this tab last saw it; a change means another tab advanced the ratchet (`adopt`).
    this.stamps = new Map();
    this.writes = new Set();
    // Distinguishes "no group" from "not looked yet" (`settled`).
    this.looked = new Set();
    // MLS deletes keys as it ratchets, so a frame opens exactly once; this local copy is the only history, and sign-out removes it.
    this.plaintext = new Map();
    this.failed = new Map();
    this.chains = new Map();
    // Short-lived, to avoid key-discovery storms.
    this.notificationKeys = new Map();

    // Signals are watermarks ("up to this frame"), not per-message events.
    this.signals = new Set();
    // Read by the notification path (`payloadTypeOf`).
    this.signalKinds = new Map();
    this.marks = new Map();
    this.typists = new Map();
    this.watermarks = new Map();
    // Delivery acks are per device (`applyAck`).
    this.acks = new Map();
    // Acks are positions, compared by sequencer seq.
    this.seqOf = new Map();
    // Kept because the frames are opened once.
    this.reactions = new Map();
    // Folds of edit/delete/pin signals, kept because their frames are opened once.
    this.edits = new Map();
    this.tombstones = new Map();
    // Kept apart so a refused delete can restore the plaintext.
    this.outgoing = new Map();
    this.pins = new Map();
    // Set by any member and known only to the group.
    this.callSfus = new Map();
    // Edit/delete are author-only.
    this.authors = new Map();
    this.stateRead = new Set();
    // Store-owned settings; they govern what is kept as well as sent.
    this.sendsRead = () => false;
    this.sendsDelivered = () => true;
  }

  get ready() { return this.cs !== null; }

  /// Separate from the constructor so failure degrades to "DMs unavailable" instead of failing sign-in.
  async start() {
    this.cs = await getCiphersuiteImpl(getCiphersuiteFromName(SUITE));
    await this.migrateScope().catch(() => {});
    await this.rememberOwnDevices().catch(() => {});
    await this.replenish().catch(() => {});
    // Retired keys mean custody was rotated; refresh group epochs once.
    if (this.recoveryKey && this.openers.length > 1) {
      await this.refreshRecoveryEpochs().catch(() => {});
    }
    await this.catchUpGroupInfo().catch(() => {});
  }

  /// Groups made before the key arrived got no GroupInfo and nothing goes back for them, so the next sign-in would wait on a device that no longer exists.
  async adoptRecoveryKey(keyring) {
    const key = keyring?.key || null;
    if (!key) return { rotated: false, failures: [] };
    const previous = this.recoveryKey;
    const rotated = !!previous && (
      previous.length !== key.length
      || previous.some((byte, i) => byte !== key[i])
    );
    this.recoveryKey = key;
    this.openers = keyring.openers?.length ? [...keyring.openers] : [key];
    if (this.backup) this.backup.rekey(keyring);

    let failures = [];
    if (this.cs && rotated) {
      // Re-sealing at the same epoch is not revocation (old escrow could open old GroupInfo), so advance every group with an empty Commit first.
      failures = await this.refreshRecoveryEpochs();
    }
    if (this.cs) await this.catchUpGroupInfo().catch(() => {});
    return { rotated, failures };
  }

  recoveryKeyId() {
    return this.recoveryKey ? encode64(sha256(this.recoveryKey)) : null;
  }

  /// Via an empty Commit (RFC 9420 allows it) so the old GroupInfo stops being valid.
  async refreshRecoveryEpochs() {
    if (!this.recoveryKey || !this.cs) return [];
    const current = this.recoveryKeyId();
    const prefix = `${this.scope}:`;
    const failures = [];

    for (const [key] of await rows(GROUPS).catch(() => [])) {
      if (typeof key !== 'string' || !key.startsWith(prefix)) continue;
      const conversationId = key.slice(prefix.length);
      try {
        await this.run(conversationId, async () => {
          let entry = await this.loadGroup(conversationId);
          entry = await this.settlePending(conversationId, entry);
          if (!entry || entry.recoveryKeyId === current) return;

          const commit = await createCommit(
            { state: entry.state, cipherSuite: this.cs },
            { extraProposals: [], ratchetTreeExtension: true },
          );
          const epoch = Number(commit.newState.groupContext.epoch);

          // Pending, sent, then taken (`sendCommit`), so failure strands neither ahead nor behind.
          await this.sendCommit(conversationId, entry, {
            kind: 'commit',
            ciphertext: encode64(encodeMlsMessage(commit.commit)),
            epoch,
          }, commit.newState, { recoveryKeyId: null });
          await this.publishGroupInfo(conversationId, this.groups.get(conversationId).state);
        });
      } catch (error) {
        failures.push({ conversationId, error });
        console.warn('could not rotate DM recovery epoch', conversationId, error);
      }
    }
    return failures;
  }

  async catchUpGroupInfo() {
    if (!this.recoveryKey) return;
    const prefix = `${this.scope}:`;
    for (const [key] of await rows(GROUPS).catch(() => [])) {
      if (typeof key !== 'string' || !key.startsWith(prefix)) continue;
      const conversationId = key.slice(prefix.length);
      try {
        const entry = await this.loadGroup(conversationId);
        if (entry) await this.publishGroupInfo(conversationId, entry.state);
      } catch { /* one conversation that cannot publish is not the others' */ }
    }
  }

  /// Filed under the account scope so re-logins are the same correspondent.
  async signatureKeyPair() {
    const stored = await get(IDENTITY, this.scope);
    if (stored) {
      return { signKey: new Uint8Array(stored.signKey), publicKey: new Uint8Array(stored.publicKey) };
    }
    // ts-mls has no standalone keygen; generate a package and keep its key.
    const first = await generateKeyPackage(this.credential(), capabilities(), defaultLifetime, [], this.cs);
    const pair = {
      signKey: first.privatePackage.signaturePrivateKey,
      publicKey: first.publicPackage.leafNode.signaturePublicKey,
    };
    await put(IDENTITY, this.scope, {
      signKey: pair.signKey, publicKey: pair.publicKey, created_at: Date.now(),
    });
    await this.stash(first);
    await this.home.publishKeyPackages([encode64(wire.keyPackage(first.publicPackage))]);
    return pair;
  }

  async leafKey() {
    return encode64((await this.signatureKeyPair()).publicKey);
  }

  credential() {
    return { credentialType: 'basic', identity: te.encode(this.identity) };
  }

  /// Account scope, never device id or conversation alone (see `all`).
  key(conversationId) { return `${this.scope}:${conversationId}`; }

  /// Under the account so a later session can open a Welcome addressed to it.
  async stash({ publicPackage, privatePackage }, extra = {}) {
    const key = `${this.scope}:${encode64(publicPackage.leafNode.hpkePublicKey)}`;
    await put(PACKAGES, key, {
      ...extra,
      created_at: Date.now(),
      publicPackage: wire.keyPackage(publicPackage),
      privatePackage,
    });
    return key;
  }

  /// Keeps one last-resort package, handed out only when the one-time ones run out.
  async replenish() {
    const status = await this.home.keyPackages();
    const mine = (status.devices || []).find((d) => d.device_id === this.deviceId);
    const have = mine?.available ?? 0;
    const needsLastResort = !mine?.last_resort;
    if (have >= STOCK && !needsLastResort) return 0;

    const pair = await this.signatureKeyPair();
    const generate = async (extra = {}) => {
      const generated = await generateKeyPackageWithKey(
        this.credential(), capabilities(), defaultLifetime, [], pair, this.cs,
      );
      await this.stash(generated, extra);
      return encode64(wire.keyPackage(generated.publicPackage));
    };
    const fresh = [];
    for (let i = have; i < STOCK; i += 1) fresh.push(await generate());
    const lastResort = needsLastResort ? await generate({ lastResort: true }) : null;
    if (fresh.length || lastResort) await this.home.publishKeyPackages(fresh, lastResort);
    return fresh.length;
  }

  /// One at a time; failures wait for the next.
  topUpSoon() {
    if (this.toppingUp) return this.toppingUp;
    this.toppingUp = Promise.resolve()
      .then(() => this.replenish())
      .catch(() => 0)
      .finally(() => { this.toppingUp = null; });
    return this.toppingUp;
  }

  /// Once per account. Copies without overwriting, so the current layout wins; only keys with this session's `${userId}|` prefix.
  async migrateScope() {
    const marker = `scope-migration:${this.scope}`;
    const done = await get(IDENTITY, marker).catch(() => null);
    if (done?.v === SCOPE_MIGRATION) return;

    // Pair has no suffix; rx/cx keys carry their marker first; the rest are `${dev}:${tail}`.
    const legacy = `${this.scope}|`;
    for (const store of [IDENTITY, PACKAGES, GROUPS, OPENED]) {
      for (const [key, value] of await rows(store).catch(() => [])) {
        if (typeof key !== 'string' || !key.startsWith(legacy)) continue;
        const rest = key.slice(legacy.length);
        let target;
        if (!rest.includes(':')) target = this.scope;
        else if (rest.startsWith('rx:') || rest.startsWith('cx:')) {
          target = `${this.scope}:${rest}`;
        } else target = `${this.scope}:${rest.slice(rest.indexOf(':') + 1)}`;
        if ((await get(store, target).catch(() => undefined)) !== undefined) continue;
        await put(store, target, value);
      }
    }
    await put(IDENTITY, marker, { v: SCOPE_MIGRATION, at: Date.now() });
  }

  /// For `isMine`, which must recognise echoes of any past session's sends.
  async rememberOwnDevices() {
    await this.mergeOwnDevices(this.deviceId);
  }

  /// Under a lock: read-then-write across tabs dropped ids, leaving frames the walk could not open.
  async mergeOwnDevices(...ids) {
    const fresh = ids.filter(Boolean);
    if (!fresh.length && this.ownDevices.size) return;
    await exclusive(`telium-mls:devices:${this.scope}`, async () => {
      const stored = await get(IDENTITY, `devices:${this.scope}`).catch(() => null);
      for (const id of stored?.ids || []) this.ownDevices.add(id);
      for (const id of fresh) this.ownDevices.add(id);
      const next = [...this.ownDevices].sort();
      const prev = stored?.ids || [];
      // Element-wise: swapping one id for another keeps the length.
      const changed = next.length !== prev.length
        || next.some((id, at) => id !== prev[at]);
      if (changed) {
        await put(IDENTITY, `devices:${this.scope}`, { ids: next }).catch(() => {});
      }
    });
  }

  /// Never true for other users.
  isMine(frame) {
    return frame.sender === this.userId
      && (frame.sender_device === this.deviceId || this.ownDevices.has(frame.sender_device));
  }

  async loadGroup(conversationId) {
    if (this.groups.has(conversationId)) return this.groups.get(conversationId);
    const row = await get(GROUPS, this.key(conversationId));
    this.looked.add(conversationId);
    this.stamps.set(conversationId, row?.stamp ?? null);
    this.joining.delete(conversationId);
    if (!row) return null;
    // An external join awaiting its answer (`selfJoin`); the walk resolves it.
    if (!row.state) {
      if (row.pending) this.joining.set(conversationId, row.pending);
      if (row.leftAt) this.leftAt.set(conversationId, row.leftAt);
      return null;
    }
    const decoded = decodeGroupState(new Uint8Array(row.state), 0);
    if (!decoded) return null;
    const current = Number(decoded[0].groupContext.epoch);
    // Client policy is configuration, not in the encoding.
    const entry = {
      state: { ...decoded[0], clientConfig: defaultClientConfig },
      lastSeq: row.lastSeq || 0,
      // Null if saved before generations.
      generation: Number.isInteger(row.generation) ? row.generation : null,
      // Persisted so sign-in doesn't republish a GroupInfo per conversation.
      published: row.published || 0,
      recoveryKeyId: row.recoveryKeyId || null,
      // Own unanswered commit; only one moving past the current epoch means anything.
      pending: row.pending && row.pending.epoch === current + 1 ? row.pending : null,
    };
    this.groups.set(conversationId, entry);
    return entry;
  }

  async saveGroup(conversationId, entry) {
    const stamp = newStamp();
    this.groups.set(conversationId, entry);
    this.stamps.set(conversationId, stamp);
    await put(GROUPS, this.key(conversationId), {
      state: encodeGroupState(entry.state),
      lastSeq: entry.lastSeq,
      generation: Number.isInteger(entry.generation) ? entry.generation : null,
      published: entry.published || 0,
      recoveryKeyId: entry.recoveryKeyId || null,
      pending: entry.pending || null,
      saved_at: Date.now(),
      stamp,
    });
  }

  // A commit's outcome can't be guessed: saved first and refused leaves us an epoch ahead; sent first and the answer lost leaves the sequencer at an epoch we discarded. So both are written down; ordered takes the new state, refused drops it, no answer keeps both and the next walk resends the same frame (recognised by frame id).

  /// `entry` is null for an external join.
  async recordPending(conversationId, entry, body, newState, extra = {}) {
    const frameId = frameIdOf(body.ciphertext);
    const pending = {
      frameId,
      epoch: Number(body.epoch),
      body: { ...body, frame_id: frameId },
      state: encodeGroupState(newState),
      ...extra,
    };
    if (entry) {
      entry.pending = pending;
      await this.saveGroup(conversationId, entry);
    } else {
      const stamp = newStamp();
      this.joining.set(conversationId, pending);
      this.stamps.set(conversationId, stamp);
      await put(GROUPS, this.key(conversationId), {
        state: null, lastSeq: 0, pending, saved_at: Date.now(), stamp,
      });
    }
    return pending;
  }

  pendingEntry(entry, pending, lastSeq) {
    const decoded = decodeGroupState(new Uint8Array(pending.state), 0);
    if (!decoded) throw new Error('a pending commit could not be read back');
    return {
      state: { ...decoded[0], clientConfig: defaultClientConfig },
      lastSeq,
      generation: Number.isInteger(entry?.generation) ? entry.generation : null,
      published: 0,
      recoveryKeyId: pending.recoveryKeyId !== undefined
        ? pending.recoveryKeyId
        : (entry?.recoveryKeyId || null),
      pending: null,
    };
  }

  /// `won` (ordered), `lost` (refused) or `unknown`. `epoch_conflict` is definite (frame id looked up first). A plain 409 from an old sequencer is definite on a first send but not a `resend`; `try_again` and server errors say nothing.
  pendingOutcome(error, pending, { resend = false } = {}) {
    const status = error?.status;
    if (typeof status !== 'number') return 'unknown';
    if (status >= 500 || status === 408 || status === 425 || status === 429) return 'unknown';
    if (status === 409) {
      const body = error.body || {};
      if (body.code === 'epoch_conflict') {
        if (body.winner_digest === pending.frameId || body.winner_frame_id === pending.frameId) {
          return 'won';
        }
        return 'lost';
      }
      // The id belongs to a different frame.
      if (body.code === 'frame_id_reused') return 'lost';
      if (body.code === 'try_again') return 'unknown';
      return resend ? 'unknown' : 'lost';
    }
    return 'lost';
  }

  /// Throws if refused or unanswered (then it stays pending).
  async sendCommit(conversationId, entry, body, newState, extra = {}) {
    const pending = await this.recordPending(conversationId, entry, body, newState, extra);
    let answer;
    try {
      answer = await this.home.sendFrame(conversationId, this.stamped(conversationId, pending.body));
    } catch (e) {
      const outcome = this.pendingOutcome(e, pending);
      if (outcome === 'won') {
        await this.takePending(conversationId, entry, pending, entry ? entry.lastSeq : (pending.lastSeq || 0));
        return null;
      }
      if (outcome === 'lost') await this.dropPending(conversationId, entry);
      throw e;
    }
    await this.takePending(conversationId, entry, pending, entry ? entry.lastSeq : (pending.lastSeq || 0));
    return answer;
  }

  async takePending(conversationId, entry, pending, lastSeq) {
    const next = this.pendingEntry(entry, pending, lastSeq);
    this.published.delete(conversationId);
    await this.saveGroup(conversationId, next);
    this.joining.delete(conversationId);
    return next;
  }

  async dropPending(conversationId, entry) {
    if (entry) {
      entry.pending = null;
      await this.saveGroup(conversationId, entry);
    } else {
      this.joining.delete(conversationId);
      await this.forget(conversationId);
    }
  }

  /// Throws without an answer, since nothing may be built on an unknown epoch.
  async settlePending(conversationId, entry) {
    const pending = entry ? entry.pending : this.joining.get(conversationId);
    if (!pending) return entry;
    let answer;
    try {
      answer = await this.home.sendFrame(conversationId, this.stamped(conversationId, pending.body));
    } catch (e) {
      const outcome = this.pendingOutcome(e, pending, { resend: true });
      if (outcome === 'won') {
        return this.takePending(conversationId, entry, pending, entry ? entry.lastSeq : (pending.lastSeq || 0));
      }
      if (outcome === 'lost') {
        await this.dropPending(conversationId, entry);
        return entry;
      }
      throw e;
    }
    const next = await this.takePending(
      conversationId, entry, pending, entry ? entry.lastSeq : (pending.lastSeq || 0),
    );
    await this.sendWelcomeIfMissing(conversationId, pending.body, answer);
    return next;
  }

  /// An older sequencer ignores the in-request Welcome, so send it separately.
  async sendWelcomeIfMissing(conversationId, body, answer) {
    if (!body?.welcome || !answer || answer.welcome || answer.replayed) return;
    await this.home.sendFrame(conversationId, this.stamped(conversationId, {
      kind: 'welcome', ciphertext: body.welcome, epoch: body.epoch,
    }));
  }

  /// The sequencer refuses stale generations (`generation_conflict`). Unknown generations and rejoins stay unstamped.
  stamped(conversationId, body) {
    if (body.generation !== undefined || body.kind === 'rejoin') return body;
    const generation = this.groups.get(conversationId)?.generation;
    return Number.isInteger(generation) ? { ...body, generation } : body;
  }

  /// So a refused start-over leaves the old group.
  async install(conversationId, entry) {
    return this.run(conversationId, async () => {
      this.published.delete(conversationId);
      this.failed.delete(conversationId);
      await this.saveGroup(conversationId, {
        state: entry.state,
        lastSeq: entry.lastSeq || 0,
        generation: Number.isInteger(entry.generation) ? entry.generation : null,
        published: 0,
        recoveryKeyId: null,
        pending: null,
      });
      await this.publishGroupInfo(conversationId, entry.state);
    });
  }

  /// `leftAt` is kept as a stateless row so being added back doesn't replay the old Welcome and stall at the removing commit.
  async forget(conversationId, { leftAt = 0 } = {}) {
    this.groups.delete(conversationId);
    this.stamps.set(conversationId, null);
    if (leftAt > 0) {
      this.leftAt.set(conversationId, leftAt);
      await put(GROUPS, this.key(conversationId), { state: null, leftAt }).catch(() => {});
    } else {
      this.leftAt.delete(conversationId);
      await del(GROUPS, this.key(conversationId)).catch(() => {});
    }
  }

  /// A stale ratchet encrypts under a spent generation. A missing or unreadable row is not newer state, so memory is kept.
  async adopt(conversationId) {
    if (!this.stamps.has(conversationId)) return;
    const row = await get(GROUPS, this.key(conversationId)).catch(() => undefined);
    if (!row || (row.stamp ?? null) === this.stamps.get(conversationId)) return;
    this.groups.delete(conversationId);
    this.stamps.delete(conversationId);
    // An error from the old copy says nothing about the new one.
    this.failed.delete(conversationId);
    // Reload now: until then `joined` says no and the store would mistake the new group for none.
    await this.loadGroup(conversationId).catch(() => null);
    if (this.stateRead.has(conversationId)) {
      for (const folds of [this.reactions, this.edits, this.tombstones, this.pins, this.callSfus]) {
        folds.delete(conversationId);
      }
      await this.readFolds(conversationId);
    }
  }

  /// Flushed before the lock is released.
  track(write) {
    const held = write.catch(() => {}).finally(() => this.writes.delete(held));
    this.writes.add(held);
    return held;
  }

  async settle() {
    while (this.writes.size) await Promise.all([...this.writes]);
  }

  joined(conversationId) { return this.groups.has(conversationId); }

  /// Until then "not in the group" would be a false claim.
  settled(conversationId) {
    return this.groups.has(conversationId) || this.looked.has(conversationId);
  }

  /// Frames past it are untried, not unreadable.
  walkedTo(conversationId) {
    const entry = this.groups.get(conversationId);
    return entry ? entry.lastSeq || 0 : 0;
  }

  epochOf(conversationId) {
    const entry = this.groups.get(conversationId);
    return entry ? Number(entry.state.groupContext.epoch) : 0;
  }

  /// Per this device's own tree, not the server's member list.
  devicesIn(conversationId) {
    const entry = this.groups.get(conversationId);
    if (!entry) return [];
    const out = [];
    for (const node of entry.state.ratchetTree || []) {
      if (!node || node.nodeType !== 'leaf') continue;
      const credential = node.leaf?.credential;
      if (credential?.credentialType !== 'basic') continue;
      const [userId, deviceId] = td.decode(credential.identity).split('|');
      // Cross-signing signs this key, so trust is for the key, not the name.
      out.push({
        userId, deviceId, signatureKey: encode64(node.leaf.signaturePublicKey),
      });
    }
    return out;
  }

  /// A promise chain within the tab, a Web Lock across tabs; adopts another tab's saves first.
  run(conversationId, fn) {
    const previous = this.chains.get(conversationId) || Promise.resolve();
    const step = () => exclusive(`telium-mls:${this.scope}:${conversationId}`, async () => {
      await this.adopt(conversationId);
      try { return await fn(); } finally { await this.settle(); }
    });
    const next = previous.then(step, step);
    // A rejection must not stall the chain.
    this.chains.set(conversationId, next.catch(() => {}));
    return next;
  }

  /// Devices without stock come back as nulls. `held` is the leaf signature keys the commit already covers, so a commit never gets two leaves for one client (several device ids can share a key).
  async claim(userIds, held = null) {
    const packages = [];
    const missing = [];
    const rejected = [];
    const taken = new Set(held || []);
    for (const userId of new Set(userIds)) {
      const answer = await this.home.claimKeyPackages(userId);
      for (const entry of answer.key_packages || []) {
        // Our own device is already in the group; a second leaf is an invalid commit.
        if (userId === this.userId && entry.device_id === this.deviceId) continue;
        if (!entry.package) { missing.push(`${userId} (${entry.device_id})`); continue; }

        const message = decodeMessage(entry.package);
        if (message.wireformat !== 'mls_key_package') {
          rejected.push(`${userId} (${entry.device_id})`);
          continue;
        }

        // The server picks the row but can't rewrite the signed credential; bind the two so a package for one device can't be relabelled.
        const leaf = message.keyPackage?.leafNode;
        const credential = leaf?.credential;
        const claimedIdentity = credential?.credentialType === 'basic'
          ? td.decode(credential.identity)
          : null;
        if (
          claimedIdentity !== `${userId}|${entry.device_id}`
          || !leaf?.signaturePublicKey
        ) {
          rejected.push(`${userId} (${entry.device_id})`);
          continue;
        }

        // Read only after the credential is bound to the row.
        const signatureKey = encode64(leaf.signaturePublicKey);
        if (taken.has(signatureKey)) continue;

        if (this.verifyClaimedPackage) {
          const accepted = await this.verifyClaimedPackage(
            userId,
            entry.device_id,
            signatureKey,
          );
          if (accepted === false) {
            rejected.push(`${userId} (${entry.device_id})`);
            continue;
          }
        }
        // Recorded only on acceptance so a rejected package leaves the account's next device free.
        taken.add(signatureKey);
        packages.push(message.keyPackage);
      }
    }
    return { packages, missing, rejected };
  }

  /// The group id is the conversation id. `from` is the seq the group begins after (0 for new; the newest frame when starting over). `policy` goes in only if every added device supports the extension; the result says whether it did.
  async establish(conversationId, memberIds, {
    from = 0, policy = null, ifAbsent = false, generation = null, stage = false,
  } = {}) {
    return this.run(conversationId, async () => {
      // `ifAbsent`: another tab may have built the group while the caller waited.
      if (ifAbsent && await this.loadGroup(conversationId)) return null;
      // `generation` is the one replaced. `stage` builds without saving; the caller passes `entry` to `install` once the Welcome is ordered.
      const next = Number.isInteger(generation) ? generation + 1 : null;
      const keep = async (state) => {
        const entry = { state, lastSeq: from, generation: next };
        if (stage) return entry;
        await this.saveGroup(conversationId, entry);
        await this.publishGroupInfo(conversationId, state);
        return entry;
      };
      // New group, new epoch: clear the publish watermark and recorded failure.
      if (!stage) {
        this.published.delete(conversationId);
        this.failed.delete(conversationId);
      }
      const wanted = policy ? normalisePolicy({ v: 1, ...policy, creator: this.userId }) : null;
      if (policy && !wanted) throw new Error('that is not a membership policy this client understands');
      const pair = await this.signatureKeyPair();
      const self = await generateKeyPackageWithKey(
        this.credential(), capabilities(), defaultLifetime, [], pair, this.cs,
      );

      // Claimed first because policy placement depends on device support. Seed with our own key, since earlier sign-ins share it.
      const { packages, missing, rejected } = await this.claim(
        memberIds, [encode64(self.publicPackage.leafNode.signaturePublicKey)],
      );
      const placed = !!wanted && packages.every(supportsPolicy);
      let state = await createGroup(
        te.encode(conversationId), self.publicPackage, self.privatePackage,
        placed ? [policyExtension(wanted)] : [], this.cs,
      );
      if (!packages.length) {
        const entry = await keep(state);
        return { welcome: null, missing, rejected, policy: placed, ...(stage ? { entry } : {}) };
      }

      const commit = await createCommit({ state, cipherSuite: this.cs }, {
        extraProposals: packages.map((keyPackage) => ({ proposalType: 'add', add: { keyPackage } })),
        // Without it the Welcome carries no tree.
        ratchetTreeExtension: true,
      });
      state = commit.newState;
      const entry = await keep(state);
      return {
        welcome: commit.welcome ? encode64(wire.welcome(commit.welcome)) : null,
        epoch: Number(state.groupContext.epoch),
        missing,
        rejected,
        policy: placed,
        ...(stage ? { entry } : {}),
      };
    });
  }

  /// Once per epoch. Sealed under the recovery key because a readable one would let the homeserver add itself and read everything afterwards.
  async publishGroupInfo(conversationId, state) {
    if (!this.recoveryKey) return;
    const epoch = Number(state.groupContext.epoch);
    const recoveryKeyId = this.recoveryKeyId();
    if (this.published.get(conversationId) >= epoch) return;
    const held = this.groups.get(conversationId);
    if (held && held.published >= epoch && held.recoveryKeyId === recoveryKeyId) return;
    this.published.set(conversationId, epoch);
    try {
      const info = await createGroupInfoWithExternalPubAndRatchetTree(state, [], this.cs);
      const sealed = await seal(this.recoveryKey, wire.groupInfo(info));
      await this.home.sendFrame(conversationId, this.stamped(conversationId, { kind: 'groupinfo', ciphertext: sealed, epoch }));
      // Persist so the next sign-in knows this epoch is covered.
      const entry = this.groups.get(conversationId);
      if (entry) {
        entry.published = Math.max(entry.published || 0, epoch);
        entry.recoveryKeyId = recoveryKeyId;
        await this.saveGroup(conversationId, entry).catch(() => {});
      }
    } catch (e) {
      // Still usable; it just won't rescue the next device.
      this.published.delete(conversationId);
      console.warn('could not publish group info', e);
    }
  }

  /// Only our own frames are tried; others are sealed to their accounts.
  async newestGroupInfo(frames) {
    if (!this.recoveryKey) return null;
    const mine = frames
      .filter((f) => f.kind === 'groupinfo' && f.sender === this.userId)
      .sort((a, b) => (b.seq || 0) - (a.seq || 0));
    for (const frame of mine) {
      // A GroupInfo from before a custody switch is sealed under the retired key.
      for (const opener of this.openers) {
        try {
          const bytes = await open(opener, frame.ciphertext);
          const decoded = decodeMlsMessage(bytes, 0);
          if (decoded?.[0]?.groupInfo) return { info: decoded[0].groupInfo, seq: frame.seq || 0 };
        } catch { /* sealed to a key further down the ring, or to another account */ }
      }
    }
    return null;
  }

  /// Fetched, not taken from the on-screen window: a busy group can have its GroupInfo below it. Also returns how far the walk got, for `selfJoin`. Bounded.
  async ownGroupInfoFrames(conversationId) {
    if (!this.recoveryKey || !this.home.dmHistory) return { frames: [], through: 0, epoch: -1 };
    const frames = [];
    let through = 0;
    // Highest commit epoch seen, so `selfJoin` can detect a GroupInfo already moved past.
    let epoch = -1;
    for (let page = 0; page < HISTORY_PAGES; page += 1) {
      const answer = await this.home.dmHistory(
        conversationId, { after: through, limit: HISTORY_PAGE },
      );
      const got = answer?.messages || [];
      for (const frame of got) {
        if (frame.kind === 'groupinfo' && frame.sender === this.userId) frames.push(frame);
      }
      epoch = Math.max(epoch, highestCommitEpoch(got));
      through = got.reduce((max, f) => Math.max(max, f.seq || 0), through);
      // A hole is not the end: this is a search.
      if (answer?.incomplete && answer.missing_from > through) {
        through = answer.missing_from;
        continue;
      }
      if (!got.length || got.length < HISTORY_PAGE) break;
    }
    return { frames, through, epoch };
  }

  /// Via an external commit from a GroupInfo. A 409 means the GroupInfo was stale.
  async selfJoin(conversationId, frames) {
    return this.run(conversationId, async () => {
      if (await this.loadGroup(conversationId)) return false;
      // Settle an earlier unanswered join first; if ordered we are already in.
      if (this.joining.has(conversationId)) {
        const settled = await this.settlePending(conversationId, null);
        if (settled) {
          this.failed.delete(conversationId);
          await this.publishGroupInfo(conversationId, settled.state);
          return true;
        }
      }
      // Giving up queues this device for manual admission, so check the server first.
      let through = frames.reduce((max, f) => Math.max(max, f.seq || 0), 0);
      let newest = await this.newestGroupInfo(frames);
      let moved = highestCommitEpoch(frames);
      if (!newest) {
        const rest = await this.ownGroupInfoFrames(conversationId);
        newest = await this.newestGroupInfo(rest.frames);
        // Only raised when something was found.
        if (newest) through = Math.max(through, rest.through);
        moved = Math.max(moved, rest.epoch ?? -1);
      }
      if (!newest) return false;

      // A GroupInfo only admits at its own epoch; once anyone commits past it the sequencer refuses every time, so say no up front.
      const infoEpoch = Number(newest.info.groupContext.epoch);
      if (newest.seq <= (this.staleJoins.get(conversationId) ?? -1)
        || moved > infoEpoch) {
        this.staleJoins.set(
          conversationId,
          Math.max(newest.seq, this.staleJoins.get(conversationId) ?? -1),
        );
        return false;
      }

      const pair = await this.signatureKeyPair();
      const self = await generateKeyPackageWithKey(
        this.credential(), capabilities(), defaultLifetime, [], pair, this.cs,
      );
      // `resync` when the tree still holds a leaf with this key: the commit replaces it, else MLS refuses the duplicate key.
      let resync = false;
      try {
        const tree = ratchetTreeFromExtension(newest.info);
        resync = clientsInTree(tree).has(encode64(pair.publicKey));
      } catch { /* no tree to look at: an ordinary join */ }
      const joined = await joinGroupExternal(
        newest.info, self.publicPackage, self.privatePackage, resync, this.cs,
        undefined, defaultClientConfig,
      );
      const epoch = Number(joined.newState.groupContext.epoch);
      try {
        // Pending until answered (`sendCommit`); `through` is where the walk starts after joining.
        await this.sendCommit(conversationId, null, {
          kind: 'commit',
          ciphertext: encode64(wire.publicMessage(joined.publicMessage)),
          epoch,
        }, joined.newState, { lastSeq: through, recoveryKeyId: null });
      } catch (e) {
        // Stale: remember it so the retry uses a newer GroupInfo or asks to be let in.
        if (e?.status === 409 && !this.joining.has(conversationId)) {
          this.staleJoins.set(
            conversationId,
            Math.max(newest.seq, this.staleJoins.get(conversationId) ?? -1),
          );
        }
        throw e;
      }
      this.staleJoins.delete(conversationId);

      // Earlier history stays closed (forward secrecy).
      this.failed.delete(conversationId);
      await this.publishGroupInfo(conversationId, this.groups.get(conversationId).state);
      return true;
    });
  }

  /// Under a policy a new person needs the add right; another device of someone in the tree does not. `lenient` drops whoever this account may not add instead of failing. The commit declares who it adds so the sequencer enforces the same policy.
  async addMembers(conversationId, userIds, { lenient = false } = {}) {
    return this.run(conversationId, async () => {
      let entry = await this.loadGroup(conversationId);
      entry = await this.settlePending(conversationId, entry);
      if (!entry) throw new Error('not a member of this group yet');
      const policy = policyIn(entry.state.groupContext.extensions);
      const inTree = usersInTree(entry.state.ratchetTree);
      // Read from the same state the commit is built on, not the caller's possibly stale picture.
      const held = clientsInTree(entry.state.ratchetTree);
      let asked = userIds;
      if (asked.some((u) => !inTree.has(u)) && !this.permits(conversationId, 'add')) {
        if (!lenient) throw new Error('this group’s membership policy does not let you add people');
        asked = asked.filter((u) => inTree.has(u));
        if (!asked.length) return { added: 0, missing: [], rejected: [] };
      }
      const claimed = await this.claim(asked, held);
      const { missing } = claimed;
      let { packages, rejected } = claimed;
      if (policy) {
        // A device that can't read the policy can't join a group that has one.
        const unable = packages.filter((p) => !supportsPolicy(p));
        if (unable.length) {
          rejected = [...rejected, ...unable.map((p) => {
            const who = identityOf(p.leafNode?.credential);
            return who ? `${who.userId} (${who.deviceId}, needs a newer client)` : 'a device that needs a newer client';
          })];
          packages = packages.filter(supportsPolicy);
        }
      }
      const newcomers = [...new Set(packages
        .map((p) => identityOf(p.leafNode?.credential)?.userId)
        .filter((u) => u && !inTree.has(u)))];
      if (!packages.length) {
        if (lenient) return { added: 0, missing, rejected };
        // Everyone already has a leaf: success.
        if (!missing.length && !rejected.length && asked.every((u) => inTree.has(u))) {
          return { added: 0, missing, rejected };
        }
        throw new Error(rejected.length
          ? 'no cryptographically trusted device had a key package to add'
          : 'nobody had a key package to add');
      }

      const commit = await createCommit({ state: entry.state, cipherSuite: this.cs }, {
        extraProposals: packages.map((keyPackage) => ({ proposalType: 'add', add: { keyPackage } })),
        ratchetTreeExtension: true,
      });
      const epoch = Number(commit.newState.groupContext.epoch);

      // One request so the sequencer writes commit, Welcome and members atomically; split, a commit could land without its Welcome.
      const body = {
        kind: 'commit', ciphertext: encode64(encodeMlsMessage(commit.commit)), epoch,
        ...(newcomers.length ? { change: { op: 'add', user_ids: newcomers } } : {}),
        ...(commit.welcome ? { welcome: encode64(wire.welcome(commit.welcome)) } : {}),
      };
      const answer = await this.sendCommit(conversationId, entry, body, commit.newState);
      await this.sendWelcomeIfMissing(conversationId, body, answer);
      await this.publishGroupInfo(conversationId, commit.newState);
      return { added: packages.length, missing, rejected };
    });
  }

  /// Needs the remove right under a policy. Never removes this account.
  async removeMembers(conversationId, userIds) {
    return this.run(conversationId, async () => {
      let entry = await this.loadGroup(conversationId);
      entry = await this.settlePending(conversationId, entry);
      if (!entry) throw new Error('not a member of this group yet');
      const targets = new Set(userIds.filter((u) => u && u !== this.userId));
      if (!targets.size) return { removed: 0 };
      if (!this.permits(conversationId, 'remove')) {
        throw new Error('this group’s membership policy does not let you remove people');
      }
      const leaves = [];
      (entry.state.ratchetTree || []).forEach((node, index) => {
        if (index % 2 || node?.nodeType !== 'leaf') return;
        const who = identityOf(node.leaf?.credential);
        if (who && targets.has(who.userId)) leaves.push(index / 2);
      });
      const commit = await createCommit({ state: entry.state, cipherSuite: this.cs }, {
        extraProposals: leaves.map((removed) => ({ proposalType: 'remove', remove: { removed } })),
        ratchetTreeExtension: true,
      });
      const epoch = Number(commit.newState.groupContext.epoch);
      await this.sendCommit(conversationId, entry, {
        kind: 'commit', ciphertext: encode64(encodeMlsMessage(commit.commit)), epoch,
        change: { op: 'remove', user_ids: [...targets] },
      }, commit.newState);
      await this.publishGroupInfo(conversationId, commit.newState);
      return { removed: leaves.length };
    });
  }

  /// Best-effort; a failure leaves `resync` for `removeDeparted`.
  async proposeLeave(conversationId) {
    return this.run(conversationId, async () => {
      let entry = await this.loadGroup(conversationId).catch(() => null);
      entry = await this.settlePending(conversationId, entry).catch(() => entry);
      if (!entry) return { proposed: 0, through: 0 };
      let through = entry.lastSeq || 0;
      const leaves = leavesOf(entry.state.ratchetTree, new Set([this.userId]));
      const own = entry.state.privatePath?.leafIndex;
      // Own leaf last so earlier proposals are signed by a still-present leaf.
      leaves.sort((a, b) => (a === own) - (b === own));
      let state = entry.state;
      let proposed = 0;
      for (const removed of leaves) {
        const made = await createProposal(state, false, { proposalType: 'remove', remove: { removed } }, this.cs);
        state = made.newState;
        const answer = await this.home.sendFrame(conversationId, this.stamped(conversationId, {
          kind: 'proposal',
          ciphertext: encode64(wire.privateMessage(made.message.privateMessage)),
          epoch: Number(state.groupContext.epoch),
        }));
        through = Math.max(through, Number(answer?.seq) || 0);
        proposed += 1;
      }
      return { proposed, through };
    });
  }

  /// So the removing commit can name them and clear `resync`.
  noteDeparted(conversationId, userIds) {
    const held = this.departed.get(conversationId) || new Set();
    for (const u of userIds || []) if (u && u !== this.userId) held.add(u);
    if (held.size) this.departed.set(conversationId, held);
  }

  async commitHeldProposals(conversationId, entry, extraProposals = []) {
    const held = Object.values(entry.state.unappliedProposals || {});
    if (!held.length && !extraProposals.length) return entry;
    const own = entry.state.privatePath?.leafIndex;
    if (held.some((h) => h.proposal?.proposalType === 'remove' && h.proposal.remove?.removed === own)) {
      throw new Error('this account has left this conversation');
    }
    const removedUsers = new Set();
    for (const p of [...held.map((h) => h.proposal), ...extraProposals]) {
      if (p?.proposalType !== 'remove') continue;
      const who = leafIdentity(entry.state.ratchetTree, p.remove?.removed)?.userId;
      if (who) removedUsers.add(who);
    }
    const departed = this.departed.get(conversationId) || new Set();
    const named = [...removedUsers].filter((u) => departed.has(u));
    const commit = await createCommit({ state: entry.state, cipherSuite: this.cs }, {
      extraProposals, ratchetTreeExtension: true,
    });
    const epoch = Number(commit.newState.groupContext.epoch);
    await this.sendCommit(conversationId, entry, {
      kind: 'commit', ciphertext: encode64(encodeMlsMessage(commit.commit)), epoch,
      ...(named.length ? { change: { op: 'remove', user_ids: named } } : {}),
    }, commit.newState);
    await this.publishGroupInfo(conversationId, commit.newState);
    return this.groups.get(conversationId) || entry;
  }

  /// Commits held Remove proposals, plus direct removes for uncovered leaves if the policy allows.
  async removeDeparted(conversationId, userIds) {
    this.noteDeparted(conversationId, userIds);
    return this.run(conversationId, async () => {
      let entry = await this.loadGroup(conversationId).catch(() => null);
      entry = entry && await this.settlePending(conversationId, entry);
      if (!entry) return { removed: 0 };
      const targets = new Set((userIds || []).filter((u) => u && u !== this.userId));
      const covered = new Set(Object.values(entry.state.unappliedProposals || {})
        .filter((h) => h.proposal?.proposalType === 'remove')
        .map((h) => h.proposal.remove.removed));
      const direct = this.permits(conversationId, 'remove')
        ? leavesOf(entry.state.ratchetTree, targets).filter((l) => !covered.has(l))
        : [];
      if (!covered.size && !direct.length) return { removed: 0 };
      await this.commitHeldProposals(
        conversationId, entry,
        direct.map((removed) => ({ proposalType: 'remove', remove: { removed } })),
      );
      return { removed: covered.size + direct.length };
    });
  }

  /// Needs no policy right (`judgeCommit`).
  async removeRevoked(conversationId) {
    if (!this.isRevokedKey) return { removed: 0 };
    return this.run(conversationId, async () => {
      let entry = await this.loadGroup(conversationId).catch(() => null);
      entry = entry && await this.settlePending(conversationId, entry);
      if (!entry) return { removed: 0 };
      const own = entry.state.privatePath?.leafIndex;
      const leaves = leavesOf(entry.state.ratchetTree, new Set([this.userId])).filter((leaf) => {
        if (leaf === own) return false;
        const key = leafSignatureKey(entry.state.ratchetTree, leaf);
        return key && this.isRevokedKey(this.userId, encode64(key));
      });
      if (!leaves.length) return { removed: 0 };
      await this.commitHeldProposals(
        conversationId, entry,
        leaves.map((removed) => ({ proposalType: 'remove', remove: { removed } })),
      );
      return { removed: leaves.length };
    });
  }

  /// Members judge it against the policy it replaces; the creator is carried over. A policyless group lets anyone adopt one; after that `judgeCommit` refuses any commit moving the creator.
  async setPolicy(conversationId, next) {
    return this.run(conversationId, async () => {
      let entry = await this.loadGroup(conversationId);
      entry = await this.settlePending(conversationId, entry);
      if (!entry) throw new Error('not a member of this group yet');
      const extensions = entry.state.groupContext.extensions || [];
      const current = policyIn(extensions);
      if (current === undefined) throw new Error('this group’s membership policy does not parse');
      if (!current) {
        // Every member must support GroupContext extensions; fail by name rather than dropping devices that predate policies.
        const stuck = leavesMissingPolicySupport(entry.state.ratchetTree);
        if (stuck.length) {
          throw new Error(`${stuck.join(', ')} needs a newer client before this group can have a membership policy`);
        }
      }
      const policy = normalisePolicy({ ...next, v: 1, creator: current ? current.creator : this.userId });
      if (!policy) throw new Error('that is not a membership policy this client understands');
      // Checked against the policy being replaced; an absent one permits all.
      if (!this.permits(conversationId, 'policy')) {
        throw new Error('this group’s membership policy does not let you change it');
      }
      if (current && samePolicy(policy, current)) return current;
      const commit = await createCommit({ state: entry.state, cipherSuite: this.cs }, {
        extraProposals: [{
          proposalType: 'group_context_extensions',
          groupContextExtensions: {
            extensions: [...extensions.filter((e) => !isPolicyExtension(e)), policyExtension(policy)],
          },
        }],
        ratchetTreeExtension: true,
      });
      const epoch = Number(commit.newState.groupContext.epoch);
      await this.sendCommit(conversationId, entry, {
        kind: 'commit', ciphertext: encode64(encodeMlsMessage(commit.commit)), epoch,
        change: { op: 'policy', policy },
      }, commit.newState);
      await this.publishGroupInfo(conversationId, commit.newState);
      return policy;
    });
  }

  /// So two callers never answer the same request.
  takeRejoins(conversationId) {
    const waiting = this.rejoins.get(conversationId);
    if (!waiting?.size) return [];
    this.rejoins.delete(conversationId);
    return [...waiting.values()];
  }

  /// Answers rejoin requests and repairs groups built before a device had key packages. Adding nothing is normal.
  async catchUp(conversationId, requesters) {
    // Loaded, not merely checked: a request can arrive for a conversation not opened since the tab did.
    if (!await this.loadGroup(conversationId).catch(() => null)) {
      return { added: 0, missing: [], rejected: [] };
    }
    const devices = this.devicesIn(conversationId);
    const present = new Set(devices.map((d) => `${d.userId}|${d.deviceId}`));
    const keys = new Set(devices.map((d) => d.signatureKey).filter(Boolean));
    // Check before claiming: claiming consumes a key package per device, so answering an answered request would drain everyone's stock. Judge by signature key when given (a reload mints a new device id for the same key); a present key whose device has no group is a leftover leaf the device replaces itself.
    const absent = requesters.filter((r) => (r.signatureKey
      ? !keys.has(r.signatureKey)
      : !present.has(`${r.userId}|${r.deviceId}`)));
    if (!absent.length) return { added: 0, missing: [], rejected: [] };

    const userIds = [...new Set(absent.map((r) => r.userId))];
    return this.addMembers(conversationId, userIds, { lenient: true });
  }

  /// Only a request; the receiver decides.
  async requestRejoin(conversationId) {
    // Body is the leaf signature key, identifying the device in tree terms (`catchUp`).
    const key = await this.leafKey().catch(() => null);
    await this.home.sendFrame(conversationId, {
      kind: 'rejoin', ciphertext: key ? rejoinBody(key) : '', epoch: this.epochOf(conversationId),
    });
  }

  /// A reply rides in the body envelope so the server never sees it.
  async send(conversationId, text, attachments, reply = null) {
    const body = encodeBody(text, attachments, reply);
    return this.post(conversationId, pack(MESSAGE, body), async (frame) => {
      if (!frame?.id) return;
      if (frame.seq) this.seqOf.set(frame.id, frame.seq);
      await this.keep(conversationId, frame.id, body);
      // Record authorship now; the walk steps over our own frames.
      this.noteAuthor(conversationId, frame.id, this.userId);
    });
  }

  async notificationTargets(conversationId) {
    const held = this.notificationKeys.get(conversationId);
    if (held && Date.now() - held.at < 60_000) return held;

    const response = await this.home.dmNotificationKeys(conversationId);
    const hintOrigin = typeof response?.hint_origin === 'string' ? response.hint_origin : '';
    if (hintOrigin !== `dm:${conversationId}`) {
      throw new Error('Homeserver returned an invalid DM notification context.');
    }
    const targets = Array.isArray(response?.targets)
      ? response.targets.filter((target) => target
        && typeof target.user_id === 'string'
        && typeof target.device_id === 'string'
        && typeof target.public_key === 'string')
      : [];
    if (targets.length > 256) throw new Error('Too many DM notification targets.');
    const complete = response?.complete !== false;
    const value = { at: Date.now(), hintOrigin, targets, complete };
    // Incomplete usually means a remote conversation's descriptor is still federating; don't cache it.
    if (complete) this.notificationKeys.set(conversationId, value);
    return value;
  }

  async sendNotificationHints(conversationId, notificationId, notify) {
    const { hintOrigin, targets, complete } = await this.notificationTargets(conversationId);
    const envelopes = await sealDmNotificationHints(
      targets,
      hintOrigin,
      notificationId,
      notify,
    );
    // Always sent, even with no enrolled device, so the homeserver can't tell the cases apart.
    await this.home.sendDmNotificationHints(conversationId, {
      notification_id: notificationId,
      envelopes,
    });
    if (!complete) {
      throw new Error('DM notification key discovery is not complete yet.');
    }
  }

  /// Messages, receipts and reactions all take this path so the sequencer can't tell them apart. `notify` is derived from the leading byte, so a new frame type stays silent until made loud. `after` runs under the send lock so another tab receiving the echo reads it from disk.
  async post(conversationId, payload, after = null) {
    return this.run(conversationId, async () => {
      let entry = await this.loadGroup(conversationId);
      // Settle any pending commit first; the group may already be past this epoch.
      entry = await this.settlePending(conversationId, entry);
      if (!entry) throw new Error('this device is not in this conversation\u2019s group yet. It will be let in the next time a device already here opens it.');
      // MLS won't seal over uncommitted proposals (only leaves are held).
      entry = await this.commitHeldProposals(conversationId, entry);
      const app = await createApplicationMessage(entry.state, payload, this.cs);
      const epoch = Number(app.newState.groupContext.epoch);
      const notificationId = dmNotificationId();
      // Shared by both hint paths so they can't disagree.
      const notify = payload[0] === MESSAGE;

      // Advance the ratchet before sending: a throwing send may still have been sequenced, and reusing its generation would stall every receiver. A burned generation is harmless. (Commits differ; see `refreshRecoveryEpochs`.)
      await this.saveGroup(conversationId, { state: app.newState, lastSeq: entry.lastSeq, generation: entry.generation });

      // Start hints first so key lookup overlaps the send.
      let hintError = null;
      const hint = this.sendNotificationHints(
        conversationId,
        notificationId,
        notify,
      ).catch((error) => {
        hintError = error;
      });

      const frame = await this.home.sendFrame(conversationId, this.stamped(conversationId, {
        kind: 'application',
        ciphertext: encode64(wire.privateMessage(app.privateMessage)),
        epoch,
        notify,
        notification_id: notificationId,
      }));
      if (after) await after(frame);
      await hint;

      // A first cross-server message can beat the descriptor to the recipient home; retry once (notification_id keeps it idempotent).
      if (hintError) {
        this.notificationKeys.delete(conversationId);
        await this.sendNotificationHints(
          conversationId,
          notificationId,
          notify,
        ).catch((error) => {
          console.warn('could not queue DM notification hint', error);
        });
      }
      return frame;
    });
  }

  /// For a group's promotion announcement (posted to `/promote`).
  async encrypt(conversationId, text) {
    return this.run(conversationId, async () => {
      const entry = await this.loadGroup(conversationId);
      if (!entry) throw new Error('this device is not in this conversation\u2019s group yet. It will be let in the next time a device already here opens it.');
      const app = await createApplicationMessage(entry.state, pack(MESSAGE, text), this.cs);
      await this.saveGroup(conversationId, { state: app.newState, lastSeq: entry.lastSeq, generation: entry.generation });
      return {
        ciphertext: encode64(wire.privateMessage(app.privateMessage)),
        epoch: Number(app.newState.groupContext.epoch),
      };
    });
  }

  /// The sender can't decrypt it later.
  async keep(conversationId, frameId, body) {
    this.plaintext.set(frameId, decodeBody(body));
    await this.remember(conversationId, frameId, body);
  }

  watermarkOf(conversationId) {
    if (!this.watermarks.has(conversationId)) {
      this.watermarks.set(
        conversationId,
        {
          delivered: null, deliveredSeq: 0, read: null,
          sentDelivered: null, sentRead: null,
        },
      );
    }
    return this.watermarks.get(conversationId);
  }

  /// Sent later as one watermark; uses the sequencer's number when known.
  noteDelivered(conversationId, frameId, seq = 0) {
    const local = this.watermarkOf(conversationId);
    if (seq > 0) {
      if (seq > local.deliveredSeq) {
        local.deliveredSeq = seq;
        local.delivered = frameId;
      }
      return;
    }
    local.delivered = furthest(local.delivered, frameId);
  }

  /// Sent when the caller flushes.
  noteRead(conversationId, frameId) {
    const local = this.watermarkOf(conversationId);
    local.read = furthest(local.read, frameId);
  }

  /// Delivery defaults on, read is off until asked for. Either can be refused, and a refusal also drops what the refuser would receive (`applyAck`). With read: one RECEIPT carrying the ack, plus the legacy `delivered` field for older builds.
  async flushSignals(conversationId) {
    const local = this.watermarkOf(conversationId);
    // `sentDelivered` is not advanced while acks are off, so re-enabling sends the true position.
    const ack = this.sendsDelivered(conversationId)
      && local.delivered && local.delivered !== local.sentDelivered
      ? { device: this.deviceId, key: await this.leafKey().catch(() => undefined), seq: local.deliveredSeq, id: local.delivered }
      : null;
    const read = this.sendsRead(conversationId) && local.read && local.read !== local.sentRead
      ? local.read
      : null;
    if (!ack && !read) return null;
    const payload = read
      ? pack(RECEIPT, JSON.stringify(ack ? { read, delivered: ack.id, ack } : { read }))
      : pack(DELIVERED, JSON.stringify(ack));
    const frame = await this.post(conversationId, payload, async (sent) => {
      if (sent?.id) await this.mark(conversationId, sent.id);
    });
    if (ack) {
      local.sentDelivered = ack.id;
      local.sentSeq = ack.seq;
    }
    if (read) local.sentRead = read;
    this.saveSignals(conversationId);
    return frame;
  }

  /// Ephemeral; carries no watermark.
  async typing(conversationId) {
    return this.post(conversationId, pack(TYPING, ''), async (sent) => {
      if (sent?.id) await this.mark(conversationId, sent.id);
    });
  }

  /// Last-write-wins per user per emoji. The sender folds its own delta immediately since `sync` steps over its own frames.
  async react(conversationId, frameId, emoji) {
    return this.setReaction(conversationId, frameId, emoji, 'add');
  }

  async unreact(conversationId, frameId, emoji) {
    return this.setReaction(conversationId, frameId, emoji, 'remove');
  }

  async setReaction(conversationId, frameId, emoji, op) {
    return this.post(
      conversationId,
      pack(REACTION, JSON.stringify({ target: frameId, emoji, op })),
      (sent) => this.ownGesture(conversationId, sent, () => (
        this.applyReaction(conversationId, this.userId, { target: frameId, emoji, op })
      )),
    );
  }

  /// Shape-checked: a malformed payload must not throw out of the sync walk.
  applyReaction(conversationId, sender, payload) {
    if (typeof payload?.target !== 'string' || typeof payload?.emoji !== 'string') return;
    if (payload.op !== 'add' && payload.op !== 'remove') return;
    if (!this.reactions.has(conversationId)) this.reactions.set(conversationId, new Map());
    const targets = this.reactions.get(conversationId);
    if (!targets.has(payload.target)) targets.set(payload.target, new Map());
    const users = targets.get(payload.target);
    const held = users.get(sender) || new Set();
    if (payload.op === 'remove') held.delete(payload.emoji);
    else held.add(payload.emoji);
    if (held.size) users.set(sender, held);
    else users.delete(sender);
    this.saveReactions(conversationId);
  }

  /// One per emoji, in arrival order.
  reactionsTo(conversationId, frameId) {
    const out = [];
    for (const [user, emojis] of this.reactions.get(conversationId)?.get(frameId) || []) {
      for (const emoji of emojis) {
        let group = out.find((r) => r.emoji === emoji);
        if (!group) out.push(group = { emoji, count: 0, users: [] });
        group.count += 1;
        group.users.push(user);
      }
    }
    return out;
  }

  /// Frames can't be opened a second time.
  saveReactions(conversationId) {
    const rows = [];
    for (const [target, users] of this.reactions.get(conversationId) || []) {
      for (const [user, emojis] of users) rows.push({ t: target, u: user, e: [...emojis] });
    }
    this.track(put(OPENED, `${this.scope}:rx:${conversationId}`, rows));
    this.backup?.queue(conversationId, RX, rows);
  }

  /// Once per conversation per session, before the sync walk. Rows not understood are skipped.
  async loadConversationState(conversationId) {
    if (this.stateRead.has(conversationId)) return;
    this.stateRead.add(conversationId);
    // Mirror first so everything after reads one store.
    await this.pullMirror(conversationId).catch(() => {});
    await this.readFolds(conversationId);
  }

  /// `adopt` reruns it after another tab writes.
  async readFolds(conversationId) {
    const rows = await get(OPENED, `${this.scope}:rx:${conversationId}`).catch(() => null);
    if (Array.isArray(rows) && rows.length) {
      if (!this.reactions.has(conversationId)) this.reactions.set(conversationId, new Map());
      const targets = this.reactions.get(conversationId);
      for (const row of rows) {
        if (typeof row?.t !== 'string' || typeof row?.u !== 'string') continue;
        const emojis = (row.e || []).filter((e) => typeof e === 'string');
        if (!emojis.length) continue;
        if (!targets.has(row.t)) targets.set(row.t, new Map());
        targets.get(row.t).set(row.u, new Set(emojis));
      }
    }

    // Authorship is rebuilt from the wire each walk.
    this.readSignals(
      conversationId, await get(OPENED, `${this.scope}:ak:${conversationId}`).catch(() => null),
    );

    const cx = await get(OPENED, `${this.scope}:cx:${conversationId}`).catch(() => null);
    if (!cx || typeof cx !== 'object') return;
    for (const row of cx.edits || []) {
      if (typeof row?.t !== 'string' || typeof row?.x !== 'string' || !row.x.trim()) continue;
      if (!this.edits.has(conversationId)) this.edits.set(conversationId, new Map());
      this.edits.get(conversationId).set(row.t, { text: row.x, by: String(row.by || '') });
    }
    for (const id of cx.dead || []) {
      if (typeof id !== 'string') continue;
      if (!this.tombstones.has(conversationId)) this.tombstones.set(conversationId, new Set());
      this.tombstones.get(conversationId).add(id);
      await del(OPENED, `${this.scope}:${id}`).catch(() => {});
    }
    for (const row of cx.pins || []) {
      if (typeof row?.t !== 'string') continue;
      if (!this.pins.has(conversationId)) this.pins.set(conversationId, new Map());
      this.pins.get(conversationId).set(row.t, {
        by: String(row.by || ''),
        author: typeof row.author === 'string' ? row.author.slice(0, SNIPPET_MAX) : '',
        snippet: typeof row.snippet === 'string' ? row.snippet.slice(0, SNIPPET_MAX) : '',
      });
    }
    if (validSfu(cx.sfu)) this.callSfus.set(conversationId, cx.sfu);
  }

  /// MLS forward secrecy means `selfJoin` can't supply the backlog. Gap-filling only: local rows win.
  async pullMirror(conversationId) {
    if (!this.backup?.enabled || this.mirrored.has(conversationId)) return 0;
    this.mirrored.add(conversationId);
    let restored = 0;
    const rows = await this.backup.restore(conversationId);
    for (const [item, value] of rows) {
      const key = item === RX || item === CX
        ? `${this.scope}:${item}:${conversationId}`
        : `${this.scope}:${item}`;
      // Null row: deleted elsewhere; remove the local copy.
      if (value === null) {
        this.plaintext.delete(item);
        await del(OPENED, key).catch(() => {});
        continue;
      }
      if (await get(OPENED, key).catch(() => undefined) !== undefined) continue;
      await put(OPENED, key, value).catch(() => {});
      restored += 1;
    }
    return restored;
  }

  /// The original ciphertext stays on the sequencer: an edit supersedes, a delete means devices stop showing/keeping it.
  async editMessage(conversationId, frameId, text) {
    return this.whileOutgoing(conversationId, frameId, { text }, () => this.post(
      conversationId,
      pack(EDIT, JSON.stringify({ target: frameId, text })),
      (sent) => this.ownGesture(conversationId, sent, () => (
        this.applyEdit(conversationId, this.userId, { target: frameId, text })
      )),
    ));
  }

  async deleteMessage(conversationId, frameId) {
    return this.whileOutgoing(conversationId, frameId, { deleted: true }, () => this.post(
      conversationId,
      pack(DELETE, JSON.stringify({ target: frameId })),
      (sent) => this.ownGesture(conversationId, sent, () => (
        this.applyDelete(conversationId, this.userId, { target: frameId })
      )),
    ));
  }

  /// Set before the first await.
  async whileOutgoing(conversationId, frameId, gesture, send) {
    let mine = this.outgoing.get(conversationId);
    if (!mine) this.outgoing.set(conversationId, (mine = new Map()));
    mine.set(frameId, gesture);
    try {
      return await send();
    } finally {
      if (mine.get(frameId) === gesture) mine.delete(frameId);
      if (!mine.size) this.outgoing.delete(conversationId);
    }
  }

  /// The snapshot rides along since later-admitted devices can't read the message.
  async setPin(conversationId, frameId, pin) {
    const payload = { target: frameId, op: pin ? 'add' : 'remove' };
    if (pin) {
      payload.author = this.authorOf(conversationId, frameId) || '';
      payload.snippet = String(this.textOf(frameId) || '').slice(0, SNIPPET_MAX);
    }
    return this.post(
      conversationId,
      pack(PIN, JSON.stringify(payload)),
      (sent) => this.ownGesture(conversationId, sent, () => (
        this.applyPin(conversationId, this.userId, payload)
      )),
    );
  }

  /// Reads folds first so an empty picture doesn't overwrite the one on disk.
  async ownGesture(conversationId, frame, apply) {
    if (!this.stateRead.has(conversationId)) await this.readFolds(conversationId);
    apply();
    if (frame?.id) await this.mark(conversationId, frame.id);
  }

  /// Basis for author-only checks.
  noteAuthor(conversationId, frameId, sender) {
    if (!sender) return;
    if (!this.authors.has(conversationId)) this.authors.set(conversationId, new Map());
    this.authors.get(conversationId).set(frameId, sender);
  }

  authorOf(conversationId, frameId) {
    return this.authors.get(conversationId)?.get(frameId) || null;
  }

  applyEdit(conversationId, sender, payload) {
    if (typeof payload?.target !== 'string' || typeof payload?.text !== 'string') return;
    if (!payload.text.trim()) return;
    // Author-only; unknown (legacy) authors are allowed.
    const author = this.authorOf(conversationId, payload.target);
    if (author && author !== sender) return;
    if (!this.edits.has(conversationId)) this.edits.set(conversationId, new Map());
    this.edits.get(conversationId).set(payload.target, { text: payload.text, by: sender });
    this.saveMessageState(conversationId);
  }

  applyDelete(conversationId, sender, payload) {
    if (typeof payload?.target !== 'string') return;
    const author = this.authorOf(conversationId, payload.target);
    if (author && author !== sender) return;
    if (!this.tombstones.has(conversationId)) this.tombstones.set(conversationId, new Set());
    this.tombstones.get(conversationId).add(payload.target);
    this.plaintext.delete(payload.target);
    this.track(del(OPENED, `${this.scope}:${payload.target}`));
    // Also clear the history mirror (readable in escrowed mode); null so the erasure replicates.
    this.backup?.queue(conversationId, payload.target, null);
    this.reactions.get(conversationId)?.delete(payload.target);
    this.pins.get(conversationId)?.delete(payload.target);
    this.saveReactions(conversationId);
    this.saveMessageState(conversationId);
  }

  applyPin(conversationId, sender, payload) {
    if (typeof payload?.target !== 'string') return;
    if (!this.pins.has(conversationId)) this.pins.set(conversationId, new Map());
    const pins = this.pins.get(conversationId);
    if (payload.op === 'remove') pins.delete(payload.target);
    else if (payload.op === 'add') {
      pins.set(payload.target, {
        by: sender,
        author: typeof payload.author === 'string' ? payload.author.slice(0, SNIPPET_MAX) : '',
        snippet: typeof payload.snippet === 'string' ? payload.snippet.slice(0, SNIPPET_MAX) : '',
      });
    } else return;
    this.saveMessageState(conversationId);
  }

  /// Last one wins.
  async setCallSfu(conversationId, endpoint) {
    const value = endpoint ? String(endpoint).trim() : null;
    if (value && !validSfu(value)) {
      throw new Error('An SFU address is an http:// or https:// URL of at most 512 characters.');
    }
    const payload = { endpoint: value };
    const frame = await this.post(conversationId, pack(CALL_SFU, JSON.stringify(payload)));
    this.applyCallSfu(conversationId, payload);
    if (frame?.id) await this.mark(conversationId, frame.id);
    return frame;
  }

  applyCallSfu(conversationId, payload) {
    if (payload?.endpoint === null) this.callSfus.delete(conversationId);
    else if (validSfu(payload?.endpoint)) this.callSfus.set(conversationId, payload.endpoint);
    else return;
    this.saveMessageState(conversationId);
  }

  callSfuIn(conversationId) {
    return this.callSfus.get(conversationId) || null;
  }

  /// Only current-epoch members can derive it.
  async callSecret(conversationId, label) {
    // Read secret and epoch together before the export yields; a concurrent commit would mislabel the epoch.
    const state = this.groups.get(conversationId)?.state;
    const secret = state?.keySchedule?.exporterSecret;
    if (!secret) return null;
    const epoch = Number(state.groupContext.epoch);
    const key = await mlsExporter(secret, label, te.encode(conversationId), 32, this.cs);
    return { key: new Uint8Array(key), epoch };
  }

  saveMessageState(conversationId) {
    const state = {
      edits: [...(this.edits.get(conversationId) || [])]
        .map(([t, e]) => ({ t, x: e.text, by: e.by })),
      dead: [...(this.tombstones.get(conversationId) || [])],
      pins: [...(this.pins.get(conversationId) || [])].map(([t, p]) => ({ t, ...p })),
      sfu: this.callSfus.get(conversationId) || null,
    };
    this.track(put(OPENED, `${this.scope}:cx:${conversationId}`, state));
    this.backup?.queue(conversationId, CX, state);
  }

  /// Frames can't be reopened.
  saveSignals(conversationId) {
    const own = this.watermarks.get(conversationId);
    const state = {
      acks: [...(this.acks.get(conversationId)?.values() || [])],
      marks: [...(this.marks.get(conversationId) || [])]
        .map(([u, m]) => ({ u, delivered: m.delivered || null, read: m.read || null })),
      own: own ? {
        delivered: own.sentDelivered || null, seq: own.sentSeq || 0, read: own.sentRead || null,
      } : null,
    };
    this.track(put(OPENED, `${this.scope}:ak:${conversationId}`, state));
  }

  /// Forward only.
  readSignals(conversationId, row) {
    if (!row || typeof row !== 'object') return;
    for (const a of Array.isArray(row.acks) ? row.acks : []) {
      if (typeof a?.userId !== 'string' || typeof a?.id !== 'string' || !Number.isSafeInteger(a?.seq)) continue;
      if (!this.acks.has(conversationId)) this.acks.set(conversationId, new Map());
      const acks = this.acks.get(conversationId);
      const slot = `${a.userId}|${a.key || a.deviceId}`;
      if ((acks.get(slot)?.seq || 0) >= a.seq) continue;
      acks.set(slot, {
        userId: a.userId, deviceId: String(a.deviceId || ''), key: a.key || null, seq: a.seq, id: a.id,
      });
    }
    for (const m of Array.isArray(row.marks) ? row.marks : []) {
      if (typeof m?.u !== 'string') continue;
      if (!this.marks.has(conversationId)) this.marks.set(conversationId, new Map());
      const marks = this.marks.get(conversationId);
      const held = marks.get(m.u) || { delivered: null, read: null };
      const id = (v) => (typeof v === 'string' ? v : null);
      marks.set(m.u, {
        delivered: furthest(held.delivered, id(m.delivered)),
        read: furthest(held.read, id(m.read)),
      });
    }
    const own = row.own;
    if (own && typeof own === 'object') {
      const local = this.watermarkOf(conversationId);
      // What was sent is also where this device had got to.
      if (typeof own.delivered === 'string' && Number.isSafeInteger(own.seq)
        && own.seq > (local.sentSeq || 0)) {
        local.sentDelivered = own.delivered;
        local.sentSeq = own.seq;
        if (own.seq > local.deliveredSeq) {
          local.deliveredSeq = own.seq;
          local.delivered = own.delivered;
        }
      }
      if (typeof own.read === 'string') {
        local.sentRead = furthest(local.sentRead, own.read);
        local.read = furthest(local.read, own.read);
      }
    }
  }

  isDeleted(conversationId, frameId) {
    return this.tombstones.get(conversationId)?.has(frameId)
      || Boolean(this.outgoing.get(conversationId)?.get(frameId)?.deleted);
  }

  isEdited(conversationId, frameId) {
    return this.edits.get(conversationId)?.has(frameId)
      || this.outgoing.get(conversationId)?.get(frameId)?.text !== undefined;
  }

  /// Drawn but not yet sequenced.
  isSaving(conversationId, frameId) {
    return this.outgoing.get(conversationId)?.get(frameId)?.text !== undefined;
  }

  currentText(conversationId, frameId) {
    return this.outgoing.get(conversationId)?.get(frameId)?.text
      ?? this.edits.get(conversationId)?.get(frameId)?.text
      ?? this.plaintext.get(frameId)?.text;
  }

  pinsIn(conversationId) {
    return [...(this.pins.get(conversationId) || [])]
      .map(([id, p]) => ({ id, ...p }));
  }

  /// Read state is dropped unless this account sends its own (reciprocity). `origin` is the sending leaf as MLS vouches for it; a mismatch with the envelope means it was relabelled, so the frame is ignored.
  absorb(conversationId, frame, payload, origin = null) {
    if (origin && frame.sender && origin.userId !== frame.sender) return;
    if (payload.type === 'delivered') {
      if (this.applyAck(conversationId, frame, payload.ack, origin)) this.saveSignals(conversationId);
      return;
    }
    if (payload.type === 'typing') {
      // Typing travels over the gateway; legacy replayed frames are ignored.
      return;
    }
    // Attributed to the frame's sender, not anything the payload claims.
    if (payload.type === 'reaction') {
      this.applyReaction(conversationId, frame.sender, payload);
      return;
    }
    if (payload.type === 'edit') {
      this.applyEdit(conversationId, frame.sender, payload);
      return;
    }
    if (payload.type === 'delete') {
      this.applyDelete(conversationId, frame.sender, payload);
      return;
    }
    if (payload.type === 'pin') {
      this.applyPin(conversationId, frame.sender, payload);
      return;
    }
    if (payload.type === 'call_sfu') {
      this.applyCallSfu(conversationId, payload);
      return;
    }
    if (payload.type !== 'receipt') return;
    if (!this.marks.has(conversationId)) this.marks.set(conversationId, new Map());
    const marks = this.marks.get(conversationId);
    const held = marks.get(frame.sender) || { delivered: null, read: null };
    // Only a receipt without a per-device ack (older build) uses account-level `delivered`.
    if (payload.ack !== undefined) this.applyAck(conversationId, frame, payload.ack, origin);
    else if (this.sendsDelivered(conversationId)) {
      held.delivered = furthest(held.delivered, payload.delivered || null);
    }
    if (this.sendsRead(conversationId)) held.read = furthest(held.read, payload.read || null);
    marks.set(frame.sender, held);
    this.saveSignals(conversationId);
  }

  /// Returns whether taken. A false "delivered" is the lie that matters, so: the device must be the leaf MLS says encrypted the frame; it can't acknowledge a position at or after its own; a known frame's seq must match what this device saw; an account doesn't ack its own message; per device it only moves forward; an account with acks off keeps nobody else's.
  applyAck(conversationId, frame, ack, origin) {
    if (!this.sendsDelivered(conversationId)) return false;
    if (!ack || typeof ack !== 'object') return false;
    const { device, key, seq, id } = ack;
    if (typeof device !== 'string' || !device || typeof id !== 'string' || !id) return false;
    if (!Number.isSafeInteger(seq) || seq <= 0) return false;
    if (!origin || origin.userId !== frame.sender) return false;
    // Match by signature key: the credential's device id is stale after a reload. Older acks without a key use the device id.
    const originKey = origin.signatureKey ? encode64(origin.signatureKey) : null;
    if (key !== undefined) {
      if (typeof key !== 'string' || !originKey || key !== originKey) return false;
    } else if (origin.deviceId !== device) {
      return false;
    }
    if (frame.sender_device && frame.sender_device !== device) return false;
    if (frame.seq && seq >= frame.seq) return false;
    const known = this.seqOf.get(id);
    if (known !== undefined && known !== seq) return false;
    const author = this.authorOf(conversationId, id);
    if (author && author === origin.userId) return false;

    if (!this.acks.has(conversationId)) this.acks.set(conversationId, new Map());
    const acks = this.acks.get(conversationId);
    // Two sessions of one browser profile are one device.
    const slot = `${origin.userId}|${originKey || device}`;
    const held = acks.get(slot);
    if (held && seq <= held.seq) return false;
    acks.set(slot, { userId: origin.userId, deviceId: device, key: originKey, seq, id });
    return true;
  }

  /// Opted-out members are absent, not shown as unread.
  readersOf(conversationId, frameId) {
    return this.markedTo(conversationId, frameId, 'read');
  }

  /// Older account-level watermarks count too.
  deliveredTo(conversationId, frameId) {
    const out = new Set(this.markedTo(conversationId, frameId, 'delivered'));
    for (const { userId } of this.deliveredDevices(conversationId, frameId)) out.add(userId);
    return [...out];
  }

  deliveredDevices(conversationId, frameId) {
    const seq = this.seqOf.get(frameId);
    if (!seq) return [];
    const out = [];
    for (const held of this.acks.get(conversationId)?.values() || []) {
      if (held.seq >= seq) out.push({ userId: held.userId, deviceId: held.deviceId, key: held.key || null });
    }
    return out;
  }

  /// People who send no acks are absent. `devices` is 0 for an older build's account-level watermark.
  deliveryBreakdown(conversationId, frameId) {
    const out = new Map();
    const held = (userId) => {
      if (!out.has(userId)) out.set(userId, { userId, devices: new Set(), read: false });
      return out.get(userId);
    };
    for (const { userId, deviceId, key } of this.deliveredDevices(conversationId, frameId)) {
      held(userId).devices.add(key || deviceId);
    }
    for (const userId of this.markedTo(conversationId, frameId, 'delivered')) held(userId);
    for (const userId of this.readersOf(conversationId, frameId)) held(userId).read = true;
    out.delete(this.userId);
    return [...out.values()]
      .map((row) => ({ userId: row.userId, devices: row.devices.size, read: row.read }))
      .sort((a, b) => a.userId.localeCompare(b.userId));
  }

  /// "Everyone" is this device's tree, not the server's member list; a member with read receipts off caps it at `delivered`.
  deliveryState(conversationId, frame) {
    if (!frame?.id) return null;
    if (frame.seq && !this.seqOf.has(frame.id)) this.seqOf.set(frame.id, frame.seq);
    const others = [...new Set(this.devicesIn(conversationId).map((d) => d.userId))]
      .filter((u) => u !== this.userId);
    if (!others.length) return 'sent';
    const readers = new Set(this.readersOf(conversationId, frame.id));
    if (others.every((u) => readers.has(u))) return 'read';
    const delivered = new Set(this.deliveredTo(conversationId, frame.id));
    if (others.every((u) => delivered.has(u) || readers.has(u))) return 'delivered';
    return 'sent';
  }

  /// Read from sender data before processing, so a signal can be held to its actual sending device. Null if not a private message or the epoch's keys are gone.
  async senderOf(state, message) {
    if (message?.wireformat !== 'mls_private_message') return null;
    const pm = message.privateMessage;
    try {
      let secret = null;
      let tree = null;
      if (pm.epoch === state.groupContext.epoch) {
        secret = state.keySchedule?.senderDataSecret;
        tree = state.ratchetTree;
      } else {
        const earlier = state.historicalReceiverData?.get(pm.epoch);
        secret = earlier?.senderDataSecret;
        tree = earlier?.ratchetTree;
      }
      if (!secret) return null;
      const data = await decryptSenderData(pm, secret, this.cs);
      if (!data) return null;
      const who = leafIdentity(tree, data.leafIndex);
      if (!who) return null;
      return { ...who, signatureKey: leafSignatureKey(tree, data.leafIndex) };
    } catch {
      return null;
    }
  }

  /// Compared by key, not device id: every session gets a fresh device id but shares one group state and key, and the remembered-id list can lose entries to a startup race.
  async ownSignatureKey(key) {
    if (!key) return false;
    // Cached; nothing rotates it under a running engine.
    if (this.ownLeafKey === undefined) {
      const pair = await this.signatureKeyPair().catch(() => null);
      this.ownLeafKey = pair?.publicKey || null;
    }
    return Boolean(this.ownLeafKey) && sameBytes(this.ownLeafKey, key);
  }

  /// Null if none (everyone may do everything), undefined if it doesn't parse.
  policyOf(conversationId) {
    const entry = this.groups.get(conversationId);
    if (!entry) return null;
    return policyIn(entry.state.groupContext.extensions);
  }

  /// So the UI avoids commits peers would reject.
  permits(conversationId, rule, userId = this.userId) {
    const policy = this.policyOf(conversationId);
    if (policy === undefined) return false;
    return policyAllows(policy, rule, userId);
  }

  /// Judges against the state before the commit; a rejection leaves state untouched.
  gate(state, verdict, message = null) {
    const policy = policyIn(state.groupContext.extensions);
    const joinerKey = externalJoinerKey(message);
    const joiner = externalJoiner(message);
    const revoked = this.isRevokedKey;
    return (incoming) => {
      // Every commit carries all held proposals, so one failing `judgeCommit` would poison them. Keep only a member removing a leaf of their own account (`proposeLeave`).
      if (incoming.kind === 'proposal') {
        const { proposal, senderLeafIndex } = incoming.proposal || {};
        const proposer = senderLeafIndex === undefined ? null : leafIdentity(state.ratchetTree, senderLeafIndex)?.userId;
        const removed = proposal?.proposalType === 'remove'
          ? leafIdentity(state.ratchetTree, proposal.remove?.removed)?.userId : null;
        const proposerKey = senderLeafIndex === undefined ? null : leafSignatureKey(state.ratchetTree, senderLeafIndex);
        const fromRevoked = Boolean(revoked && proposer && proposerKey && revoked(proposer, encode64(proposerKey)));
        if (proposer && removed === proposer && !fromRevoked) return 'accept';
        verdict.skipped = true;
        return 'reject';
      }
      if (incoming.kind !== 'commit') return 'accept';
      const why = judgeCommit(policy, state.ratchetTree, { ...incoming, joinerKey, joiner, revoked });
      if (why) {
        verdict.reason = why;
        return 'reject';
      }
      return 'accept';
    };
  }

  markedTo(conversationId, frameId, which) {
    const out = [];
    for (const [userId, held] of this.marks.get(conversationId) || []) {
      if (held[which] && held[which] >= frameId) out.push(userId);
    }
    return out;
  }

  typistsIn(conversationId) {
    const now = Date.now();
    const out = [];
    for (const [userId, until] of this.typists.get(conversationId) || []) {
      if (until > now && userId !== this.userId) out.push(userId);
    }
    return out;
  }

  /// MLS requires stepping through every commit (old epoch keys are deleted), so frames above a skip are unopenable. Usually a no-op. Bounded by `HISTORY_PAGE * HISTORY_PAGES`; a longer absence misses the oldest messages.
  async catchUpTo(conversationId, frames) {
    if (!this.home?.dmHistory) return;
    const held = (frames || []).map((f) => f.seq || 0).filter((seq) => seq > 0);
    if (!held.length) return;
    for (let page = 0; page < HISTORY_PAGES; page += 1) {
      // Re-read under the lock each pass; `lastSeq` is what has actually been applied.
      const entry = await this.run(conversationId, () => this.loadGroup(conversationId));
      // Not welcomed yet: paging would only fetch frames the walk steps over.
      if (!entry) return;
      const through = entry.lastSeq || 0;
      // Lowest frame in hand above the mark.
      const next = held.reduce((low, seq) => (seq > through && seq < low ? seq : low), Infinity);
      if (!Number.isFinite(next) || next <= through + 1) return;
      const answer = await this.home.dmHistory(conversationId, {
        after: through, limit: HISTORY_PAGE,
      }).catch(() => null);
      const got = answer?.messages;
      if (!got?.length) return;
      // `incomplete`: a frame is missing. Walk only the unbroken run (a missing commit must not be stepped over) and stop paging.
      if (answer.incomplete) {
        const run = contiguousFrom(got, through);
        if (run.length) await this.sync(conversationId, run, { served: true });
        return;
      }
      await this.sync(conversationId, got, { served: true });
      // No progress: later pages build on an epoch we didn't reach.
      if (this.walkedTo(conversationId) <= through) return;
    }
  }

  /// Frames at or before `lastSeq` are skipped; the first unprocessable frame stops the walk since later ones depend on its key schedule. Never steps over a hole: the sequencer fans out after committing, so frames can arrive out of order, and walking the later one first would move `lastSeq` past a frame that could never be opened. `served`: the page came from the server, so a hole is its answer, not a delay.
  async sync(conversationId, frames, { backfill = false, served = false } = {}) {
    if (backfill) await this.catchUpTo(conversationId, frames);
    const first = await this.walk(conversationId, frames, served);
    if (!first.gap) return first.opened;
    await this.catchUpTo(conversationId, frames);
    const again = await this.walk(conversationId, frames, served);
    return [...first.opened, ...again.opened];
  }

  /// Reports whether it stopped at a hole.
  async walk(conversationId, frames, served) {
    return this.run(conversationId, async () => {
      const ordered = [...frames].sort((a, b) => (a.seq || 0) - (b.seq || 0));
      for (const frame of ordered) {
        if (frame.id && frame.seq) this.seqOf.set(frame.id, frame.seq);
      }
      // Folds first so `recall` knows which frames are tombstoned.
      await this.loadConversationState(conversationId);
      await this.recall(conversationId, ordered);
      let entry = await this.loadGroup(conversationId);
      const opened = [];
      let dirty = false;
      let stopped = false;
      let gap = false;
      let droppedJoin = false;

      for (const frame of ordered) {
        const seq = frame.seq || 0;
        if (entry && seq <= entry.lastSeq) continue;
        // A missing frame sits below this one; see `sync`.
        if (entry && !served && seq > entry.lastSeq + 1) {
          gap = true;
          break;
        }

        // Our own frames were applied when made and can't be re-applied; "own" spans every session of this profile (`isMine`).
        const mine = this.isMine(frame);
        const generation = Number.isInteger(frame.generation) ? frame.generation : null;

        // Frame of a group replaced by StartOver; unopenable and irrelevant.
        if (entry && generation !== null && Number.isInteger(entry.generation)
          && generation < entry.generation) {
          entry.lastSeq = seq;
          dirty = true;
          continue;
        }

        // GroupInfo is a recovery aid and never advances state.
        if (frame.kind === 'groupinfo') {
          if (entry) { entry.lastSeq = seq; dirty = true; }
          continue;
        }

        // A rejoin request isn't an MLS message (processing would throw and stop the walk); note it and step over.
        if (frame.kind === 'rejoin') {
          if (!mine && frame.sender && frame.sender_device) {
            let waiting = this.rejoins.get(conversationId);
            if (!waiting) this.rejoins.set(conversationId, waiting = new Map());
            // Keyed by device, which is what lacks a leaf.
            const signatureKey = rejoinKey(frame.ciphertext);
            waiting.set(signatureKey ? `${frame.sender}|${signatureKey}` : `${frame.sender}|${frame.sender_device}`, {
              userId: frame.sender, deviceId: frame.sender_device,
              ...(signatureKey ? { signatureKey } : {}),
            });
          }
          if (entry) { entry.lastSeq = seq; dirty = true; }
          continue;
        }

        if (frame.kind === 'welcome') {
          // Most Welcomes are for other devices; failing to open one is normal. An openable Welcome is only a candidate: the server holds our public KeyPackages and could forge one, so `admitWelcome` decides. One ordered before this device left is into the group it left (`forget`).
          const before = !entry && seq <= (this.leftAt.get(conversationId) || 0);
          if (!mine && !before) {
            let joined = null;
            try { joined = await this.join(decodeMessage(frame.ciphertext)); } catch { /* not ours */ }
            if (joined) {
              let refusal;
              try {
                refusal = await this.admitWelcome(conversationId, entry, joined, generation);
              } catch (e) {
                // Identity check unanswered: neither joining nor skipping is safe; retry next sync.
                this.failed.set(conversationId, e);
                stopped = true;
                break;
              }
              if (!refusal) {
                entry = { state: joined, lastSeq: seq, generation };
                dirty = true;
                this.failed.delete(conversationId);
                this.topUpSoon();
                continue;
              }
              console.warn('refused a welcome', conversationId, refusal);
            }
          }
          // Walk past it so it doesn't read as a hole.
          if (entry) { entry.lastSeq = seq; dirty = true; }
          continue;
        }

        // Our commit whose answer never came (`sendCommit`): its echo settles it. Another commit at its epoch means it lost the race.
        if (frame.kind === 'commit') {
          const pending = entry ? entry.pending : this.joining.get(conversationId);
          if (pending) {
            const ours = frame.frame_id === pending.frameId
              || frameIdOf(frame.ciphertext) === pending.frameId;
            if (ours) {
              entry = this.pendingEntry(entry, pending, seq);
              if (generation !== null) entry.generation = generation;
              this.joining.delete(conversationId);
              this.published.delete(conversationId);
              this.staleJoins.delete(conversationId);
              droppedJoin = false;
              dirty = true;
              continue;
            }
            if (Number(frame.epoch || 0) >= pending.epoch) {
              if (entry) {
                entry.pending = null;
                dirty = true;
              } else {
                this.joining.delete(conversationId);
                droppedJoin = true;
              }
            }
          }
        }

        // Before being welcomed in, frames stay unopened.
        if (!entry || mine) {
          if (entry) { entry.lastSeq = seq; dirty = true; }
          continue;
        }

        // A commit the policy forbids is refused, not skipped: later history builds on its epoch, so the walk stops and reports why.
        const verdict = { reason: null };
        try {
          const message = decodeMessage(frame.ciphertext);
          const origin = await this.senderOf(entry.state, message);
          // Our own frame from a session whose device id isn't in `isMine`'s list: processing would fail (this state already spent that generation) and stop the walk forever. Detect by key, not id.
          if (!mine && origin?.signatureKey
            && await this.ownSignatureKey(origin.signatureKey)) {
            // Learn the id so later frames skip the crypto.
            this.mergeOwnDevices(origin.deviceId).catch(() => {});
            entry.lastSeq = seq;
            dirty = true;
            continue;
          }
          // Non-commits from a revoked device are skipped; its commits reach the gate, which refuses them.
          if (frame.kind !== 'commit' && origin?.signatureKey
            && this.isRevokedKey?.(origin.userId, encode64(origin.signatureKey))) {
            entry.lastSeq = seq;
            dirty = true;
            continue;
          }
          const result = await processMessage(
            message, entry.state, emptyPskIndex, this.gate(entry.state, verdict, message), this.cs,
          );
          if (result.kind === 'newState' && result.actionTaken === 'reject' && verdict.skipped) {
            entry.state = result.newState;
            entry.lastSeq = seq;
            dirty = true;
            continue;
          }
          if (result.kind === 'newState' && result.actionTaken === 'reject') {
            this.failed.set(conversationId, new Error(
              `a change to this group was refused: ${verdict.reason || 'it broke the group’s membership policy'}`,
            ));
            stopped = true;
            break;
          }
          entry.state = result.newState;
          if (result.kind === 'applicationMessage') {
            const payload = unpack(result.message);
            if (payload.type === 'message') {
              await this.keep(conversationId, frame.id, payload.text);
              opened.push(frame.id);
              // Acknowledge messages only (receipts of receipts would loop), and not this account's own.
              if (frame.sender !== this.userId) this.noteDelivered(conversationId, frame.id, seq);
            } else {
              this.absorb(conversationId, frame, payload, origin);
              await this.mark(conversationId, frame.id, payload.type);
            }
          }
        } catch (e) {
          // A frame from an older epoch sequenced after our external commit but written before it; step over it so a late rejoin doesn't lock the conversation.
          const ours = Number(entry.state.groupContext.epoch);
          const theirs = Number(frame.epoch || 0);
          if (theirs > 0 && theirs < ours) {
            entry.lastSeq = seq;
            dirty = true;
            continue;
          }
          // Otherwise stop: continuing past a divergence leaves silent holes.
          this.failed.set(conversationId, e);
          stopped = true;
          break;
        }
        // Opened, so it is this group's generation.
        if (generation !== null && !Number.isInteger(entry.generation)) entry.generation = generation;
        entry.lastSeq = seq;
        dirty = true;
      }

      if (droppedJoin && !entry) await this.forget(conversationId);
      if (entry && dirty) await this.saveGroup(conversationId, entry);
      // No echo by the end: resend under the same frame id (idempotent).
      if (!gap && !stopped && (entry ? entry.pending : this.joining.has(conversationId))) {
        try {
          entry = (await this.settlePending(conversationId, entry)) || entry;
        } catch (e) {
          console.warn('a commit of this device is still unanswered', conversationId, e);
        }
      }
      // Clear stale errors on any non-stopped pass, even with no entry.
      if (!stopped) this.failed.delete(conversationId);
      // One GroupInfo per sync.
      if (entry) await this.publishGroupInfo(conversationId, entry.state);
      return { opened, gap };
    });
  }

  /// Null accepts; else the refusal reason; throws if an identity check couldn't be reached. The group id must be this conversation's; a group this device still uses is replaced only by a fresh one (epoch 1, not an older generation), while a device removed from its tree or with a stopped walk may be re-added at any epoch; every other leaf passes the claimed-KeyPackage check, so a replacement admits no stranger on a legacy unsigned leaf.
  async admitWelcome(conversationId, entry, joined, generation = null) {
    const groupId = joined.groupContext?.groupId;
    if (!groupId || !sameBytes(new Uint8Array(groupId), te.encode(conversationId))) {
      return 'it is for a different group';
    }
    let before = null;
    if (entry) {
      before = new Set();
      let stillIn = false;
      for (const node of entry.state.ratchetTree || []) {
        if (!node || node.nodeType !== 'leaf') continue;
        const who = identityOf(node.leaf?.credential);
        if (who) before.add(who.userId);
        if (await this.ownSignatureKey(node.leaf?.signaturePublicKey)) stillIn = true;
      }
      // Fresh also means not older than the held generation; the same one is accepted since clients without generations restart at epoch 1.
      const current = !Number.isInteger(generation) || !Number.isInteger(entry.generation)
        || generation >= entry.generation;
      const fresh = Number(joined.groupContext.epoch) === 1 && current;
      if (stillIn && !this.failed.has(conversationId) && !fresh) {
        return 'it would replace a group this device is still in';
      }
    }
    for (const node of joined.ratchetTree || []) {
      if (!node || node.nodeType !== 'leaf') continue;
      const key = node.leaf?.signaturePublicKey;
      if (await this.ownSignatureKey(key)) continue;
      const who = identityOf(node.leaf?.credential);
      if (!who || !key) return 'it holds a leaf with no identity';
      if (!this.verifyClaimedPackage) continue;
      const verdict = await this.verifyClaimedPackage(who.userId, who.deviceId, encode64(key));
      if (verdict === false) return `${who.userId} (${who.deviceId}) is not a device their identity signed`;
      if (verdict !== true && before && !before.has(who.userId)) {
        return `${who.userId} was not in this conversation's group`;
      }
    }
    return null;
  }

  /// Tries each stored package.
  async join(message) {
    if (message.wireformat !== 'mls_welcome') throw new Error('not a welcome');
    const stored = await all(PACKAGES, this.scope);
    let last = null;
    for (const row of stored) {
      const decoded = decodeMlsMessage(new Uint8Array(row.publicPackage), 0);
      if (!decoded || decoded[0].wireformat !== 'mls_key_package') continue;
      try {
        return await joinGroup(
          message.welcome, decoded[0].keyPackage,
          {
            initPrivateKey: new Uint8Array(row.privatePackage.initPrivateKey),
            hpkePrivateKey: new Uint8Array(row.privatePackage.hpkePrivateKey),
            signaturePrivateKey: new Uint8Array(row.privatePackage.signaturePrivateKey),
          },
          emptyPskIndex, this.cs,
        );
      } catch (e) { last = e; }
    }
    throw last || new Error('this welcome was not addressed to any key this device holds');
  }

  async remember(conversationId, frameId, body) {
    await put(OPENED, `${this.scope}:${frameId}`, body).catch(() => {});
    // Mirror it so the next sign-in can read it.
    this.backup?.queue(conversationId, frameId, body);
  }

  /// Persistent, since it can't be decrypted again.
  async mark(conversationId, frameId, type) {
    this.signals.add(frameId);
    if (type) this.signalKinds.set(frameId, type);
    await put(OPENED, `${this.scope}:${frameId}`, SIGNAL).catch(() => {});
    this.backup?.queue(conversationId, frameId, SIGNAL);
  }

  /// Also records authorship for every frame.
  async recall(conversationId, frames) {
    for (const frame of frames) {
      if (frame.kind !== 'application') continue;
      this.noteAuthor(conversationId, frame.id, frame.sender);
      if (this.plaintext.has(frame.id) || this.signals.has(frame.id)) continue;
      if (this.isDeleted(conversationId, frame.id)) continue;
      const held = await get(OPENED, `${this.scope}:${frame.id}`).catch(() => undefined);
      if (held === SIGNAL) this.signals.add(frame.id);
      else if (held !== undefined) this.plaintext.set(frame.id, decodeBody(held));
    }
  }

  /// Undefined means this device cannot read the frame.
  textOf(frameId) { return this.plaintext.get(frameId)?.text; }

  /// What was quoted at send time, or null.
  replyOf(frameId) { return this.plaintext.get(frameId)?.reply || null; }

  attachmentsOf(frameId) { return this.plaintext.get(frameId)?.attachments || []; }

  /// Only the opener can tell.
  isSignal(frameId) { return this.signals.has(frameId); }

  /// `message`, the signal's type, or `undefined` for a frame never opened (`frameMayInterrupt` treats that as a message). Frames recalled from disk give `unknown`.
  payloadTypeOf(frameId) {
    if (this.plaintext.has(frameId)) return 'message';
    if (this.signals.has(frameId)) return this.signalKinds.get(frameId) || 'unknown';
    return undefined;
  }

  errorFor(conversationId) { return this.failed.get(conversationId); }
}

// Shared with guild-call-keys.js so call leaves are judged like conversation leaves.
