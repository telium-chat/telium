// Single outbound chokepoint.

import { isNativeShellRuntime } from '../platform.js';
import { decide, REFUSAL } from './policy.js';
import {
  openTunnelFetch, openTunnelSocket, relayCapability, relayUnderstood, tunnelSupported,
} from './tunnel.js';

let source = null;

const origins = new Map();

const allowedOnce = new Set();

const contacted = new Map();

/// True during a sanctioned raw call so the L2 guard can tell it from a bypass.
let sanctioned = false;

function viaChokepoint(fn) {
  sanctioned = true;
  try {
    return fn();
  } finally {
    sanctioned = false;
  }
}

export function configureTransport({ getPrefs, getGuilds, getHomeDomain, onRefusal = null }) {
  source = { getPrefs, getGuilds, getHomeDomain, onRefusal };
  publishProtectedHosts();
}

/// The whole set is sent every time; merging would leave a guild switched to direct blocked until restart.
export function publishProtectedHosts() {
  const push = globalThis.teliumDesktop?.relay?.setProtectedHosts;
  if (typeof push !== 'function') return;
  const hosts = new Set();
  for (const [origin, domain] of origins) {
    if (effectiveMode(domain).route !== 'protected') continue;
    try {
      hosts.add(new URL(origin).hostname);
    } catch {}
  }
  Promise.resolve(push([...hosts])).catch((e) => {
    console.error('[network privacy] could not arm the desktop network guard', e);
  });
}

export function registerOrigin(domain, urls) {
  for (const raw of urls || []) {
    if (!raw) continue;
    try {
      origins.set(new URL(raw).origin, domain);
    } catch {}
  }
  publishProtectedHosts();
}

export function forgetOrigin(domain) {
  for (const [origin, owner] of origins) if (owner === domain) origins.delete(origin);
  publishProtectedHosts();
}

export function domainOf(url) {
  try {
    return origins.get(new URL(url, globalThis.location?.href || 'https://invalid.invalid').origin) || null;
  } catch {
    return null;
  }
}

export function protectionSupported() {
  return isNativeShellRuntime() && tunnelSupported();
}

export function effectiveMode(domain) {
  if (!source) return { route: 'direct', refusal: null, reason: 'unconfigured' };
  return decide({
    prefs: source.getPrefs(),
    guilds: source.getGuilds(),
    domain,
    homeDomain: source.getHomeDomain(),
    relay: relayCapability(),
    understood: relayUnderstood(),
    supported: protectionSupported(),
    allowDirectOnce: allowedOnce.has(domain),
  });
}

export function permitDirectOnce(domain) {
  allowedOnce.add(domain);
}

export function clearDirectPermission(domain) {
  if (domain) allowedOnce.delete(domain);
  else allowedOnce.clear();
}

export function directContacts() {
  return [...contacted.entries()]
    .map(([origin, entry]) => ({ origin, ...entry }))
    .sort((a, b) => b.at - a.at);
}

function noteContact(url, purpose) {
  let origin;
  try {
    origin = new URL(url, globalThis.location?.href || 'https://invalid.invalid').origin;
  } catch {
    return;
  }
  const entry = contacted.get(origin) || { purpose, count: 0, at: 0 };
  entry.count += 1;
  entry.at = Date.now();
  entry.purpose = purpose || entry.purpose;
  contacted.set(origin, entry);
}

export class ProtectionRefused extends Error {
  constructor(domain, refusal) {
    super(`refusing to connect to ${domain} directly: protection was requested`);
    this.name = 'ProtectionRefused';
    this.domain = domain;
    this.refusal = refusal;
    this.protection = true;
  }
}

function route(url, purpose) {
  const domain = domainOf(url);
  if (!domain) {
    noteContact(url, purpose);
    return { domain: null, decision: { route: 'direct', refusal: null, reason: 'third-party' } };
  }
  return { domain, decision: effectiveMode(domain) };
}

function refuse(domain, decision) {
  const error = new ProtectionRefused(domain, decision.refusal || REFUSAL.failed);
  source?.onRefusal?.(domain, error.refusal);
  throw error;
}

