/// `@everyone` shares the guild's id and sits at position 0 and does not move; every other role is at 1 or above. The server is the authority on order.

export function rankedRoles(roles, guildId) {
  return (roles || [])
    .filter((r) => r.id !== guildId)
    .slice()
    .sort((a, b) => (b.position || 0) - (a.position || 0) || a.id.localeCompare(b.id));
}

/// The gap is held as a marker while the role is pulled out, because removing a row renumbers the gaps below it.
export function moveRole(list, id, at) {
  const role = list.find((r) => r.id === id);
  if (!role) return list;
  const gap = Math.max(0, Math.min(at, list.length));
  const slot = { id: null };
  const staged = [...list.slice(0, gap), slot, ...list.slice(gap)];
  return staged
    .filter((r) => r === slot || r.id !== id)
    .map((r) => (r === slot ? role : r));
}

export function rolePlacements(list) {
  return list.map((role, i) => ({ id: role.id, position: list.length - i }));
}

/// Only rows not already where the guild thinks they are.
export function roleMoves(list) {
  return rolePlacements(list).filter((p, i) => (list[i].position || 0) !== p.position);
}

/// The server refuses to move, edit or delete a role at or above the actor's rank, or to move one to such a position.
export function mayHold(me, role) {
  if (!me || !role) return false;
  if (me.is_owner) return true;
  return (me.top_role_position ?? 0) > (role.position || 0);
}

/// Refused for anyone but the owner at either end of the move.
export function mayReorder(me, list, moves) {
  if (!me) return false;
  if (me.is_owner) return true;
  const top = me.top_role_position ?? 0;
  const now = new Map(list.map((r) => [r.id, r.position || 0]));
  return moves.every((p) => (now.get(p.id) ?? 0) < top && p.position < top);
}

export function mayDropAt(me, list, id, at) {
  const next = moveRole(list, id, at);
  return mayReorder(me, list, roleMoves(next));
}
