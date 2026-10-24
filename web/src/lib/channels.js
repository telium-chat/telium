/// Channel list shape: uncategorised channels first, then each category with its channels; `position` is the index in that order.

import { has } from './perms.js';
import {
  AnnouncementIcon, ForumIcon, HashIcon, VoiceIcon,
} from '../components/icons.jsx';

/// Private means an @everyone overwrite (role id == guild id) removing VIEW_CHANNEL; there is no flag.
export function isPrivate(channel) {
  const everyone = (channel?.permission_overwrites || []).find(
    (o) => (o.target_type || 'role') === 'role' && o.target_id === channel.guild_id,
  );
  return Boolean(everyone) && has(everyone.deny, 'VIEW_CHANNEL');
}

/// Empty categories are kept so a channel can be dropped into them.
export function channelTree(channels) {
  const groups = new Map();
  for (const ch of channels) {
    if (ch.type === 'category') groups.set(ch.id, { category: ch, items: [] });
  }
  const loose = [];
  for (const ch of channels) {
    if (ch.type === 'category') continue;
    // Parent missing or hidden: channel goes to the top level.
    const group = ch.parent_id ? groups.get(ch.parent_id) : null;
    if (group) group.items.push(ch);
    else loose.push(ch);
  }
  return { loose, groups: [...groups.values()] };
}

export function channelsIn(tree) {
  const out = [...tree.loose];
  for (const group of tree.groups) out.push(group.category, ...group.items);
  return out;
}

/// The gap is held as a marker while the channel is pulled out, since removal renumbers later gaps.
export function moveChannel(tree, id, parentId, at) {
  const channel = channelsIn(tree).find((c) => c.id === id);
  if (!channel || channel.type === 'category') return tree;
  if (parentId && !tree.groups.some((g) => g.category.id === parentId)) return tree;

  const slot = { id: null };
  const open = (items) => {
    const gap = Math.max(0, Math.min(at, items.length));
    return [...items.slice(0, gap), slot, ...items.slice(gap)];
  };
  // Re-insert the channel itself, not a copy with the new parent, or `channelMoves` sees no change.
  const settle = (items) => items
    .filter((c) => c === slot || c.id !== id)
    .map((c) => (c === slot ? channel : c));

  return {
    loose: settle(parentId ? tree.loose : open(tree.loose)),
    groups: tree.groups.map((g) => ({
      ...g,
      items: settle(g.category.id === parentId ? open(g.items) : g.items),
    })),
  };
}

export function moveCategory(tree, id, at) {
  const group = tree.groups.find((g) => g.category.id === id);
  if (!group) return tree;
  const gap = Math.max(0, Math.min(at, tree.groups.length));
  const slot = { category: { id: null }, items: [] };
  const staged = [...tree.groups.slice(0, gap), slot, ...tree.groups.slice(gap)];
  return {
    loose: tree.loose,
    groups: staged.filter((g) => g === slot || g !== group).map((g) => (g === slot ? group : g)),
  };
}

export function placements(tree) {
  const out = [];
  const place = (ch, parentId) => out.push({ id: ch.id, position: out.length, parent_id: parentId });
  for (const ch of tree.loose) place(ch, null);
  for (const group of tree.groups) {
    place(group.category, null);
    for (const ch of group.items) place(ch, group.category.id);
  }
  return out;
}

/// Only rows not already where the guild has them; the first drag sends everything (all start at 0).
export function channelMoves(tree) {
  const before = new Map(channelsIn(tree).map((ch) => [ch.id, ch]));
  return placements(tree).filter((p) => {
    const ch = before.get(p.id);
    return !ch || (ch.position || 0) !== p.position || (ch.parent_id || null) !== p.parent_id;
  });
}

const GLYPH = {
  text: HashIcon,
  voice: VoiceIcon,
  forum: ForumIcon,
  announcement: AnnouncementIcon,
};

export function channelGlyph(channel) {
  return GLYPH[channel?.type] || HashIcon;
}

const VIEW = {
  voice: 'voice',
  forum: 'forum',
};

export function channelView(channel) {
  return VIEW[channel?.type] || 'chat';
}

export function channelRoute(channel) {
  return {
    view: channelView(channel),
    guildId: channel.guild_id,
    channelId: channel.id,
  };
}

/// Categories and threads are not `<#id>` targets; unresolved mentions render as names.
const UNLINKABLE = new Set(['category', 'thread']);

/// Unknown types are linkable: a newer server's type is likelier a room than a heading.
export function isLinkable(channel) {
  return Boolean(channel) && !UNLINKABLE.has(channel.type);
}
