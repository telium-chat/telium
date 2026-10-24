import { HttpError } from '../api.js';
import { frameIdOf } from '../frame-id.js';
import { frameMayInterrupt } from '../interrupts.js';
import * as vault from '../vault.js';

const PENDING_FRAMES = 200;
const PENDING_CONVERSATIONS = 32;

/// The newest frames, not the oldest: counting up from a floor opened long conversations on years-old frames.
const HISTORY_TAIL = 100;

async function readWindow(home, id) {
  return (await home.dmHistory(id, { tail: HISTORY_TAIL })).messages || [];
}

function generationOf(convo, frames) {
  const newest = frames.reduce((top, f) => (!top || (f.seq || 0) > (top.seq || 0) ? f : top), null);
  if (newest) return Number.isInteger(newest.generation) ? newest.generation : null;
  return Number.isInteger(convo?.generation) ? convo.generation : null;
}

async function sendBeginning(home, id, built, generation) {
  const body = { kind: 'welcome', ciphertext: built.welcome, epoch: built.epoch || 0 };
  if (Number.isInteger(generation)) Object.assign(body, { start_over: true, generation });
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await home.sendFrame(id, body);
    } catch (e) {
      if (!unanswered(e) || attempt >= 3) throw e;
    }
  }
}

function unanswered(e) {
  const status = e?.status;
  return typeof status !== 'number' || status >= 500 || [408, 425, 429].includes(status);
}

async function orderedBeginning(home, id, built, me) {
  const sent = frameIdOf(built.welcome);
  try {
    const frames = await readWindow(home, id);
    return frames.findLast((f) => f.kind === 'welcome' && f.sender === me
      && (f.frame_id === sent || frameIdOf(f.ciphertext) === sent)) || null;
  } catch {
    return null;
  }
}

function lostTheBeginning(e) {
  return e?.status === 409 && e.body?.code === 'generation_conflict';
}

