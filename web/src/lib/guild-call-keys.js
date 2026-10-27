// E2EE for a guild call on an SFU. Each call makes its own MLS group from its devices. The server orders commits and names the next committer but cannot add a device: every leaf must carry its account's cross-signed device key, else leave.

import {
  createCommit, createGroup, defaultLifetime, emptyPskIndex, encodeMlsMessage,
  generateKeyPackageWithKey, joinGroup, mlsExporter, processMessage,
} from 'ts-mls';
import { capabilities, decodeMessage, encode64, identityOf, wire } from './mls.js';
import { sleep } from './util.js';

/// Distinct from a conversation's.
export const GUILD_MEDIA_LABEL = 'telium guild call media v1';

const te = new TextEncoder();

/// How long a member behind the server waits for the catch-up commit.
export const BEHIND_GRACE_MS = 3000;
export const TEND_RETRY_MS = 2000;
const TEND_RETRIES = 5;
export const VOUCH_BACKOFF_MS = [500, 1500];
/// How long to keep talking to a device whose account is unreachable before leaving.
export const DOUBT_MS = 60000;
/// Welcome wait before asking the server, and tries.
export const WELCOME_MS = 10000;
const WELCOME_TRIES = 3;


/// Fallback committer: the longest-standing member.
export function committerOf(roster) {
  const members = (roster || []).filter((v) => v.e2ee_member);
  members.sort((a, b) => ((a.joined_at ?? 0) - (b.joined_at ?? 0))
    || (a.user_id < b.user_id ? -1 : a.user_id > b.user_id ? 1 : 0));
  return members[0]?.user_id || null;
}

export function leavesOf(tree) {
  const out = [];
  (tree || []).forEach((node, index) => {
    if (index % 2 || node?.nodeType !== 'leaf') return;
    const who = identityOf(node.leaf?.credential);
    out.push({ index: index / 2, userId: who?.userId || null, deviceId: who?.deviceId || null, leaf: node.leaf });
  });
  return out;
}

/// A leaf goes when its account left, is on a different device, or is waiting again (it rejoined). Everyone waiting is added. The committer's own leaf is never touched.
export function planChange(leaves, participants, me) {
  const byUser = new Map((participants || []).map((p) => [p.user_id, p]));
  const removes = [];
  for (const leaf of leaves) {
    if (leaf.userId === me) continue;
    const p = byUser.get(leaf.userId);
    if (!p || p.device_id !== leaf.deviceId || !p.member) removes.push(leaf.index);
  }
  const adds = (participants || []).filter((p) => !p.member && p.key_package && p.user_id !== me);
  return { removes, adds };
}

/// Network, timeout, busy server.
function unanswered(e) {
  if (e?.unknown) return true;
  const status = e?.status;
  return !status || status === 408 || status === 429 || status >= 500;
}

const disowned = (userId) => new Error(
  `A device in this call claims to be ${userId}, but their account never signed it, so this device left.`,
);

export class GuildCallKeys {
  /// `onTrouble(error)`: the call can't be trusted and should end. `onLost(error)`: rejoin with a fresh leaf (without it, the call ends).
  constructor({
    mls, api, channelId, me, onKey, onTrouble, onLost, roster,
    grace = BEHIND_GRACE_MS, retryMs = TEND_RETRY_MS, vouchBackoff = VOUCH_BACKOFF_MS,
    doubtMs = DOUBT_MS, welcomeMs = WELCOME_MS,
  }) {
    this.mls = mls;
    this.api = api;
    this.channelId = channelId;
    this.me = me;
    this.onKey = onKey || (() => {});
    this.onTrouble = onTrouble || (() => {});
    this.onLost = onLost || ((e) => this.onTrouble(e));
    this.roster = roster || (() => []);
    this.groupId = null;
    this.state = null;
    this.pkg = null;
    this.offered = null;
    this.latest = null;
    this.early = [];
    this.chain = Promise.resolve();
    this.trusted = new Map();
    this.doubts = new Map();
    this.recheck = null;
    this.waiting = null;
    this.sent = null;
    this.retry = null;
    this.retries = 0;
    this.grace = grace;
    this.retryMs = retryMs;
    this.vouchBackoff = vouchBackoff;
    this.doubtMs = doubtMs;
    this.welcomeMs = welcomeMs;
    this.committer = null;
    this.welcomeTries = 0;
    this.lost = false;
    this.stopped = false;
  }

