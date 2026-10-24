import { lookupAllowed } from '../mutual-lookups.js';

const PROFILE_RETRY_MS = 30_000;

export const friendMethods = {
  async refreshConversations() {
    if (!this.home) return;
    const resp = await this.home.conversations();
    this.conversations = resp.conversations || [];
    this.emit('conversations');
  },

  async refreshFriends() {
    if (!this.home) return;
    const resp = await this.home.friends();
    this.friends = new Map((resp.friends || []).map((f) => [f.user_id, f]));
    for (const f of this.friends.values()) {
      if (f.presence) this.presence.set(f.user_id, f.presence);
    }
    this.friendsLoaded = true;
    for (const [userId, tried] of [...this.peerProfileTried]) {
      if (tried !== true) this.peerProfileTried.delete(userId);
    }
    // Wake rows told to wait: their subscription is installed from an effect, so a landing list can go unheard.
    const waiting = [...this.profileWanted];
    this.profileWanted.clear();
    for (const userId of waiting) this.ensureProfile(userId);
    this.emit('friends');
  },

  async mutualFriendsWith(userId) {
    if (!this.home) return { friends: [], complete: false };
    return this.home.mutualFriends(userId);
  },

  async mutualGuildsWith(userId) {
    const guilds = [...this.guilds.values()];
    const checks = await Promise.all(guilds.map(async (guild) => {
      const api = this.apiForGuild(guild.id);
      if (!api) return { guild, complete: false, member: false };
      try {
        const answer = await api.memberStatus(guild.id, userId);
        return { guild, complete: true, member: answer?.member === true };
      } catch {
        return { guild, complete: false, member: false };
      }
    }));
    return {
      guilds: checks.filter((row) => row.member).map((row) => row.guild),
      complete: checks.every((row) => row.complete),
    };
  },

  /// The privacy setting is enforced only here so a new caller cannot forget it.
  ensureMutuals(userId, { trigger = 'open' } = {}) {
    if (!userId || userId === this.me?.user_id) return Promise.resolve(null);
    // Read now, not cached: another device may have just changed the setting.
    if (!lookupAllowed(this.mutualLookups(), trigger)) return Promise.resolve(null);
    const running = this.mutualsAsked.get(userId);
    if (running) return running;
    const run = Promise.all([
      this.mutualFriendsWith(userId)
        .catch(() => ({ friends: [], complete: false, error: true })),
      this.mutualGuildsWith(userId)
        .catch(() => ({ guilds: [], complete: false, error: true })),
    ]).then(([friends, guilds]) => {
      const answer = { friends, guilds };
      this.mutuals.set(userId, answer);
      // Don't keep a failed lookup as the answer; incomplete answers are re-asked a few times.
      const incomplete = friends.error || guilds.error || !friends.complete || !guilds.complete;
      if (incomplete) {
        this.mutualsAsked.delete(userId);
        const tries = (this.mutualsRetries.get(userId) || 0) + 1;
        this.mutualsRetries.set(userId, tries);
        if (tries <= 3) setTimeout(() => this.ensureMutuals(userId, { trigger }), 1500 * 2 ** (tries - 1));
      } else {
        this.mutualsRetries.delete(userId);
      }
      this.emit('mutuals', { user_id: userId });
      return answer;
    });
    this.mutualsAsked.set(userId, run);
    return run;
  },

  mutualsFor(userId) {
    return this.mutuals.get(userId) || null;
  },

  applyFriend(row) {
    if (!row?.user_id) return row;
    if (row.state) this.friends.set(row.user_id, { ...this.friends.get(row.user_id), ...row });
    else this.friends.delete(row.user_id);
    this.emit('friends');
    return row;
  },

  async addFriend(userId) { return this.applyFriend(await this.home.addFriend(userId)); },

  async acceptFriend(userId) {
    const row = this.applyFriend(await this.home.acceptFriend(userId));
    await this.refreshConversations().catch(() => {});
    return row;
  },

  async removeFriend(userId) { return this.applyFriend(await this.home.removeFriend(userId)); },

  async blockUser(userId) {
    const row = this.applyFriend(await this.home.blockUser(userId));
    await this.refreshConversations().catch(() => {});
    return row;
  },

  async unblockUser(userId) {
    const row = this.applyFriend(await this.home.unblockUser(userId));
    await this.refreshConversations().catch(() => {});
    return row;
  },

  statusOf(userId) {
    return this.presence.get(userId)?.status
      || this.friends.get(userId)?.presence?.status
      || 'offline';
  },

  /// The early return is sound only for `display_name`/`avatar_ref` of accounts this home server hosts.
  ensureProfile(userId) {
    if (!userId || !this.home) return;
    if (userId === this.me?.user_id) return;
    // Not before the friends list answers: until then a row cannot tell a friend from a stranger.
    if (!this.friendsLoaded) { this.profileWanted.add(userId); return; }
    if (this.friends.get(userId)?.display_name) return;
    this.fetchIdentity(userId);
  },

  ensureFullProfile(userId) {
    if (!userId || !this.home) return;
    if (userId === this.me?.user_id) return;
    this.fetchIdentity(userId);
  },

  /// A refusal is recorded as when, so it ages out instead of becoming a request loop.
  fetchIdentity(userId) {
    const tried = this.peerProfileTried.get(userId);
    if (tried === true) return;
    if (typeof tried === 'number' && Date.now() - tried < PROFILE_RETRY_MS) return;
    this.peerProfileTried.set(userId, true);
    this.home.userProfile(userId)
      .then((profile) => this.receiveIdentity(userId, profile))
      .catch(() => {
        this.peerProfileTried.set(userId, Date.now());
        this.identities.set(userId, false);
        this.emit('identity', { user_id: userId, profile: false });
      });
  },

  receiveIdentity(userId, profile) {
    if (!userId || !profile || typeof profile !== 'object') return;
    this.peerProfileTried.set(userId, true);
    this.identities.set(userId, profile);
    this.applyPeerProfile(userId, profile);
    this.emit('identity', { user_id: userId, profile });
  },

  identityOf(userId) {
    if (userId && userId === this.me?.user_id) return this.me?.profile || undefined;
    return this.identities.get(userId);
  },

  /// Presence fills an empty slot only, so a stale answer cannot overwrite a newer gateway update.
  applyPeerProfile(userId, profile) {
    if (!profile || typeof profile !== 'object') return;
    const entry = {
      user_id: userId,
      display_name: profile.display_name || null,
      avatar_ref: profile.avatar_ref || null,
    };
    this.peerProfiles.set(userId, entry);
    this.emit('peers', entry);
    const live = profile.presence;
    if (live?.status && !this.presence.has(userId)) {
      const next = {
        user_id: userId,
        status: live.status,
        custom_status: live.custom_status ?? profile.custom_status ?? null,
      };
      this.presence.set(userId, next);
      this.emit('presence', next);
    }
  },

  peerProfile(userId) {
    return this.peerProfiles.get(userId) || null;
  },

  friendsIn(state) {
    return [...this.friends.values()]
      .filter((f) => f.state === state)
      .sort((a, b) => (a.display_name || a.user_id).localeCompare(b.display_name || b.user_id));
  },

  pendingFriendCount() {
    return this.friendsIn('pending_in').length;
  },
};
