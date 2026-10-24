// Safe to paste into a public issue: built field by field from an allowlist, never by filtering the store. Sensitive values appear only as shape (count, length, boolean, container kind); the only names are server domains.

import { label } from './failure.js';
import { repeatable } from './retry.js';
import { KEYS } from './sync.js';
import * as snapshot from './snapshot.js';

/// Explicit so a key added later is reported as unrecognised; comparing found to expected kind catches rows that throw on first render.
const LOCAL_KEYS = [
  { key: 'telium.session.v1', kind: 'object', keeps: 'the signed-in session' },
  { key: 'telium.accounts.v1', kind: 'object', keeps: 'every account signed in on this browser' },
  { key: 'telium.sync.v1', kind: 'object', keeps: 'the offline mirror of account settings' },
  { key: 'telium.sync.state.v1', kind: 'object', keeps: 'whether the mirror has been sealed' },
  { key: 'telium.dm-drafts.local.v1', kind: 'object', keeps: 'unsent DM drafts' },
  { key: 'telium.prefs.v1', kind: 'object', keeps: 'pre-sync-store settings, imported once' },
  { key: 'telium.emoji.recent.v1', kind: 'array', keeps: 'pre-sync-store recent emoji' },
  { key: 'telium.emoji.tone.v1', kind: 'string', keeps: 'pre-sync-store skin tone' },
  { key: 'telium.changelog.v1', kind: 'object', keeps: 'the cached changelog and which entry this device has read' },
];

const LOCAL_FAMILIES = [
  { prefix: 'telium.auth.opaque.v1:', keeps: 'servers pinned to password-proof sign-in' },
  { prefix: 'telium.identity.pin.v1:', keeps: 'pinned identity keys' },
];

const SYNC_KINDS = {
  [KEYS.prefs]: 'object',
  [KEYS.emojiRecent]: 'array',
  [KEYS.emojiTone]: 'string',
  [KEYS.gifFavorites]: 'array',
  [KEYS.savedStickers]: 'array',
  [KEYS.drafts]: 'object',
};

function kindOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (value === undefined) return 'missing';
  return typeof value;
}

/// Over-replacing loses detail, under-replacing leaks an id.
export function routeShape(path) {
  return String(path || '/')
    .split('/')
    .map((seg) => (seg && (seg.length > 12 || /[0-9@.]/.test(seg)) ? ':id' : seg))
    .join('/');
}

function readLocal(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function localState() {
  const rows = [];
  for (const entry of LOCAL_KEYS) {
    const raw = readLocal(entry.key);
    if (raw === null) {
      rows.push({ key: entry.key, present: false, keeps: entry.keeps });
      continue;
    }
    let parsed;
    let parses = true;
    try { parsed = JSON.parse(raw); } catch { parses = false; }
    rows.push({
      key: entry.key,
      present: true,
      keeps: entry.keeps,
      parses,
      bytes: raw.length,
      expected_kind: entry.kind,
      found_kind: parses ? kindOf(parsed) : 'unparseable',
      healthy: parses && kindOf(parsed) === entry.kind,
    });
  }
  for (const family of LOCAL_FAMILIES) {
    let count = 0;
    try {
      for (let i = 0; i < localStorage.length; i += 1) {
        if (String(localStorage.key(i)).startsWith(family.prefix)) count += 1;
      }
    } catch { count = -1; }
    rows.push({ key: `${family.prefix}*`, present: count > 0, entries: count, keeps: family.keeps });
  }
  const known = new Set(LOCAL_KEYS.map((e) => e.key));
  const unknown = [];
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const name = String(localStorage.key(i));
      if (!name.startsWith('telium.') || known.has(name)) continue;
      if (LOCAL_FAMILIES.some((f) => name.startsWith(f.prefix))) continue;
      unknown.push(name.includes(':') ? `${name.split(':')[0]}:*` : name);
    }
  } catch { /* storage disabled; the rows above already say so */ }
  return { rows, unrecognised: [...new Set(unknown)].sort() };
}

function syncState(store) {
  const raw = readLocal('telium.sync.v1');
  if (raw === null) return { present: false, rows: [] };
  let mirror = null;
  try { mirror = JSON.parse(raw); } catch { return { present: true, parses: false, rows: [] }; }
  if (!mirror || typeof mirror !== 'object' || Array.isArray(mirror)) {
    return { present: true, parses: true, usable: false, found_kind: kindOf(mirror), rows: [] };
  }
  // Unknown rows are counted, not named: mirror keys arrive over the network, so a name could smuggle data into a public report.
  const rows = [];
  let unrecognised = 0;
  for (const [key, row] of Object.entries(mirror)) {
    if (!SYNC_KINDS[key]) { unrecognised += 1; continue; }
    rows.push({
      key,
      expected_kind: SYNC_KINDS[key],
      found_kind: kindOf(row && typeof row === 'object' ? row.value : undefined),
      healthy: kindOf(row?.value) === SYNC_KINDS[key],
    });
  }
  return {
    present: true,
    parses: true,
    usable: true,
    sealed: store?.sync?.sealed === true,
    rows,
    unrecognised,
  };
}