export const dmMethods = {
  noteConversation(d) {
    const convo = this.conversations.find((c) => c.id === d.conversation_id);
    if (!convo) this.refreshConversations().catch(() => {});
  },

  noteActivity(d) {
    if (d.kind !== 'application') return;
    const type = this.mls?.payloadTypeOf(d.id);
    const mine = d.sender === this.me?.user_id;
    if (mine ? type !== 'message' : !frameMayInterrupt(type)) return;
    const convo = this.conversations.find((c) => c.id === d.conversation_id);
    if (!convo) return;
    const at = d.created_at || Date.now();
    if ((convo.last_activity_at || 0) >= at) return;
    convo.last_activity_at = at;
    this.emit('conversations');
  },

  /// Called after the engine opens the frame, never on arrival: only `payloadTypeOf` tells a receipt from a message.
  noteUnseen(d) {
    if (d.kind !== 'application' || d.sender === this.me?.user_id) return false;
    // Requests go to the request inbox, not the attention stream.
    const convo = this.conversations.find((c) => c.id === d.conversation_id);
    if (d.request_state === 'pending' || convo?.request_state === 'pending') return false;
    if (!frameMayInterrupt(this.mls?.payloadTypeOf(d.id))) return false;
    if (this.route.view === 'dms' && this.route.conversationId === d.conversation_id) {
      return false;
    }
    if (convo && !convo.unread) { convo.unread = true; this.emit('conversations'); }
    this.dmUnread.set(d.conversation_id, (this.dmUnread.get(d.conversation_id) || 0) + 1);
    this.emit('unread', null);
    return true;
  },

  /// Buffer for live frames of conversations without loaded history; `dmFrames` can't hold them, where presence means fully loaded.
  pendingFrames(conversationId) {
    if (this.dmPendingFull.has(conversationId)) return null;
    let waiting = this.dmPending.get(conversationId);
    if (!waiting) {
      if (this.dmPending.size >= PENDING_CONVERSATIONS) {
        this.dmPendingFull.add(conversationId);
        return null;
      }
      this.dmPending.set(conversationId, waiting = []);
    }
    if (waiting.length >= PENDING_FRAMES) {
      // Dropped whole: a trimmed buffer has a hole the timeline cannot represent.
      this.dmPending.delete(conversationId);
      this.dmPendingFull.add(conversationId);
      return null;
    }
    return waiting;
  },

  /// Merged by frame id keeping the server's copy, ordered by `seq`.
  loadFrames(conversationId, fetched) {
    const waiting = this.dmPending.get(conversationId);
    this.dmPending.delete(conversationId);
    this.dmPendingFull.delete(conversationId);
    let frames = fetched;
    if (waiting?.length) {
      const held = new Set(fetched.map((f) => f.id));
      const extra = waiting.filter((f) => !held.has(f.id));
      if (extra.length) {
        frames = [...fetched, ...extra].sort((a, b) => (a.seq || 0) - (b.seq || 0));
      }
    }
    this.dmFrames.set(conversationId, frames);
    return frames;
  },

  async refreshCustody() {
    this.custody = await this.home.vaultMode();
    this.emit('vault', this.vault);
    return this.custody;
  },

  /// A moved account's vault needs the recovery key; opening re-wraps under this server's OPAQUE key.
  async unlockVault(secret) {
    if (!this.home) throw new Error('sign in before recovering encrypted DMs');
    const userId = this.session?.home?.user_id || null;
    const {
      looksLikeRecoveryKey, recoveryVaultWrapper,
    } = await import('../account-recovery.js');
    const recoveryWrapper = looksLikeRecoveryKey(secret) ? recoveryVaultWrapper(secret) : null;
    const opened = await vault.load(
      this.home,
      recoveryWrapper ? null : secret,
      userId,
      this.authRecoveryWrapper,
      recoveryWrapper,
    );
    if (opened.locked || !opened.key) {
      throw new Error(recoveryWrapper
        ? 'that recovery key did not open the vault'
        : 'that recovery passphrase did not open the key');
    }
    if (recoveryWrapper) this.accountRecoveryWrapper = recoveryWrapper;

    this.vault = opened;
    this.sync.adoptKeyring(opened, { current: true }).catch(() => {});
    await this.mls?.adoptRecoveryKey(opened);
    this.emit('vault', opened);
    await this.refreshCustody().catch(() => {});
    await this.startTrust().catch(() => {});

    const id = this.route.conversationId;
    if (id && this.mls) await this.openConversation(id);
    return opened;
  },

  async openConversation(id) {
    const listed = this.conversations.find((c) => c.id === id);
    if (listed?.unread) { listed.unread = false; this.emit('conversations'); }
    const convo = await this.loadConversation(id);
    // Opening is the only read receipt a DM has.
    if (this.dmUnread.delete(id)) this.emit('unread', null);
    return convo;
  },

  loadConversation(id) {
    const running = this.dmLoading.get(id);
    if (running) return running;
    const load = this.loadConversationNow(id).finally(() => {
      if (this.dmLoading.get(id) === load) this.dmLoading.delete(id);
    });
    this.dmLoading.set(id, load);
    return load;
  },

  prefetchConversation(id) {
    if (!id || this.dmFrames.has(id)) return;
    this.loadConversation(id).catch(() => {});
  },

  async loadConversationNow(id) {
    const convo = await this.home.conversation(id);
    const window = await readWindow(this.home, id);
    // Merged, not installed: a frame may have landed on the gateway meanwhile.
    const frames = this.loadFrames(id, window);
    if (this.mls) {
      await this.mls.sync(id, frames, { backfill: true }).catch(() => {});
      if (!this.mls.joined(id) && !this.vault?.needs_device) {
        await this.rejoinConversation(id).catch(() => {});
      }
      // No automatic repair of a stopped walk: `forget` would delete the creator's only group state.
      await this.mendConversation(id, convo, window).catch(() => {});
      this.scheduleSignals(id);
      await this.answerRejoins(id);
      await this.settleDepartures(id, convo).catch(() => {});
      await Promise.resolve().then(() => this.mls.removeRevoked?.(id)).catch(() => {});
    }
    // Set last so "loaded once" means the group state was walked too.
    this.dmOpened.set(id, convo);
    this.emit('dm', { conversation_id: id });
    return convo;
  },

  /// Frames landing before `this.mls` is published are buffered, not walked; drain them or they stay undecrypted.
  async drainStartup() {
    if (!this.mls) return;
    const loaded = [...this.dmFrames.entries()];
    const waiting = [...this.dmPending.entries()];
    for (const [id, frames] of [...loaded, ...waiting]) {
      if (!frames?.length) continue;
      const isWindow = this.dmFrames.has(id);
      try {
        await this.mls.sync(id, frames, isWindow ? { backfill: true } : {});
        if (!this.mls.joined(id) && !this.vault?.needs_device) {
          await this.rejoinConversation(id).catch(() => {});
        }
      } catch {}
      this.emit('dm', { conversation_id: id });
    }
  },

  /// The gateway replays nothing on reconnect; a missed commit leaves later frames ciphertext.
  async resumeConversation(domain) {
    if (!this.mls || !domain || domain !== this.home?.domain) return;
    if (this.route.view !== 'dms') return;
    const id = this.route.conversationId;
    if (!id || !this.dmFrames.has(id)) return;
    await this.openConversation(id).catch(() => {});
  },

  /// Retried twice on 409: the sequencer refuses a commit built on a stale epoch.
  async rejoinConversation(id, attempt = 0) {
    let frames = this.dmFrames.get(id) || [];
    if (attempt) {
      frames = this.loadFrames(id, await readWindow(this.home, id));
    }
    try {
      if (!(await this.mls.selfJoin(id, frames))) {
        // `selfJoin` also says no when another tab already joined; asking again would put a needless request in the stream.
        if (this.mls.joined(id)) {
          this.rejoinBlocked.delete(id);
          await this.mls.sync(id, this.loadFrames(id, await readWindow(this.home, id))).catch(() => {});
          this.emit('dm', { conversation_id: id });
          return true;
        }
        // No openable GroupInfo: re-reading cannot fix it, so ask a device that is inside.
        await this.askToRejoin(id);
        return false;
      }
      this.rejoinBlocked.delete(id);
    } catch (e) {
      if (!(e instanceof HttpError && e.status === 409)) throw e;
      if (attempt < 2) return this.rejoinConversation(id, attempt + 1);
      if (this.mls.joined(id)) return true;
      await this.askToRejoin(id);
      return false;
    }
    const fresh = this.loadFrames(id, await readWindow(this.home, id));
    await this.mls.sync(id, fresh).catch(() => {});
    this.emit('dm', { conversation_id: id });
    return true;
  },

  async catchUpConversation(id) {
    if (!this.mls) return;
    const fresh = this.loadFrames(id, await readWindow(this.home, id));
    await this.mls.sync(id, fresh, { backfill: true });
    this.emit('dm', { conversation_id: id });
  },

  async askToRejoin(id) {
    try {
      await this.mls.requestRejoin(id);
      this.rejoinBlocked.delete(id);
    } catch (e) {
      this.rejoinBlocked.set(id, e);
    }
  },

  /// Once per conversation per session: a claim can spend a key package.
  async mendConversation(id, convo, window) {
    if (!this.mls || !convo || this.vault?.needs_device) return;
    if (this.dmMended.has(id)) return;
    const me = this.me?.user_id;
    const members = (convo.members || [])
      .filter((m) => !m.state || m.state === 'joined')
      .map((m) => m.user_id || m)
      .filter(Boolean);
    if (!this.mls.joined(id)) {
      const traces = window.some((f) => ['welcome', 'commit', 'groupinfo', 'application'].includes(f.kind));
      const whole = Number(convo.last_seq || 0) <= window.length;
      if (convo.creator !== me || traces || !whole || !members.length) return;
      this.dmMended.add(id);
      const from = window.reduce((high, f) => Math.max(high, f.seq || 0), 0);
      const generation = generationOf(convo, window);
      const built = await this.mls.establish(id, members, { from, ifAbsent: true, generation });
      if (built?.welcome) {
        try {
          await sendBeginning(this.home, id, built, generation);
        } catch (e) {
          if (!lostTheBeginning(e)) throw e;
          await this.mls.forget(id);
        }
      }
      this.rejoinBlocked.delete(id);
      return;
    }
    if (convo.kind !== 'dm') return;
    const inTree = new Set(this.mls.devicesIn(id).map((d) => d.userId));
    const absent = members.filter((u) => !inTree.has(u));
    if (!absent.length) return;
    this.dmMended.add(id);
    await this.rebased(id, () => this.mls.addMembers(id, absent, { lenient: true }));
  },

  /// On a 409 walk to the newest epoch and rebuild; if the walk does not move the epoch, report instead of retrying.
  async rebased(id, commit, attempts = 3) {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await commit();
      } catch (e) {
        if (!(e instanceof HttpError) || e.status !== 409) throw e;
        const before = this.mls.epochOf(id);
        const fresh = this.loadFrames(id, await readWindow(this.home, id));
        await this.mls.sync(id, fresh, { backfill: true }).catch(() => {});
        if (attempt >= attempts || this.mls.epochOf(id) <= before) {
          const stuck = new Error('This conversation’s encryption could not catch up with a change another member made, so this was not applied. Try again after it has synced.');
          stuck.cause = e;
          throw stuck;
        }
      }
    }
  },

  /// A person asks for this; doing it automatically would let one confused device re-key a working conversation.
  async resetConversation(id) {
    if (!this.mls) throw new Error('Encryption is not available in this session.');
    const convo = this.conversations.find((c) => c.id === id);
    const members = (convo?.members || []).map((m) => m.user_id || m).filter(Boolean);
    if (!members.length) throw new Error('This conversation has no members to add.');

    // Read first for the watermark: the new group starts after the newest frame.
    const before = await readWindow(this.home, id);
    const from = before.reduce((high, f) => Math.max(high, f.seq || 0), 0);
    // The sequencer orders a start-over only from this generation, so two members pressing it make one group.
    const generation = generationOf(convo, before);

    const built = await this.mls.establish(id, members, { from, generation, stage: true });
    const others = members.filter((m) => m !== this.me?.user_id);
    if (others.length && !built.welcome) {
      throw new Error(built.rejected?.length
        ? `${built.rejected.join(', ')} did not present a KeyPackage signed by a trusted device identity, so it was not added.`
        : built.missing?.length
          ? `${built.missing.join(', ')} has no key published to add, so there is nobody to start over with. That device has to sign in once first.`
          : 'Nobody else could be added to a new group, so nothing was changed.');
    }
    if (built.welcome) {
      let answer = null;
      try {
        answer = await sendBeginning(this.home, id, built, generation);
      } catch (e) {
        // No answer is not "not ordered": dropping the staged group would strand the sender.
        if (unanswered(e)) answer = await orderedBeginning(this.home, id, built, this.me?.user_id);
        if (answer) return this.installBeginning(id, built, answer);
        if (!lostTheBeginning(e)) throw e;
        const fresh = this.loadFrames(id, await readWindow(this.home, id));
        await this.mls.sync(id, fresh).catch(() => {});
        this.emit('dm', { conversation_id: id });
        return { welcome: null, missing: [], rejected: [], superseded: true, generation: e.body.generation };
      }
      return this.installBeginning(id, built, answer);
    }
    return this.installBeginning(id, built, null, generation);
  },

  async installBeginning(id, built, answer, fallback = null) {
    const taken = answer ? (Number.isInteger(answer.generation) ? answer.generation : null) : fallback;
    await this.mls.install(id, { ...built.entry, generation: taken });
    const fresh = this.loadFrames(id, await readWindow(this.home, id));
    await this.mls.sync(id, fresh).catch(() => {});
    this.emit('dm', { conversation_id: id });
    const { entry: _entry, ...shown } = built;
    return { ...shown, generation: taken };
  },

  /// Proposes leaves before telling the server, while it still lets this account post.
  async leaveConversation(id) {
    const left = await this.mls?.proposeLeave(id)
      .catch((e) => { console.warn('could not propose leaving the group', id, e); return null; });
    await this.home.leaveConversation(id);
    await this.mls?.forget(id, { leftAt: left?.through || this.mls.walkedTo?.(id) || 0 });
  },

  async settleDepartures(id, convo = null, also = []) {
    if (!this.mls) return;
    const descriptor = convo || this.conversations.find((c) => c.id === id);
    const departed = new Set(also);
    for (const m of descriptor?.members || []) {
      if (m.state !== 'active' && m.resync) departed.add(m.user_id);
    }
    if (!departed.size) return;
    try {
      await this.mls.removeDeparted(id, [...departed]);
    } catch (e) {
      if (!(e instanceof HttpError && e.status === 409)) throw e;
    }
  },
  async answerRejoins(id) {
    if (!this.mls) return;
    const asking = this.mls.takeRejoins(id);
    if (asking.length) await this.admitSigned(id, asking);
  },

  /// Own sibling devices must be signed by the anchored identity; another person's rejoin also needs verification.
  async admitSigned(id, asking) {
    if (!this.trust || !asking?.length) return;
    const signed = [];
    for (const row of asking) {
      if (await this.trust.authorizedRejoinDevice(row.userId, row.deviceId, row.signatureKey || null).catch(() => false)) {
        signed.push(row);
      }
    }
    if (signed.length) await this.admit(id, signed);
  },

  async admit(id, asking) {
    if (!this.mls) return;
    try {
      const { added } = await this.mls.catchUp(id, asking);
      if (!added) return;
    } catch (e) {
      if (!(e instanceof HttpError && e.status === 409)) this.emit('dm', { conversation_id: id });
      return;
    }
    if (!this.dmFrames.has(id)) return;
    const fresh = await readWindow(this.home, id).catch(() => null);
    if (fresh) {
      await this.mls.sync(id, this.loadFrames(id, fresh), { backfill: true }).catch(() => {});
    }
    this.emit('dm', { conversation_id: id });
  },

  async sendDm(conversationId, text, attachments, reply = null, nonce = null) {
    this.notifyTypingStop(conversationId);
    if (this.vault?.needs_device) {
      throw new Error('Approve this device from another trusted device before sending encrypted DMs.');
    }
    // `this.mls` is published only once the engine can do crypto.
    if (!this.mls) {
      throw new Error('Encryption is not available on this device yet. Try again in a moment.');
    }
    if (!this.mls.joined(conversationId)) await this.rejoinConversation(conversationId);
    this.sending.add(conversationId);
    let frame;
    try {
      frame = await this.mls.send(conversationId, text, attachments, reply);
    } finally {
      this.sending.delete(conversationId);
    }
    // The composer's nonce lets its optimistic row become this message.
    if (nonce && frame) frame.nonce = nonce;
    const list = this.dmFrames.get(conversationId);
    if (list && frame?.id && !list.some((f) => f.id === frame.id)) list.push(frame);
    if (frame?.id) this.noteActivity(frame);
    this.emit('dm', { conversation_id: conversationId });
    return frame;
  },

  async reactDm(conversationId, frameId, emoji) {
    return this.setDmReaction(conversationId, frameId, emoji, 'add');
  },

  async unreactDm(conversationId, frameId, emoji) {
    return this.setDmReaction(conversationId, frameId, emoji, 'remove');
  },

  async setDmReaction(conversationId, frameId, emoji, op) {
    const me = this.mls.userId;
    const held = Boolean(this.mls.reactions?.get(conversationId)?.get(frameId)?.get(me)?.has(emoji));
    const changes = held !== (op === 'add');
    if (changes) {
      this.mls.applyReaction(conversationId, me, { target: frameId, emoji, op });
      this.emit('dm', { conversation_id: conversationId });
    }
    try {
      const frame = op === 'add'
        ? await this.mls.react(conversationId, frameId, emoji)
        : await this.mls.unreact(conversationId, frameId, emoji);
      this.emit('dm', { conversation_id: conversationId });
      return frame;
    } catch (e) {
      if (changes) {
        this.mls.applyReaction(conversationId, me, {
          target: frameId, emoji, op: op === 'add' ? 'remove' : 'add',
        });
        this.emit('dm', { conversation_id: conversationId });
      }
      throw e;
    }
  },

  async editDm(conversationId, frameId, text) {
    return this.drawnAtOnce(conversationId, this.mls.editMessage(conversationId, frameId, text));
  },

  async deleteDm(conversationId, frameId) {
    return this.drawnAtOnce(conversationId, this.mls.deleteMessage(conversationId, frameId));
  },

  async drawnAtOnce(conversationId, sending) {
    this.emit('dm', { conversation_id: conversationId });
    try {
      return await sending;
    } finally {
      this.emit('dm', { conversation_id: conversationId });
    }
  },

  async setPinDm(conversationId, frameId, pin) {
    // Asked before the gesture goes out: `ownGesture` folds the pin in before the send resolves.
    const before = this.conversationOnScreen(conversationId)
      ? this.mls.pinsIn(conversationId).map((p) => p.id)
      : null;
    const frame = await this.mls.setPin(conversationId, frameId, pin);
    this.notePinsMadeSince(conversationId, before);
    this.emit('dm', { conversation_id: conversationId });
    return frame;
  },

  /// `dmOpened` matters: routing precedes the fold, and that first fold carries every historical pin.
  conversationOnScreen(conversationId) {
    return Boolean(conversationId)
      && this.route.view === 'dms'
      && this.route.conversationId === conversationId
      && this.dmOpened.has(conversationId);
  },

  notePinsMadeSince(conversationId, before) {
    if (!before || !this.mls || !this.conversationOnScreen(conversationId)) return;
    const held = new Set(before);
    for (const pin of this.mls.pinsIn(conversationId)) {
      if (!held.has(pin.id)) this.notePinNotice(conversationId, pin.id, pin.by || null);
    }
  },

  /// Separate from `startConversation` because drawing a profile card must not create a DM.
  dmWith(userId) {
    if (!userId) return null;
    return this.conversations.find((c) => {
      if (c.kind !== 'dm') return false;
      const others = (c.members || [])
        .map((m) => m.user_id || m)
        .filter((id) => id && id !== this.me?.user_id);
      return others.length === 1 && others[0] === userId;
    }) || null;
  },

  messageRequests() {
    return this.conversations.filter((c) => c.kind === 'dm' && c.request_state === 'pending');
  },

  pendingMessageRequestCount() {
    return this.messageRequests().length;
  },

  async acceptMessageRequest(conversationId) {
    await this.home.acceptMessageRequest(conversationId);
    await this.refreshConversations();
    return this.conversations.find((c) => c.id === conversationId) || null;
  },

  async declineMessageRequest(conversationId) {
    await this.home.declineMessageRequest(conversationId);
    await this.refreshConversations();
  },

  /// A one-to-one DM is never created twice; the server's claim on the pair is the real guarantee.
  /// Created first because the group id must equal the conversation id.
  async startConversation(memberIds, kind = 'dm', { policy = null } = {}) {
    if (kind !== 'dm' || memberIds.length !== 1) {
      return this.mintConversation(memberIds, kind, policy);
    }
    const peer = memberIds[0];
    const found = this.dmWith(peer);
    // Messaging somebody who messaged you accepts their request; must happen before the caller navigates.
    // Keyed on the peer so two gestures at the same pending row don't both accept.
    if (found?.request_state === 'pending') {
      const accepting = this.startingDms.get(peer);
      if (accepting) return accepting;
      const accept = this.acceptMessageRequest(found.id)
        .then((row) => row || found)
        .finally(() => {
          if (this.startingDms.get(peer) === accept) this.startingDms.delete(peer);
        });
      this.startingDms.set(peer, accept);
      return accept;
    }
    if (found) return found;
    // Keyed on the peer: a `busy` flag in one row cannot see another's click.
    const running = this.startingDms.get(peer);
    if (running) return running;
    const start = this.mintConversation(memberIds, kind, policy)
      .finally(() => {
        if (this.startingDms.get(peer) === start) this.startingDms.delete(peer);
      });
    this.startingDms.set(peer, start);
    return start;
  },

  async mintConversation(memberIds, kind, policy) {
    const withPolicy = kind === 'gc' && policy
      ? { v: 1, creator: this.me.user_id, admins: [], ...policy }
      : null;
    const convo = await this.home.createConversation({
      kind, members: memberIds, ...(withPolicy ? { policy: withPolicy } : {}),
    });
    // Build only when the server says the conversation is new, else a gateway event could skip `establish`.
    const fresh = (convo.creator ?? this.me.user_id) === this.me.user_id
      && !Number(convo.last_seq);
    const generation = Number.isInteger(convo.generation) ? convo.generation : null;
    const built = this.mls && fresh
      ? await this.mls.establish(
        convo.id, [...memberIds, this.me.user_id], { policy: withPolicy, ifAbsent: true, generation },
      )
      : null;
    if (built) {
      if (withPolicy && !built.policy) {
        await this.home.withdrawConversationPolicy(convo.id).catch(() => {});
        convo.policy = null;
        convo.policy_withdrawn = true;
      }
      if (built.welcome) {
        try {
          await sendBeginning(this.home, convo.id, built, generation);
        } catch (e) {
          if (!lostTheBeginning(e)) throw e;
          await this.mls.forget(convo.id);
        }
      }
      convo.missing_devices = built.missing;
      convo.rejected_devices = built.rejected;
    }
    await this.refreshConversations().catch(() => {});
    return convo;
  },

  async setConversationPolicy(conversationId, next) {
    const policy = await this.rebased(conversationId, () => this.mls.setPolicy(conversationId, next));
    this.emit('dm');
    await this.refreshConversations().catch(() => {});
    return policy;
  },

  /// The member row is not written ahead: a refused commit would leave a member the group never let in.
  async addToConversation(conversationId, userId) {
    return this.rebased(conversationId, () => this.mls.addMembers(conversationId, [userId]));
  },

  async removeFromConversation(conversationId, userIds) {
    const done = await this.rebased(conversationId, () => this.mls.removeMembers(conversationId, userIds));
    this.emit('dm');
    await this.refreshConversations().catch(() => {});
    return done;
  },

  /// History does not move: republishing would mean decrypting everyone's messages without consent.
  async promoteConversation(conversationId, { domain, name }) {
    if (!this.apiFor(domain)) throw new Error(`no session on ${domain}`);
    // Re-mint the session: guild creation copies the current profile.
    await this.renewServer(domain);
    const api = this.apiFor(domain);
    const guild = await api.createGuild(name);
    const invite = await api.createInvite(guild.id, {}).catch(() => null);
    const announcement = `This group is becoming a guild: ${name} on ${domain}.`
      + (invite?.code ? ` Join with the invite ${invite.code}.` : '')
      + ' Everything said here stays here, and stays encrypted.';
    const sealed = this.mls
      ? await this.mls.encrypt(conversationId, announcement)
      : { ciphertext: '', epoch: 0 };
    const resp = await this.home.promote(conversationId, {
      guild_id: guild.id,
      announcement: sealed.ciphertext,
    });
    if (this.mls && resp.announcement?.id) {
      await this.mls.keep(resp.announcement.id, announcement);
    }
    // The gateway does not retroactively add us to a guild we just made.
    this.connectServer(domain, this.session.servers[domain]);
    await this.refreshConversations().catch(() => {});
    return { guild, invite };
  },
};
