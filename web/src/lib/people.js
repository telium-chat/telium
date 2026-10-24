// Everybody this client could suggest when it asks "who?", friends first.

import { fuzzyMatch } from './switcher.js';
import { shortName } from './util.js';
import { faceOf } from './faces.js';

export const PEOPLE_LIMIT = 50;

const RANK = { friend: 0, spoken: 1, known: 2 };

export function knownPeople(store) {
  const me = store.me?.user_id || null;
  const blocked = new Set();
  for (const f of store.friends?.values?.() || []) if (f.state === 'blocked') blocked.add(f.user_id);

  const out = new Map();
  // A member row is often the only place a server member's name is known, so keep the first name any source offered.
  const named = new Map();
  const note = (id, tier, name = null) => {
    if (!id || id === me || blocked.has(id)) return;
    if (name && !named.has(id)) named.set(id, name);
    const was = out.get(id);
    if (was && RANK[was.tier] <= RANK[tier]) return;
    out.set(id, { id, tier });
  };

  for (const f of store.friends?.values?.() || []) if (f.state === 'accepted') note(f.user_id, 'friend');
  for (const convo of store.conversations || []) {
    for (const m of convo.members || []) note(m.user_id || m, 'spoken');
  }
  for (const roster of store.members?.values?.() || []) {
    for (const m of roster.values()) if (!m.banned) note(m.user_id, 'known', m.display_name);
  }
  for (const id of store.peerProfiles?.keys?.() || []) note(id, 'known');

  return [...out.values()].map((p) => {
    const face = faceOf(store, p.id);
    return { ...p, name: face?.name || named.get(p.id) || shortName(p.id), face };
  });
}

/// With nothing typed: friends and people you talk to, not every member of every server.
export function rankPeople(people, query, { exclude = new Set(), limit = PEOPLE_LIMIT } = {}) {
  const text = String(query || '').trim().replace(/^@/, '');
  const pool = people.filter((p) => !exclude.has(p.id));
  if (!text) {
    return pool
      .filter((p) => p.tier !== 'known')
      .sort((a, b) => (RANK[a.tier] - RANK[b.tier]) || a.name.localeCompare(b.name))
      .slice(0, limit)
      .map((person) => ({ person, positions: [], idPositions: [] }));
  }
  const hits = [];
  for (const person of pool) {
    const byName = fuzzyMatch(person.name, text);
    const byId = fuzzyMatch(person.id.slice(1), text);
    if (!byName && !byId) continue;
    const idWins = byId && (!byName || byId.score > byName.score);
    hits.push({
      person,
      score: (idWins ? byId.score : byName.score) - RANK[person.tier] * 4,
      positions: idWins ? [] : byName.positions,
      idPositions: idWins ? byId.positions.map((i) => i + 1) : [],
    });
  }
  hits.sort((a, b) => (b.score - a.score) || a.person.name.localeCompare(b.person.name));
  return hits.slice(0, limit);
}

/// An id that names its own server passes through as typed; a bare name gets this session's domain.
export function fullId(typed, domain) {
  const raw = String(typed || '').trim();
  if (!raw) return '';
  const local = raw.startsWith('@') ? raw.slice(1) : raw;
  if (local.includes(':')) return `@${local}`;
  return domain ? `@${local}:${domain}` : `@${local}`;
}