async function snapshotState(store) {
  const userId = store?.session?.home?.user_id || null;
  if (!userId) return { present: false, reason: 'not signed in' };
  let snap = null;
  try { snap = await snapshot.read(userId); } catch { return { present: false, reason: 'unreadable' }; }
  if (!snap) return { present: false };
  return {
    present: true,
    age_ms: snap.saved_at ? Date.now() - snap.saved_at : null,
    guilds: snap.guilds?.length ?? 0,
    channels: snap.channels?.length ?? 0,
    cached_channels: snap.messages ? Object.keys(snap.messages).length : 0,
    in_use: Boolean(store?.cachedAt),
  };
}

function connections(store) {
  const out = [];
  for (const conn of store?.gw?.connections?.values?.() || []) {
    const failure = conn.failure();
    out.push({
      domain: conn.domain,
      role: conn.role,
      status: conn.status,
      attempts: conn.attempt,
      down_for_ms: conn.downSince ? Date.now() - conn.downSince : null,
      close_code: conn.lastCode || null,
      // Bounded: a server can say anything.
      close_reason: (conn.lastReason || '').slice(0, 200) || null,
      diagnosis: failure ? label(failure.kind) : 'connected',
    });
  }
  return out;
}

/// Errors are bounded library sentences with no content or ids; the count stands in for which conversation.
function dmEncryption(store) {
  const mls = store?.mls;
  const conversations = store?.conversations || [];
  let inGroup = 0;
  const errors = [];
  for (const convo of conversations) {
    if (mls?.joined?.(convo.id)) inGroup += 1;
    const failure = mls?.errorFor?.(convo.id);
    if (failure) {
      const said = failure.body?.message || failure.message || String(failure);
      if (said) errors.push(said.slice(0, 200));
    }
  }
  return {
    engine_present: Boolean(mls),
    // Present but not ready means startup hasn't finished (or never did).
    engine_ready: Boolean(mls?.ready),
    recovery_key: Boolean(mls?.recoveryKey),
    conversations: conversations.length,
    in_group: inGroup,
    loaded: store?.dmFrames?.size ?? 0,
    buffered: store?.dmPending?.size ?? 0,
    awaiting_device: Boolean(store?.vault?.needs_device),
    vault_locked: Boolean(store?.vault?.locked),
    custody: store?.custody?.mode || null,
    // Deduplicated: many conversations behind one broken epoch repeat one sentence.
    sync_errors: [...new Set(errors)].slice(0, 5),
  };
}

export async function collect(store) {
  const nav = typeof navigator === 'undefined' ? {} : navigator;
  return {
    generated_at: new Date().toISOString(),
    build: {
      version: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'unknown',
      id: typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'dev',
    },
    device: {
      user_agent: nav.userAgent || 'unknown',
      language: nav.language || 'unknown',
      online: nav.onLine !== false,
      // "It does not remember anything" is nearly always unavailable storage.
      local_storage: typeof localStorage !== 'undefined' && (() => {
        try { localStorage.getItem('telium.session.v1'); return true; } catch { return false; }
      })(),
      indexed_db: typeof indexedDB !== 'undefined',
      route: typeof location === 'undefined' ? null : routeShape(location.pathname + location.hash),
    },
    account: {
      home_domain: store?.session?.home?.domain || null,
      signed_in: Boolean(store?.session?.home),
      reading_fallback: Boolean(store?.fallback),
      encryption_ready: Boolean(store?.mls),
    },
    counts: {
      servers: Object.keys(store?.session?.servers || {}).length,
      guilds: store?.guilds?.size ?? 0,
      channels: store?.channels?.size ?? 0,
      conversations: store?.conversations?.length ?? 0,
      friends: store?.friends?.size ?? 0,
      cached_channels: store?.messages?.size ?? 0,
      drafts: Object.keys(store?.sync?.get?.(KEYS.drafts) || {}).length,
    },
    connections: connections(store),
    dm_encryption: dmEncryption(store),
    recent_failures: (store?.gw?.history || []).map((h) => ({
      at: new Date(h.at).toISOString(),
      domain: h.domain,
      role: h.role,
      diagnosis: label(h.kind),
      close_code: h.code,
    })),
    local_storage: localState(),
    sync_store: syncState(store),
    snapshot: await snapshotState(store),
  };
}

/// JSON in a fence: no reformatting step for fields to escape the allowlist.
export function toMarkdown(report) {
  return ['```json', JSON.stringify(report, null, 2), '```'].join('\n');
}

export { repeatable };
