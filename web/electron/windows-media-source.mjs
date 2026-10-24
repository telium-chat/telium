import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

function text(value, max = 128) {
  if (typeof value !== 'string') return '';
  return [...value.trim()].slice(0, max).join('');
}

export function windowsMediaKind(session = {}) {
  if (session.media_type === 'video') return 'video';
  if (session.media_type === 'music') return 'music';

  const app = text(session.source_app_id, 160).toLowerCase();
  const title = text(session.title, 256).toLowerCase();
  const artist = text(session.artist);
  const album = text(session.album);
  if (artist || album || /spotify|musicbee|music\.ui|groove|foobar|winamp|itunes|cider|tidal|amazon.?music|apple.?music/.test(app)) {
    return 'music';
  }
  if (/spotify|soundcloud|bandcamp|apple music|amazon music|tidal|youtube music/.test(title)) return 'music';
  if (/youtube|netflix|twitch|hulu|prime video|disney\+?|video|movie|watching/.test(title)) return 'video';
  if (/chrome|chromium|edge|msedge|firefox|brave|opera|vivaldi|vlc|mpv|potplayer|wmplayer|media.?player|movies/.test(app)) {
    return 'video';
  }
  return null;
}

export function windowsMediaActivity(session = {}) {
  const title = text(session.title);
  const artist = text(session.artist);
  const album = text(session.album);
  if (!title && !artist && !album) return null;

  const source = text(session.source_app_id, 160)
    .replace(/\.exe$/i, '')
    .replace(/[_-]+/g, ' ')
    .trim();
  const kind = windowsMediaKind(session);
  if (!kind) return null;
  const state = kind === 'music'
    ? (artist || album || null)
    : (artist || album || source || null);

  return {
    name: source || 'Windows media',
    type: kind === 'video' ? 3 : 2,
    details: title || album || artist || null,
    state,
    timestamps: null,
    party: null,
    buttons: [],
    assets: null,
  };
}

export function defaultWindowsMediaHelperPath({
  env = process.env,
  resourcesPath = process.resourcesPath,
  exists = existsSync,
} = {}) {
  if (env.TELIUM_WINDOWS_MEDIA_HELPER) return env.TELIUM_WINDOWS_MEDIA_HELPER;
  const packaged = resourcesPath
    ? join(resourcesPath, 'windows-media', 'telium-windows-media.exe')
    : null;
  if (packaged && exists(packaged)) return packaged;
  return join(
    here,
    'windows-media-helper',
    'target',
    'x86_64-pc-windows-gnu',
    'release',
    'telium-windows-media.exe',
  );
}

export function createWindowsMediaSource({
  platform = process.platform,
  helperPath = defaultWindowsMediaHelperPath(),
  spawnProcess = spawn,
  onActivity = () => {},
  onStatus = () => {},
  onError = () => {},
  restartDelayMs = 2000,
} = {}) {
  let child = null;
  let lineReader = null;
  let stopped = false;
  let restartTimer = null;
  let activeKeys = new Set();
  let lastHelperError = null;

  const emitStatus = (state, extra = {}) => onStatus({
    available: state !== 'unsupported' && state !== 'unavailable',
    state,
    reason: null,
    players: activeKeys.size,
    readable: activeKeys.size,
    playing: activeKeys.size,
    names: [],
    ...extra,
  });

  const clearActivities = () => {
    for (const key of activeKeys) onActivity({ key, activity: null });
    activeKeys = new Set();
  };

  const applySnapshot = (raw) => {
    if (!Array.isArray(raw)) return;
    const sessions = raw.slice(0, 32);
    const next = new Set();
    const names = [];

    for (let index = 0; index < sessions.length; index += 1) {
      const session = sessions[index] || {};
      const source = text(session.source_app_id, 160);
      const pid = Number.isSafeInteger(Number(session.process_id)) ? Number(session.process_id) : null;
      const key = pid !== null ? `${source || 'process'}:${pid}` : (source || `session-${index}`);
      const activity = windowsMediaActivity(session);
      if (!activity) continue;
      next.add(key);
      names.push(activity.name);
      onActivity({ key, activity });
    }

    for (const key of activeKeys) {
      if (!next.has(key)) onActivity({ key, activity: null });
    }
    activeKeys = next;
    emitStatus(next.size ? 'playing' : 'no-players', {
      players: sessions.length,
      readable: next.size,
      playing: next.size,
      names: names.slice(0, 8),
      provider: sessions.some((session) => session?.provider === 'wasapi') ? 'wasapi' : null,
    });
  };

  const scheduleRestart = () => {
    if (stopped || restartTimer) return;
    restartTimer = setTimeout(() => {
      restartTimer = null;
      start();
    }, restartDelayMs);
    restartTimer.unref?.();
  };

  const start = () => {
    if (platform !== 'win32') {
      emitStatus('unsupported', { available: false, reason: 'not-windows' });
      return { available: false, state: 'unsupported', reason: 'not-windows' };
    }
    if (stopped || child) return { available: Boolean(child), state: child ? 'starting' : 'stopped' };

    emitStatus('starting', { available: false });
    let spawned;
    try {
      spawned = spawnProcess(helperPath, [], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      emitStatus('unavailable', { available: false, reason: 'spawn-failed' });
      onError(error);
      scheduleRestart();
      return { available: false, state: 'unavailable', reason: 'spawn-failed' };
    }
    child = spawned;

    lineReader = createInterface({ input: spawned.stdout });
    lineReader.on('line', (line) => {
      try {
        applySnapshot(JSON.parse(line));
      } catch (error) {
        onError(new Error(`Windows media helper returned invalid data: ${error?.message || error}`));
      }
    });
    spawned.stderr?.on('data', (chunk) => {
      const message = String(chunk || '').trim();
      if (message) {
        lastHelperError = message.slice(0, 500);
        onError(new Error(lastHelperError));
      }
    });
    spawned.once('error', (error) => {
      if (child !== spawned) return;
      const detail = text(error?.message || error, 240) || null;
      emitStatus('unavailable', { available: false, reason: 'helper-error', detail });
      onError(error);
    });
    spawned.once('exit', (code, signal) => {
      if (child !== spawned) return;
      child = null;
      lineReader?.close();
      lineReader = null;
      clearActivities();
      if (!stopped) {
        const detail = lastHelperError
          || (code !== null ? `helper exited with code ${code}` : null)
          || (signal ? `helper exited after signal ${signal}` : null);
        emitStatus('unavailable', {
          available: false,
          reason: 'helper-exited',
          detail,
        });
        scheduleRestart();
      }
    });

    return { available: true, state: 'starting', reason: null };
  };

  const stop = async () => {
    stopped = true;
    clearTimeout(restartTimer);
    restartTimer = null;
    clearActivities();
    lineReader?.close();
    lineReader = null;
    const running = child;
    child = null;
    try { running?.kill(); } catch { /* already gone */ }
    emitStatus('stopped', { available: false });
  };

  return { start, stop };
}
