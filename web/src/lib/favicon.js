// Unread badge drawn on the tab icon, judged at 16x16.

const MAX_COUNT = 9;

/// Used when `--mention` cannot be read: the light-theme `oklch(53% 0.185 25)`.
const FALLBACK_MENTION = '#c02b2f';

const DOT_SIZE = 0.40;
const COUNT_SIZE = 0.56;
const WIDE_RATIO = 1.45;
const GAP = 0.085;
const INSET = 0.02;
const TEXT_FILL = 0.80;
const TEXT_SPAN = { 1: 0.52, 2: 0.64 };

const FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";

/// The computed `--mention` is `oklch(...)`; push it through a 1x1 canvas to get hex, since the favicon renders outside the document.
let probe = null;
function mentionColor() {
  try {
    const raw = getComputedStyle(document.documentElement)
      .getPropertyValue('--mention').trim();
    if (!raw) return FALLBACK_MENTION;
    if (!probe) {
      probe = document.createElement('canvas');
      probe.width = 1; probe.height = 1;
    }
    const ctx = probe.getContext('2d', { willReadFrequently: true });
    if (!ctx) return raw;
    // A rejected colour leaves `fillStyle` unchanged, hence the black sentinel.
    ctx.fillStyle = '#000000';
    ctx.fillStyle = raw;
    if (ctx.fillStyle === '#000000' && !/^#0{3,8}$/.test(raw)) return FALLBACK_MENTION;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
  } catch {
    return FALLBACK_MENTION;
  }
}

function viewBoxOf(openTag) {
  const found = /viewBox\s*=\s*["']([^"']+)["']/i.exec(openTag);
  const parts = (found?.[1] || '').trim().split(/[\s,]+/).map(Number);
  if (parts.length === 4 && parts.every(Number.isFinite)) {
    const [x, y, w, h] = parts;
    if (w > 0 && h > 0) return { x, y, w, h };
  }
  return { x: 0, y: 0, w: 512, h: 512 };
}

function escapeText(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function badgedFaviconSvg(source, { dot = false, count = 0, color = FALLBACK_MENTION } = {}) {
  const open = /<svg\b[^>]*>/i.exec(source)?.[0];
  const end = source.lastIndexOf('</svg>');
  if (!open || end < 0) return null;
  if (!dot && count <= 0) return source;

  const inner = source.slice(source.indexOf(open) + open.length, end);
  const box = viewBoxOf(open);
  const unit = Math.min(box.w, box.h);

  const label = count > 0 ? (count > MAX_COUNT ? `${MAX_COUNT}+` : String(count)) : '';
  const height = (count > 0 ? COUNT_SIZE : DOT_SIZE) * unit;
  const width = label.length > 1 ? height * WIDE_RATIO : height;

  const inset = INSET * unit;
  const right = box.x + box.w - inset;
  const bottom = box.y + box.h - inset;
  const left = right - width;
  const top = bottom - height;

  // The gap is punched out rather than painted, since the tab strip may be light or dark.
  const gap = GAP * unit;
  const id = 'telium-badge-cut';
  const mask = `<mask id="${id}" maskUnits="userSpaceOnUse" `
    + `x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}">`
    + `<rect x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" fill="#fff"/>`
    + `<rect x="${left - gap}" y="${top - gap}" width="${width + gap * 2}" `
    + `height="${height + gap * 2}" rx="${(height + gap * 2) / 2}" fill="#000"/>`
    + '</mask>';

  const pill = `<rect x="${left}" y="${top}" width="${width}" height="${height}" `
    + `rx="${height / 2}" fill="${color}"/>`;

  // `textLength` pins glyph width across fonts; the baseline uses cap height since not every renderer honours `dominant-baseline`.
  const size = height * TEXT_FILL;
  const text = label
    ? `<text x="${left + width / 2}" y="${top + height / 2 + size * 0.36}" `
      + `text-anchor="middle" textLength="${width * (TEXT_SPAN[label.length] || 0.64)}" `
      + 'lengthAdjust="spacingAndGlyphs" '
      + `font-family="${FONT}" font-size="${size}" font-weight="700" `
      + `fill="#fff">${escapeText(label)}</text>`
    : '';

  return `${open}${mask}<g mask="url(#${id})">${inner}</g>${pill}${text}</svg>`;
}

function dataUri(svg) {
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

let link = null;
let originalHref = null;
let source = null;
let loading = null;
let drawn = null;
let frame = 0;

function iconLink() {
  if (link?.isConnected) return link;
  link = document.getElementById('favicon')
    || document.querySelector('link[rel~="icon"]:not([rel~="apple-touch-icon"])');
  if (link && originalHref === null) originalHref = link.getAttribute('href');
  return link;
}

/// Swap the node rather than `href`: some browsers only re-read the icon when the element changes.
function setHref(href) {
  const current = iconLink();
  if (!current) return;
  const next = document.createElement('link');
  next.id = 'favicon';
  next.rel = 'icon';
  next.type = 'image/svg+xml';
  next.href = href;
  current.replaceWith(next);
  link = next;
}

async function loadSource() {
  if (source !== null) return source;
  if (!loading) {
    const current = iconLink();
    const href = current?.href;
    loading = (async () => {
      if (!href || typeof fetch !== 'function') return '';
      try {
        const res = await fetch(href, { cache: 'force-cache' });
        const text = res.ok ? await res.text() : '';
        return /<svg\b/i.test(text) ? text : '';
      } catch {
        return '';
      }
    })().then((text) => { source = text; return text; });
  }
  return loading;
}

/// Uses the store's helpers so muted channels drop out. A DM counts as a mention.
function totalsOf(store) {
  let unread = 0;
  let mentions = 0;
  try {
    for (const channel of store.channels?.values?.() || []) {
      if (!channel?.guild_id || !store.guilds?.has?.(channel.guild_id)) continue;
      if (store.isMuted?.(channel.id)) continue;
      const state = store.unreadFor(channel.id);
      unread += state?.unread || 0;
      mentions += state?.mentions || 0;
    }
    const dms = store.dmUnreadTotal?.() || 0;
    unread += dms;
    mentions += dms;
  } catch {
    // A store still assembling itself is not an error; it will emit again.
  }
  return { unread, mentions };
}

async function draw(store) {
  const { unread, mentions } = totalsOf(store);
  const count = Math.max(0, mentions);
  const dot = count === 0 && unread > 0;
  const shape = count > 0 ? `n${Math.min(count, MAX_COUNT + 1)}` : (dot ? 'dot' : 'plain');
  // The colour is in the key so a theme switch redraws.
  const color = shape === 'plain' ? '' : mentionColor();
  const key = `${shape}:${color}`;
  if (key === drawn) return;

  if (shape === 'plain') {
    const had = drawn !== null;
    drawn = key;
    if (had && originalHref !== null) setHref(originalHref);
    return;
  }

  const svg = await loadSource();
  if (!svg) return;
  const badged = badgedFaviconSvg(svg, { dot, count, color });
  if (!badged) return;
  drawn = key;
  setHref(dataUri(badged));
}

export function restoreFavicon() {
  if (originalHref !== null) setHref(originalHref);
  drawn = null;
}

export function installFaviconBadge(store) {
  if (typeof document === 'undefined' || !store) return () => {};
  iconLink();

  const schedule = () => {
    if (frame) return;
    frame = 1;
    Promise.resolve().then(() => { frame = 0; draw(store); });
  };

  const offs = [
    store.on('unread', schedule),
    store.on('mention', schedule),
    store.on('guilds', schedule),
    store.on('conversations', schedule),
    store.on('channels', schedule),
    store.on('prefs', schedule),
    store.on('ready', schedule),
    store.on('signout', () => { restoreFavicon(); }),
  ];

  schedule();
  return () => { offs.forEach((off) => off?.()); restoreFavicon(); };
}
