const MAX_APPLICATION_ID = 64;
const MAX_APPLICATION_NAME = 128;
const MAX_ASSET_KEY = 256;
const MAX_ARTWORK_URL = 512;
const DEFAULT_TIMEOUT_MS = 2500;

function cleanText(value, max = MAX_APPLICATION_NAME) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? [...trimmed].slice(0, max).join('') : null;
}

export function cleanApplicationId(value) {
  const id = cleanText(value == null ? '' : String(value), MAX_APPLICATION_ID);
  return id && /^\d+$/.test(id) ? id : null;
}

export function cleanApplicationName(value) {
  return cleanText(value, MAX_APPLICATION_NAME);
}

function cleanIconHash(value) {
  const hash = cleanText(value, 128);
  return hash && /^[a-z0-9_]+$/i.test(hash) ? hash : null;
}

function cleanAssetKey(value) {
  return cleanText(value, MAX_ASSET_KEY);
}

function defaultEndpoints(id) {
  // Current Discord clients take the top line from RPC app metadata; OAuth2 is the fallback.
  return [
    `https://discord.com/api/v10/applications/${id}/rpc`,
    `https://discord.com/api/v10/oauth2/applications/${id}/rpc`,
  ];
}

function defaultAssetsEndpoint(id) {
  return `https://discord.com/api/v10/oauth2/applications/${id}/assets`;
}

async function fetchJsonWithTimeout(fetchImpl, url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response?.ok) return null;
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function mergeMetadata(current, raw) {
  const candidate = typeof raw === 'string' ? { name: raw } : raw;
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return current || null;
  const name = cleanApplicationName(candidate.name);
  const icon = cleanIconHash(candidate.icon ?? candidate.icon_hash);
  if (!name && !icon) return current || null;
  return {
    name: name || current?.name || null,
    icon: icon || current?.icon || null,
  };
}

