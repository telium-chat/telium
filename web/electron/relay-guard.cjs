'use strict';

// Layer 3 of protected mode and the only wall: `onBeforeRequest` sees every request, including element-driven loads and the service worker. It cancels rather than rewrites.

const NETWORK_SCHEMES = new Set(['http:', 'https:', 'ws:', 'wss:']);

/// Lowercase, strip a trailing dot (`guild.example.` bypasses exact match) and IPv6 brackets.
function normalizeHost(value) {
  let host = String(value || '').toLowerCase().trim();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  while (host.endsWith('.')) host = host.slice(0, -1);
  return host;
}

function createRelayGuard() {
  /// Hostnames, not domains: a guild's hosts come from its discovery document, which only the renderer has read.
  let hosts = new Set();

  let relayEndpoint = null;

  /// Replace, not merge: merging would leave a guild switched back to direct blocked.
  function setProtectedHosts(next) {
    const updated = new Set();
    for (const entry of next || []) {
      const host = normalizeHost(entry);
      if (host) updated.add(host);
    }
    hosts = updated;
  }

  function setRelayEndpoint(url) {
    if (!url) { relayEndpoint = null; return; }
    try {
      const parsed = new URL(String(url));
      relayEndpoint = { host: normalizeHost(parsed.hostname), port: parsed.port, path: parsed.pathname };
    } catch {
      relayEndpoint = null;
    }
  }

  function allows(rawUrl) {
    let parsed;
    try {
      parsed = new URL(String(rawUrl || ''));
    } catch {
      // Unparsable: no host to match; cancelling would break the app and protect nobody.
      return { allow: true, reason: 'unparsable' };
    }

    if (!NETWORK_SCHEMES.has(parsed.protocol)) return { allow: true, reason: 'local-scheme' };

    // Relay endpoint exempted by exact host, port and path; kept narrow so it cannot become a hole to the account server.
    if (relayEndpoint
      && normalizeHost(parsed.hostname) === relayEndpoint.host
      && parsed.port === relayEndpoint.port
      && parsed.pathname === relayEndpoint.path) {
      return { allow: true, reason: 'relay' };
    }

    const host = normalizeHost(parsed.hostname);
    if (hosts.has(host)) return { allow: false, reason: 'protected' };

    // Subdomains are blocked too: the discovery host list may miss one, and a missing picture is visible where a leaked address is not.
    for (const protectedHost of hosts) {
      if (host.endsWith(`.${protectedHost}`)) return { allow: false, reason: 'protected-subdomain' };
    }

    return { allow: true, reason: 'unprotected' };
  }

  /// Attaches to the default session shared by renderer, service worker and Chromium's own fetches; requests with no `webContentsId` are blocked too.
  function install(ses) {
    ses.webRequest.onBeforeRequest((details, callback) => {
      callback(allows(details?.url).allow ? {} : { cancel: true });
    });
  }

  return {
    setProtectedHosts,
    setRelayEndpoint,
    allows,
    install,
    protectedHosts: () => [...hosts],
  };
}

module.exports = { createRelayGuard, normalizeHost, NETWORK_SCHEMES };
