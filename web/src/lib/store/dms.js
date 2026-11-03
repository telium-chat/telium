import { HttpError } from '../api.js';
import { frameIdOf } from '../frame-id.js';
import { frameMayInterrupt } from '../interrupts.js';
import { KEYS } from '../sync.js';
import { worthRetrying } from '../mls.js';
import * as vault from '../vault.js';

const PENDING_FRAMES = 200;
const PENDING_CONVERSATIONS = 32;

/// The newest frames, not the oldest: counting up from a floor opened long conversations on years-old frames.
const HISTORY_TAIL = 100;
/// One scrollback page; the server clamps harder.
const HISTORY_PAGE = 200;

/// Auto-retry waits between outbox pumps, then gives up and asks the person to resend.
const OUTBOX_BACKOFF = [5_000, 15_000, 30_000, 60_000, 120_000, 300_000];

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

  /// Tell the home how far this account has actually got, so its unread count — and every
  /// other device's badge — settles against the delivery cursor. Debounced per conversation;
  /// the cursor only ever moves forward (the server takes MAX).
  reportDmDelivered(conversationId, seq = 0) {
    const walked = this.mls?.walkedTo?.(conversationId) || 0;
    const next = Math.max(this.dmDeliveredPending?.get(conversationId) || 0, walked, seq);
    this.dmDeliveredPending?.set(conversationId, next);
    if (!next || !this.dmDeliveredTimers || this.dmDeliveredTimers.has(conversationId)) return;
    this.dmDeliveredTimers.set(conversationId, setTimeout(() => {
      this.dmDeliveredTimers?.delete(conversationId);
      const pending = this.dmDeliveredPending?.get(conversationId);
      this.dmDeliveredPending?.delete(conversationId);
      if (!pending) return;
      const sent = this.home?.sendDmDelivered?.(conversationId, pending);
      sent?.catch(() => {});
    }, 1_500));
  },

  /// Conversations the gateway could not tell this device about while it was away: the server
  /// kept every frame, so compare its `last_seq` with the walk watermark each conversation is
  /// at, fetch what moved, and raise the badges the live frames would have raised. A
  /// conversation this device has never walked is left alone: it has no watermark to measure
  /// from, and its first open needs the rejoin flow anyway.
  catchUpDmUnread() {
    if (!this.mls || this.vault?.needs_device) return Promise.resolve();
    if (this.dmCatchUp) return this.dmCatchUp;
    const run = (async () => {
      const stale = this.conversations
        .filter((c) => (c.kind === 'dm' || c.kind === 'gc')
          && !this.conversationOnScreen(c.id)
          && (this.mls.walkedTo(c.id) || 0) > 0
          && (Number(c.last_seq || 0) > (this.mls.walkedTo(c.id) || 0)
            || (this.dmServerUnread?.get(c.id) || 0) > 0))
        .sort((a, b) => Number(b.last_seq || 0) - Number(a.last_seq || 0));
      for (const convo of stale) {
        try { await this.backfillDmUnread(convo.id); } catch { /* the next conversation still counts */ }
      }
    })().finally(() => {
      if (this.dmCatchUp === run) this.dmCatchUp = null;
    });
    this.dmCatchUp = run;
    return run;
  },

  /// One conversation's missed frames: fetch the window, walk it, and settle the delivery
  /// cursor. The badge itself is the server's own count — this snapshot already carries it —
  /// so nothing is counted twice here; what this does is put the frames in hand and tell the
  /// home the account now holds them.
  async backfillDmUnread(conversationId) {
    const walked = this.mls.walkedTo(conversationId) || 0;
    const fetched = await readWindow(this.home, conversationId);
    const merged = this.mergeFrames(conversationId, fetched);
    await this.mls.sync(conversationId, merged, { backfill: true }).catch(() => {});
    const convo = this.conversations.find((c) => c.id === conversationId);
    if (convo?.request_state === 'pending') return;
    const seen = this.conversationOnScreen(conversationId);
    let missed = false;
    for (const frame of merged) {
      if ((frame.seq || 0) <= walked) continue;
      if (frame.kind !== 'application' || frame.sender === this.me?.user_id) continue;
      if (this.mls.isSignal?.(frame.id)) continue;
      const type = this.mls.payloadTypeOf?.(frame.id);
      if (type !== undefined && !frameMayInterrupt(type)) continue;
      missed = true;
      break;
    }
    if (missed && convo && !convo.unread) { convo.unread = true; this.emit('conversations'); }
    this.reportDmDelivered(conversationId);
    if (!seen) this.emit('dm', { conversation_id: conversationId });
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
    // A frame arriving after a read outdates the read: the server snapshot it zeroed is
    // stale in both directions (it still counts the read frames, not this one), so the
    // live counter takes over until the next refresh.
    if (this.dmReadCleared?.delete(d.conversation_id)) {
      this.dmServerUnread?.set(d.conversation_id, 0);
    }
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

  /// Merged by frame id keeping the server's copy, ordered by `seq`. Replaces the loaded window,
  /// so the scrollback floor moves with it.
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
    this.noteOldest(conversationId, frames);
    return frames;
  },

  /// Prepends an older page without dropping anything already in the timeline, including live frames.
  mergeFrames(conversationId, older) {
    const below = new Set(older.map((f) => f.id));
    const current = (this.dmFrames.get(conversationId) || []).filter((f) => !below.has(f.id));
    const waiting = this.dmPending.get(conversationId) || [];
    const known = new Set([...below, ...current.map((f) => f.id)]);
    const extra = waiting.filter((f) => !known.has(f.id));
    this.dmPending.delete(conversationId);
    this.dmPendingFull.delete(conversationId);
    const frames = [...older, ...current, ...extra].sort((a, b) => (a.seq || 0) - (b.seq || 0));
    this.dmFrames.set(conversationId, frames);
    this.noteOldest(conversationId, frames);
    return frames;
  },

  noteOldest(conversationId, frames) {
    const top = frames[0]?.seq;
    if (Number.isInteger(top)) this.dmOldest?.set(conversationId, top);
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
    this.dmReadCleared?.add(id);
    this.reportDmDelivered(id);
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

  /// One page of history below the loaded window, merged into the timeline and walked.
  /// Resolves true when frames were added; deduplicates concurrent callers.
  loadOlderDm(id) {
    if (!id || !this.dmFrames.has(id) || this.dmHistoryEnd.has(id)) return Promise.resolve(false);
    const running = this.dmLoadingOlder.get(id);
    if (running) return running;
    const load = this.loadOlderDmNow(id).finally(() => {
      if (this.dmLoadingOlder.get(id) === load) this.dmLoadingOlder.delete(id);
    });
    this.dmLoadingOlder.set(id, load);
    return load;
  },

  async loadOlderDmNow(id) {
    const floor = this.dmOldest.get(id) ?? (this.dmFrames.get(id) || [])[0]?.seq;
    if (!Number.isInteger(floor) || floor <= 1) {
      this.dmHistoryEnd.add(id);
      this.emit('dm', { conversation_id: id });
      return false;
    }
    let answer;
    try {
      answer = await this.home.dmHistory(id, { before: floor, limit: HISTORY_PAGE });
    } catch (e) {
      this.emit('dm', { conversation_id: id });
      throw e;
    }
    const fetched = answer?.messages || [];
    // A short page is the beginning; an incomplete one has a hole below it that
    // paging cannot cross, so stop here either way.
    if (fetched.length < HISTORY_PAGE || answer?.incomplete) this.dmHistoryEnd.add(id);
    if (fetched.length) {
      const merged = this.mergeFrames(id, fetched);
      if (this.mls) await this.mls.sync(id, merged, { backfill: true }).catch(() => {});
    }
    this.emit('dm', { conversation_id: id });
    return fetched.length > 0;
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
    this.reportDmDelivered(id);
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
    // Set when the send failed but the exact wire body is now queued for retry: the message is
    // not lost, so this resolves instead of throwing, and the composer clears as usual.
    let hold = null;
    this.sending.add(conversationId);
    let frame;
    try {
      frame = await this.mls.send(conversationId, text, attachments, reply, {
        queued: (body, plain) => {
          hold = this.queueDmSend(conversationId, body, plain, { text, attachments, reply, nonce });
        },
      });
    } catch (e) {
      // Queued is not failed: the message is sitting in the outbox, so the composer
      // clears as usual and the row stays pending until the pump lands it.
      if (!hold) throw e;
    } finally {
      this.sending.delete(conversationId);
    }
    if (hold) {
      this.emit('outbox', conversationId);
      return null;
    }
    this.finishSentDm(conversationId, frame, nonce);
    return frame;
  },

  /// What a delivered send does to the timeline, shared by `sendDm` and the outbox pump.
  finishSentDm(conversationId, frame, nonce = null) {
    if (nonce && frame) frame.nonce = nonce;
    const list = this.dmFrames.get(conversationId);
    if (list && frame?.id && !list.some((f) => f.id === frame.id)) list.push(frame);
    if (frame?.id) this.noteActivity(frame);
    this.emit('dm', { conversation_id: conversationId });
  },

  /// A send the wire refused but that may already be sequenced: the only safe retry is the
  /// identical body (the frame id makes a repeat idempotent), so it waits here and pumps.
  queueDmSend(conversationId, body, plain, { text, attachments, reply, nonce }) {
    const entry = {
      key: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      conversationId,
      body,
      plain,
      text,
      attachments: attachments || [],
      reply,
      nonce,
      attempts: 0,
      createdAt: Date.now(),
      nextAt: Date.now(),
      failed: false,
      error: null,
    };
    const queue = this.dmOutbox.get(conversationId) || [];
    queue.push(entry);
    this.dmOutbox.set(conversationId, queue);
    this.persistDmOutbox();
    this.scheduleDmPump(conversationId, 0);
    return entry;
  },

  dmOutboxIn(conversationId) {
    return this.dmOutbox.get(conversationId) || [];
  },

  /// The wait until the next entry worth pumping is due, or null when nothing is waiting.
  /// The pump aims its next wake at this, so no entry can outlast its own backoff timer.
  dmOutboxWait(conversationId) {
    const now = Date.now();
    let wait = null;
    for (const entry of this.dmOutboxIn(conversationId)) {
      if (entry.failed) continue;
      const until = Math.max(0, (entry.nextAt || 0) - now);
      if (wait === null || until < wait) wait = until;
    }
    return wait;
  },

  scheduleDmPump(conversationId, delay) {
    clearTimeout(this.dmOutboxTimers.get(conversationId));
    const timer = setTimeout(() => {
      this.dmOutboxTimers.delete(conversationId);
      this.pumpDmOutbox(conversationId);
    }, delay);
    this.dmOutboxTimers.set(conversationId, timer);
  },

  async pumpDmOutbox(conversationId) {
    if (this.dmOutboxPumping.has(conversationId)) return;
    this.dmOutboxPumping.add(conversationId);
    try {
      const queue = this.dmOutbox.get(conversationId) || [];
      let changed = false;
      for (const entry of [...queue]) {
        if (entry.failed || entry.nextAt > Date.now()) continue;
        try {
          // Same body, same frame id: a repeat answers with the frame the first attempt ordered.
          const frame = await this.home.sendFrame(conversationId, entry.body);
          this.dmOutbox.set(
            conversationId,
            (this.dmOutbox.get(conversationId) || []).filter((e) => e !== entry),
          );
          this.persistDmOutbox();
          // Under the send lock, where the direct path lands its completion too, so another
          // tab receiving the echo cannot read the plaintext store mid-write.
          await this.mls?.run(conversationId, () => this.mls.notedSent(conversationId, frame, entry.plain));
          this.finishSentDm(conversationId, frame, entry.nonce);
        } catch (e) {
          entry.attempts += 1;
          entry.error = e;
          if (!worthRetrying(e) || entry.attempts >= OUTBOX_BACKOFF.length) {
            entry.failed = true;
          } else {
            entry.nextAt = Date.now() + OUTBOX_BACKOFF[Math.min(entry.attempts, OUTBOX_BACKOFF.length) - 1];
          }
        }
        changed = true;
      }
      if (changed) this.emit('outbox', conversationId);
    } finally {
      this.dmOutboxPumping.delete(conversationId);
      // Whatever is still waiting sets the next wake itself: a wake that arrived mid-pump,
      // or a timer an earlier schedule replaced, cannot strand an entry past its backoff.
      const wait = this.dmOutboxWait(conversationId);
      if (wait !== null) this.scheduleDmPump(conversationId, wait);
    }
  },

  /// A failed send the person is sending again: a fresh frame rather than the stored body,
  /// whose keys may have aged out while it waited.
  async resendQueuedDm(conversationId, key) {
    const queue = this.dmOutbox.get(conversationId) || [];
    const entry = queue.find((e) => e.key === key);
    if (!entry) return null;
    this.dmOutbox.set(conversationId, queue.filter((e) => e !== entry));
    this.persistDmOutbox();
    this.emit('outbox', conversationId);
    return this.sendDm(conversationId, entry.text, entry.attachments, entry.reply, entry.nonce);
  },

  dropQueuedDm(conversationId, key) {
    const queue = this.dmOutbox.get(conversationId) || [];
    if (!queue.some((e) => e.key === key)) return;
    this.dmOutbox.set(conversationId, queue.filter((e) => e.key !== key));
    this.persistDmOutbox();
    this.emit('outbox', conversationId);
  },

  persistDmOutbox() {
    const all = {};
    for (const [id, queue] of this.dmOutbox) {
      if (queue.length) {
        all[id] = queue.map(({ conversationId: _dropped, ...rest }) => rest);
      }
    }
    this.sync.set(KEYS.outbox, all);
  },

  /// Re-arms sends that were still queued when this device last stopped. Merges by key so a
  /// device that already pumped an entry cannot have it handed back by a slower sync.
  adoptDmOutbox() {
    const all = this.sync.get(KEYS.outbox);
    if (!all || typeof all !== 'object') return;
    for (const [id, queue] of Object.entries(all)) {
      if (!Array.isArray(queue) || !queue.length) continue;
      const held = this.dmOutbox.get(id) || [];
      const keys = new Set(held.map((e) => e.key));
      const fresh = queue
        .filter((e) => e?.key && e.body && !keys.has(e.key))
        .map((e) => ({
          ...e,
          conversationId: id,
          nextAt: Date.now(),
          failed: Boolean(e.failed),
          error: e.error ?? null,
        }));
      if (fresh.length) {
        this.dmOutbox.set(id, [...held, ...fresh]);
        // Let the socket settle before the first retry after a start.
        this.scheduleDmPump(id, 2_000);
      }
    }
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