function externalArtworkUrl(raw) {
  const value = cleanText(raw, MAX_ARTWORK_URL);
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

function mediaProxyArtworkUrl(raw) {
  const value = cleanText(raw, MAX_ARTWORK_URL);
  if (!value?.startsWith('mp:')) return null;
  const path = value.slice(3);
  if (!path || path.startsWith('/') || path.includes('\\') || path.includes('..')) return null;
  return externalArtworkUrl(`https://media.discordapp.net/${path}`);
}

function appIconUrl(id, hash) {
  const cleanId = cleanApplicationId(id);
  const cleanHash = cleanIconHash(hash);
  if (!cleanId || !cleanHash) return null;
  return `https://cdn.discordapp.com/app-icons/${cleanId}/${cleanHash}.png?size=128`;
}

function appAssetUrl(id, assetId) {
  const cleanId = cleanApplicationId(id);
  const cleanAssetId = cleanApplicationId(assetId);
  if (!cleanId || !cleanAssetId) return null;
  return `https://cdn.discordapp.com/app-assets/${cleanId}/${cleanAssetId}.png?size=256`;
}

export function createApplicationNameResolver({
  localLookup,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  endpoints = defaultEndpoints,
  assetsEndpoint = defaultAssetsEndpoint,
} = {}) {
  const metadata = new Map();
  const localChecked = new Set();
  const localPending = new Map();
  const remoteChecked = new Set();
  const remotePending = new Map();
  const assetLists = new Map();
  const assetPending = new Map();

  const rememberMetadata = (id, raw) => {
    const merged = mergeMetadata(metadata.get(id), raw);
    if (merged) metadata.set(id, merged);
    return merged;
  };

  const remember = (rawId, rawName, rawIcon = null) => {
    const id = cleanApplicationId(rawId);
    if (!id) return null;
    const merged = rememberMetadata(id, { name: rawName, icon: rawIcon });
    return merged?.name || null;
  };

  const peek = (rawId) => {
    const id = cleanApplicationId(rawId);
    return id ? metadata.get(id)?.name || null : null;
  };

  const peekMetadata = (rawId) => {
    const id = cleanApplicationId(rawId);
    const known = id ? metadata.get(id) : null;
    return known ? { ...known } : null;
  };

  const ensureLocal = async (id) => {
    if (localChecked.has(id)) return metadata.get(id) || null;
    if (localPending.has(id)) return localPending.get(id);
    const work = (async () => {
      try {
        rememberMetadata(id, await localLookup?.(id));
      } catch {
        // Bundled detectable database is optional.
      } finally {
        localChecked.add(id);
      }
      return metadata.get(id) || null;
    })();
    localPending.set(id, work);
    try {
      return await work;
    } finally {
      if (localPending.get(id) === work) localPending.delete(id);
    }
  };

  const ensureRemote = async (id) => {
    if (remoteChecked.has(id)) return metadata.get(id) || null;
    if (remotePending.has(id)) return remotePending.get(id);
    const work = (async () => {
      if (typeof fetchImpl === 'function') {
        for (const url of endpoints(id)) {
          const data = await fetchJsonWithTimeout(fetchImpl, url, timeoutMs);
          if (!data || typeof data !== 'object' || Array.isArray(data)) continue;
          const merged = rememberMetadata(id, data);
          if (merged?.name || merged?.icon) break;
        }
      }
      remoteChecked.add(id);
      return metadata.get(id) || null;
    })();
    remotePending.set(id, work);
    try {
      return await work;
    } finally {
      if (remotePending.get(id) === work) remotePending.delete(id);
    }
  };

  const resolve = async (rawId) => {
    const id = cleanApplicationId(rawId);
    if (!id) return null;

    const known = metadata.get(id)?.name;
    if (known) return known;
    const local = await ensureLocal(id);
    if (local?.name) return local.name;
    const remote = await ensureRemote(id);
    return remote?.name || null;
  };

  const loadAssets = async (id) => {
    if (assetLists.has(id)) return assetLists.get(id);
    if (assetPending.has(id)) return assetPending.get(id);
    const work = (async () => {
      const byName = new Map();
      if (typeof fetchImpl === 'function') {
        const data = await fetchJsonWithTimeout(fetchImpl, assetsEndpoint(id), timeoutMs);
        if (Array.isArray(data)) {
          for (const raw of data) {
            const assetId = cleanApplicationId(raw?.id);
            const name = cleanAssetKey(raw?.name)?.toLowerCase();
            if (assetId && name) byName.set(name, assetId);
          }
        }
      }
      assetLists.set(id, byName);
      return byName;
    })();
    assetPending.set(id, work);
    try {
      return await work;
    } finally {
      if (assetPending.get(id) === work) assetPending.delete(id);
    }
  };

  const resolveAsset = async (id, raw) => {
    // External image URLs stay data; the renderer proxies non-Discord hosts.
    const direct = externalArtworkUrl(raw) || mediaProxyArtworkUrl(raw);
    if (direct) return direct;
    const key = cleanAssetKey(raw);
    if (!key || /^https?:/i.test(key)) return null;
    if (/^\d+$/.test(key)) return appAssetUrl(id, key);
    const assets = await loadAssets(id);
    const assetId = assets.get(key.toLowerCase());
    return assetId ? appAssetUrl(id, assetId) : null;
  };

  const resolveArtwork = async (rawId, rawAssets) => {
    const id = cleanApplicationId(rawId);
    if (!id) return null;
    await ensureLocal(id);

    const assets = rawAssets && typeof rawAssets === 'object' && !Array.isArray(rawAssets)
      ? rawAssets
      : {};
    const [customLarge, customSmall] = await Promise.all([
      resolveAsset(id, assets.large_image),
      resolveAsset(id, assets.small_image),
    ]);

    let known = metadata.get(id) || null;
    // External large image keeps the app identity as the small badge.
    const needsApplicationBadge = Boolean(
      customLarge && !customSmall && externalArtworkUrl(assets.large_image),
    );
    if ((!customLarge || needsApplicationBadge) && !known?.icon) {
      known = await ensureRemote(id);
    }

    const applicationIcon = appIconUrl(id, known?.icon);
    const largeImage = customLarge || applicationIcon;
    const smallImage = customSmall || (needsApplicationBadge ? applicationIcon : null);
    if (!largeImage && !smallImage) return null;

    return {
      large_image: largeImage || null,
      large_text: largeImage
        ? (customLarge ? cleanText(assets.large_text) : known?.name || null)
        : null,
      small_image: smallImage || null,
      small_text: smallImage
        ? (customSmall ? cleanText(assets.small_text) : known?.name || null)
        : null,
    };
  };

  return Object.freeze({ remember, peek, peekMetadata, resolve, resolveArtwork });
}
