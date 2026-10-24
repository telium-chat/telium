// Quick switcher ranking and recents. Pure; the view is `views/dialogs/QuickSwitcher.jsx`.

import { remoteMediaOrigin } from './media.js';
import { shortName } from './util.js';

export const FILTERS = [
  { token: '@', label: 'users', match: (e) => e.group === 'user' || e.group === 'conversation' },
  { token: '#', label: 'text channels', match: (e) => e.group === 'channel' && e.kind !== 'voice' },
  { token: '!', label: 'voice channels', match: (e) => e.kind === 'voice' },
  { token: '*', label: 'servers', match: (e) => e.group === 'guild' },
];

const BY_TOKEN = new Map(FILTERS.map((f) => [f.token, f]));

export const FILTER_HINT = FILTERS.map((f) => `${f.token} ${f.label}`);

/// The token only counts when it leads (`@bob`, not `bob@`).
export function parseQuery(raw) {
  const text = String(raw || '');
  const token = text.length && BY_TOKEN.has(text[0]) ? text[0] : null;
  return {
    token,
    filter: token ? BY_TOKEN.get(token) : null,
    text: (token ? text.slice(1) : text).trim(),
  };
}

const MATCH = 1;
const BONUS_START = 18;
/// After a separator or at a camelCase step, so `vc` finds `voice-chat`.
const BONUS_BOUNDARY = 10;
const BONUS_RUN = 12;
const PENALTY_LEAD = 1;
const PENALTY_LEAD_MAX = 12;
const PENALTY_GAP = 2;
const BONUS_EXACT = 30;
const BONUS_PREFIX = 18;

const ALNUM = /[a-z0-9]/;

function startsWord(lower, raw, j) {
  if (j === 0) return true;
  if (!ALNUM.test(lower[j - 1])) return true;
  return raw[j] !== lower[j] && raw[j - 1] === lower[j - 1];
}

/// A dynamic program rather than a greedy walk, which would score `ge` in `#game-general` as scattered. Returns null or `{ score, positions }`.
export function fuzzyMatch(raw, query) {
  const text = String(raw || '');
  const q = String(query || '').toLowerCase();
  if (!q) return { score: 0, positions: [] };
  const t = text.toLowerCase();
  const n = q.length;
  const m = t.length;
  if (n > m) return null;

  let probe = 0;
  for (let j = 0; j < m && probe < n; j += 1) if (t[j] === q[probe]) probe += 1;
  if (probe < n) return null;

  let prev = new Float64Array(m).fill(-Infinity);
  const parents = [];
  for (let i = 0; i < n; i += 1) {
    const row = new Float64Array(m).fill(-Infinity);
    const parent = new Int32Array(m).fill(-1);
    // Best gapped predecessor, carried along the row to keep the table O(query x name).
    let gapBest = -Infinity;
    let gapArg = -1;
    for (let j = 0; j < m; j += 1) {
      if (i > 0 && j > 0) {
        const decayed = gapBest === -Infinity ? -Infinity : gapBest - PENALTY_GAP;
        if (prev[j - 1] >= decayed) { gapBest = prev[j - 1]; gapArg = j - 1; } else { gapBest = decayed; }
      }
      if (t[j] !== q[i]) continue;
      const bonus = startsWord(t, text, j) ? (j === 0 ? BONUS_START : BONUS_BOUNDARY) : 0;
      if (i === 0) {
        row[j] = MATCH + bonus - Math.min(j, PENALTY_LEAD_MAX) * PENALTY_LEAD;
      } else if (j > 0) {
        const run = prev[j - 1] === -Infinity ? -Infinity : prev[j - 1] + BONUS_RUN;
        if (run === -Infinity && gapBest === -Infinity) continue;
        if (run >= gapBest) { row[j] = run + MATCH + bonus; parent[j] = j - 1; } else { row[j] = gapBest + MATCH + bonus; parent[j] = gapArg; }
      }
    }
    prev = row;
    parents.push(parent);
  }

  let end = -1;
  let score = -Infinity;
  for (let j = 0; j < m; j += 1) if (prev[j] > score) { score = prev[j]; end = j; }
  if (end < 0) return null;

  const positions = new Array(n);
  for (let i = n - 1, j = end; i >= 0; i -= 1) {
    positions[i] = j;
    j = parents[i][j];
  }

  if (t === q) score += BONUS_EXACT;
  else if (t.startsWith(q)) score += BONUS_PREFIX;
  return { score, positions };
}

const RECENCY_TOP = 24;
const RECENCY_STEP = 1.2;
const RECENCY_FLOOR = 2;

function recencyBonus(rank) {
  if (rank < 0) return 0;
  return Math.max(RECENCY_FLOOR, RECENCY_TOP - rank * RECENCY_STEP);
}

const BONUS_UNREAD = 4;
const BONUS_MENTION = 6;

export const MAX_ROWS = 10;

const CHANNEL_VIEW = { voice: 'voice', forum: 'forum' };

