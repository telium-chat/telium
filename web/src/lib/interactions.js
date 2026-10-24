// App-authored message UI. Nothing is trusted: strings are clamped and stripped, URLs admitted by scheme and host, images only via this federation's proxy. No React, so the checks are testable. Pending state is module-level because a deferred interaction outlives its message row.

import { destinationOf, ownHosts } from './link-trust.js';
import { mediaUrl } from './media.js';

/// Layout bounds; the server validates on write, this is the last fence before the DOM.
export const LIMITS = {
  customId: 100,
  buttonLabel: 80,
  placeholder: 150,
  optionLabel: 100,
  optionDescription: 100,
  cardTitle: 256,
  cardDescription: 4096,
  fieldName: 256,
  fieldValue: 1024,
  footer: 2048,
  authorName: 256,
  modalTitle: 120,
  inputLabel: 100,
  inputValue: 4000,
  rows: 5,
  perRow: 5,
  options: 25,
  fields: 25,
  cards: 10,
  modalInputs: 5,
};

export const BUTTON_STYLES = new Set(['primary', 'secondary', 'success', 'danger', 'link']);

// Strips bidi overrides, zero-width and tag characters, soft hyphen, invisible operators and C0/C1 controls. The `u` flag is load-bearing (tag range). The first alternative keeps a well-formed England/Scotland/Wales flag sequence whole.
const UNSAFE_CHARS =
  /\u{1F3F4}[\u{E0030}-\u{E0039}\u{E0061}-\u{E007A}]{2,6}\u{E007F}|[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\u{E0000}-\u{E007F}]/gu;

/// The clamp appends an ellipsis so a cut is visible.
export function plainText(value, max, { multiline = false } = {}) {
  if (typeof value !== 'string') return '';
  // Deletes everything except a well-formed subdivision flag (see UNSAFE_CHARS).
  let text = value.replace(UNSAFE_CHARS, (m) => (m.codePointAt(0) === 0x1f3f4 ? m : ''));
  text = multiline
    // Three blank lines in a row push everything below off screen.
    ? text.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n')
    : text.replace(/\s+/g, ' ');
  text = text.trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

export function safeCustomId(value) {
  if (typeof value !== 'string') return '';
  const id = value.replace(UNSAFE_CHARS, '');
  if (!id || id.length > LIMITS.customId) return '';
  return id;
}

/// `destinationOf` refuses non-http(s) and relative URLs; the cross-origin warning relies on a real `<a target="_blank">` (see `AppButton`).
export function safeLinkUrl(raw) {
  const found = destinationOf(raw);
  return found ? found.href : null;
}

const PROXY_PATH = /^\/_telium\/v1\/(camo|media)\//;
const BARE_HASH = /^[A-Fa-f0-9]{16,128}$/;

/// The server resolves a card image to `{ kind: "media", origin, hash, ... }` or `{ kind: "camo", url, ... }`; both are re-checked against `ownHosts`. Anything else draws nothing, since any request leaks that the reader is in the room.
export function proxiedMedia(store, base, raw) {
  if (!raw) return null;

  if (typeof raw === 'object') {
    // `origin` names the owning server; a foreign one goes through this server's federation cache.
    if (raw.kind === 'media' || (typeof raw.hash === 'string' && !raw.url)) {
      if (!BARE_HASH.test(String(raw.hash || ''))) return null;
      return mediaUrl(base, raw.hash, foreignOrigin(base, raw.origin));
    }
    // Resolved (`url`) or application-written (`camo`); the string check below proves the host.
    if (typeof raw.url === 'string') return proxiedMedia(store, base, raw.url);
    if (typeof raw.camo === 'string') return proxiedMedia(store, base, raw.camo);
    return null;
  }

  if (typeof raw !== 'string' || !raw) return null;
  // A bare hash names a cache entry on the channel's own server.
  if (BARE_HASH.test(raw)) return `${base || ''}/_telium/v1/camo/${raw}`;
  const found = destinationOf(raw);
  if (!found) return null;
  let path;
  try { path = new URL(found.href).pathname; } catch { return null; }
  if (!PROXY_PATH.test(path)) return null;
  if (!ownHosts(store).has(found.host)) return null;
  return found.href;
}

/// `null` means this server.
function foreignOrigin(base, origin) {
  if (typeof origin !== 'string' || !origin) return null;
  let host = '';
  try { host = new URL(base, 'https://invalid.example').host; } catch { host = ''; }
  return origin === host ? null : origin;
}

/// Integer RGB clamped to 24 bits so nothing escapes into CSS.
export function accentFrom(colour) {
  if (typeof colour !== 'number' || !Number.isFinite(colour)) return null;
  const rgb = Math.floor(colour) & 0xFFFFFF;
  const r = (rgb >> 16) & 0xFF;
  const g = (rgb >> 8) & 0xFF;
  const b = rgb & 0xFF;
  return `rgb(${r} ${g} ${b})`;
}

/// Re-checked since the row may come from an older build or federated peer; malformed children are dropped.
export function normalizeComponents(raw, { includeSelects = true } = {}) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const rows = [];
  for (const row of raw.slice(0, LIMITS.rows)) {
    if (!row || row.type !== 'action_row' || !Array.isArray(row.components)) continue;
    const children = [];
    for (const child of row.components.slice(0, LIMITS.perRow)) {
      const item = normalizeChild(child, seen, includeSelects);
      if (item) children.push(item);
    }
    if (children.length) rows.push({ type: 'action_row', components: children });
  }
  return rows;
}