  get epoch() { return this.state ? Number(this.state.groupContext.epoch) : null; }

  /// A commit against a half-replaced state would fork this device.
  run(fn) {
    const next = this.chain.then(() => (this.stopped ? null : fn()));
    this.chain = next.catch((e) => {
      if (!this.stopped) this.onTrouble(e);
    });
    return next;
  }

  async offer() {
    const pair = await this.mls.signatureKeyPair();
    this.pkg = await generateKeyPackageWithKey(
      this.mls.credential(), capabilities(), defaultLifetime, [], pair, this.mls.cs,
    );
    this.offered = encode64(wire.keyPackage(this.pkg.publicPackage));
    return this.offered;
  }

  begin(info) {
    return this.run(async () => {
      this.groupId = info.group_id;
      if (info.member) await this.found();
      else this.expect();
      const early = this.early;
      this.early = [];
      for (const d of early) await this.apply(d);
    });
  }

  hear(d) {
    return this.run(async () => {
      if (!this.groupId) { this.early.push(d); return; }
      await this.apply(d);
    });
  }

  async apply(d) {
    if (d.op === 'reset') {
      if (d.group_id === this.groupId && this.state) return;
      this.groupId = d.group_id;
      this.state = null;
      if (d.founder === this.me) await this.found();
      else this.expect();
      return;
    }
    if (d.op === 'committer') {
      if (d.group_id && d.group_id !== this.groupId) {
        // An announcement from a group this device is not part of: it missed
        // the move (a reset or a commit while its gateway was quiet). Ask the
        // server where things stand now rather than at the next roster move.
        this.check();
        return;
      }
      this.committer = d.committer || null;
      // Named to write, perhaps because the last went quiet: look now. Not awaited; already queued.
      if (this.committer === this.me) this.tend();
      return;
    }
    if (d.op === 'refused') {
      // The committer will never add this session's package.
      if (d.user_id === this.me && !this.state) this.lose();
      return;
    }
    if (d.op !== 'commit') return;
    if (d.group_id !== this.groupId) {
      this.check();
      return;
    }
    if (!this.state) {
      await this.enter(d);
      return;
    }
    // Our own commit, already applied when accepted.
    if (d.epoch <= this.epoch) return;
    // A gateway reconnect doesn't replay the relay; skipped commits are read back, and only if that fails is the group unfollowable.
    if (d.epoch !== this.epoch + 1) {
      await this.catchUp();
      if (this.state && d.epoch > this.epoch) this.lose();
      return;
    }
    if (!(await this.follow(d))) this.lose();
  }

  /// `quiet` when read from the log, where a Welcome for a dropped package is just old.
  async enter(d, { quiet = false } = {}) {
    if (!d.welcome || !(d.added || []).includes(this.me)) return false;
    const message = decodeMessage(d.welcome);
    if (message.wireformat !== 'mls_welcome') return false;
    let state;
    try {
      state = await joinGroup(
        message.welcome, this.pkg.publicPackage, this.pkg.privatePackage, emptyPskIndex, this.mls.cs,
      );
    } catch {
      // Either for a pre-rejoin package or the Welcome meant for this one; `check` asks the server.
      if (!quiet) this.check();
      return false;
    }
    clearTimeout(this.waiting);
    this.waiting = null;
    await this.admit(state);
    return true;
  }

  /// False when it won't process, which nothing after it can mend.
  async follow(d) {
    // Ours after all: the server took it and the answer was lost. MLS can't process its own commit.
    const sent = this.sent;
    this.sent = null;
    if (sent && sent.epoch === this.epoch && sent.commit === d.commit) {
      await this.admit(sent.newState);
      return true;
    }
    let result;
    try {
      result = await processMessage(
        decodeMessage(d.commit), this.state, emptyPskIndex, () => 'accept', this.mls.cs,
      );
    } catch {
      return false;
    }
    const mine = leavesOf(result.newState.ratchetTree)
      .some((l) => l.userId === this.me && l.deviceId === this.mls.deviceId);
    if (!mine) {
      // Removed: a fresh leaf is on its way.
      this.state = null;
      this.expect();
      return true;
    }
    await this.admit(result.newState);
    return true;
  }

