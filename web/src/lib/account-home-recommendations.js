import { ed25519 } from '@noble/curves/ed25519.js';
import { unb64 } from './util.js';

export const RECOMMENDATION_KIND = 'telium.account_home_recommendations';
export const RECOMMENDATION_VERSION = 1;
export const DEFAULT_RECOMMENDATION_URL = import.meta.env.VITE_TELIUM_RECOMMENDATION_URL
  || 'https://telium.chat/.well-known/telium/account-home-recommendations.json';
export const DEFAULT_RECOMMENDATION_PUBLIC_KEY = import.meta.env.VITE_TELIUM_RECOMMENDATION_PUBLIC_KEY || '';
export const RECOMMENDATION_CACHE_PREFIX = 'telium.account-home-recommendations.v1:';

/// The constant is frozen at module load; this asks the question at call time.
export const pinnedRecommendationKey = () => (
  import.meta.env.VITE_TELIUM_RECOMMENDATION_PUBLIC_KEY || DEFAULT_RECOMMENDATION_PUBLIC_KEY
);
export const hasPinnedRecommendationKey = () => Boolean(pinnedRecommendationKey());
export const MAX_SELECTION_SHARE = 0.5;

const textEncoder = new TextEncoder();

const sortForCanonicalJson = (value) => {
  if (Array.isArray(value)) return value.map(sortForCanonicalJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortForCanonicalJson(value[key])]),
  );
};

export const canonicalRecommendationJson = (value) => JSON.stringify(sortForCanonicalJson(value));

const unsignedBody = (document) => {
  const copy = structuredClone(document);
  delete copy.key_id;
  delete copy.signature;
  return copy;
};

const validHttpsOrigin = (value) => {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.origin === value.replace(/\/$/, '');
  } catch {
    return false;
  }
};

export const verifyRecommendationDocument = (document, publicKey) => {
  if (!document || typeof document !== 'object') return false;
  if (document.kind !== RECOMMENDATION_KIND || document.version !== RECOMMENDATION_VERSION) return false;
  if (typeof document.signature !== 'string' || typeof publicKey !== 'string' || !publicKey) return false;
  try {
    const signature = unb64(document.signature);
    const key = unb64(publicKey);
    if (signature.length !== 64 || key.length !== 32) return false;
    return ed25519.verify(
      signature,
      textEncoder.encode(canonicalRecommendationJson(unsignedBody(document))),
      key,
    );
  } catch {
    return false;
  }
};

export const usableRecommendations = (document, nowMs = Date.now()) => {
  if (!document || typeof document !== 'object') return [];
  const generatedAt = Date.parse(document.generated_at || '');
  const expiresAt = Date.parse(document.expires_at || '');
  if (!Number.isFinite(generatedAt) || !Number.isFinite(expiresAt)) return [];
  if (generatedAt > nowMs + 5 * 60 * 1000 || expiresAt <= nowMs || expiresAt <= generatedAt) return [];
  if (!Array.isArray(document.servers)) return [];

  return document.servers.filter((server) => (
    server
    && typeof server.domain === 'string'
    && server.domain.length > 0
    && validHttpsOrigin(server.api_origin)
    && typeof server.name === 'string'
    && server.name.length > 0
    && Number.isInteger(server.weight)
    && server.weight > 0
  ));
};

const cappedProbabilities = (rawWeights, maxShare = MAX_SELECTION_SHARE) => {
  if (rawWeights.length === 0) return [];
  if (rawWeights.length === 1) return [1];

  const raw = rawWeights.map((weight) => Math.max(0, Number(weight) || 0));
  const total = raw.reduce((sum, weight) => sum + weight, 0);
  if (total <= 0) return raw.map(() => 1 / raw.length);

  let probabilities = raw.map((weight) => weight / total);
  const fixed = new Set();

  while (true) {
    const over = probabilities
      .map((probability, index) => ({ probability, index }))
      .filter(({ probability, index }) => !fixed.has(index) && probability > maxShare);
    if (!over.length) break;

    for (const { index } of over) {
      probabilities[index] = maxShare;
      fixed.add(index);
    }

    const remainingMass = 1 - [...fixed].reduce((sum, index) => sum + probabilities[index], 0);
    const remainingRaw = raw.reduce(
      (sum, weight, index) => sum + (fixed.has(index) ? 0 : weight),
      0,
    );
    if (remainingRaw <= 0) break;
    probabilities = probabilities.map((probability, index) => (
      fixed.has(index) ? probability : remainingMass * (raw[index] / remainingRaw)
    ));
  }

  return probabilities;
};