function normalizeChild(child, seen, includeSelects) {
  if (!child || typeof child !== 'object') return null;
  if (child.type === 'button') return normalizeButton(child, seen);
  if (child.type === 'select' && includeSelects) return normalizeSelect(child, seen);
  return null;
}

/// `custom_id` keys the pending state, so it must be unique per message.
function claim(seen, id) {
  if (!id || seen.has(id)) return false;
  seen.add(id);
  return true;
}

function normalizeButton(raw, seen) {
  const style = BUTTON_STYLES.has(raw.style) ? raw.style : 'secondary';
  const label = plainText(raw.label, LIMITS.buttonLabel);
  const emoji = plainText(raw.emoji, 16);
  if (!label && !emoji) return null;

  if (style === 'link') {
    const url = safeLinkUrl(raw.url);
    // Kept as a disabled button so a refusal is visible.
    return { type: 'button', style, label, emoji, url, disabled: !url || Boolean(raw.disabled) };
  }

  const customId = safeCustomId(raw.custom_id);
  if (!claim(seen, customId)) return null;
  return {
    type: 'button', style, label, emoji, customId, disabled: Boolean(raw.disabled),
  };
}

function normalizeSelect(raw, seen) {
  const customId = safeCustomId(raw.custom_id);
  if (!claim(seen, customId)) return null;
  const options = [];
  const values = new Set();
  for (const opt of (Array.isArray(raw.options) ? raw.options : []).slice(0, LIMITS.options)) {
    if (!opt || typeof opt !== 'object') continue;
    const value = safeCustomId(opt.value);
    const label = plainText(opt.label, LIMITS.optionLabel);
    if (!value || !label || values.has(value)) continue;
    values.add(value);
    options.push({
      value,
      label,
      description: plainText(opt.description, LIMITS.optionDescription),
      emoji: plainText(opt.emoji, 16),
      default: Boolean(opt.default),
    });
  }
  if (!options.length) return null;
  // Clamp min/max to what the list can satisfy.
  const max = clampInt(raw.max, 1, options.length, 1);
  const min = clampInt(raw.min, 0, max, max > 1 ? 0 : 1);
  return {
    type: 'select',
    customId,
    placeholder: plainText(raw.placeholder, LIMITS.placeholder),
    options,
    min,
    max,
    disabled: Boolean(raw.disabled),
  };
}

function clampInt(value, low, high, fallback) {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.min(high, Math.max(low, n));
}

/// Not `lib/embeds.js`: a card is app-written, an unfurl is server-fetched.
export function normalizeCards(raw, { store, base } = {}) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, LIMITS.cards).map((card) => normalizeCard(card, { store, base })).filter(Boolean);
}

