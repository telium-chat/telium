import { isElectronRuntime } from './platform.js';
import {
  encodeRichActivity, normalizeRichActivities, richActivitiesOf,
} from './activity.js';
import { PRESETS, reencode } from './image.js';
import { uploadMedia } from './upload.js';

const PRESENCE_ART_TTL_SECS = 6 * 60 * 60;

export function richPresenceKinds(store) {
  const prefs = store?.prefs || {};
  const legacyGameDefault = prefs.richPresenceEnabled !== false;
  return {
    game: typeof prefs.richPresenceGameEnabled === 'boolean'
      ? prefs.richPresenceGameEnabled
      : legacyGameDefault,
    music: typeof prefs.richPresenceMusicEnabled === 'boolean'
      ? prefs.richPresenceMusicEnabled
      : false,
    video: typeof prefs.richPresenceVideoEnabled === 'boolean'
      ? prefs.richPresenceVideoEnabled
      : false,
  };
}

export function richPresenceActivityKind(activity) {
  if (activity?.type === 2) return 'music';
  if (activity?.type === 1 || activity?.type === 3) return 'video';
  return 'game';
}

export function richPresenceActivityAllowed(store, activity) {
  if (!activity) return false;
  return richPresenceKinds(store)[richPresenceActivityKind(activity)] !== false;
}

function activityList(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  return value ? [value] : [];
}

function visibleActivities(store, domain, enabled, activities) {
  if (!enabled || !store.sharesStatus(domain)) return [];
  const status = store.prefs.presence || 'online';
  if (status === 'invisible' || status === 'offline') return [];
  return activityList(activities).filter((activity) => richPresenceActivityAllowed(store, activity));
}

function richPresenceWanted(store) {
  return Object.values(richPresenceKinds(store)).some(Boolean);
}

function withoutLocalArtwork(activity) {
  const assets = activity?.assets;
  if (!assets?.local_large_image) return activity;
  const { local_large_image: _local, ...safeAssets } = assets;
  return { ...activity, assets: Object.keys(safeAssets).length ? safeAssets : null };
}

async function artworkFile(payload, encodeImage) {
  if (!payload?.bytes || typeof payload?.mime !== 'string') return null;
  let bytes;
  if (payload.bytes instanceof ArrayBuffer) {
    bytes = new Uint8Array(payload.bytes);
  } else if (ArrayBuffer.isView(payload.bytes)) {
    bytes = new Uint8Array(payload.bytes.buffer, payload.bytes.byteOffset, payload.bytes.byteLength);
  } else {
    return null;
  }
  if (!bytes.byteLength) return null;
  const file = new File([bytes], payload.name || 'album-art', { type: payload.mime });
  // Re-encode local file artwork every time rather than uploading verbatim: strips EXIF and polyglot payloads and downsizes.
  return encodeImage(file, {}, PRESETS.icon);
}

function withRehostedArtwork(activity, media) {
  if (!media?.url) return withoutLocalArtwork(activity);
  const largeMedia = media.origin && media.hash && media.capability ? {
    origin: media.origin,
    hash: media.hash,
    capability: media.capability,
  } : null;
  return {
    ...activity,
    assets: {
      ...(activity.assets || {}),
      // Kept as a rolling-upgrade fallback; new clients prefer `large_media`.
      large_image: media.url,
      large_media: largeMedia,
      local_large_image: undefined,
    },
  };
}

/// A media player republishes its whole state on every property change, so the same song is reported many times. Restoring an already-uploaded cover synchronously keeps the album art from blinking out between the report and the upload.
export function settledPresenceArtwork(activity, cache) {
  const handle = activity?.assets?.local_large_image;
  if (!handle) return null;
  const entry = cache?.get(handle);
  return entry?.settled ? withRehostedArtwork(activity, entry.media) : null;
}