/// `group` is the coarse kind the filters select on; `kind` the fine one for glyph and sort; `where` the line under the name.
export function destinations(store) {
  const out = [];
  const me = store.me?.user_id || null;

  for (const guild of store.guilds.values()) {
    out.push({
      key: `guild:${guild.id}`,
      group: 'guild',
      kind: 'guild',
      title: guild.name || guild.id,
      where: guild.domain || '',
      guildId: guild.id,
      iconRef: guild.icon_ref || null,
      recentId: null,
      unread: 0,
      mentions: 0,
    });
  }

  for (const channel of store.channels.values()) {
    if (channel.type === 'category' || channel.type === 'thread') continue;
    const guild = store.guilds.get(channel.guild_id);
    const state = store.unreadFor(channel.id);
    out.push({
      key: `channel:${channel.id}`,
      group: 'channel',
      kind: channel.type || 'text',
      title: channel.name || channel.id,
      where: guild?.name || channel.domain || '',
      guildId: channel.guild_id,
      channelId: channel.id,
      view: CHANNEL_VIEW[channel.type] || 'chat',
      recentId: channel.id,
      unread: state.unread || 0,
      mentions: state.mentions || 0,
    });
  }

  const nameOf = (userId) => (
    store.friends.get(userId)?.display_name
    || store.peerProfiles.get(userId)?.display_name
    || shortName(userId)
  );

  for (const convo of store.conversations) {
    const others = (convo.members || [])
      .map((member) => member.user_id || member)
      .filter((id) => id && id !== me);
    const group = convo.kind === 'gc';
    const title = convo.name
      || (others.length ? others.map(nameOf).join(', ') : 'Just you');
    out.push({
      key: `convo:${convo.id}`,
      group: 'conversation',
      kind: group ? 'gdm' : 'dm',
      title,
      where: group
        ? others.map(shortName).join(', ')
        : (others[0] || ''),
      avatarRef: null,
      conversationId: convo.id,
      userId: group ? null : (others[0] || null),
      recentId: convo.id,
      unread: store.dmUnreadFor(convo.id),
      mentions: 0,
    });
  }

  const spoken = new Set(out.filter((e) => e.kind === 'dm' && e.userId).map((e) => e.userId));
  const seen = new Set(spoken);
  const person = (userId, name, avatarRef, base, mediaOrigin) => {
    if (!userId || userId === me || seen.has(userId)) return;
    seen.add(userId);
    out.push({
      key: `user:${userId}`,
      group: 'user',
      kind: 'user',
      title: name || shortName(userId),
      where: userId,
      userId,
      avatarRef: avatarRef || null,
      base: base || null,
      mediaOrigin: mediaOrigin || null,
      recentId: null,
      unread: 0,
      mentions: 0,
    });
  };

  const homeBase = store.home?.base || null;
  const homeDomain = store.home?.domain || null;
  for (const friend of store.friends.values()) {
    if (friend.state === 'blocked') continue;
    // A friend's avatar is served by our own home server, even for remote friends.
    person(
      friend.user_id,
      friend.display_name,
      friend.avatar_ref,
      homeBase,
      remoteMediaOrigin(friend.user_id, homeDomain),
    );
  }
  for (const [guildId, roster] of store.members) {
    const base = store.apiForGuild(guildId)?.base || null;
    for (const member of roster.values()) {
      if (member.banned) continue;
      person(
        member.user_id,
        member.nickname || member.display_name,
        member.avatar_ref,
        base,
        null,
      );
    }
  }

  return out;
}

function idleOrder(entries, recentRank) {
  const recents = [];
  const rest = [];
  for (const entry of entries) {
    if (entry.recentId && recentRank.has(entry.recentId)) recents.push(entry);
    else rest.push(entry);
  }
  recents.sort((a, b) => recentRank.get(a.recentId) - recentRank.get(b.recentId));
  rest.sort((a, b) => (
    (b.mentions - a.mentions)
    || (b.unread - a.unread)
    || a.title.localeCompare(b.title)
  ));
  return [...recents, ...rest];
}

export function rankDestinations(entries, raw, { recent = [], limit = MAX_ROWS } = {}) {
  const { filter, text } = parseQuery(raw);
  const pool = filter ? entries.filter(filter.match) : entries;
  const recentRank = new Map();
  recent.forEach((id, at) => { if (!recentRank.has(id)) recentRank.set(id, at); });

  if (!text) {
    return idleOrder(pool, recentRank).slice(0, limit).map((entry) => ({ entry, positions: [] }));
  }

  const hits = [];
  for (const entry of pool) {
    const match = fuzzyMatch(entry.title, text);
    if (!match) continue;
    const rank = entry.recentId && recentRank.has(entry.recentId)
      ? recentRank.get(entry.recentId)
      : -1;
    hits.push({
      entry,
      positions: match.positions,
      score: match.score
        + recencyBonus(rank)
        + (entry.mentions ? BONUS_MENTION : 0)
        + (entry.unread ? BONUS_UNREAD : 0),
    });
  }
  // Ties broken by name so the list doesn't shuffle under the cursor.
  hits.sort((a, b) => (b.score - a.score) || a.entry.title.localeCompare(b.entry.title));
  return hits.slice(0, limit);
}