function normalizeCard(raw, { store, base }) {
  if (!raw || typeof raw !== 'object') return null;
  const title = plainText(raw.title, LIMITS.cardTitle);
  const description = plainText(raw.description, LIMITS.cardDescription, { multiline: true });
  const author = raw.author && typeof raw.author === 'object'
    ? {
      name: plainText(raw.author.name, LIMITS.authorName),
      icon: proxiedMedia(store, base, raw.author.icon_url || raw.author.icon),
      url: safeLinkUrl(raw.author.url),
    }
    : null;
  const footer = raw.footer && typeof raw.footer === 'object'
    ? {
      text: plainText(raw.footer.text, LIMITS.footer),
      icon: proxiedMedia(store, base, raw.footer.icon_url || raw.footer.icon),
    }
    : null;
  const fields = (Array.isArray(raw.fields) ? raw.fields : [])
    .slice(0, LIMITS.fields)
    .map((f) => (f && typeof f === 'object' ? {
      name: plainText(f.name, LIMITS.fieldName),
      value: plainText(f.value, LIMITS.fieldValue, { multiline: true }),
      inline: Boolean(f.inline),
    } : null))
    .filter((f) => f && (f.name || f.value));

  const card = {
    title,
    description,
    url: safeLinkUrl(raw.url),
    accent: accentFrom(raw.colour ?? raw.color),
    author: author && (author.name || author.icon) ? author : null,
    fields,
    image: proxiedMedia(store, base, raw.image),
    thumbnail: proxiedMedia(store, base, raw.thumbnail),
    footer: footer && (footer.text || footer.icon) ? footer : null,
    timestamp: timestampOf(raw.timestamp),
  };

  const carries = card.title || card.description || card.fields.length
    || card.image || card.thumbnail || card.author || card.footer || card.timestamp;
  return carries ? card : null;
}