export async function rehostLocalPresenceArtwork(
  store,
  activity,
  cache = new Map(),
  encodeImage = reencode,
) {
  const handle = activity?.assets?.local_large_image;
  if (!handle || !store.home || !window.teliumDesktop?.readRichPresenceArtwork) return activity;

  let entry = cache.get(handle);
  if (!entry) {
    entry = { settled: false, media: null, pending: null };
    entry.pending = (async () => {
      const payload = await window.teliumDesktop.readRichPresenceArtwork(handle);
      const file = await artworkFile(payload, encodeImage);
      if (!file) return null;
      return uploadMedia(store.home, file, 'profile', { ttlSecs: PRESENCE_ART_TTL_SECS });
    })();
    cache.set(handle, entry);
    // Registered before awaiting `pending`, so the next report of the same track skips the wait.
    entry.pending.then(
      (media) => { entry.settled = true; entry.media = media || null; },
      () => { cache.delete(handle); },
    );
  }

  return withRehostedArtwork(activity, await entry.pending);
}

/// The profile card reads the local presence map, so it needn't wait for the server's echo.
function syncOwnPresence(store, enabled, activities) {
  const mine = store.me?.user_id || store.session?.home?.user_id;
  if (!mine || !(store.presence instanceof Map)) return;

  const previous = store.presence.get(mine) || {};
  const status = store.prefs.presence || previous.status || 'online';
  const rich = enabled && status !== 'invisible' && status !== 'offline'
    ? normalizeRichActivities(
      activityList(activities).filter((activity) => richPresenceActivityAllowed(store, activity)),
    )
    : [];
  const primary = rich[0] || null;
  const prefStatus = store.prefs.status?.text;
  const local = {
    ...previous,
    user_id: mine,
    status,
    custom_status: prefStatus !== undefined ? (prefStatus || null) : (previous.custom_status ?? null),
    activity: encodeRichActivity(primary),
    rich_activity: primary,
    rich_activities: rich,
  };
  store.presence.set(mine, local);
  store.emit('presence', local);
}

