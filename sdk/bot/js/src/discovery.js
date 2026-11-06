import { request } from './http.js';
import { getJson as safeGetJson, getText as safeGetText, parseTxtPointer } from './secure-discovery.js';

// Deliberately long so it is visible in `ps`, Dockerfiles and unit files.
export const INSECURE_HTTP_ENV = 'TELIUM_BOT_INSECURE_ALLOW_PLAINTEXT_HTTP';

function insecureHttpAllowed(explicit) {
  if (explicit !== undefined) return explicit === true;
  const value = globalThis.process?.env?.[INSECURE_HTTP_ENV];
  return value === '1' || value === 'true';
}

function parseUrl(value) {
  try { return new URL(value); } catch { return null; }
}

// Confined to the dialled host or a subdomain: the bot token must reach exactly one authority.
function withinDelegation(host, dialled) {
  const a = String(host || '').toLowerCase();
  const b = String(dialled || '').toLowerCase();
  if (!a || !b) return false;
  return a === b || a.endsWith(`.${b}`);
}

function requireEndpoint({ value, label, dialled, allowInsecure, schemes, insecureScheme }) {
  const url = parseUrl(value);
  if (!url) {
    throw new Error(`${dialled} published an unusable ${label} in its discovery document: ${value}`);
  }
  const secure = schemes[0];
  if (url.protocol !== secure) {
    if (url.protocol !== insecureScheme) {
      throw new Error(
        `${dialled} published a ${label} that is not ${secure}// (${url.protocol}//); refusing to send bot credentials over it`,
      );
    }
    if (!allowInsecure) {
      throw new Error(
        `${dialled} published a plaintext ${label} (${value}). Telium bot credentials are only sent over TLS; `
        + `set ${INSECURE_HTTP_ENV}=1 to allow this for local development only.`,
      );
    }
  }
  if (!withinDelegation(url.hostname, dialled)) {
    throw new Error(
      `${dialled} published a ${label} on ${url.hostname}, which is not ${dialled} or a delegation beneath it; `
      + 'refusing to follow a discovery document to another origin',
    );
  }
  return url;
}

// The session response is chosen by the same party as discovery: unchecked, it reopens the same hole.
export function requireGatewayUrl(value, dialled, { allowInsecureHttp } = {}) {
  return requireEndpoint({
    value,
    label: 'gateway',
    dialled,
    allowInsecure: insecureHttpAllowed(allowInsecureHttp),
    schemes: ['wss:'],
    insecureScheme: 'ws:',
  }).toString().replace(/\/$/, '');
}

// Callers that know their domain must pass `expectServerName`: `server_name` is self-reported.

async function tryTxtDiscovery(seed, dialled, expectServerName, getText, getJson) {
  // Never transmit bearer credentials to either discovery endpoint.
  const target = parseTxtPointer(await getText(seed + '/telium.txt'), dialled);
  const doc = await getJson(target + '/.well-known/telium/server');
  const expected = expectServerName || dialled;
  if (doc?.server_name?.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(target + ' does not claim the account domain ' + expected);
  }
  if (!doc.api || parseUrl(doc.api)?.origin !== target) {
    throw new Error(target + ' advertised a different API origin');
  }
  return doc;
}

export async function discover(server, {
  allowInsecureHttp, expectServerName, timeoutMs,
  // Optional transport injection for test harnesses; production always uses
  // DNS-pinned, TLS-verified, size-capped reads with redirect refusal.
  txtGetText = safeGetText, txtGetJson = safeGetJson, directGetJson = safeGetJson,
} = {}) {
  const allowInsecure = insecureHttpAllowed(allowInsecureHttp);
  const explicit = /^[a-z][a-z0-9+.-]*:\/\//i.test(server);

  let seeds;
  let dialled;
  if (explicit) {
    const url = parseUrl(server);
    if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:')) {
      throw new Error(`${server} is not an http(s) address`);
    }
    if (url.protocol === 'http:' && !allowInsecure) {
      throw new Error(
        `Refusing to discover ${server} over plaintext HTTP; the bot's long-lived token would follow it. `
        + `Set ${INSECURE_HTTP_ENV}=1 to allow this for local development only.`,
      );
    }
    seeds = [server.replace(/\/$/, '')];
    dialled = url.hostname;
  } else {
    // https only unless explicitly local: an http fallback lets a packet-dropper capture the bot token.
    seeds = allowInsecure
      ? [`https://${server}`, `http://${server}`]
      : [`https://${server}`];
    dialled = String(server).split('/')[0].split(':')[0];
  }

  let lastError;
  for (const seed of seeds) {
    let doc;
    let tryTxt = false;
    try {
      doc = seed.startsWith('https://')
        ? await directGetJson(seed + '/.well-known/telium/server')
        : await request(seed, 'GET', '/.well-known/telium/server', { timeoutMs });
      // Some websites respond with HTML or unrelated JSON at every path.
      if (!doc || typeof doc.server_name !== 'string') tryTxt = true;
    } catch (error) {
      lastError = error;
      // A network failure means the account domain itself is down. Do not
      // fan out more requests; only a real missing document permits fallback.
      tryTxt = error?.status === 404 || error instanceof SyntaxError;
    }
    if (tryTxt && seed.startsWith('https://')) {
      try {
        doc = await tryTxtDiscovery(seed, dialled, expectServerName, txtGetText, txtGetJson);
      } catch (error) {
        // Invalid pointers and identity mismatches fail closed. In particular,
        // never retry over HTTP after a rejected HTTPS delegation.
        throw error;
      }
    }
    if (!doc) continue;

    // `server_name` is self-reported; the assertion audience comes from the home's indexed domain, never from here.
    const expected = expectServerName ?? (explicit ? null : dialled);
    if (expected && doc?.server_name && String(doc.server_name).toLowerCase() !== String(expected).toLowerCase()) {
      throw new Error(
        `${expected} identified itself as "${doc.server_name}" in its discovery document; refusing to connect`,
      );
    }

    const apiUrl = requireEndpoint({
      value: doc?.api || seed,
      label: 'api base',
      dialled,
      allowInsecure,
      schemes: ['https:'],
      insecureScheme: 'http:',
    });
    const api = apiUrl.toString().replace(/\/$/, '');

    const gatewayUrl = requireEndpoint({
      value: doc?.gateway || `${api.replace(/^http/, 'ws')}/gateway/v1`,
      label: 'gateway',
      dialled,
      allowInsecure,
      schemes: ['wss:'],
      insecureScheme: 'ws:',
    });

    return {
      serverName: doc?.server_name,
      // The dialled name is the only basis for audience or authorisation decisions.
      domain: expected || dialled,
      api,
      gateway: gatewayUrl.toString().replace(/\/$/, ''),
    };
  }
  throw lastError || new Error(`Could not discover ${server}`);
}
