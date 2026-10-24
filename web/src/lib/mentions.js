// Mention tokens (`<@id>`, `<@&ULID>`, `<#ULID>`) and the composer's display form: labels bracketed by invisible sentinels, restored by `toWireMentions`.

import { colourOf, shortName } from './util.js';
import {
  previewSpans, runRe, strayRunRe, RUN_CLOSE, RUN_FIRST, RUN_LAST, RUN_OPEN,
} from './markdown-preview.js';
import { hasStandIn, toDisplayText, toWireText } from './emoji.js';

const ULID = '[A-Z0-9]{26}';
export const USER_ID = '@[a-z0-9._-]{1,32}:[a-zA-Z0-9-]+(?:\\.[a-zA-Z0-9-]+)*(?::[0-9]{2,5})?';
export const USER = `<${USER_ID}>`;
export const ROLE = `<@&${ULID}>`;
export const CHANNEL = `<#${ULID}>`;
// `@everyone` and `@here` stay bare: the server matches the literal words.
export const BROADCAST = '@(?:everyone|here)(?![\\w.:@-])';
// Pre-delimiting messages carry the bare id and can't be migrated, so it stays readable.
export const LEGACY_USER = USER_ID;

export function parseMention(raw) {
  const text = typeof raw === 'string' ? raw : '';
  if (new RegExp(`^${ROLE}$`).test(text)) return { kind: 'role', id: text.slice(3, -1) };
  if (new RegExp(`^${CHANNEL}$`).test(text)) return { kind: 'channel', id: text.slice(2, -1) };
  if (new RegExp(`^${USER}$`).test(text)) return { kind: 'user', id: text.slice(1, -1) };
  if (new RegExp(`^${LEGACY_USER}$`).test(text)) return { kind: 'user', id: text };
  if (/^@(?:everyone|here)$/.test(text)) return { kind: 'broadcast', id: text };
  return null;
}

export function mentionToken(kind, id) {
  if (kind === 'role') return `<@&${id}>`;
  if (kind === 'channel') return `<#${id}>`;
  if (kind === 'broadcast') return id;
  return `<${id}>`;
}

export function displayNameOf(store, guildId, userId) {
  const member = store?.members?.get?.(guildId)?.get?.(userId);
  const named = member?.nickname
    || member?.display_name
    || (userId && userId === store?.me?.user_id ? store?.me?.display_name : null)
    || store?.friends?.get?.(userId)?.display_name
    || store?.peerProfile?.(userId)?.display_name;
  return named || shortName(userId) || userId || '';
}

export function resolveMention(parsed, ctx = {}) {
  const store = ctx.store;
  if (!parsed) return null;
  if (parsed.kind === 'role') {
    const role = store?.roles?.get?.(ctx.guildId)?.get?.(parsed.id);
    const mine = !!store?.myMember?.(ctx.guildId)?.roles?.includes(parsed.id);
    return {
      ...parsed,
      label: role ? `@${role.name}` : '@unknown-role',
      colour: role?.color ? colourOf(role.color) : null,
      title: role ? `Role: ${role.name}` : 'A role on another server',
      mine,
    };
  }
  if (parsed.kind === 'channel') {
    const channel = store?.channels?.get?.(parsed.id);
    return {
      ...parsed,
      label: channel ? `#${channel.name}` : '#unknown',
      colour: null,
      title: channel?.topic || (channel ? `#${channel.name}` : 'A channel you cannot see'),
      mine: false,
      channel,
    };
  }
  if (parsed.kind === 'broadcast') {
    return { ...parsed, label: parsed.id, colour: null, title: 'Notifies the channel', mine: true };
  }
  return {
    ...parsed,
    label: `@${displayNameOf(store, ctx.guildId, parsed.id)}`,
    colour: null,
    title: parsed.id,
    mine: parsed.id === ctx.me,
  };
}

/// The label for a token, resolved. The composer needs only this much.
export function labelFor(token, ctx) {
  return resolveMention(parseMention(token), ctx)?.label || token;
}

// -------------------------------------------------------------- display text

// Sentinel table for the life of the tab, so pasted text still resolves. 239 selectors max; past it a token stays literal.
const bySelector = new Map();
const byMention = new Map();

function allocate(token, label) {
  const key = `${token}\u0000${label}`;
  const seen = byMention.get(key);
  if (seen) return seen;
  if (byMention.size > RUN_LAST - RUN_FIRST) return null;
  const selector = String.fromCodePoint(RUN_FIRST + byMention.size);
  byMention.set(key, selector);
  bySelector.set(selector, { token, label });
  return selector;
}

function literalMask(text) {
  const literal = new Uint8Array(text.length);
  for (const span of previewSpans(text)) {
    if (!span.kinds.includes('code') && !span.kinds.includes('codeblock')) continue;
    for (let i = span.start; i < span.end; i += 1) literal[i] = 1;
  }
  return literal;
}

const wireRe = () => new RegExp(`${ROLE}|${CHANNEL}|${USER}`, 'g');

/// A bare legacy id is left alone so editing never promotes typed text to a ping.
export function toDisplayMentions(wire, ctx = {}) {
  const text = typeof wire === 'string' ? wire : '';
  if (!text.includes('<')) return text;
  const literal = literalMask(text);
  return text.replace(wireRe(), (token, at) => {
    for (let i = at; i < at + token.length; i += 1) if (literal[i]) return token;
    const label = labelFor(token, ctx);
    const selector = allocate(token, label);
    return selector ? `${RUN_OPEN}${selector}${label}${RUN_CLOSE}` : token;
  });
}

export function toWireMentions(display) {
  const text = typeof display === 'string' ? display : '';
  if (!text.includes(RUN_OPEN) && !text.includes(RUN_CLOSE)) return text;
  const out = text.replace(runRe(), (raw, selector, label) => {
    const entry = bySelector.get(selector);
    return entry && entry.label === label ? entry.token : label;
  });
  return out.replace(strayRunRe(), '');
}

export function splitMentions(text) {
  const parts = [];
  if (typeof text !== 'string' || !text) return parts;
  const re = runRe();
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    const entry = bySelector.get(m[1]);
    if (!entry || entry.label !== m[2]) continue;
    if (m.index > last) parts.push({ text: text.slice(last, m.index) });
    parts.push({ run: m[0], token: entry.token, label: entry.label });
    last = m.index + m[0].length;
  }
  if (last < text.length || !parts.length) parts.push({ text: text.slice(last) });
  return parts;
}

export function hasDisplayOnly(text) {
  if (hasStandIn(text)) return true;
  return typeof text === 'string' && text.includes(RUN_OPEN) && runRe().test(text);
}

export function displayText(wire, ctx) {
  return toDisplayMentions(toDisplayText(wire), ctx);
}

export function wireText(display) {
  return toWireText(toWireMentions(display));
}
