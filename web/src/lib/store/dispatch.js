import { mayInterrupt } from '../interrupts.js';
import { participants } from '../util.js';
import { rejoinKey } from '../rejoin.js';

export const dispatchMethods = {
  onDispatch({ domain, t, d }) {
    const interrupting = mayInterrupt(t);
    switch (t) {
      // Only the home server speaks for account migrations.
      case 'MIGRATION_ALERT':
      case 'MIGRATION_UPDATE':
        if (domain === this.home?.domain) this.onMigrationAlert(d);
        break;
      case 'RECOVERY_EMAIL_UPDATE':
        if (domain === this.home?.domain) this.onRecoveryEmail(d);
        break;
      case 'MESSAGE_CREATE': this.onMessage(domain, d, interrupting); break;
      case 'MESSAGE_UPDATE': this.patchMessage(d); break;
      case 'MESSAGE_DELETE': this.removeMessage(d); break;
      case 'MESSAGE_REACTION_ADD': this.onReaction(d, 'add'); break;
      case 'MESSAGE_REACTION_REMOVE': this.onReaction(d, 'remove'); break;
      case 'MESSAGE_REACTION_CLEAR': this.onReaction(d, 'clear'); break;
      case 'TYPING_START': this.onTyping(d); break;
      case 'TYPING_STOP': this.onTypingStop(d); break;
      case 'DM_TYPING_START': this.onDmTyping(d, true); break;
      case 'DM_TYPING_STOP': this.onDmTyping(d, false); break;
      case 'PRESENCE_UPDATE':
        this.presence.set(d.user_id, d);
        this.emit('presence', d);
        if (this.friends.has(d.user_id)) {
          this.friends.set(d.user_id, { ...this.friends.get(d.user_id), presence: d });
          this.emit('friends');
        }
        break;
      case 'PROFILE_UPDATE': this.onProfileUpdate(d); break;
      case 'FRIEND_UPDATE':
        this.friends.set(d.user_id, { ...this.friends.get(d.user_id), ...d });
        this.emit('friends');
        if (d.state === 'accepted' || d.state === 'blocked') {
          this.refreshConversations().catch(() => {});
        }
        break;
      case 'FRIEND_REMOVE':
        this.friends.delete(d.user_id);
        this.emit('friends');
        break;
      case 'MEMBER_ADD':
      case 'MEMBER_UPDATE': this.onMember(d); break;
      case 'MEMBER_REMOVE':
        if (d.user_id === this.me?.user_id) { this.dropGuild(d.guild_id); break; }
        this.members.get(d.guild_id)?.delete(d.user_id);
        this.emit('members', d.guild_id);
        break;
      case 'CHANNEL_CREATE':
      case 'CHANNEL_UPDATE': {
        const guildId = d.guild_id || this.channels.get(d.id)?.guild_id;
        this.channels.set(d.id, { ...this.channels.get(d.id), ...d, guild_id: guildId, domain });
        // An echo of the first of several quick toggles must not undo the rest.
        this.reapplyPending(`ow:${d.id}:`);
        this.emit('channels', guildId);
        break;
      }
      case 'CHANNEL_DELETE': {
        const gone = this.channels.get(d.id);
        if (this.voice.delete(d.id)) this.emit('voice', d.id);
        this.watchers.delete(d.id);
        this.channels.delete(d.id);
        this.emit('channels', gone?.guild_id);
        break;
      }
      case 'CHANNEL_PINS_UPDATE': {
        const held = this.channelPins.get(d.channel_id);
        if (held && d.message_id) {
          if (d.pinned) held.add(d.message_id);
          else held.delete(d.message_id);
        }
        this.emit('pins', d.channel_id);
        if (d.pinned && d.message_id && this.reading === d.channel_id) {
          this.notePinNotice(d.channel_id, d.message_id, null);
        }
        break;
      }
      case 'THREAD_CREATE':
      case 'THREAD_UPDATE': {
        const parent = d.parent_id || d.channel_id;
        const list = this.threads.get(parent) || [];
        const at = list.findIndex((t) => t.id === d.id);
        if (at >= 0) list[at] = { ...list[at], ...d };
        else list.unshift(d);
        this.threads.set(parent, [...list]);
        const known = this.channels.get(d.id);
        if (known) this.channels.set(d.id, { ...known, name: d.title });
        this.emit('threads', parent);
        break;
      }
      case 'THREAD_DELETE': {
        this.dropThread(d.parent_id, d.id);
        break;
      }
      case 'GUILD_UPDATE': {
        const prev = this.guilds.get(d.id) || {};
        this.guilds.set(d.id, { ...prev, ...d, domain });
        this.emit('guilds');
        break;
      }
      case 'ROLE_CREATE': case 'ROLE_UPDATE': case 'ROLE_DELETE': {
        // Privacy-critical: removing a role must evict now-hidden rooms and cached voice rosters.
        this.loadRoles(d.guild_id, { force: true }).catch(() => {});
        this.refreshMe(d.guild_id).catch(() => {});
        const guild = this.guilds.get(d.guild_id);
        if (guild?.domain) this.gw.requestChannels(guild.domain, d.guild_id);
        this.emit('roles', d.guild_id);
        break;
      }
      case 'VOICE_STATE_UPDATE': this.onVoice(d); break;
      case 'DM_MESSAGE': this.onDmFrame(d, interrupting); break;
      case 'DM_REQUEST_UPDATE':
        this.refreshConversations().catch(() => {});
        break;
      case 'DM_MEMBER_LEAVE': this.onDmLeave(d); break;
      case 'VERIFICATION': this.onVerification(d); break;
      case 'AUTOMOD_ACTION': this.emit('automod', d); break;
      case 'CHANNEL_VISIBILITY': {
        // Delete first so losing VIEW_CHANNEL drops everything cached while it was held.
        const visible = new Set((d.channels || []).map((ch) => ch.id));
        for (const [channelId, channel] of [...this.channels]) {
          if (channel.guild_id !== d.guild_id || visible.has(channelId)) continue;
          // Threads are absent from the snapshot; absence says nothing about them.
          if (channel.type === 'thread') continue;
          if (this.voice.delete(channelId)) this.emit('voice', channelId);
          this.watchers.delete(channelId);
          this.channels.delete(channelId);
        }
        for (const ch of d.channels || []) {
          this.channels.set(ch.id, { ...ch, guild_id: d.guild_id, domain });
        }
        this.reapplyPending('ow:');

        if (Array.isArray(d.voice_states)) {
          const touchedVoice = new Set();
          for (const [channelId] of [...this.voice]) {
            if (this.channels.get(channelId)?.guild_id !== d.guild_id) continue;
            this.voice.delete(channelId);
            touchedVoice.add(channelId);
          }
          for (const state of d.voice_states) {
            if (!state?.channel_id || !visible.has(state.channel_id)) continue;
            const list = this.voice.get(state.channel_id) || [];
            list.push(state);
            this.voice.set(state.channel_id, list);
            touchedVoice.add(state.channel_id);
          }
          for (const channelId of touchedVoice) this.emit('voice', channelId);
        }

        this.emit('channels', d.guild_id);
        this.loadReadState(d.guild_id).catch(() => {});
        break;
      }
      case 'MEMBER_LIST_UPDATE': this.onMemberList(d); break;
      case 'GUILD_DELETE': this.dropGuild(d.id || d.guild_id); break;
      case 'GUILD_EMOJI_UPDATE':
        this.loadExpressions(d.guild_id, { force: true }).catch(() => {});
        break;
      case 'MESSAGE_HELD':
        this.emit('held', d);
        break;
      case 'GUILD_APPLICANT':
        this.emit('applicant', d);
        break;
      case 'VOICE_WATCHERS_UPDATE': this.onWatchers(d); break;
      case 'VOICE_SERVER_UPDATE': this.emit('voice-server', d); break;
      case 'VOICE_SIGNAL': this.emit('voice-signal', d); break;
      case 'VOICE_E2EE': this.emit('voice-e2ee', d); break;
      default: break;
    }
    this.emit('dispatch', { domain, t, d });
  },

  onMessage(domain, msg, interrupting = mayInterrupt('MESSAGE_CREATE')) {
    const list = this.messages.get(msg.channel_id);
    if (list) {
      if (!list.some((m) => m.id === msg.id)) list.push(msg);
    }

    const fromMe = msg.author === this.me?.user_id;
    const text = msg.content || '';
    const directlyMentioned = !fromMe
      && (text.includes(this.me?.user_id) || /@everyone\b|@here\b/.test(text));
    const repliedToMe = !fromMe && msg.reply_author === this.me?.user_id;
    const mentioned = directlyMentioned || repliedToMe;
    const notificationKind = directlyMentioned ? 'mention' : (repliedToMe ? 'reply' : null);

    // Mention signalling must not hide behind this check: an open timeline can sit in an unfocused tab.
    if (interrupting && !fromMe && this.reading !== msg.channel_id) {
      const state = this.readState.get(msg.channel_id) || { unread: 0, mentions: 0 };
      state.unread = (state.unread || 0) + 1;
      if (mentioned) state.mentions = (state.mentions || 0) + 1;
      this.readState.set(msg.channel_id, state);
      this.emit('unread', this.channels.get(msg.channel_id)?.guild_id);
    }

    if (interrupting && mentioned) {
      this.emit('mention', {
        guildId: this.channels.get(msg.channel_id)?.guild_id,
        channelId: msg.channel_id,
        message: msg,
        kind: notificationKind,
      });
    }

    const wasTyping = this.typing.get(msg.channel_id)?.delete(msg.author);
    if (wasTyping) this.emit('typing', msg.channel_id);
    this.emit('message', msg);
  },

  patchMessage(d) {
    const list = this.messages.get(d.channel_id);
    const at = list?.findIndex((m) => m.id === d.id) ?? -1;
    if (at >= 0) list[at] = { ...list[at], ...d };
    this.emit('message-update', d);
  },

  removeMessage(d) {
    const list = this.messages.get(d.channel_id);
    if (list) {
      const at = list.findIndex((m) => m.id === d.id);
      if (at >= 0) list.splice(at, 1);
    }
    this.emit('message-update', d);
  },

  async deleteMessageNow(channelId, id) {
    const list = this.messages.get(channelId);
    const at = list?.findIndex((m) => m.id === id) ?? -1;
    const gone = at >= 0 ? list[at] : null;
    const after = at > 0 ? list[at - 1].id : null;
    if (gone) this.removeMessage({ channel_id: channelId, id });
    try {
      return await this.apiForChannel(channelId).deleteMessage(channelId, id);
    } catch (e) {
      const now = this.messages.get(channelId);
      if (gone && now && !now.some((m) => m.id === id)) {
        const prev = after ? now.findIndex((m) => m.id === after) : -1;
        now.splice(prev >= 0 ? prev + 1 : Math.min(at, now.length), 0, gone);
        this.emit('message-update', { channel_id: channelId, id });
      }
      throw e;
    }
  },

  async editMessageNow(channelId, id, content) {
    const before = this.messages.get(channelId)?.find((m) => m.id === id);
    if (before) {
      this.patchMessage({
        channel_id: channelId, id, content, edited_at: new Date().toISOString(), saving: true,
      });
    }
    try {
      const saved = await this.apiForChannel(channelId).editMessage(channelId, id, content);
      if (before) this.patchMessage({ channel_id: channelId, id, saving: false });
      return saved;
    } catch (e) {
      if (before) {
        this.patchMessage({
          channel_id: channelId,
          id,
          content: before.content,
          edited_at: before.edited_at ?? null,
          saving: false,
        });
      }
      throw e;
    }
  },

  onReaction(d, kind) {
    const list = this.messages.get(d.channel_id);
    const at = list?.findIndex((m) => m.id === d.message_id) ?? -1;
    if (at >= 0) {
      const groups = list[at].reactions || [];
      const mine = d.user_id === this.me?.user_id;
      // A reaction is a set: my own click already drew it, so the echo must not count it twice.
      const group = groups.find((g) => g.emoji === d.emoji);
      const holds = group && (mine ? group.me : (group.users || []).includes(d.user_id));
      if ((kind === 'add' && holds) || (kind === 'remove' && mine && !holds)) return;
      let next;
      if (kind === 'clear') {
        next = [];
      } else if (kind === 'remove') {
        next = groups
          .map((g) => (g.emoji === d.emoji
            ? {
              ...g,
              count: g.count - 1,
              me: mine ? false : g.me,
              users: (g.users || []).filter((u) => u !== d.user_id),
            }
            : g))
          .filter((g) => g.emoji !== d.emoji || g.count > 0);
      } else if (groups.some((g) => g.emoji === d.emoji)) {
        next = groups.map((g) => (g.emoji === d.emoji
          ? {
            ...g,
            count: g.count + 1,
            me: mine ? true : g.me,
            users: (g.users || []).includes(d.user_id)
              ? g.users
              : [...(g.users || []), d.user_id],
          }
          : g));
      } else {
        next = [...groups, { emoji: d.emoji, count: 1, me: mine, users: [d.user_id] }];
      }
      list[at] = { ...list[at], reactions: next };
    }
    this.emit('message-update', { id: d.message_id, channel_id: d.channel_id });
  },

  async setOwnReaction(channelId, messageId, emoji, on) {
    const d = { channel_id: channelId, message_id: messageId, emoji, user_id: this.me?.user_id };
    const api = this.apiForChannel(channelId);
    const held = Boolean(this.messages.get(channelId)?.find((m) => m.id === messageId)
      ?.reactions?.some((g) => g.emoji === emoji && g.me));
    const changes = held !== on;
    if (changes) this.onReaction(d, on ? 'add' : 'remove');
    try {
      if (on) await api.react(messageId, emoji);
      else await api.unreact(messageId, emoji);
    } catch (e) {
      if (changes) this.onReaction(d, on ? 'remove' : 'add');
      throw e;
    }
  },

  onTyping(d) {
    if (d.user_id === this.me?.user_id) return;
    if (!this.typing.has(d.channel_id)) this.typing.set(d.channel_id, new Map());
    this.typing.get(d.channel_id).set(d.user_id, true);
    this.emit('typing', d.channel_id);
  },

  setLocalTyping(channelId, active) {
    if (!channelId) return;
    const was = this.localTyping.has(channelId);
    if (active === was) return;
    if (active) this.localTyping.set(channelId, true);
    else this.localTyping.delete(channelId);
    this.emit('typing', channelId);
  },

  onTypingStop(d) {
    if (d.user_id === this.me?.user_id) return;
    const users = this.typing.get(d.channel_id);
    if (!users?.delete(d.user_id)) return;
    if (!users.size) this.typing.delete(d.channel_id);
    this.emit('typing', d.channel_id);
  },

  onDmTyping(d, active) {
    const conversationId = d?.conversation_id;
    const userId = d?.user_id;
    if (!conversationId || !userId || userId === this.me?.user_id) return;
    let users = this.dmTyping.get(conversationId);
    if (active) {
      if (!users) this.dmTyping.set(conversationId, users = new Set());
      if (users.has(userId)) return;
      users.add(userId);
    } else {
      if (!users?.delete(userId)) return;
      if (!users.size) this.dmTyping.delete(conversationId);
    }
    this.emit('dm', { conversation_id: conversationId });
  },

  dmTypistsIn(conversationId) {
    return [...(this.dmTyping.get(conversationId) || [])]
      .filter((userId) => userId !== this.me?.user_id);
  },

  onDmLeave(d) {
    const at = this.conversations.findIndex((c) => c.id === d.conversation_id);
    if (at < 0) return;
    if (d.user_id !== this.me?.user_id) {
      const convo = this.conversations[at];
      // A redelivered event must not talk over the stronger word (`participants`).
      const member = participants(convo).find((m) => m.user_id === d.user_id);
      if (!member) return;
      convo.members = convo.members.map(
        (m) => (m.user_id === d.user_id ? { ...m, state: 'left', resync: true } : m),
      );
      this.emit('conversations');
      this.settleDepartures(d.conversation_id, null, [d.user_id]).catch(() => {});
      return;
    }
    this.conversations.splice(at, 1);
    this.dmUnread.delete(d.conversation_id);
    this.dmFrames.delete(d.conversation_id);
    this.dmOpened.delete(d.conversation_id);
    this.dmPending.delete(d.conversation_id);
    this.mls?.forget(d.conversation_id).catch(() => {});
    if (this.route.view === 'dms' && this.route.conversationId === d.conversation_id) {
      this.navigate({ view: 'dms', conversationId: null });
    }
    this.emit('conversations');
    this.emit('unread', null);
  },

  onProfileUpdate(d) {
    const userId = d?.user_id;
    if (!userId) return;
    if (userId === this.me?.user_id) {
      this.me = { ...this.me, profile: { ...this.me.profile, ...d } };
      this.emit('me', this.me);
      return;
    }
    this.receiveIdentity(userId, d);
    const friend = this.friends.get(userId);
    if (friend) {
      this.friends.set(userId, {
        ...friend,
        display_name: d.display_name || null,
        avatar_ref: d.avatar_ref || null,
      });
      this.emit('friends');
    }
  },

  onMember(d) {
    if (!this.members.has(d.guild_id)) this.members.set(d.guild_id, new Map());
    const map = this.members.get(d.guild_id);
    map.set(d.user_id, { ...map.get(d.user_id), ...d });
    this.reapplyPending(`mr:${d.guild_id}:${d.user_id}:`);
    if (d.user_id === this.me?.user_id) {
      this.refreshMe(d.guild_id).catch(() => {});
      const guild = this.guilds.get(d.guild_id);
      if (guild?.domain) this.gw.requestChannels(guild.domain, d.guild_id);
    }
    this.emit('members', d.guild_id);
  },

  onMemberList(d) {
    if (!this.members.has(d.guild_id)) this.members.set(d.guild_id, new Map());
    const map = this.members.get(d.guild_id);
    for (const op of d.ops || []) {
      for (const item of op.items || []) {
        map.set(item.user_id, { ...map.get(item.user_id), ...item, guild_id: d.guild_id });
        if (item.presence) this.presence.set(item.user_id, item.presence);
      }
    }
    this.emit('members', d.guild_id);
  },

  dropGuild(guildId) {
    if (!guildId || !this.guilds.has(guildId)) return;
    this.guilds.delete(guildId);
    for (const [id, ch] of [...this.channels]) {
      if (ch.guild_id !== guildId) continue;
      if (this.voice.delete(id)) this.emit('voice', id);
      this.watchers.delete(id);
      this.channels.delete(id);
    }
    this.members.delete(guildId);
    this.roles.delete(guildId);
    this.emojis.delete(guildId);
    this.stickers.delete(guildId);
    this.expressionData.delete(guildId);
    this.expressionLoads.delete(guildId);
    // `navigate` merges: clearing the channel while view stayed 'voice' threw.
    if (this.route.guildId === guildId) {
      this.navigate({ view: 'chat', guildId: null, channelId: null });
    }
    this.emit('guilds');
    this.emit('channels', guildId);
  },

  /// Leaving is a null channel_id and a move is the destination alone, so find the user first, within this guild.
  onVoice(d) {
    const touched = new Set();
    // Occupancy before this frame: a call rings on the nobody-to-somebody step.
    const room = d.conversation_id || null;
    const before = room ? (this.voice.get(room)?.length || 0) : 0;
    for (const [channelId, list] of this.voice) {
      if (d.conversation_id) { if (channelId !== d.conversation_id) continue; }
      else if (d.guild_id && this.channels.get(channelId)?.guild_id !== d.guild_id) continue;
      const at = list.findIndex((v) => v.user_id === d.user_id);
      if (at < 0) continue;
      if (channelId === d.channel_id && !d.left) Object.assign(list[at], d);
      else list.splice(at, 1);
      touched.add(channelId);
    }
    if (d.channel_id && !d.left && !touched.has(d.channel_id)) {
      const list = this.voice.get(d.channel_id) || [];
      list.push(d);
      this.voice.set(d.channel_id, list);
      touched.add(d.channel_id);
    }
    if (room) this.noteCall(d, before, this.voice.get(room)?.length || 0);
    for (const channelId of touched) this.emit('voice', channelId);
  },

  /// Nothing is reconciled against `this.voice`: a watcher the roster lacks is a member we cannot see.
  onWatchers(d) {
    if (!d.channel_id) return;
    this.watchers.set(d.channel_id, d.watchers || []);
    this.emit('watchers', d.channel_id);
  },

  rereadMembers(conversationId) {
    const convo = this.conversations.find((c) => c.id === conversationId);
    if (convo?.kind !== 'gc') return;
    clearTimeout(this.membersReread);
    this.membersReread = setTimeout(() => {
      this.membersReread = null;
      this.refreshConversations().catch(() => {});
    }, 400);
  },

  onDmFrame(d, interrupting = mayInterrupt('DM_MESSAGE')) {
    const list = this.dmFrames.get(d.conversation_id) ?? this.pendingFrames(d.conversation_id);
    // Hold our own echo only while a send of ours is outstanding (other devices have no key for it).
    const racing = d.kind === 'application'
      && this.sending.has(d.conversation_id)
      && Boolean(this.mls?.isMine(d))
      && this.mls.textOf(d.id) === undefined;
    if (list && !racing && !list.some((f) => f.id === d.id)) list.push(d);
    this.noteConversation(d);
    this.emit('dm', d);

    if (d.kind === 'rejoin' && this.mls) {
      if (d.sender === this.me?.user_id && d.sender_device === this.mls.deviceId) return;
      const signatureKey = rejoinKey(d.ciphertext);
      this.admitSigned(
        d.conversation_id,
        [{ userId: d.sender, deviceId: d.sender_device, ...(signatureKey ? { signatureKey } : {}) }],
      ).catch(() => {});
      return;
    }

    // Walk on arrival even for unopened conversations: else receipts notify and Welcomes/commits go unapplied.
    if (this.mls) {
      const pinsBefore = this.conversationOnScreen(d.conversation_id)
        ? this.mls.pinsIn(d.conversation_id).map((pin) => pin.id)
        : null;
      this.mls.sync(d.conversation_id, list || [d])
        .then(() => {
          this.notePinsMadeSince(d.conversation_id, pinsBefore);
          this.emit('dm', d);
          this.scheduleSignals(d.conversation_id);
          this.answerRejoins(d.conversation_id);
          if (d.kind === 'commit') this.rereadMembers(d.conversation_id);
          // Unopened live frame the gap-fill missed: re-read history once, bounded, so it arrives late not never.
          if (d.kind === 'application'
            && this.dmFrames.has(d.conversation_id)
            && !this.mls.isSignal(d.id)
            && this.mls.textOf(d.id) === undefined
            && !this.dmSyncRetrying.has(d.conversation_id)) {
            this.dmSyncRetrying.add(d.conversation_id);
            this.home.dmHistory(d.conversation_id, { tail: 100 })
              .then((resp) => {
                const fetched = resp?.messages || [];
                if (fetched.length) {
                  const merged = this.loadFrames(d.conversation_id, fetched);
                  return this.mls.sync(d.conversation_id, merged, { backfill: true });
                }
              })
              .catch(() => {})
              .then(() => {
                this.dmSyncRetrying.delete(d.conversation_id);
                this.emit('dm', d);
              });
          }
        })
        .catch(() => {
          // Walk threw: no repair, `forget` would delete the creator's only group state.
          this.emit('dm', d);
        })
        // Badge and notification wait for the walk: until the frame is open a receipt looks like a message.
        .then(() => {
          this.noteActivity(d);
          if (interrupting && this.noteUnseen(d)) this.emit('dm-notify', d);
        });
    } else {
      this.noteActivity(d);
      if (interrupting && this.noteUnseen(d)) this.emit('dm-notify', d);
    }
  },
};
