import { access } from 'node:fs/promises';
import { join } from 'node:path';

const MPRIS_PREFIX = 'org.mpris.MediaPlayer2.';
const MPRIS_PATH = '/org/mpris/MediaPlayer2';
const MPRIS_ROOT = 'org.mpris.MediaPlayer2';
const MPRIS_PLAYER = 'org.mpris.MediaPlayer2.Player';
const DBUS_PROPERTIES = 'org.freedesktop.DBus.Properties';
const DBUS_NAME = 'org.freedesktop.DBus';
const DBUS_PATH = '/org/freedesktop/DBus';
const DBUS_IFACE = 'org.freedesktop.DBus';
const DBUS_TIMEOUT_MS = 4_000;
const PLAYER_TIMEOUT_MS = 3_000;
const VIDEO_FILE_EXTENSION = /\.(?:avi|flv|m2ts|m4v|mkv|mov|mp4|mpeg|mpg|ogv|ts|webm|wmv)$/i;
const BROWSER_PLAYER = /(?:^|[\s._-])(?:brave|chrome|chromium|edge|firefox|vivaldi|zen)(?:$|[\s._-])/i;

function unwrap(value) {
  let current = value;
  // dbus-next wraps variants in `{ signature, value }`; recurse to unwrap.
  for (let i = 0; i < 4; i += 1) {
    if (!current || typeof current !== 'object' || Array.isArray(current)
      || !Object.prototype.hasOwnProperty.call(current, 'value')) break;
    current = current.value;
  }
  return current;
}

function text(value) {
  const raw = unwrap(value);
  if (typeof raw !== 'string') return null;
  const clean = raw.trim();
  return clean || null;
}