/// `new Date(x)` on a hostile string gives Invalid Date.
function timestampOf(raw) {
  if (raw == null) return null;
  const at = typeof raw === 'number' ? new Date(raw) : new Date(String(raw));
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

/// `text_input` is only drawn inside a modal the reader opened.
export function normalizeModal(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const customId = safeCustomId(raw.custom_id);
  const title = plainText(raw.title, LIMITS.modalTitle);
  if (!customId || !title) return null;
  const inputs = [];
  const seen = new Set();
  for (const row of (Array.isArray(raw.components) ? raw.components : []).slice(0, LIMITS.modalInputs)) {
    const children = row?.type === 'action_row' && Array.isArray(row.components)
      ? row.components
      : [row];
    for (const child of children) {
      const input = normalizeTextInput(child, seen);
      if (input) inputs.push(input);
    }
  }
  return inputs.length ? { customId, title, inputs: inputs.slice(0, LIMITS.modalInputs) } : null;
}

function normalizeTextInput(raw, seen) {
  if (!raw || raw.type !== 'text_input') return null;
  const customId = safeCustomId(raw.custom_id);
  const label = plainText(raw.label, LIMITS.inputLabel);
  if (!claim(seen, customId) || !label) return null;
  const style = raw.style === 'paragraph' ? 'paragraph' : 'short';
  const max = clampInt(raw.max, 1, LIMITS.inputValue, LIMITS.inputValue);
  const min = clampInt(raw.min, 0, max, 0);
  return {
    customId,
    label,
    style,
    required: Boolean(raw.required),
    min,
    max,
    placeholder: plainText(raw.placeholder, LIMITS.placeholder),
    value: plainText(raw.value, max, { multiline: style === 'paragraph' }),
  };
}

/// Ephemeral vs channel route comes from `msg.ephemeral` (set here), never the app payload, since they authorise differently.
export const interactionRoute = (channelId, messageId, { ephemeral = false } = {}) => (
  ephemeral
    ? `/_telium/v1/channels/${channelId}/ephemeral/${messageId}/interact`
    : `/_telium/v1/channels/${channelId}/messages/${messageId}/interact`
);

/// The presser never gets the interaction token (the app's credential).
export const modalRoute = (interactionId) => (
  `/_telium/v1/interactions/${interactionId}/modal`
);

/// Token lifetime (fifteen minutes).
export const DEFERRED_TTL_MS = 15 * 60 * 1000;

/// Silence gets a short leash; the press becomes available again.
export const SILENCE_MS = 15_000;

// Module state: `update_message` rebuilds the row, which would destroy component state.
const pending = new Map();
const listeners = new Set();

const keyOf = (messageId, customId) => `${messageId}\u0000${customId}`;

function announce() {
  for (const fn of [...listeners]) fn();
}

/// Coarse on purpose: one listener, not one per button.
export function subscribeInteractions(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function interactionPhase(messageId, customId) {
  return pending.get(keyOf(messageId, customId))?.phase || 'idle';
}

function setPhase(messageId, customId, next) {
  const key = keyOf(messageId, customId);
  const held = pending.get(key);
  if (held?.timer) clearTimeout(held.timer);
  if (!next) pending.delete(key);
  else pending.set(key, { ...held, ...next });
  announce();
}

export function beginInteraction(messageId, customId) {
  setPhase(messageId, customId, { phase: 'sending', since: Date.now() });
  return keyOf(messageId, customId);
}

export function endInteraction(messageId, customId) {
  setPhase(messageId, customId, null);
}

export function deferInteraction(messageId, customId, { ttl = DEFERRED_TTL_MS, phase = 'deferred' } = {}) {
  const timer = setTimeout(() => endInteraction(messageId, customId), ttl);
  // `unref` is absent in browsers.
  timer?.unref?.();
  // `sending` gets the short leash; `deferred` gets the full token lifetime.
  setPhase(messageId, customId, { phase, since: Date.now(), timer });
}

export function forgetInteractions() {
  for (const held of pending.values()) if (held.timer) clearTimeout(held.timer);
  pending.clear();
  waiters.clear();
  ephemeral.clear();
  announce();
  announceEphemeral();
}

/// Returns the interaction id and kind; the answer arrives later as a gateway frame.
export async function postInteraction(api, { channelId, messageId, customId, values, ephemeral }) {
  if (!api?.post) throw new Error('No server for this channel.');
  // The server resolves both against the stored component tree.
  const body = { custom_id: customId };
  if (values) body.values = values;
  return (await api.post(interactionRoute(channelId, messageId, { ephemeral }), body)) || null;
}

export async function postModalSubmit(api, { interactionId, fields }) {
  if (!api?.post) throw new Error('No server for this channel.');
  if (!interactionId) throw new Error('This form is no longer open.');
  return (await api.post(modalRoute(interactionId), { components: fields })) || null;
}

// Ephemeral messages stay out of `store.messages` (paged, acked, unread-counted; the server never heard of these).
const ephemeral = new Map();
const ephemeralListeners = new Set();
const MAX_EPHEMERAL = 20;

function announceEphemeral() {
  for (const fn of [...ephemeralListeners]) fn();
}

export function subscribeEphemeral(fn) {
  ephemeralListeners.add(fn);
  return () => ephemeralListeners.delete(fn);
}

export function ephemeralFor(channelId) {
  return ephemeral.get(channelId) || [];
}

/// Capped per channel, dropping the oldest.
export function noteEphemeral(channelId, msg) {
  if (!channelId || !msg) return null;
  const list = ephemeral.get(channelId) || [];
  const entry = { ...msg, channel_id: channelId, ephemeral: true };
  if (!entry.id) entry.id = `ephemeral-${Date.now()}-${list.length}`;
  if (!entry.created_at) entry.created_at = new Date().toISOString();
  const next = [...list, entry].slice(-MAX_EPHEMERAL);
  ephemeral.set(channelId, next);
  announceEphemeral();
  return entry;
}

export function dismissEphemeral(channelId, id) {
  const list = ephemeral.get(channelId);
  if (!list) return;
  ephemeral.set(channelId, list.filter((m) => m.id !== id));
  announceEphemeral();
}

/// Absent fields are left alone.
export function updateEphemeral(channelId, patch) {
  const list = ephemeral.get(channelId);
  if (!list || !patch?.id) return null;
  let found = null;
  const next = list.map((msg) => {
    if (msg.id !== patch.id) return msg;
    found = {
      ...msg,
      ...(patch.content == null ? {} : { content: patch.content }),
      ...('components' in patch ? { components: patch.components } : {}),
      ...('cards' in patch ? { cards: patch.cards } : {}),
      ephemeral: true,
    };
    return found;
  });
  if (!found) return null;
  ephemeral.set(channelId, next);
  announceEphemeral();
  return found;
}

export function ephemeralFrame(t, d) {
  if (!d || typeof d !== 'object') return null;
  if (t === 'EPHEMERAL_MESSAGE_CREATE') return d;
  if (t === 'MESSAGE_CREATE' && d.ephemeral) return d;
  return null;
}

// Follow-up frames name the interaction, not the button.
const waiters = new Map();

export function awaitFollowUp(interactionId, at) {
  if (!interactionId) return;
  waiters.set(interactionId, at);
}

function releaseWaiter(interactionId) {
  const at = waiters.get(interactionId);
  if (!at) return null;
  waiters.delete(interactionId);
  endInteraction(at.messageId, at.customId);
  return at;
}

/// For frames that don't name an interaction.
function releaseWaitersOn(messageId) {
  if (!messageId) return;
  for (const [id, at] of [...waiters]) {
    if (at.messageId === messageId) releaseWaiter(id);
  }
}

// A `modal` frame becomes an announcement `useInteractions` picks up.
const modalListeners = new Set();

export function subscribeModalRequests(fn) {
  modalListeners.add(fn);
  return () => modalListeners.delete(fn);
}

function announceModal(request) {
  for (const fn of [...modalListeners]) fn(request);
}

/// Called for every dispatch, so "not mine" returns fast. A bare `MESSAGE_UPDATE` releases the control on purpose: an edit is a visible answer.
export function handleInteractionFrame(store, t, d) {
  if (!d || typeof d !== 'object') return;

  // A message only this reader can see.
  const ghost = ephemeralFrame(t, d);
  if (ghost) {
    const at = ghost.interaction_id ? waiters.get(ghost.interaction_id) : null;
    noteEphemeral(ghost.channel_id || at?.channelId, ghost);
    if (ghost.interaction_id) releaseWaiter(ghost.interaction_id);
    return;
  }

  if (t === 'INTERACTION_DEFERRED') {
    const at = waiters.get(d.interaction_id);
    if (!at) return;
    // The promise arrived; switch to the full token lifetime.
    deferInteraction(at.messageId, at.customId);
    return;
  }

  if (t === 'MODAL_OPEN') {
    const at = waiters.get(d.interaction_id);
    if (!at) return;
    const modal = normalizeModal(d);
    // Release before the dialog opens; the form has its own busy state.
    releaseWaiter(d.interaction_id);
    if (modal) announceModal({ at, interactionId: String(d.interaction_id), modal });
    return;
  }

  if (t === 'EPHEMERAL_MESSAGE_UPDATE') {
    const at = waiters.get(d.interaction_id);
    updateEphemeral(d.channel_id || at?.channelId, d);
    // No interaction id: find the control by message (ephemeral press is filed under `d.id`).
    releaseWaitersOn(d.id);
    return;
  }

  if (t === 'MESSAGE_UPDATE') {
    releaseWaitersOn(d.id);
    return;
  }

  if (t === 'MESSAGE_CREATE' && d.reply_to) {
    releaseWaitersOn(d.reply_to);
  }
}

const attached = new Map();

export function attachInteractions(store) {
  if (!store?.on) return () => {};
  const held = attached.get(store);
  if (held) {
    held.count += 1;
  } else {
    const off = store.on('dispatch', ({ t, d }) => handleInteractionFrame(store, t, d));
    attached.set(store, { count: 1, off });
  }
  return () => {
    const entry = attached.get(store);
    if (!entry) return;
    entry.count -= 1;
    if (entry.count > 0) return;
    entry.off?.();
    attached.delete(store);
  };
}
