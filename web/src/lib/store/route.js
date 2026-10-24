export const routeMethods = {
  dropThread(parentId, threadId) {
    const list = this.threads.get(parentId) || [];
    this.threads.set(parentId, list.filter((t) => t.id !== threadId));
    this.channels.delete(threadId);
    this.messages.delete(threadId);
    if (this.route.channelId === threadId) {
      const parent = this.channels.get(parentId);
      this.navigate({ view: parent?.type === 'forum' ? 'forum' : 'chat', channelId: parentId });
    }
    this.emit('threads', parentId);
    this.emit('channels', this.channels.get(parentId)?.guild_id);
  },

  commitSearch(guildId, params, { chips = [], query = '' } = {}) {
    if (!guildId || !params) return;
    this.committedSearch = { guildId, params, chips, query, at: Date.now() };
    this.emit('search', this.committedSearch);
  },

  clearSearch() {
    if (!this.committedSearch) return;
    this.committedSearch = null;
    this.emit('search', null);
  },

  navigate(route) {
    const from = this.route.guildId;
    this.route = { ...this.route, ...route };
    // Results for the server you just left don't belong in the new guild's pane.
    if (this.committedSearch && this.route.guildId !== from) this.clearSearch();
    this.noteVisit(this.route.view === 'dms' ? this.route.conversationId : this.route.channelId);
    // Entering a guild asks for its members, not the sidebar; keyed on the guild; first window only.
    if (this.route.guildId !== from) this.ensureGuildMembers(this.route.guildId);
    this.emit('route', this.route);
  },
};