  /// All of them if it holds nothing, to find its Welcome. True if the log read through without a gap.
  async catchUp() {
    if (!this.api.voiceE2eeCommits) return false;
    let log;
    try {
      log = await this.api.voiceE2eeCommits(this.channelId, this.state ? this.epoch : 0);
    } catch {
      return false;
    }
    if (this.stopped || !log || log.group_id !== this.groupId) return false;
    for (const c of log.commits || []) {
      if (this.stopped) return false;
      if (c.group_id && c.group_id !== this.groupId) return false;
      if (!this.state) {
        await this.enter(c, { quiet: true });
        continue;
      }
      if (c.epoch <= this.epoch) continue;
      // Older than the server keeps: no catching up.
      if (c.epoch !== this.epoch + 1) return false;
      if (!(await this.follow(c))) return false;
    }
    return true;
  }

  async found() {
    this.state = await createGroup(
      te.encode(this.groupId), this.pkg.publicPackage, this.pkg.privatePackage, [], this.mls.cs,
    );
    await this.install();
  }

  /// A new epoch needs every leaf vouched for by its account; an unsigned device was put there by someone else, so this device leaves. An unreachable account is let in and re-asked (a slow homeserver shouldn't end the call); a no, or silence for `doubtMs`, ends it.
  async admit(state) {
    const doubts = new Map();
    for (const leaf of leavesOf(state.ratchetTree)) {
      if (!leaf.userId || !leaf.deviceId || !leaf.leaf?.signaturePublicKey) {
        throw new Error('This call’s encryption group holds a device that does not say whose it is, so this device left.');
      }
      if (leaf.userId === this.me && leaf.deviceId === this.mls.deviceId) continue;
      const key = encode64(leaf.leaf.signaturePublicKey);
      const verdict = await this.vouched(leaf.userId, leaf.deviceId, key);
      if (verdict === 'no') throw disowned(leaf.userId);
      if (verdict === 'unknown') {
        const id = `${leaf.userId}|${leaf.deviceId}|${key}`;
        doubts.set(id, this.doubts.get(id) || {
          userId: leaf.userId, deviceId: leaf.deviceId, key, since: Date.now(),
        });
      }
    }
    if (this.stopped) return;
    this.state = state;
    clearTimeout(this.waiting);
    this.waiting = null;
    this.doubts = doubts;
    this.doubt();
    await this.install();
  }

  /// Re-asks about every device whose account hasn't answered.
  doubt() {
    if (this.stopped || this.recheck || !this.doubts.size) return;
    this.recheck = setTimeout(() => {
      this.recheck = null;
      this.run(async () => {
        // Out of the group since.
        if (!this.state) return;
        for (const [id, d] of this.doubts) {
          const verdict = await this.vouched(d.userId, d.deviceId, d.key);
          if (this.stopped || this.doubts.get(id) !== d) continue;
          if (verdict === 'no') throw disowned(d.userId);
          if (verdict === 'yes') this.doubts.delete(id);
          else if (Date.now() - d.since >= this.doubtMs) {
            throw new Error(`Nobody could reach ${d.userId}’s account to check the device they are calling from, so this device left.`);
          }
        }
        this.doubt();
      });
    }, this.retryMs);
  }

  vouched(userId, deviceId, key) {
    const id = `${userId}|${deviceId}|${key}`;
    if (!this.trusted.has(id)) {
      const check = this.verify(userId, deviceId, key);
      this.trusted.set(id, check);
      // Only a yes is kept; a no may be a one-off lookup failure.
      check.then((v) => { if (v !== 'yes' && this.trusted.get(id) === check) this.trusted.delete(id); });
    }
    return this.trusted.get(id);
  }

