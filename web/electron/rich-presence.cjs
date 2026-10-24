'use strict';

const path = require('node:path');
const { app, utilityProcess } = require('electron');
const { createLocalArtworkRegistry } = require('./rich-presence-local-art.cjs');

const MAX_TEXT = 128;
const MAX_APP_ID = 64;
const MAX_URL = 1024;
const MAX_ARTWORK_URL = 512;
const MAX_PARTY = 1_000_000;

function text(value, max = MAX_TEXT) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? [...trimmed].slice(0, max).join('') : null;
}

function integer(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

function safeUrl(raw) {
  const value = text(raw, MAX_URL);
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

function safeArtworkUrl(raw) {
  const value = text(raw, MAX_ARTWORK_URL);
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

function sanitizeArtwork(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const largeImage = safeArtworkUrl(raw.large_image);
  const smallImage = safeArtworkUrl(raw.small_image);
  if (!largeImage && !smallImage) return null;
  return {
    large_image: largeImage,
    large_text: largeImage ? text(raw.large_text) : null,
    small_image: smallImage,
    small_text: smallImage ? text(raw.small_text) : null,
  };
}

function sanitizeRichActivity(message) {
  const activity = message?.activity;
  if (!activity || typeof activity !== 'object' || Array.isArray(activity)) return null;

  const applicationId = text(activity.application_id, MAX_APP_ID);
  const name = text(activity.name);
  const details = text(activity.details);
  const state = text(activity.state);
  const typeValue = Number(activity.type);
  const type = Number.isInteger(typeValue) && typeValue >= 0 && typeValue <= 5 ? typeValue : 0;

  const timestamps = {};
  const start = integer(activity.timestamps?.start);
  const end = integer(activity.timestamps?.end);
  if (start) timestamps.start = start;
  if (end) timestamps.end = end;

  let party = null;
  const size = activity.party?.size;
  if (Array.isArray(size) && size.length >= 2) {
    const current = integer(size[0]);
    const maximum = integer(size[1]);
    if (current !== null && maximum !== null && current <= maximum
      && maximum <= MAX_PARTY) {
      party = { size: [current, maximum] };
    }
  }

  // Rejoin button labels and URLs, keep only credential-free web links; secrets, join data and pid/socket ids never cross this seam.
  const labels = Array.isArray(activity.buttons) ? activity.buttons.slice(0, 2) : [];
  const urls = Array.isArray(activity.metadata?.button_urls)
    ? activity.metadata.button_urls.slice(0, 2)
    : [];
  const buttons = [];
  for (let i = 0; i < Math.min(labels.length, urls.length, 2); i += 1) {
    const label = text(labels[i], 32);
    const url = safeUrl(urls[i]);
    if (label && url) buttons.push({ label, url });
  }

  // SET_ACTIVITY omits the application name; use a generic label.
  const displayName = name || (applicationId ? 'Desktop activity' : null);
  if (!displayName && !details && !state) return null;

  return {
    application_id: applicationId,
    name: displayName || 'Desktop activity',
    type,
    details,
    state,
    timestamps: Object.keys(timestamps).length ? timestamps : null,
    party,
    buttons,
    assets: sanitizeArtwork(activity.assets),
  };
}

function workerPath() {
  if (!app.isPackaged) return path.join(__dirname, 'rich-presence-worker.mjs');
  return path.join(process.resourcesPath, 'app.asar.unpacked', 'rich-presence-worker.mjs');
}

function activityKey(data) {
  const socketId = data?.socketId;
  if (typeof socketId === 'string' || typeof socketId === 'number') {
    return `socket:${String(socketId).slice(0, 128)}`;
  }
  const pid = integer(data?.pid);
  return pid === null ? 'default' : `pid:${pid}`;
}

function explicitRpcActivity(data) {
  const socketId = data?.socketId;
  if (socketId === undefined || socketId === null) return false;
  const applicationId = data?.activity?.application_id;
  // arRPC's process detector reuses the application id as the socket id; keep it private.
  return applicationId === undefined || String(socketId) !== String(applicationId);
}

function activityPriority(data) {
  // Priority: explicit Discord RPC, then native OS media, then generic process-name detection.
  if (data?.source === 'mpris' || data?.source === 'windows-media') return 2;
  return explicitRpcActivity(data) ? 3 : 1;
}

function activityKind(activity) {
  if (activity?.type === 2) return 'music';
  if (activity?.type === 1 || activity?.type === 3) return 'video';
  return 'game';
}

function sanitizeActivityKinds(value) {
  return {
    game: value?.game !== false,
    music: value?.music === true,
    video: value?.video === true,
  };
}

function activityAllowed(activity, kinds) {
  return Boolean(activity) && kinds?.[activityKind(activity)] !== false;
}

function createRichPresenceService({
  getWindow,
  onWorkerReady,
  onWineBridgeStatus,
  onMprisStatus,
  onWindowsMediaStatus,
  onRpcStatus,
  onWorkerFailure,
} = {}) {
  let child = null;
  let wanted = false;
  let activityKinds = sanitizeActivityKinds();
  let current = null;
  let lastEmitted = null;
  let wineStatus = null;
  let mprisStatus = null;
  let windowsMediaStatus = null;
  let rpcStatus = null;
  let restartTimer = null;
  let generation = 0;
  let sequence = 0;
  const activities = new Map();
  const localArtwork = createLocalArtworkRegistry();

  const currentWindow = () => {
    const window = getWindow?.();
    return window && !window.isDestroyed() ? window : null;
  };

  /// Only when it is news: media players announce on every property, and a false "different" costs one redundant IPC message.
  const emit = (activity) => {
    const encoded = activity === null ? null : JSON.stringify(activity);
    if (encoded === lastEmitted) return;
    lastEmitted = encoded;
    current = activity;
    currentWindow()?.webContents.send('telium:rich-presence', activity);
  };

  const emitWineStatus = (status) => {
    const sessions = integer(status?.sessions);
    const activeBridges = integer(status?.activeBridges);
    wineStatus = status && typeof status === 'object' ? {
      available: Boolean(status.available),
      state: text(status.state, 64),
      reason: text(status.reason, 64),
      sessions: sessions ?? 0,
      activeBridges: activeBridges ?? 0,
    } : null;
    currentWindow()?.webContents.send('telium:wine-rich-presence-status', wineStatus);
    onWineBridgeStatus?.(wineStatus);
  };

  const emitMprisStatus = (status) => {
    const names = Array.isArray(status?.names)
      ? status.names.map((name) => text(name, 64)).filter(Boolean).slice(0, 8)
      : [];
    mprisStatus = status && typeof status === 'object' ? {
      available: Boolean(status.available),
      state: text(status.state, 64),
      reason: text(status.reason, 64),
      players: integer(status.players) ?? 0,
      readable: integer(status.readable) ?? 0,
      playing: integer(status.playing) ?? 0,
      names,
      bus: text(status.bus, 32),
    } : null;
    currentWindow()?.webContents.send('telium:mpris-status', mprisStatus);
    onMprisStatus?.(mprisStatus);
  };

  const emitWindowsMediaStatus = (status) => {
    const names = Array.isArray(status?.names)
      ? status.names.map((name) => text(name, 64)).filter(Boolean).slice(0, 8)
      : [];
    windowsMediaStatus = status && typeof status === 'object' ? {
      available: Boolean(status.available),
      state: text(status.state, 64),
      reason: text(status.reason, 64),
      players: integer(status.players) ?? 0,
      readable: integer(status.readable) ?? 0,
      playing: integer(status.playing) ?? 0,
      names,
      provider: text(status.provider, 32),
      detail: text(status.detail, 240),
    } : null;
    currentWindow()?.webContents.send('telium:windows-media-status', windowsMediaStatus);
    onWindowsMediaStatus?.(windowsMediaStatus);
  };

  const emitRpcStatus = (status) => {
    rpcStatus = status && typeof status === 'object' ? {
      available: Boolean(status.available),
      state: text(status.state, 64),
      connections: integer(status.connections) ?? 0,
      slot: integer(status.slot),
      earlierPipeOccupied: Boolean(status.earlierPipeOccupied),
    } : null;
    currentWindow()?.webContents.send('telium:rpc-status', rpcStatus);
    onRpcStatus?.(rpcStatus);
  };

  const selectActivity = () => {
    const selected = new Map();
    for (const entry of activities.values()) {
      if (!activityAllowed(entry.activity, activityKinds)) continue;
      const slot = activityKind(entry.activity);
      const previous = selected.get(slot);
      if (!previous
        || entry.priority > previous.priority
        || (entry.priority === previous.priority && entry.sequence > previous.sequence)) {
        selected.set(slot, entry);
      }
    }

    // One best signal per category (game, music, video); stable order so all consumers agree.
    const currentActivities = ['game', 'music', 'video']
      .map((slot) => selected.get(slot)?.activity)
      .filter(Boolean);
    emit(currentActivities.length ? currentActivities : null);
  };

  const applyActivity = (data) => {
    const key = activityKey(data);
    const activity = sanitizeRichActivity(data);
    if (activity) {
      // Album art file:// paths never enter the renderer; expose an opaque one-session handle, including track identity since players overwrite one cache path.
      const rawActivity = data?.activity;
      const trackKey = [
        text(rawActivity?.name),
        text(rawActivity?.details),
        text(rawActivity?.state),
        text(rawActivity?.assets?.large_text),
      ].filter(Boolean).join('\0');
      const localHandle = localArtwork.register(
        rawActivity?.assets?.local_large_image,
        trackKey,
      );
      if (localHandle) {
        activity.assets = {
          ...(activity.assets || {}),
          local_large_image: localHandle,
          large_text: text(rawActivity?.assets?.large_text),
        };
      }
      activities.set(key, {
        activity,
        priority: activityPriority(data),
        sequence: ++sequence,
      });
    } else {
      activities.delete(key);
    }
    selectActivity();
  };

  const stopChild = () => {
    clearTimeout(restartTimer);
    restartTimer = null;
    const running = child;
    child = null;
    generation += 1;
    activities.clear();
    localArtwork.clear();
    if (running) {
      try { running.postMessage({ op: 'stop' }); } catch { /* already exited */ }
      setTimeout(() => {
        try { running.kill(); } catch { /* already exited */ }
      }, 500).unref?.();
    }
  };

  const start = () => {
    if (!wanted || child) return;
    const mine = ++generation;
    let ready = false;
    let probeTimer = null;
    const worker = utilityProcess.fork(workerPath(), [], {
      serviceName: 'Telium Rich Presence',
    });
    child = worker;

    const stopProbing = () => {
      if (probeTimer) clearInterval(probeTimer);
      probeTimer = null;
    };
    const probe = () => {
      if (ready || child !== worker || mine !== generation) {
        stopProbing();
        return;
      }
      try { worker.postMessage({ op: 'probe' }); } catch (error) {
        // postMessage is queued until the child's handler exists; retrying only guards odd startup failures.
        if (child !== worker || mine !== generation) return;
        console.warn('[Telium desktop] arRPC readiness probe:', error.message || error);
      }
    };

    worker.on('message', (message) => {
      if (child !== worker || mine !== generation || !message || typeof message !== 'object') return;
      if (message.type === 'ready' && !ready) {
        ready = true;
        stopProbing();
        onWorkerReady?.(message);
      }
      if (message.type === 'wine-bridge-status') emitWineStatus(message);
      if (message.type === 'mpris-status') emitMprisStatus(message);
      if (message.type === 'windows-media-status') emitWindowsMediaStatus(message);
      if (message.type === 'rpc-status') emitRpcStatus(message);
      if (message.type === 'activity') applyActivity(message.data);
      if (message.type === 'wine-bridge-error') {
        console.warn('[Telium desktop] Wine RPC bridge:', message.message || 'startup failed');
      }
      if (message.type === 'error') {
        const error = new Error(String(message.message || 'unknown arRPC worker error'));
        console.warn('[Telium desktop] arRPC worker:', error.message);
        onWorkerFailure?.(error);
      }
    });
    worker.on('error', (error) => {
      console.warn('[Telium desktop] arRPC utility process error:', error);
      onWorkerFailure?.(error);
    });
    worker.on('exit', (code) => {
      stopProbing();
      if (child !== worker) return;
      child = null;
      activities.clear();
      localArtwork.clear();
      emit(null);
      emitWineStatus({ available: false, state: 'stopped', reason: ready ? 'worker-exited' : 'worker-not-ready' });
      emitMprisStatus({ available: false, state: 'stopped', reason: ready ? 'worker-exited' : 'worker-not-ready' });
      emitWindowsMediaStatus({ available: false, state: 'stopped', reason: ready ? 'worker-exited' : 'worker-not-ready' });
      emitRpcStatus({ available: false, state: 'stopped', connections: 0, slot: null, earlierPipeOccupied: false });
      if (!ready) onWorkerFailure?.(new Error(`arRPC worker exited before ready (${code}).`));
      if (!wanted) return;
      console.warn(`[Telium desktop] arRPC worker exited (${code}); restarting.`);
      restartTimer = setTimeout(start, 2000);
      restartTimer.unref?.();
    });

    // Do not wait for `spawn`: a late `once('spawn')` listener can miss it and leave the retry loop unstarted.
    probeTimer = setInterval(probe, 250);
    probeTimer.unref?.();
    probe();
  };

  return Object.freeze({
    setEnabled(enabled, kinds = null) {
      const nextKinds = sanitizeActivityKinds(kinds);
      const kindsChanged = nextKinds.game !== activityKinds.game
        || nextKinds.music !== activityKinds.music
        || nextKinds.video !== activityKinds.video;
      activityKinds = nextKinds;

      const next = Boolean(enabled);
      if (wanted === next) {
        if (wanted) {
          start();
          if (kindsChanged) selectActivity();
        }
        return;
      }
      wanted = next;
      if (wanted) {
        start();
        selectActivity();
      } else {
        stopChild();
        emit(null);
        emitWineStatus({ available: false, state: 'disabled', reason: null });
        emitMprisStatus({ available: false, state: 'disabled', reason: null });
        emitWindowsMediaStatus({ available: false, state: 'disabled', reason: null });
        emitRpcStatus({ available: false, state: 'disabled', connections: 0, slot: null, earlierPipeOccupied: false });
      }
    },
    activity() { return current; },
    wineStatus() { return wineStatus; },
    mprisStatus() { return mprisStatus; },
    windowsMediaStatus() { return windowsMediaStatus; },
    rpcStatus() { return rpcStatus; },
    readArtwork(handle) { return localArtwork.read(handle); },
    dispose() {
      wanted = false;
      stopChild();
      current = null;
      lastEmitted = null;
      wineStatus = null;
      mprisStatus = null;
      windowsMediaStatus = null;
      rpcStatus = null;
      localArtwork.clear();
    },
  });
}

module.exports = {
  createRichPresenceService,
  sanitizeRichActivity,
  activityPriority,
  activityKind,
  sanitizeActivityKinds,
  activityAllowed,
};