export async function teliumFetch(url, init = {}, { purpose = 'request' } = {}) {
  const { domain, decision } = route(url, purpose);
  if (decision.route === 'refuse') refuse(domain, decision);
  if (decision.route === 'protected') {
    try {
      return await openTunnelFetch(domain, url, init);
    } catch (err) {
      const retry = effectiveMode(domain);
      if (retry.route === 'direct') return viaChokepoint(() => fetch(url, init));
      const failure = { ...retry, refusal: REFUSAL.failed, route: 'refuse' };
      err.protection = true;
      refuse(domain, failure);
    }
  }
  return viaChokepoint(() => fetch(url, init));
}

export function teliumSocket(url, protocols, { purpose = 'gateway' } = {}) {
  const { domain, decision } = route(url, purpose);
  if (decision.route === 'refuse') refuse(domain, decision);
  if (decision.route === 'protected') return openTunnelSocket(domain, url, protocols);
  return viaChokepoint(() => new WebSocket(url, protocols));
}

export async function teliumMediaSrc(url, { purpose = 'media' } = {}) {
  if (!url) return { src: null, release: () => {} };
  const { domain, decision } = route(url, purpose);
  if (decision.route === 'direct') return { src: url, release: () => {} };
  if (decision.route === 'refuse') return { src: null, release: () => {} };
  try {
    const resp = await openTunnelFetch(domain, url, { method: 'GET' });
    if (!resp.ok) return { src: null, release: () => {} };
    const blob = await resp.blob();
    const src = URL.createObjectURL(blob);
    return { src, release: () => URL.revokeObjectURL(src) };
  } catch {
    return { src: null, release: () => {} };
  }
}

/// Throws even in shipped builds; logging after letting the request through is too late.
let onBypass = null;

export function onTransportBypass(fn) {
  onBypass = fn;
}

function bypass(kind, url) {
  const detail = `${kind} to ${url} bypassed the Telium transport while protection was on`;
  onBypass?.({ kind, url, detail });
  const err = new Error(
    `${detail}. Every outbound request must go through web/src/lib/net/transport.js; `
    + 'see docs/network-privacy.md.',
  );
  err.name = 'TransportBypass';
  return err;
}

function guarded(url) {
  const domain = domainOf(url);
  if (!domain) return false;
  return effectiveMode(domain).route === 'protected';
}

/// Must install before anything else: LiveKit captures globalThis.WebSocket early.
export function installTransportGuard(scope = globalThis) {
  const realFetch = scope.fetch;
  const RealWebSocket = scope.WebSocket;
  const realOpen = scope.XMLHttpRequest?.prototype?.open;
  const realBeacon = scope.navigator?.sendBeacon;

  if (typeof realFetch === 'function') {
    scope.fetch = function guardedFetch(input, init) {
      const url = typeof input === 'string' ? input : input?.url;
      if (!sanctioned && url && guarded(url)) throw bypass('fetch', url);
      return realFetch.call(this, input, init);
    };
  }

  if (typeof RealWebSocket === 'function') {
    // Subclass keeps static readyState constants and instanceof.
    class GuardedWebSocket extends RealWebSocket {
      constructor(url, protocols) {
        if (!sanctioned && url && guarded(url)) throw bypass('WebSocket', String(url));
        super(url, protocols);
      }
    }
    scope.WebSocket = GuardedWebSocket;
  }

  if (typeof realOpen === 'function') {
    scope.XMLHttpRequest.prototype.open = function guardedOpen(method, url, ...rest) {
      if (!sanctioned && url && guarded(url)) throw bypass('XMLHttpRequest', String(url));
      return realOpen.call(this, method, url, ...rest);
    };
  }

  if (typeof realBeacon === 'function') {
    scope.navigator.sendBeacon = function guardedBeacon(url, data) {
      if (!sanctioned && url && guarded(url)) {
        onBypass?.({ kind: 'sendBeacon', url: String(url) });
        return false;
      }
      return realBeacon.call(this, url, data);
    };
  }

  return function uninstall() {
    if (typeof realFetch === 'function') scope.fetch = realFetch;
    if (typeof RealWebSocket === 'function') scope.WebSocket = RealWebSocket;
    if (typeof realOpen === 'function') scope.XMLHttpRequest.prototype.open = realOpen;
    if (typeof realBeacon === 'function') scope.navigator.sendBeacon = realBeacon;
  };
}