  /// Retried after a pause since it is two lookups, often cross-server. Persistent no is no; persistent silence is 'unknown'.
  async verify(userId, deviceId, key) {
    if (!this.mls.verifyClaimedPackage) return 'yes';
    for (let attempt = 0; ; attempt += 1) {
      let verdict;
      try {
        verdict = await this.mls.verifyClaimedPackage(userId, deviceId, key) === false ? 'no' : 'yes';
      } catch (e) {
        verdict = unanswered(e) ? 'unknown' : 'no';
      }
      if (verdict === 'yes') return verdict;
      if (attempt >= this.vouchBackoff.length || this.stopped) return verdict;
      await sleep(this.vouchBackoff[attempt]);
    }
  }

  async install() {
    if (this.stopped) return;
    const raw = new Uint8Array(await mlsExporter(
      this.state.keySchedule.exporterSecret, GUILD_MEDIA_LABEL,
      te.encode(`${this.channelId}|${this.groupId}`), 32, this.mls.cs,
    ));
    if (this.stopped) return;
    this.latest = { raw, epoch: this.epoch };
    await this.onKey(raw, this.epoch);
  }

  /// After `welcomeMs` it asks the server: already a member means the Welcome is in the log; refused means it never comes; waiting means retry a few times, then take a fresh seat.
  expect(again = false) {
    clearTimeout(this.waiting);
    this.waiting = null;
    if (!again) this.welcomeTries = 0;
    if (this.stopped || this.state) return;
    this.waiting = setTimeout(() => {
      this.waiting = null;
      if (!this.state) this.run(() => this.waited());
    }, this.welcomeMs);
  }

  async waited() {
    if (this.state || this.lost) return;
    let view = null;
    try { view = await this.api.voiceE2ee(this.channelId); } catch { /* asked again below */ }
    if (this.stopped || this.state) return;
    // A server that doesn't say where this session stands: the Welcome isn't coming.
    if (view && !view.standing) { this.lose(); return; }
    if (view) {
      if (view.committer !== undefined) this.committer = view.committer;
      if (view.standing === 'refused') { this.lose(); return; }
      if (view.standing === 'member') {
        if (view.group_id === this.groupId && await this.catchUp() && this.state) {
          this.tend();
          return;
        }
        this.lose();
        return;
      }
    }
    this.welcomeTries += 1;
    if (this.welcomeTries >= WELCOME_TRIES) { this.lose(); return; }
    this.expect(true);
  }

  /// The server's last named member while still in the group, else the longest-standing.
  committerNow() {
    const roster = this.roster();
    if (this.committer && roster.some((v) => v.user_id === this.committer && v.e2ee_member)) {
      return this.committer;
    }
    return committerOf(roster);
  }

  /// Only the committer acts: one commit adding the waiting and dropping the gone.
  tend() {
    if (this.stopped || this.committerNow() !== this.me) return this.chain;
    return this.run(() => this.change());
  }

  async change() {
    if (!this.state) {
      // The committer holds nothing to commit with: whatever made it a member never reached it.
      this.check();
      return;
    }
    let view;
    try {
      view = await this.api.voiceE2ee(this.channelId);
    } catch {
      this.later();
      return;
    }
    if (this.stopped || !this.state) return;
    if (view.committer !== undefined) this.committer = view.committer;
    if (view.committer && view.committer !== this.me) return;
    if (view.group_id !== this.groupId || view.epoch !== this.epoch) {
      // Ahead of us is a commit on its way or one not coming; `check` waits to see.
      if (view.group_id !== this.groupId || view.epoch > this.epoch) this.check();
      return;
    }
    const participants = view.participants || [];
    const { removes, adds } = planChange(leavesOf(this.state.ratchetTree), participants, this.me);
    const packages = [];
    let skipped = false;
    for (const p of adds) {
      const keyPackage = await this.checked(p);
      if (keyPackage) packages.push({ p, keyPackage });
      // Not vouched for yet; the next look may change that, and nothing else would bring it back.
      else if (keyPackage === undefined) skipped = true;
      // Never going to be added: say so, so it rejoins with a fresh one. Best effort.
      else if (this.api.voiceE2eeRefuse) {
        this.api.voiceE2eeRefuse(this.channelId, { user_id: p.user_id, key_package: p.key_package })
          .catch(() => {});
      }
    }
    if (this.stopped) return;
    if (!removes.length && !packages.length) {
      if (skipped) this.later();
      else this.retries = 0;
      return;
    }
    const commit = await createCommit({ state: this.state, cipherSuite: this.mls.cs }, {
      extraProposals: [
        ...removes.map((removed) => ({ proposalType: 'remove', remove: { removed } })),
        ...packages.map(({ keyPackage }) => ({ proposalType: 'add', add: { keyPackage } })),
      ],
      // The Welcome must carry the tree; there is nowhere else to get it.
      ratchetTreeExtension: true,
    });
    const encoded = encode64(encodeMlsMessage(commit.commit));
    this.sent = null;
    try {
      await this.api.voiceE2eeCommit(this.channelId, {
        group_id: this.groupId,
        epoch: this.epoch,
        commit: encoded,
        welcome: commit.welcome ? encode64(wire.welcome(commit.welcome)) : null,
        added: packages.map(({ p }) => ({ user_id: p.user_id, key_package: p.key_package })),
      });
    } catch (e) {
      // Someone else's commit won, or the request landed anyway; the call goes on.
      if (e?.status !== 409) this.sent = { epoch: this.epoch, commit: encoded, newState: commit.newState };
      // Not ours to write.
      if (e?.body?.code === 'not_committer') {
        this.committer = e.body.committer || null;
        return;
      }
      this.later();
      return;
    }
    this.retries = 0;
    await this.admit(commit.newState);
    if (skipped) this.later();
  }