const operatorKey = (server) => {
  const contact = typeof server?.operator_contact === 'string'
    ? server.operator_contact.trim().toLowerCase()
    : '';
  return contact ? `operator:${contact}` : `domain:${server?.domain || ''}`;
};

const selectionProbabilities = (servers) => {
  const raw = servers.map((server) => Math.max(1, server.weight));
  const groups = new Map();

  servers.forEach((server, index) => {
    const key = operatorKey(server);
    if (!groups.has(key)) groups.set(key, { indexes: [], weight: 0 });
    const group = groups.get(key);
    group.indexes.push(index);
    group.weight += raw[index];
  });

  const groupList = [...groups.values()];
  const groupProbabilities = cappedProbabilities(groupList.map((group) => group.weight));
  const probabilities = servers.map(() => 0);

  groupList.forEach((group, groupIndex) => {
    const withinTotal = group.indexes.reduce((sum, index) => sum + raw[index], 0);
    for (const index of group.indexes) {
      probabilities[index] = groupProbabilities[groupIndex] * (raw[index] / withinTotal);
    }
  });

  return probabilities;
};

export const chooseAccountHome = (servers, random = Math.random) => {
  if (!Array.isArray(servers) || servers.length === 0) return null;
  const probabilities = selectionProbabilities(servers);
  const draw = Math.min(Math.max(Number(random()), 0), 1 - Number.EPSILON);
  let cursor = 0;
  for (let i = 0; i < servers.length; i += 1) {
    cursor += probabilities[i];
    if (draw < cursor) return servers[i];
  }
  return servers.at(-1) ?? null;
};

export const secureRandom = () => {
  const word = new Uint32Array(1);
  crypto.getRandomValues(word);
  return word[0] / 0x100000000;
};

const cacheKey = (url) => `${RECOMMENDATION_CACHE_PREFIX}${url}`;

const readCachedDocument = (storageImpl, url) => {
  if (!storageImpl) return null;
  try {
    const raw = storageImpl.getItem(cacheKey(url));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
};

const writeCachedDocument = (storageImpl, url, document) => {
  if (!storageImpl) return;
  try {
    storageImpl.setItem(cacheKey(url), JSON.stringify(document));
  } catch {
  }
};

const removeCachedDocument = (storageImpl, url) => {
  if (!storageImpl) return;
  try { storageImpl.removeItem(cacheKey(url)); } catch { /* best-effort cleanup */ }
};

const useVerifiedDocument = (document, publicKey, nowMs) => {
  if (!verifyRecommendationDocument(document, publicKey)) {
    return { servers: [], document, reason: 'invalid_signature' };
  }
  const servers = usableRecommendations(document, nowMs);
  if (!servers.length) return { servers: [], document, reason: 'no_usable_servers' };
  return { servers, document, reason: null };
};

export const loadAccountHomeRecommendations = async ({
  url = DEFAULT_RECOMMENDATION_URL,
  // Read at call time, like `hasPinnedRecommendationKey`.
  publicKey = pinnedRecommendationKey(),
  fetchImpl = fetch,
  storageImpl = typeof localStorage !== 'undefined' ? localStorage : null,
  nowMs = Date.now(),
} = {}) => {
  if (!publicKey) return { servers: [], document: null, reason: 'no_pinned_key', source: null };

  let networkReason = 'unavailable';
  try {
    const response = await fetchImpl(url, {
      cache: 'no-store',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      headers: { accept: 'application/json' },
    });
    if (response.ok) {
      const document = await response.json();
      const result = useVerifiedDocument(document, publicKey, nowMs);
      if (result.reason === null) {
        writeCachedDocument(storageImpl, url, document);
        return { ...result, source: 'network' };
      }
      // A validly signed empty or expired feed is authoritative; don't revive an older candidate set.
      if (verifyRecommendationDocument(document, publicKey)) {
        if (result.reason === 'no_usable_servers') removeCachedDocument(storageImpl, url);
        return { ...result, source: 'network' };
      }
      networkReason = result.reason;
    } else {
      networkReason = `http_${response.status}`;
    }
  } catch {
    networkReason = 'unavailable';
  }

  // Cached bytes are re-verified and re-checked for expiry every time.
  const cached = readCachedDocument(storageImpl, url);
  if (cached) {
    const result = useVerifiedDocument(cached, publicKey, nowMs);
    if (result.reason === null) {
      return { ...result, reason: null, source: 'cache', networkReason };
    }
    removeCachedDocument(storageImpl, url);
  }

  return { servers: [], document: null, reason: networkReason, source: null };
};
