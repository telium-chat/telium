import { richActivitiesOf } from './activity.js';

/// Viewer-local: derived from `store.voice` (not presence), re-checking VIEW_CHANNEL.
export function voiceActivityFor(store, userId, { guildId = null } = {}) {
  if (!store || !userId || !(store.voice instanceof Map) || !(store.channels instanceof Map)) {
    return null;
  }

  for (const [channelId, states] of store.voice) {
    const channel = store.channels.get(channelId);
    if (!channel?.guild_id) continue; // excludes DM/group-DM call rooms
    if (guildId && channel.guild_id !== guildId) continue;
    if (!store.guilds?.has(channel.guild_id)) continue;
    if (typeof store.can === 'function' && !store.can(channelId, 'VIEW_CHANNEL')) continue;

    const state = (states || []).find(
      (candidate) => candidate?.user_id === userId
        && candidate?.channel_id === channelId
        && !candidate?.left,
    );
    if (!state) continue;

    const guild = store.guilds.get(channel.guild_id);
    return {
      kind: 'voice',
      user_id: userId,
      guild_id: channel.guild_id,
      guild_name: guild?.name || channel.guild_id,
      channel_id: channelId,
      channel_name: channel.name || 'Voice',
      joined_at: state.joined_at || null,
    };
  }
  return null;
}

export function profileActivitiesFor(store, userId, presence, options = {}) {
  return {
    voice: voiceActivityFor(store, userId, options),
    rich: richActivitiesOf(presence),
  };
}
