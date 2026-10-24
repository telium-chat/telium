'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const { createRichPresenceService } = require('./rich-presence.cjs');

// Packaged version for the preload: `app` is unavailable there.
process.env.TELIUM_APP_VERSION = app.getVersion();

const RICH_PRESENCE_SMOKE = process.env.TELIUM_RICH_PRESENCE_SMOKE === '1';
const MPRIS_SMOKE = process.env.TELIUM_MPRIS_SMOKE === '1';
const ACTIVITY_SMOKE = RICH_PRESENCE_SMOKE || MPRIS_SMOKE;
let richPresence = null;
let smokeTimer = null;

function assertTeliumWindow(event) {
  const window = BrowserWindow.fromWebContents(event.sender);
  const mainFrame = event.sender?.mainFrame || null;
  const frame = event.senderFrame || null;
  if (!window || window.isDestroyed() || (frame && mainFrame && frame !== mainFrame)) {
    throw new Error('Untrusted renderer tried to use the Telium rich-presence bridge.');
  }
}

ipcMain.handle('telium:set-rich-presence-enabled', (event, enabled, kinds) => {
  assertTeliumWindow(event);
  // Smokes own the worker lifecycle; the signed-out renderer would race their forced enable.
  if (!ACTIVITY_SMOKE) richPresence?.setEnabled(Boolean(enabled), kinds);
  return true;
});

ipcMain.handle('telium:rich-presence-activity', (event) => {
  assertTeliumWindow(event);
  return richPresence?.activity() || null;
});

ipcMain.handle('telium:read-rich-presence-artwork', async (event, handle) => {
  assertTeliumWindow(event);
  if (typeof handle !== 'string' || handle.length > 128) return null;
  try {
    return await richPresence?.readArtwork(handle) || null;
  } catch (error) {
    console.warn('[Telium desktop] Could not read local presence artwork:', error?.message || error);
    return null;
  }
});

ipcMain.handle('telium:wine-rich-presence-status', (event) => {
  assertTeliumWindow(event);
  return richPresence?.wineStatus() || null;
});

ipcMain.handle('telium:mpris-status', (event) => {
  assertTeliumWindow(event);
  return richPresence?.mprisStatus() || null;
});

ipcMain.handle('telium:windows-media-status', (event) => {
  assertTeliumWindow(event);
  return richPresence?.windowsMediaStatus() || null;
});

ipcMain.handle('telium:rpc-status', (event) => {
  assertTeliumWindow(event);
  return richPresence?.rpcStatus() || null;
});

app.whenReady().then(() => {
  let arrpcReady = false;
  let wineBridgeReady = process.platform !== 'linux';

  const finishSmoke = (code, message) => {
    if (!ACTIVITY_SMOKE) return;
    clearTimeout(smokeTimer);
    const kind = MPRIS_SMOKE ? 'mpris-smoke' : 'rich-presence-smoke';
    if (message) console.info(`[Telium desktop] ${kind}=${message}`);
    app.exit(code);
  };

  const maybeFinishRichPresenceSmoke = () => {
    if (RICH_PRESENCE_SMOKE && arrpcReady && wineBridgeReady) finishSmoke(0, 'ready');
  };

  richPresence = createRichPresenceService({
    getWindow: () => BrowserWindow.getAllWindows().find((window) => !window.isDestroyed()) || null,
    onWorkerReady: () => {
      arrpcReady = true;
      maybeFinishRichPresenceSmoke();
    },
    onWineBridgeStatus: (status) => {
      if (process.platform !== 'linux' || !RICH_PRESENCE_SMOKE) return;
      if (status?.available !== true) {
        finishSmoke(7, `wine-bridge-unavailable:${status?.reason || 'unknown'}`);
        return;
      }
      wineBridgeReady = true;
      maybeFinishRichPresenceSmoke();
    },
    onMprisStatus: (status) => {
      if (!MPRIS_SMOKE) return;
      if (status?.state === 'unavailable') {
        finishSmoke(8, `unavailable:${status.reason || 'unknown'}`);
        return;
      }
      // Counted only after the source read player metadata, not merely opened D-Bus.
      if (status?.available === true && status.playing > 0) {
        finishSmoke(0, `ready:${status.names?.join(',') || 'player'}`);
      }
    },
    onWorkerFailure: (error) => finishSmoke(5, `failed:${error?.message || error}`),
  });

  if (ACTIVITY_SMOKE) {
    smokeTimer = setTimeout(() => {
      if (MPRIS_SMOKE) {
        const status = richPresence.mprisStatus();
        finishSmoke(9, `timed-out:${status?.state || 'no-status'}:${status?.reason || 'none'}:${status?.players || 0}`);
        return;
      }
      const waitingFor = !arrpcReady ? 'arrpc' : 'wine-bridge';
      finishSmoke(6, `timed-out:${waitingFor}`);
    }, 15_000);
    richPresence.setEnabled(true);
  }
});

app.on('before-quit', () => {
  clearTimeout(smokeTimer);
  richPresence?.dispose();
});

// Packaged integration smokes skip the renderer so signed-out bootstrap cannot disable the worker.
if (!ACTIVITY_SMOKE) require('./main.cjs');