function integer(value) {
  const raw = unwrap(value);
  if (typeof raw === 'bigint') {
    const n = Number(raw);
    return Number.isSafeInteger(n) ? n : null;
  }
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

function artists(value) {
  const raw = unwrap(value);
  if (!Array.isArray(raw)) return text(raw) ? [text(raw)] : [];
  return raw.map(text).filter(Boolean);
}

function metadataValue(metadata, key) {
  if (!metadata || typeof metadata !== 'object') return null;
  return unwrap(metadata[key]);
}

function serviceLabel(service) {
  const suffix = String(service || '').startsWith(MPRIS_PREFIX)
    ? String(service).slice(MPRIS_PREFIX.length)
    : String(service || 'Music');
  const stable = suffix.replace(/\.instance[^.]*$/i, '').replace(/\.instance[_-].*$/i, '');
  const words = stable.replace(/[._-]+/g, ' ').trim();
  return words ? words.replace(/\b\w/g, (letter) => letter.toUpperCase()) : 'Music';
}

function mediaUrlKind(value) {
  const raw = text(value);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    if (host === 'music.youtube.com') return 'audio';
    if (host === 'youtu.be') return 'video';
    if ((host === 'youtube.com' || host.endsWith('.youtube.com'))
      && /^\/(?:watch(?:\/|$)|shorts(?:\/|$)|live(?:\/|$)|embed(?:\/|$))/.test(url.pathname)) {
      return 'video';
    }
    if (host === 'vimeo.com' || host.endsWith('.vimeo.com')
      || host === 'twitch.tv' || host.endsWith('.twitch.tv')) return 'video';
    if (VIDEO_FILE_EXTENSION.test(url.pathname)) return 'video';
  } catch {
    if (VIDEO_FILE_EXTENSION.test(raw.split(/[?#]/, 1)[0])) return 'video';
  }
  return null;
}

function activityTypeFromMpris({ service, identity, metadata }) {
  // MPRIS has no audio/video flag: prefer explicit metadata, then a narrow browser fallback.
  const mime = text(metadataValue(metadata, 'xesam:mimeType'))?.toLowerCase();
  if (mime?.startsWith('video/')) return 3;
  if (mime?.startsWith('audio/')) return 2;

  const urlKind = mediaUrlKind(metadataValue(metadata, 'xesam:url'));
  if (urlKind === 'video') return 3;
  if (urlKind === 'audio') return 2;

  const playerName = `${text(identity) || ''} ${serviceLabel(service)} ${String(service || '')}`;
  if (/youtube\s*music|youtubemusic/i.test(playerName)) return 2;
  if (text(metadataValue(metadata, 'xesam:album'))) return 2;
  if (BROWSER_PLAYER.test(playerName)) return 3;
  return 2;
}

function artwork(artUrl, album) {
  const raw = text(artUrl);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      if (url.username || url.password) return null;
      return {
        large_image: url.href,
        large_text: text(album),
      };
    }
    // Never put a local path on the network: the main process replaces it with an opaque handle.
    if (url.protocol === 'file:' && (!url.hostname || url.hostname === 'localhost')) {
      return {
        local_large_image: url.href,
        large_text: text(album),
      };
    }
  } catch {
    // A bad art URL is not a bad activity.
  }
  return null;
}

async function withTimeout(value, milliseconds, label) {
  let timer = null;
  try {
    return await Promise.race([
      Promise.resolve(value),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function sessionBusSetup() {
  const configured = text(process.env.DBUS_SESSION_BUS_ADDRESS);
  if (configured) {
    return { options: { busAddress: configured }, mode: 'environment' };
  }

  // An explicit address keeps the packaged utility process independent of the launcher's session environment.
  const candidates = [];
  const runtimeDir = text(process.env.XDG_RUNTIME_DIR);
  if (runtimeDir) candidates.push({ path: join(runtimeDir, 'bus'), mode: 'xdg-runtime' });
  const uid = process.getuid?.();
  if (Number.isInteger(uid)) candidates.push({ path: `/run/user/${uid}/bus`, mode: 'run-user' });

  const seen = new Set();
  for (const candidate of candidates) {
    if (!candidate.path || seen.has(candidate.path)) continue;
    seen.add(candidate.path);
    try {
      await access(candidate.path);
      return {
        options: { busAddress: `unix:path=${candidate.path}` },
        mode: candidate.mode,
      };
    } catch {
    }
  }
  return { options: undefined, mode: 'automatic' };
}

/// Longer than any round of D-Bus calls, shorter than a deliberate seek.
const POSITION_DRIFT_MS = 2_000;

/// Not `mpris:trackid`, which is optional and often reminted on queue reshuffles.
function sameTrack(previous, next) {
  return Boolean(previous) && previous.name === next.name && previous.type === next.type
    && previous.details === next.details && previous.state === next.state;
}

/// Players republish on volume and rate changes; recomputing timestamps would emit a presence update for an unchanged song.
function steadyTimestamps(previous, next, now) {
  if (!previous || !next) return next;
  if (previous.end - previous.start !== next.end - next.start) return next;
  const predicted = now - previous.start;
  const measured = now - next.start;
  return Math.abs(predicted - measured) <= POSITION_DRIFT_MS ? previous : next;
}

export function activityFromMpris({
  service,
  identity,
  playbackStatus,
  metadata,
  positionMicros,
  previous = null,
}, now = Date.now()) {
  if (text(playbackStatus)?.toLowerCase() !== 'playing') return null;

  const title = text(metadataValue(metadata, 'xesam:title'));
  if (!title) return null;
  const artistList = artists(metadataValue(metadata, 'xesam:artist'));
  const album = text(metadataValue(metadata, 'xesam:album'));
  const lengthMicros = integer(metadataValue(metadata, 'mpris:length'));
  const position = integer(positionMicros);

  let timestamps = null;
  if (lengthMicros && lengthMicros > 0 && position !== null && position >= 0) {
    const durationMs = Math.max(1, Math.round(lengthMicros / 1000));
    const positionMs = Math.min(durationMs, Math.max(0, Math.round(position / 1000)));
    const start = Math.round(now - positionMs);
    timestamps = { start, end: start + durationMs };
  }

  const activity = {
    name: text(identity) || serviceLabel(service),
    type: activityTypeFromMpris({ service, identity, metadata }),
    details: title,
    state: artistList.length ? artistList.join(', ') : album,
    timestamps,
    party: null,
    buttons: [],
    assets: artwork(metadataValue(metadata, 'mpris:artUrl'), album),
  };
  if (!sameTrack(previous, activity)) return activity;
  return { ...activity, timestamps: steadyTimestamps(previous.timestamps, timestamps, now) };
}

export function createMprisSource({ onActivity, onError, onStatus, dbusModule } = {}) {
  let bus = null;
  let dbusInterface = null;
  let busReady = false;
  let busMode = null;
  let statusState = 'idle';
  let statusReason = null;
  let stopped = false;
  const knownServices = new Set();
  const players = new Map();

  const reportError = (error) => {
    try { onError?.(error); } catch { /* observers must not take down discovery */ }
  };

  const emit = (service, activity) => {
    try { onActivity?.({ key: service, activity: activity || null }); } catch (error) { reportError(error); }
  };

  const statusSnapshot = () => {
    const names = [];
    for (const service of knownServices) {
      const label = players.get(service)?.identity || serviceLabel(service);
      if (label && !names.includes(label)) names.push(label);
      if (names.length >= 8) break;
    }
    const playing = [...players.values()].filter((player) => Boolean(player.activity)).length;
    return {
      available: busReady,
      state: statusState,
      reason: statusReason,
      players: knownServices.size,
      readable: players.size,
      playing,
      names,
      bus: busMode,
    };
  };

  const emitStatus = () => {
    try { onStatus?.(statusSnapshot()); } catch (error) { reportError(error); }
  };

  const setStatus = (state, reason = null) => {
    statusState = state;
    statusReason = reason;
    emitStatus();
  };

  const refreshStatus = () => {
    if (stopped) {
      setStatus('stopped');
      return;
    }
    if (!busReady) return;
    setStatus(knownServices.size ? 'watching' : 'no-players');
  };

  const removePlayer = (service, { forget = true } = {}) => {
    const player = players.get(service);
    if (player) {
      players.delete(service);
      try { player.properties?.off?.('PropertiesChanged', player.onPropertiesChanged); } catch { /* best effort */ }
      try { player.player?.off?.('Seeked', player.onSeeked); } catch { /* best effort */ }
    }
    if (forget) knownServices.delete(service);
    emit(service, null);
    refreshStatus();
  };

  const refresh = async (service, player) => {
    const revision = ++player.revision;
    try {
      const values = await withTimeout(Promise.all([
        player.properties.GetAll(MPRIS_PLAYER),
        player.properties.GetAll(MPRIS_ROOT).catch(() => ({})),
        player.properties.Get(MPRIS_PLAYER, 'Position').catch(() => null),
      ]), PLAYER_TIMEOUT_MS, `${service} metadata`);
      if (stopped || players.get(service) !== player || revision !== player.revision) return;
      const [playerProps, rootProps, positionValue] = values;
      player.identity = text(unwrap(rootProps?.Identity)) || serviceLabel(service);
      player.activity = activityFromMpris({
        service,
        identity: player.identity,
        playbackStatus: unwrap(playerProps?.PlaybackStatus),
        metadata: unwrap(playerProps?.Metadata) || {},
        positionMicros: unwrap(positionValue),
        previous: player.activity,
      });
      emit(service, player.activity);
      refreshStatus();
    } catch (error) {
      if (!stopped && players.get(service) === player) {
        player.activity = null;
        emit(service, null);
        reportError(error);
        refreshStatus();
      }
    }
  };

  const addPlayer = async (service) => {
    if (stopped || !service.startsWith(MPRIS_PREFIX)) return;
    knownServices.add(service);
    if (players.has(service)) {
      refreshStatus();
      return;
    }
    const player = {
      service,
      identity: serviceLabel(service),
      activity: null,
      revision: 0,
      properties: null,
      player: null,
      onPropertiesChanged: null,
      onSeeked: null,
    };
    try {
      const object = await withTimeout(
        bus.getProxyObject(service, MPRIS_PATH),
        PLAYER_TIMEOUT_MS,
        `${service} introspection`,
      );
      if (stopped || !knownServices.has(service)) return;
      player.properties = object.getInterface(DBUS_PROPERTIES);
      player.player = object.getInterface(MPRIS_PLAYER);
      players.set(service, player);
      player.onPropertiesChanged = (iface, changed) => {
        if (iface !== MPRIS_PLAYER) return;
        const keys = changed && typeof changed === 'object' ? Object.keys(changed) : [];
        if (!keys.length || keys.some((key) => [
          'Metadata', 'PlaybackStatus', 'Rate', 'Position',
        ].includes(key))) void refresh(service, player);
      };
      player.onSeeked = () => { void refresh(service, player); };
      player.properties.on?.('PropertiesChanged', player.onPropertiesChanged);
      player.player.on?.('Seeked', player.onSeeked);
      await refresh(service, player);
    } catch (error) {
      players.delete(service);
      emit(service, null);
      if (!stopped) reportError(error);
      refreshStatus();
    }
  };

  const onNameOwnerChanged = (name, oldOwner, newOwner) => {
    if (typeof name !== 'string' || !name.startsWith(MPRIS_PREFIX)) return;
    const hadOwner = Boolean(text(oldOwner));
    const hasOwner = Boolean(text(newOwner));
    if (hadOwner && hasOwner) {
      removePlayer(name);
      void addPlayer(name);
    } else if (hasOwner) {
      void addPlayer(name);
    } else if (hadOwner) {
      removePlayer(name);
    }
  };

  return Object.freeze({
    async start() {
      if (stopped || bus) return false;
      if (process.platform !== 'linux' && !dbusModule) {
        setStatus('unsupported', 'not-linux');
        return false;
      }
      setStatus('starting');
      try {
        let dbus;
        if (dbusModule) {
          dbus = dbusModule;
          busMode = 'injected';
        } else {
          let imported;
          try {
            imported = await import('@jellybrick/dbus-next');
          } catch (error) {
            reportError(error);
            setStatus('unavailable', 'dependency-missing');
            return false;
          }
          dbus = imported.default || imported;
          const setup = await sessionBusSetup();
          busMode = setup.mode;
          bus = dbus.sessionBus(setup.options);
        }
        if (!bus) bus = dbus.sessionBus();

        bus.on?.('error', (error) => {
          reportError(error);
          if (!stopped) {
            busReady = false;
            setStatus('unavailable', 'session-bus-error');
          }
        });
        const object = await withTimeout(
          bus.getProxyObject(DBUS_NAME, DBUS_PATH),
          DBUS_TIMEOUT_MS,
          'D-Bus session connection',
        );
        if (stopped) return false;
        dbusInterface = object.getInterface(DBUS_IFACE);
        dbusInterface.on?.('NameOwnerChanged', onNameOwnerChanged);
        const names = await withTimeout(
          dbusInterface.ListNames(),
          DBUS_TIMEOUT_MS,
          'D-Bus ListNames',
        );
        if (stopped) return false;
        busReady = true;
        const services = (Array.isArray(names) ? names : []).filter((name) => (
          typeof name === 'string' && name.startsWith(MPRIS_PREFIX)
        ));
        for (const service of services) knownServices.add(service);
        refreshStatus();
        await Promise.allSettled(services.map(addPlayer));
        refreshStatus();
        return true;
      } catch (error) {
        reportError(error);
        busReady = false;
        setStatus('unavailable', 'session-bus-unavailable');
        try { bus?.disconnect?.(); } catch { /* unavailable bus */ }
        bus = null;
        dbusInterface = null;
        return false;
      }
    },
    status() { return statusSnapshot(); },
    async stop() {
      if (stopped) return;
      stopped = true;
      busReady = false;
      try { dbusInterface?.off?.('NameOwnerChanged', onNameOwnerChanged); } catch { /* best effort */ }
      for (const service of [...knownServices]) removePlayer(service);
      knownServices.clear();
      try { bus?.disconnect?.(); } catch { /* best effort */ }
      bus = null;
      dbusInterface = null;
      setStatus('stopped');
    },
  });
}
