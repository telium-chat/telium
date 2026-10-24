'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Frozen separately because `Object.freeze` is shallow; nothing here decides anything, judgement is across IPC.
const relay = Object.freeze({
  configure: (options) => ipcRenderer.invoke('telium:relay-configure', options || {}),
  setProtectedHosts: (hosts) => ipcRenderer.invoke('telium:relay-protected-hosts', Array.isArray(hosts) ? hosts : [...(hosts || [])]),
  fetch: (request) => ipcRenderer.invoke('telium:relay-fetch', request || {}),
  socketOpen: (request) => ipcRenderer.invoke('telium:relay-socket-open', request || {}),
  socketSend: (frame) => ipcRenderer.invoke('telium:relay-socket-send', frame || {}),
  socketClose: (request) => ipcRenderer.invoke('telium:relay-socket-close', request || {}),
  // Unsubscribe removes only its own listener: a gateway and a media socket can both be open.
  onSocketEvent(callback) {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, payload) => callback(payload || {});
    ipcRenderer.on('telium:relay-socket-event', listener);
    return () => ipcRenderer.removeListener('telium:relay-socket-event', listener);
  },
});

// No function takes a URL, version or digest: the main process re-derives everything from the pinned publisher.
const updates = Object.freeze({
  state: () => ipcRenderer.invoke('telium:updates-state'),
  check: () => ipcRenderer.invoke('telium:updates-check'),
  install: () => ipcRenderer.invoke('telium:updates-install'),
  restart: () => ipcRenderer.invoke('telium:updates-restart'),
  onChanged(callback) {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, state) => callback(state || null);
    ipcRenderer.on('telium:updates-changed', listener);
    return () => ipcRenderer.removeListener('telium:updates-changed', listener);
  },
});

const bridge = Object.freeze({
  runtime: 'electron',
  platform: process.platform,
  // What is installed, not built; absent in a dev shell, and the renderer treats absent as "do not say".
  versions: Object.freeze({
    app: process.env.TELIUM_APP_VERSION || '',
    electron: process.versions.electron || '',
    chrome: process.versions.chrome || '',
  }),
  relay,
  updates,
  screenShareAudioFallback: process.platform === 'linux',
  openExternal: (url) => ipcRenderer.invoke('telium:open-external', url),
  notificationPermission: () => ipcRenderer.invoke('telium:notification-permission'),
  requestNotificationPermission: () => ipcRenderer.invoke('telium:request-notification-permission'),
  showNotification: (payload) => ipcRenderer.invoke('telium:show-notification', payload),
  prepareGofilePlayback: (source, token) => ipcRenderer.invoke('telium:prepare-gofile', { source, token }),
  fetchGifBytes: (url) => ipcRenderer.invoke('telium:fetch-gif', url),
  windowFocus: () => ipcRenderer.invoke('telium:window-focus'),
  importDiscordGifs: () => ipcRenderer.invoke('telium:import-discord-gifs'),
  screenShareAudioStart: () => ipcRenderer.invoke('telium:screen-share-audio-start'),
  screenShareAudioStop: () => ipcRenderer.invoke('telium:screen-share-audio-stop'),

  // Keep the Linux-specific aliases below until callers migrate.
  desktopIntegration: () => ipcRenderer.invoke('telium:desktop-integration'),
  setDesktopLauncherInstalled: (enabled) => ipcRenderer.invoke(
    'telium:set-desktop-launcher-installed', Boolean(enabled),
  ),
  setDesktopStartOnLogin: (enabled) => ipcRenderer.invoke(
    'telium:set-desktop-start-on-login', Boolean(enabled),
  ),

  linuxDesktopIntegration: () => ipcRenderer.invoke('telium:linux-desktop-integration'),
  setLinuxLauncherInstalled: (enabled) => ipcRenderer.invoke(
    'telium:set-linux-launcher-installed', Boolean(enabled),
  ),
  setLinuxStartOnLogin: (enabled) => ipcRenderer.invoke(
    'telium:set-linux-start-on-login', Boolean(enabled),
  ),
  setRichPresenceEnabled: (enabled, kinds = null) => ipcRenderer.invoke(
    'telium:set-rich-presence-enabled',
    Boolean(enabled),
    kinds && typeof kinds === 'object' ? {
      game: kinds.game !== false,
      music: kinds.music !== false,
      video: kinds.video !== false,
    } : null,
  ),
  richPresenceActivity: () => ipcRenderer.invoke('telium:rich-presence-activity'),
  readRichPresenceArtwork: (handle) => ipcRenderer.invoke('telium:read-rich-presence-artwork', handle),
  wineRichPresenceStatus: () => ipcRenderer.invoke('telium:wine-rich-presence-status'),
  mprisStatus: () => ipcRenderer.invoke('telium:mpris-status'),
  windowsMediaStatus: () => ipcRenderer.invoke('telium:windows-media-status'),
  rpcStatus: () => ipcRenderer.invoke('telium:rpc-status'),
  onRichPresenceChanged(callback) {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, activity) => callback(activity || null);
    ipcRenderer.on('telium:rich-presence', listener);
    return () => ipcRenderer.removeListener('telium:rich-presence', listener);
  },
  onWineRichPresenceStatusChanged(callback) {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, status) => callback(status || null);
    ipcRenderer.on('telium:wine-rich-presence-status', listener);
    return () => ipcRenderer.removeListener('telium:wine-rich-presence-status', listener);
  },
  onMprisStatusChanged(callback) {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, status) => callback(status || null);
    ipcRenderer.on('telium:mpris-status', listener);
    return () => ipcRenderer.removeListener('telium:mpris-status', listener);
  },
  onWindowsMediaStatusChanged(callback) {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, status) => callback(status || null);
    ipcRenderer.on('telium:windows-media-status', listener);
    return () => ipcRenderer.removeListener('telium:windows-media-status', listener);
  },
  onRpcStatusChanged(callback) {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, status) => callback(status || null);
    ipcRenderer.on('telium:rpc-status', listener);
    return () => ipcRenderer.removeListener('telium:rpc-status', listener);
  },
  onWindowFocusChanged(callback) {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, focused) => callback(Boolean(focused));
    ipcRenderer.on('telium:window-focus', listener);
    return () => ipcRenderer.removeListener('telium:window-focus', listener);
  },
  onOpenFeedback(callback) {
    if (typeof callback !== 'function') return () => {};
    const listener = () => callback();
    ipcRenderer.on('telium:open-feedback', listener);
    return () => ipcRenderer.removeListener('telium:open-feedback', listener);
  },
});

contextBridge.exposeInMainWorld('teliumDesktop', bridge);
