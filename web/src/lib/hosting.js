
import { bytes } from './util.js';

const MAX_PROVIDERS = 200;
const MAX_PLANS = 12;
const MAX_REGIONS = 40;
const MAX_SHORT = 64;
const MAX_TEXT = 600;

/// Control characters and bidirectional overrides. Written as escapes since they are invisible.
// eslint-disable-next-line no-control-regex
const UNPRINTABLE = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

export function text(value, max = MAX_TEXT) {
  if (typeof value !== 'string') return '';
  const clean = value.replace(UNPRINTABLE, '').trim();
  return clean.length > max ? `${clean.slice(0, max)}...` : clean;
}

export function link(value) {
  if (typeof value !== 'string' || value.length > 512) return null;
  let url;
  try { url = new URL(value.trim()); } catch { return null; }
  if (url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  return url.toString();
}

/// `price_minor` is in the currency's minor unit (cents).
function plan(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = text(raw.id, MAX_SHORT);
  const name = text(raw.name, MAX_SHORT);
  if (!id || !name) return null;
  const period = ['free', 'monthly', 'yearly', 'metered'].includes(raw.period) ? raw.period : 'free';
  return {
    id,
    name,
    price_minor: number(raw.price_minor),
    currency: /^[A-Z]{3}$/.test(raw.currency) ? raw.currency : '',
    period,
    member_cap: number(raw.member_cap),
    storage_bytes: number(raw.storage_bytes),
    media_quota_bytes: number(raw.media_quota_bytes),
    notes: text(raw.notes),
  };
}

/// Null for "not said", distinct from zero.
function number(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.floor(value);
}

export function provider(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = text(raw.name, MAX_SHORT);
  const signup = link(raw.signup_url);
  if (!name || !signup) return null;
  return {
    id: text(raw.id, MAX_SHORT) || name,
    name,
    description: text(raw.description),
    base_url: link(raw.base_url),
    signup_url: signup,
    terms_url: link(raw.terms_url),
    privacy_url: link(raw.privacy_url),
    contact: text(raw.contact, MAX_SHORT),
    regions: Array.isArray(raw.regions)
      ? raw.regions.slice(0, MAX_REGIONS).map((r) => text(r, MAX_SHORT)).filter(Boolean)
      : [],
    plans: Array.isArray(raw.plans)
      ? raw.plans.slice(0, MAX_PLANS).map(plan).filter(Boolean)
      : [],
    source: {
      kind: raw.source?.kind === 'catalog' ? 'catalog' : 'operator',
      label: text(raw.source?.label, MAX_SHORT),
      publisher: text(raw.source?.publisher, MAX_SHORT),
    },
  };
}

export function marketplace(payload) {
  const raw = payload && typeof payload === 'object' ? payload : {};
  const providers = Array.isArray(raw.providers)
    ? raw.providers.slice(0, MAX_PROVIDERS).map(provider).filter(Boolean)
    : [];
  return {
    enabled: raw.enabled === true,
    self_hosted: {
      server_name: text(raw.self_hosted?.server_name, MAX_SHORT),
      available: raw.self_hosted?.available !== false,
    },
    providers,
    guided_handoff: raw.portability?.guided_handoff === true,
  };
}

export function price(p) {
  if (!p) return '';
  if (p.period === 'metered') return p.price_minor ? `${amount(p)} metered` : 'Metered';
  if (p.period === 'free' || !p.price_minor) return 'Free';
  return `${amount(p)} / ${p.period === 'yearly' ? 'year' : 'month'}`;
}

function amount(p) {
  const value = (p.price_minor / 100).toFixed(2);
  return p.currency ? `${value} ${p.currency}` : value;
}

export function limits(p) {
  if (!p) return [];
  const out = [];
  if (p.member_cap) out.push(`${p.member_cap.toLocaleString()} members`);
  if (p.storage_bytes) out.push(`${bytes(p.storage_bytes)} storage`);
  if (p.media_quota_bytes) out.push(`${bytes(p.media_quota_bytes)} media a month`);
  return out;
}

export function entryPlan(p) {
  if (!p?.plans?.length) return null;
  return p.plans.reduce((best, next) => (
    (next.price_minor ?? Infinity) < (best.price_minor ?? Infinity) ? next : best
  ));
}