  /// A few tries at most; the next roster move tends again anyway.
  later() {
    if (this.stopped || this.retry || this.retries >= TEND_RETRIES) return;
    this.retries += 1;
    this.retry = setTimeout(() => {
      this.retry = null;
      this.tend();
    }, this.retryMs);
  }

  /// Whether this session fell silently out of step (missed commit/reset while the gateway was down, or a lost Welcome). Asked twice, `grace` apart, against where the server was the first time; still behind, it reads the log back; only if that fails is it lost.
  async check() {
    const target = await this.run(() => this.behind());
    if (!target) return;
    await sleep(this.grace);
    if (this.stopped || this.reached(target)) return;
    const caught = await this.run(async () => {
      if (this.reached(target)) return true;
      if (this.groupId !== target.group_id) return false;
      await this.catchUp();
      return this.reached(target);
    }).catch(() => false);
    if (this.stopped) return;
    if (!caught) { this.lose(); return; }
    this.tend();
  }

  async behind() {
    if (!this.groupId || this.lost) return null;
    let view;
    try { view = await this.api.voiceE2ee(this.channelId); } catch { return null; }
    const target = {
      group_id: view.group_id,
      epoch: view.epoch,
      member: Boolean((view.participants || []).find((p) => p.user_id === this.me)?.member),
    };
    return this.reached(target) ? null : target;
  }

  /// Same group, held at least to `target` or, holding nothing, not a member by the server's account either.
  reached(target) {
    if (this.groupId !== target.group_id) return false;
    return this.state ? this.epoch >= target.epoch : !target.member;
  }

  /// Only a fresh leaf can follow from here, which means joining again; said once.
  lose() {
    if (this.lost || this.stopped) return;
    this.lost = true;
    this.onLost(new Error('This device lost track of the call’s encryption and cannot hear it. Rejoin the call.'));
  }

  /// Only an MLS KeyPackage whose credential names the device the server filed it under, from a device its account vouches for; anything else is left out.
  async checked(p) {
    let message;
    try { message = decodeMessage(p.key_package); } catch { return null; }
    if (message.wireformat !== 'mls_key_package') return null;
    const leaf = message.keyPackage?.leafNode;
    const who = identityOf(leaf?.credential);
    if (!who || who.userId !== p.user_id || who.deviceId !== p.device_id || !leaf.signaturePublicKey) return null;
    // Undefined rather than null: not this time, as opposed to not ever.
    if (await this.vouched(who.userId, who.deviceId, encode64(leaf.signaturePublicKey)) !== 'yes') return undefined;
    return message.keyPackage;
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retry);
    clearTimeout(this.recheck);
    clearTimeout(this.waiting);
    this.retry = null;
    this.recheck = null;
    this.waiting = null;
    this.doubts = new Map();
    this.sent = null;
    this.state = null;
    this.pkg = null;
    this.early = [];
  }
}
