/// Guild rail order and folders: a preference in the sync store, as an ordered list of `{ kind: 'guild', id }` and `{ kind: 'folder', id, name, collapsed, guilds }` nodes. Every operation is a pure list-to-list function.

export function folderId() {
  const rand = globalThis.crypto?.randomUUID?.();
  if (rand) return `f-${rand.slice(0, 8)}`;
  return `f-${Math.random().toString(36).slice(2, 10)}`;
}

/// A guild not in the arrangement joins the end in name order; one named twice is kept once; an empty folder is dropped.
export function normalizeRail(saved, guilds) {
  const known = new Map(guilds.map((g) => [g.id, g]));
  const seen = new Set();
  const out = [];
  for (const node of Array.isArray(saved) ? saved : []) {
    if (!node) continue;
    if (node.kind === 'folder') {
      const ids = (node.guilds || []).filter((id) => known.has(id) && !seen.has(id));
      for (const id of ids) seen.add(id);
      if (!ids.length) continue;
      out.push({
        kind: 'folder',
        id: node.id || folderId(),
        name: typeof node.name === 'string' ? node.name : '',
        collapsed: Boolean(node.collapsed),
        guilds: ids,
      });
      continue;
    }
    // A bare string is tolerated: an older or hand-edited value may hold one, and rejecting it would reset the rail.
    const id = node.kind === 'guild' ? node.id : node;
    if (typeof id !== 'string' || !known.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({ kind: 'guild', id });
  }
  const rest = guilds
    .filter((g) => !seen.has(g.id))
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  for (const g of rest) out.push({ kind: 'guild', id: g.id });
  return out;
}

export function findRail(nodes, ref) {
  if (!ref) return null;
  if (ref.type === 'folder') return nodes.find((n) => n.kind === 'folder' && n.id === ref.id) || null;
  const top = nodes.find((n) => n.kind === 'guild' && n.id === ref.id);
  if (top) return top;
  const holder = folderOf(nodes, ref.id);
  return holder ? { kind: 'guild', id: ref.id } : null;
}

export function folderOf(nodes, guildId) {
  return nodes.find((n) => n.kind === 'folder' && n.guilds.includes(guildId)) || null;
}

/// Emptying a folder deletes it; the rule lives here so every operation inherits it.
function without(nodes, ref) {
  const out = [];
  for (const node of nodes) {
    if (node.kind !== 'folder') {
      if (ref.type === 'guild' && node.kind === 'guild' && node.id === ref.id) continue;
      out.push(node);
      continue;
    }
    if (ref.type === 'folder' && node.id === ref.id) continue;
    const guilds = ref.type === 'guild' ? node.guilds.filter((id) => id !== ref.id) : node.guilds;
    if (!guilds.length) continue;
    out.push(guilds === node.guilds ? node : { ...node, guilds });
  }
  return out;
}

/// The target is held as an object while the source is pulled out, because removal renumbers the gaps after it.
export function moveTo(nodes, ref, gap) {
  const node = findRail(nodes, ref);
  if (!node) return nodes;
  const at = Math.max(0, Math.min(gap, nodes.length));
  const slot = { kind: 'slot' };
  const staged = [...nodes.slice(0, at), slot, ...nodes.slice(at)];
  const moved = ref.type === 'folder' ? node : { kind: 'guild', id: ref.id };
  return without(staged, ref).map((n) => (n === slot ? moved : n));
}

/// Drops one guild onto another into a folder holding both. The only way a folder is made.
export function combine(nodes, ref, targetGuildId) {
  if (ref.type !== 'guild' || ref.id === targetGuildId) return nodes;
  // Dropping onto a guild inside a folder means that folder.
  const holder = folderOf(nodes, targetGuildId);
  if (holder) return addToFolder(nodes, ref, holder.id);
  if (!nodes.some((n) => n.kind === 'guild' && n.id === targetGuildId)) return nodes;
  const pruned = without(nodes, ref);
  const folder = {
    kind: 'folder',
    id: folderId(),
    name: '',
    collapsed: false,
    guilds: [targetGuildId, ref.id],
  };
  return pruned.map((n) => (n.kind === 'guild' && n.id === targetGuildId ? folder : n));
}

export function addToFolder(nodes, ref, id, at = Infinity) {
  if (ref.type !== 'guild') return nodes;
  const target = nodes.find((n) => n.kind === 'folder' && n.id === id);
  if (!target) return nodes;
  // Pruning first makes this also work as reorder inside the folder.
  const pruned = without(nodes, ref);
  const holder = pruned.find((n) => n.kind === 'folder' && n.id === id);
  // Its own last guild: pruning took the folder with it, so the guild stays where it is.
  if (!holder) return nodes;
  const guilds = [...holder.guilds];
  guilds.splice(Math.max(0, Math.min(at, guilds.length)), 0, ref.id);
  return pruned.map((n) => (n === holder ? { ...holder, guilds } : n));
}

export function renameFolder(nodes, id, name) {
  return nodes.map((n) => (n.kind === 'folder' && n.id === id
    ? { ...n, name: name.trim().slice(0, 48) }
    : n));
}

export function setCollapsed(nodes, id, collapsed) {
  return nodes.map((n) => (n.kind === 'folder' && n.id === id ? { ...n, collapsed } : n));
}

/// Deleting a folder opens it: its guilds stay on the rail, in order.
export function dissolveFolder(nodes, id) {
  const out = [];
  for (const node of nodes) {
    if (node.kind === 'folder' && node.id === id) {
      for (const guildId of node.guilds) out.push({ kind: 'guild', id: guildId });
    } else out.push(node);
  }
  return out;
}

export function folderLabel(folder, guilds) {
  if (folder.name) return folder.name;
  const names = folder.guilds
    .map((id) => guilds.get(id)?.name)
    .filter(Boolean);
  return names.join(', ') || 'Folder';
}

/// For anything that walks guilds in arranged order without drawing folders.
export function orderedGuildIds(nodes) {
  return nodes.flatMap((node) => (node.kind === 'folder' ? node.guilds : [node.id]));
}
