
export function enterThread(store, t, parentId = t.parent_id) {
  store.channels.set(t.id, {
    id: t.id,
    name: t.title,
    type: 'thread',
    parent_id: parentId,
    guild_id: t.guild_id,
    domain: store.channels.get(parentId)?.domain,
  });
  store.navigate({ channelId: t.id });
}

export async function startThread(store, parentId, { title, messageId = null }) {
  const body = { title: title.trim() };
  if (messageId) body.message_id = messageId;
  const thread = await store.apiForChannel(parentId).createThread(parentId, body);
  const list = store.threads.get(parentId) || [];
  store.threads.set(parentId, [thread, ...list.filter((t) => t.id !== thread.id)]);
  store.emit('threads', parentId);
  store.emit('channels', thread.guild_id || store.channels.get(parentId)?.guild_id);
  enterThread(store, { ...thread, guild_id: thread.guild_id || store.channels.get(parentId)?.guild_id }, parentId);
  return thread;
}

/// Not `parent_id || id`: a channel in a category has a `parent_id` too, and that is the category.
export function threadParentOf(channel) {
  if (!channel) return null;
  return channel.type === 'thread' ? channel.parent_id : channel.id;
}