/// Device-ephemeral: never put in SyncStore/localStorage and never survives sign-out or disabling the setting.
export function installDesktopRichPresence(store) {
  if (!isElectronRuntime() || !window.teliumDesktop?.setRichPresenceEnabled) return () => {};

  let activities = [];
  let activityRevision = 0;
  const artworkCache = new Map();
  // `wanted` is the local preference; `enabled` is whether this authenticated session may run the detector, so a default-on setting doesn't scan processes on the signed-out screen.
  let wanted = richPresenceWanted(store);
  let authenticated = false;
  let enabled = false;
  let nativeKinds = null;
  let disposed = false;
  let healQueued = false;
  store.desktopRichActivities = [];
  store.desktopRichActivity = null;

  const publish = () => {
    if (disposed) return;
    syncOwnPresence(store, enabled, activities);
    store.gw.setPresence((domain) => {
      const base = store.presenceFor(domain);
      // Strips Electron-only fields such as local artwork handles before anything leaves the device. `activity` stays the v1 single-activity carrier; new servers also keep `rich_activities`.
      const networkRich = normalizeRichActivities(
        visibleActivities(store, domain, enabled, activities),
      );
      const primary = networkRich[0] || null;
      return {
        ...base,
        activity: encodeRichActivity(primary),
        rich_activity: primary,
        rich_activities: networkRich,
      };
    });
  };

  const showActivity = (next) => {
    activities = enabled
      ? activityList(next).filter((activity) => richPresenceActivityAllowed(store, activity))
      : [];
    store.desktopRichActivities = activities;
    store.desktopRichActivity = activities[0] || null;
    publish();
    store.emit('rich-presence', activities);
  };

  const setActivity = (next) => {
    const mine = ++activityRevision;
    const reported = enabled
      ? activityList(next).filter((activity) => richPresenceActivityAllowed(store, activity))
      : [];
    const initial = reported.map(
      (activity) => settledPresenceArtwork(activity, artworkCache) || activity,
    );
    showActivity(initial);
    if (!initial.some((activity) => activity?.assets?.local_large_image)) return;

    // A revision guards the whole set: a slow upload from an old track can't resurrect it after a category changed.
    void Promise.all(initial.map((activity) => (
      activity?.assets?.local_large_image
        ? rehostLocalPresenceArtwork(store, activity, artworkCache)
        : activity
    )))
      .then((resolved) => {
        if (disposed || !enabled || mine !== activityRevision) return;
        showActivity(resolved);
      })
      .catch((error) => {
        if (mine !== activityRevision) return;
        console.warn('Could not publish local album artwork:', error);
        showActivity(initial.map(withoutLocalArtwork));
      });
  };

  const syncWorker = () => {
    const kinds = richPresenceKinds(store);
    const next = authenticated && wanted;
    const kindsChanged = !nativeKinds
      || nativeKinds.game !== kinds.game
      || nativeKinds.music !== kinds.music
      || nativeKinds.video !== kinds.video;
    const enabledChanged = next !== enabled;
    if (!enabledChanged && !kindsChanged) return;

    enabled = next;
    nativeKinds = kinds;
    if (!enabled && enabledChanged && activities.length) setActivity([]);
    window.teliumDesktop.setRichPresenceEnabled(enabled, kinds).catch((error) => {
      console.warn('Could not change desktop rich presence:', error);
    });
  };

  const syncPreference = () => {
    wanted = richPresenceWanted(store);
    if (activities.some((activity) => !richPresenceActivityAllowed(store, activity))) setActivity(activities);
    syncWorker();
    // Store.setPresence emits `prefs` before republishing its base presence; run a microtask later so our fields are the final answer.
    queueMicrotask(publish);
  };

  const markReady = () => {
    // Re-read rather than trusting the previous account's value. Game presence defaults on; media presence does not.
    wanted = richPresenceWanted(store);
    authenticated = Boolean(store.session);
    syncWorker();
    publish();
  };

  // A mixed-version server can treat another session's status update as a full replacement and erase this activity; resend when an online self-echo arrives without Rich Presence. Offline stays authoritative so this can't fight invisibility.
  const healOwnPresence = (incoming) => {
    const mine = store.me?.user_id || store.session?.home?.user_id;
    if (disposed || !enabled || !activities.length || !mine || incoming?.user_id !== mine) return;
    if (incoming.status === 'offline' || incoming.status === 'invisible') return;
    if (richActivitiesOf(incoming).length) return;
    if (healQueued) return;
    healQueued = true;
    queueMicrotask(() => {
      healQueued = false;
      if (disposed || !enabled || !activities.length) return;
      publish();
    });
  };

  const offActivity = window.teliumDesktop.onRichPresenceChanged?.((next) => {
    setActivity(next);
  }) || (() => {});
  const offPrefs = store.on('prefs', syncPreference);
  const offPresence = store.on('presence', healOwnPresence);
  const offReady = store.on('ready', markReady);
  // Gateway readiness is separate: each newly connected server needs the activity republished after its base presence handshake.
  const offGatewayReady = store.gw.on('ready', publish);
  const offSignout = store.on('signout', () => {
    authenticated = false;
    wanted = false;
    syncWorker();
  });

  // Always force the native side off during bootstrap; `ready` turns it back on after authentication.
  window.teliumDesktop.setRichPresenceEnabled(false, richPresenceKinds(store))
    .then(() => window.teliumDesktop.richPresenceActivity?.())
    .then((current) => {
      if (disposed || !enabled || !current) return;
      setActivity(current);
    })
    .catch((error) => console.warn('Could not initialize desktop rich presence:', error));

  return () => {
    disposed = true;
    activityRevision += 1;
    offActivity();
    offPrefs();
    offPresence();
    offReady();
    offGatewayReady();
    offSignout();
    artworkCache.clear();
    activities = [];
    store.desktopRichActivities = [];
    store.desktopRichActivity = null;
    window.teliumDesktop.setRichPresenceEnabled(false, richPresenceKinds(store)).catch(() => {});
  };
}
