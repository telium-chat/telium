'use strict';

const {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  Menu,
  Notification,
  Tray,
  desktopCapturer,
  ipcMain,
  nativeImage,
  session,
  shell,
} = require('electron');
const { autoUpdater } = require('electron-updater');
const dns = require('node:dns').promises;
const { spawn } = require('node:child_process');
const { readFileSync } = require('node:fs');
const https = require('node:https');
const net = require('node:net');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { createRelayBridge } = require('./relay.cjs');
const { createRelayGuard } = require('./relay-guard.cjs');
const { installPageZoom } = require('./page-zoom.cjs');
const { createScreenShareAudioService } = require('./screen-share-audio.cjs');
const { createUpdateService, runningAppImage } = require('./updater.cjs');
const { createDesktopUpdater } = require('./desktop-updater.cjs');
const { createTrayController } = require('./tray-lifecycle.cjs');
const { installRendererCrashHandlers } = require('./renderer-crash.cjs');
const {
  createLinuxDesktopIntegration,
  hasStartInTrayFlag,
} = require('./linux-desktop-integration.cjs');
const { createWindowsDesktopIntegration } = require('./windows-desktop-integration.cjs');

const PRODUCT = 'Telium';
const APP_USER_MODEL_ID = 'chat.telium.desktop';
const MAX_GIF_BYTES = 20 * 1024 * 1024;
const DEV_URL = process.env.TELIUM_DEV_SERVER_URL || null;
const SMOKE = process.env.TELIUM_DESKTOP_SMOKE === '1';
const START_IN_TRAY = hasStartInTrayFlag(process.argv);
let mainWindow = null;
let trayController = null;
let desktopUpdater = null;
let linuxDesktopIntegration = null;
let windowsDesktopIntegration = null;
let revealOnReady = false;
const screenShareAudio = createScreenShareAudioService({ electronApp: app });
const desktopIcons = new Map();

function desktopIcon(name) {
  if (desktopIcons.has(name)) return desktopIcons.get(name);

  const encoded = readFileSync(path.join(__dirname, 'assets', `${name}.png.base64`), 'utf8')
    .replace(/\s+/g, '');
  const image = nativeImage.createFromDataURL(`data:image/png;base64,${encoded}`);
  if (image.isEmpty()) throw new Error(`Could not load Telium desktop icon: ${name}`);
  desktopIcons.set(name, image);
  return image;
}

// `relay` carries traffic, `relayGuard` refuses it; separate so the guard works while the relay is down.
const relay = createRelayBridge({
  sendSocketEvent: (event) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('telium:relay-socket-event', event);
  },
});
const relayGuard = createRelayGuard();

function trustedRendererUrl(raw) {
  if (!raw) return false;
  try {
    const url = new URL(raw);
    if (DEV_URL) {
      const dev = new URL(DEV_URL);
      if (url.origin === dev.origin) return true;
    }
    if (url.protocol !== 'file:') return false;
    const rendererRoot = path.resolve(__dirname, 'renderer');
    const candidate = path.resolve(fileURLToPath(url));
    return candidate === rendererRoot || candidate.startsWith(`${rendererRoot}${path.sep}`);
  } catch {
    return false;
  }
}

// Trust the WebContents that made the request; reparsing a file:// URL varies across AppImage extraction paths.
function trustedWebContents(contents) {
  return Boolean(
    mainWindow
      && !mainWindow.isDestroyed()
      && contents
      && contents === mainWindow.webContents,
  );
}

function assertTrustedSender(event) {
  const mainFrame = event.sender?.mainFrame || null;
  const frame = event.senderFrame || null;
  if (!trustedWebContents(event.sender) || (frame && mainFrame && frame !== mainFrame)) {
    throw new Error('Untrusted renderer tried to use a Telium desktop bridge.');
  }
}

function validateHttpUrl(raw) {
  const url = new URL(String(raw || ''));
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) {
    throw new Error('Only credential-free HTTP(S) URLs can be opened externally.');
  }
  return url;
}

function validateGofileDownload(raw) {
  const url = new URL(String(raw || ''));
  const host = url.hostname.toLowerCase();
  if (
    url.protocol !== 'https:'
    || (host !== 'gofile.io' && !host.endsWith('.gofile.io'))
    || !url.pathname.startsWith('/download/')
    || url.username
    || url.password
  ) {
    throw new Error('Gofile playback only accepts HTTPS gofile.io download URLs.');
  }
  return url;
}

function validateGuestToken(token) {
  const value = String(token || '');
  if (value.length < 16 || value.length > 2048 || !/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new Error('Gofile returned an invalid guest token.');
  }
  return value;
}

function isPrivateOrSpecialIp(address) {
  const family = net.isIP(address);
  if (family === 4) {
    const octets = address.split('.').map(Number);
    const [a, b] = octets;
    return a === 0
      || a === 10
      || a === 127
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 198 && (b === 18 || b === 19))
      || (a === 192 && b === 0 && octets[2] === 2)
      || (a === 198 && b === 51 && octets[2] === 100)
      || (a === 203 && b === 0 && octets[2] === 113)
      || a >= 224;
  }
  if (family === 6) {
    const value = address.toLowerCase().split('%')[0];
    if (value === '::' || value === '::1') return true;
    if (value.startsWith('fc') || value.startsWith('fd')) return true;
    if (/^fe[89abcdef]/.test(value)) return true;
    if (value.startsWith('ff')) return true;
    if (value.startsWith('2001:db8:')) return true;
    const mapped = value.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return mapped ? isPrivateOrSpecialIp(mapped[1]) : false;
  }
  return true;
}

async function publicAddresses(hostname) {
  const resolved = await dns.lookup(hostname, { all: true, verbatim: true });
  if (!resolved.length) throw new Error('GIF host could not be resolved.');
  if (resolved.some(({ address }) => isPrivateOrSpecialIp(address))) {
    throw new Error('GIF host resolves to a private or special network address.');
  }
  return resolved;
}

async function fetchGifBytes(raw) {
  const url = new URL(String(raw || ''));
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('Desktop GIF playback only fetches credential-free HTTPS URLs.');
  }

  const [{ address, family }] = await publicAddresses(url.hostname);
  return new Promise((resolve, reject) => {
    const agent = new https.Agent({
      lookup: (_hostname, _options, callback) => callback(null, address, family),
    });
    const request = https.request(url, {
      agent,
      headers: {
        'accept-encoding': 'identity',
        'user-agent': 'Telium/0.1 desktop-gif-player',
      },
      method: 'GET',
      timeout: 12_000,
    }, (response) => {
      const status = response.statusCode || 0;
      if (status < 200 || status >= 300) {
        response.resume();
        reject(new Error(`GIF host returned HTTP ${status}.`));
        return;
      }

      const declared = Number(response.headers['content-length'] || 0);
      if (declared > MAX_GIF_BYTES) {
        response.destroy();
        reject(new Error('GIF is too large for controlled playback.'));
        return;
      }

      const chunks = [];
      let total = 0;
      response.on('data', (chunk) => {
        total += chunk.length;
        if (total > MAX_GIF_BYTES) {
          response.destroy(new Error('GIF is too large for controlled playback.'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => {
        const bytes = Buffer.concat(chunks);
        const signature = bytes.subarray(0, 6).toString('ascii');
        if (signature !== 'GIF87a' && signature !== 'GIF89a') {
          reject(new Error('The fetched resource is not a GIF.'));
          return;
        }
        resolve(bytes.toString('base64'));
      });
    });
    request.on('timeout', () => request.destroy(new Error('GIF request timed out.')));
    request.on('error', reject);
    request.end();
  });
}

async function openDiscordAuthWindowAndExtract(parentWindow) {
  return new Promise((resolve) => {
    let finished = false;
    const authWindow = new BrowserWindow({
      parent: parentWindow || undefined,
      modal: Boolean(parentWindow),
      width: 520,
      height: 750,
      minWidth: 400,
      minHeight: 600,
      title: 'Import Favorite GIFs from Discord',
      show: true,
      autoHideMenuBar: true,
      backgroundColor: '#313338',
      webPreferences: {
        partition: 'persist:discord_import',
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    });

    if (process.platform === 'win32') authWindow.removeMenu();

    const cleanup = () => {
      if (!finished) {
        finished = true;
        resolve({ canceled: true });
      }
    };

    authWindow.on('closed', cleanup);

    let isExtracting = false;
    const checkAndExtract = async () => {
      if (finished || isExtracting || authWindow.isDestroyed()) return;
      const currentUrl = authWindow.webContents.getURL() || '';

      if (!currentUrl.includes('/channels/') && !currentUrl.includes('/app')) {
        return;
      }

      isExtracting = true;

      try {
        const extractionCode = `
          (async () => {
            const sleep = (ms) => new Promise(r => setTimeout(r, ms));
            for (let attempt = 0; attempt < 30; attempt++) {
              let wpRequire;
              try {
                if (typeof webpackChunkdiscord_app !== 'undefined') {
                  webpackChunkdiscord_app.push([[Symbol()], {}, e => { wpRequire = e; return e; }]);
                  if (!wpRequire) {
                    webpackChunkdiscord_app.push([[Symbol()],, e => { wpRequire = e; return e; }]);
                  }
                }
              } catch (e) {}

              let allExports = [];
              if (wpRequire?.c) {
                allExports = Object.values(wpRequire.c)
                  .map(m => m?.exports)
                  .filter(x => typeof x === 'object' && x && x !== window && (typeof DOMTokenList === 'undefined' || x !== DOMTokenList.prototype))
                  .flatMap(x => { try { return [x, ...Object.values(x)]; } catch { return [x]; } });
              }

              const FrecencyUserSettings = window.FrecencyUserSettings
                || allExports.find(x => x?.ProtoClass?.typeName?.endsWith('FrecencyUserSettings'))
                || window.Vencord?.Webpack?.findByProps?.('updateAsync', 'getCurrentValue');

              if (FrecencyUserSettings) {
                if (typeof FrecencyUserSettings.loadIfNecessary === 'function') {
                  await FrecencyUserSettings.loadIfNecessary();
                }
                const source = FrecencyUserSettings.getCurrentValue?.()?.favoriteGifs?.gifs;
                if (source) {
                  let token = null;
                  const authStore = allExports.find(x => typeof x?.getToken === 'function' && typeof x?.getId === 'function')
                                 || allExports.find(x => typeof x?.getToken === 'function');
                  if (authStore) {
                    try { token = authStore.getToken(); } catch {}
                  }
                  if (!token) {
                    try {
                      const raw = window.localStorage.getItem('token');
                      if (raw) token = JSON.parse(raw);
                    } catch {}
                  }

                  const isDiscordCdn = (u) => {
                    try {
                      const p = new URL(u);
                      return /(?:cdn\\.discordapp\\.com|media\\.discordapp\\.net)$/i.test(p.hostname)
                        && /^\\/(?:attachments|ephemeral-attachments)\\//i.test(p.pathname);
                    } catch { return false; }
                  };

                  const toRefresh = new Set();
                  for (const [key, val] of Object.entries(source)) {
                    if (isDiscordCdn(key)) toRefresh.add(key);
                    if (val?.src && isDiscordCdn(val.src)) toRefresh.add(val.src);
                    if (val?.url && isDiscordCdn(val.url)) toRefresh.add(val.url);
                  }

                  const urlsList = Array.from(toRefresh);
                  const exactMap = new Map();
                  const pathMap = new Map();
                  const BATCH_SIZE = 50;

                  for (let b = 0; b < urlsList.length; b += BATCH_SIZE) {
                    const batch = urlsList.slice(b, b + BATCH_SIZE);
                    try {
                      const res = await fetch('/api/v9/attachments/refresh-urls', {
                        method: 'POST',
                        headers: {
                          'Content-Type': 'application/json',
                          ...(token ? { 'Authorization': token } : {})
                        },
                        body: JSON.stringify({ attachment_urls: batch })
                      });
                      if (res.ok) {
                        const data = await res.json();
                        for (const item of data?.refreshed_urls || []) {
                          if (item?.original && item?.refreshed) {
                            exactMap.set(item.original, item.refreshed);
                            try {
                              pathMap.set(new URL(item.original).pathname, item.refreshed);
                            } catch {}
                          }
                        }
                      }
                    } catch (e) {}
                    if (b + BATCH_SIZE < urlsList.length) await sleep(200);
                  }

                  const getRefreshed = (orig) => {
                    if (!orig) return orig;
                    try {
                      return exactMap.get(orig) || pathMap.get(new URL(orig).pathname) || orig;
                    } catch {
                      return exactMap.get(orig) || orig;
                    }
                  };

                  const output = {};
                  let discordCount = 0;
                  let externalCount = 0;

                  for (const [key, val] of Object.entries(source)) {
                    const item = { ...val };
                    let finalKey = key;
                    if (isDiscordCdn(key)) {
                      finalKey = getRefreshed(key);
                      discordCount++;
                    } else {
                      externalCount++;
                    }
                    if (item.src && isDiscordCdn(item.src)) {
                      item.src = getRefreshed(item.src);
                    }
                    if (item.url && isDiscordCdn(item.url)) {
                      item.url = getRefreshed(item.url);
                    }
                    output[finalKey] = item;
                  }

                  return {
                    success: true,
                    gifs: output,
                    total: Object.keys(output).length,
                    discordCount,
                    externalCount
                  };
                }
              }
              await sleep(500);
            }
            return { success: false, error: 'Timed out waiting for Discord favorites store to load.' };
          })();
        `;

        const result = await authWindow.webContents.executeJavaScript(extractionCode);
        if (result && result.success) {
          finished = true;
          authWindow.destroy();
          resolve(result);
          return;
        } else if (result?.error) {
          isExtracting = false;
        }
      } catch (err) {
        isExtracting = false;
      }
    };

    authWindow.webContents.on('did-navigate-in-page', checkAndExtract);
    authWindow.webContents.on('did-navigate', checkAndExtract);
    authWindow.webContents.on('did-finish-load', checkAndExtract);

    authWindow.loadURL('https://discord.com/login').catch(() => {});
  });
}

/// Electron stringifies a rejection across IPC, losing the `code` the renderer branches on.
async function relayReply(work) {
  try {
    return await work();
  } catch (error) {
    return { error: typeof error?.code === 'string' ? error.code : 'failed', message: error?.message || 'the protected connection failed' };
  }
}

// Who may hand this installation a new executable. A file in the asar rather than `process.env`, which whoever launches the app could repoint; absent means no publisher.
const publisher = (() => {
  try {
    const raw = require('node:fs').readFileSync(path.join(__dirname, 'publisher.json'), 'utf8');
    const parsed = JSON.parse(raw);
    return {
      url: typeof parsed.url === 'string' ? parsed.url : '',
      publicKey: typeof parsed.publicKey === 'string' ? parsed.publicKey : '',
    };
  } catch {
    return { url: '', publicKey: '' };
  }
})();

const updates = createUpdateService({
  publisher,
  currentVersion: app.getVersion(),
  appImagePath: runningAppImage(),
  onChange: (state) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('telium:updates-changed', state);
    }
  },
});

function installUpdateBridge() {
  // None of the verbs takes an argument: the renderer cannot name a URL, version or digest.
  ipcMain.handle('telium:updates-state', (event) => {
    assertTrustedSender(event);
    return { ...updates.state(), configured: Boolean(publisher.url && publisher.publicKey) };
  });

  ipcMain.handle('telium:updates-check', async (event) => {
    assertTrustedSender(event);
    return updates.check();
  });

  ipcMain.handle('telium:updates-install', async (event) => {
    assertTrustedSender(event);
    return updates.install();
  });

  ipcMain.handle('telium:updates-restart', (event) => {
    assertTrustedSender(event);
    // Refused unless something is staged, or any frame could close the app on every launch.
    if (!updates.stagedPath()) return false;
    if (process.platform === 'win32') {
      // Runs the staged, verified NSIS installer: spawn detached and exit; the installer restarts the app.
      const child = spawn(updates.stagedPath(), ['/S'], { detached: true, stdio: 'ignore' });
      child.unref();
      app.exit(0);
      return true;
    }
    // `execPath` is the AppImage, not the unpacked binary inside its disappearing mount.
    const image = runningAppImage();
    app.relaunch(image ? { execPath: image } : {});
    app.exit(0);
    return true;
  });
}

function installDesktopBridges() {
  // Behind `assertTrustedSender`: `relay-configure` accepts a live session bearer.
  ipcMain.handle('telium:relay-configure', (event, payload = {}) => {
    assertTrustedSender(event);
    relay.configure({ url: payload.url, token: payload.token });
    relayGuard.setRelayEndpoint(relay.relayUrl());
    return true;
  });

  ipcMain.handle('telium:relay-protected-hosts', (event, hosts) => {
    assertTrustedSender(event);
    relayGuard.setProtectedHosts(Array.isArray(hosts) ? hosts : []);
    return true;
  });

  ipcMain.handle('telium:relay-fetch', (event, payload = {}) => {
    assertTrustedSender(event);
    return relayReply(() => relay.fetch(payload));
  });

  ipcMain.handle('telium:relay-socket-open', (event, payload = {}) => {
    assertTrustedSender(event);
    return relayReply(() => relay.socketOpen(payload));
  });

  // An undeliverable send is a gone socket; the renderer learns from the `close` event.
  ipcMain.handle('telium:relay-socket-send', (event, payload = {}) => {
    assertTrustedSender(event);
    relay.socketSend(payload);
  });

  ipcMain.handle('telium:relay-socket-close', (event, payload = {}) => {
    assertTrustedSender(event);
    relay.socketClose(payload);
  });

  ipcMain.handle('telium:open-external', async (event, raw) => {
    assertTrustedSender(event);
    const url = validateHttpUrl(raw);
    await shell.openExternal(url.href);
    return true;
  });

  ipcMain.handle('telium:notification-permission', (event) => {
    assertTrustedSender(event);
    return Notification.isSupported() ? 'granted' : 'unsupported';
  });

  ipcMain.handle('telium:request-notification-permission', (event) => {
    assertTrustedSender(event);
    return Notification.isSupported() ? 'granted' : 'unsupported';
  });

  ipcMain.handle('telium:show-notification', (event, payload = {}) => {
    assertTrustedSender(event);
    if (!Notification.isSupported()) return false;
    const title = String(payload.title || PRODUCT).slice(0, 160);
    const body = String(payload.body || '').slice(0, 1024);
    const notification = new Notification({ title, body });
    notification.on('click', () => trayController?.show());
    notification.show();
    return true;
  });

  ipcMain.handle('telium:prepare-gofile', async (event, payload = {}) => {
    assertTrustedSender(event);
    validateGofileDownload(payload.source);
    const token = validateGuestToken(payload.token);
    await event.sender.session.cookies.set({
      url: 'https://gofile.io/',
      name: 'accountToken',
      value: token,
      domain: '.gofile.io',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'no_restriction',
    });
    return true;
  });

  ipcMain.handle('telium:fetch-gif', async (event, raw) => {
    assertTrustedSender(event);
    return fetchGifBytes(raw);
  });

  ipcMain.handle('telium:window-focus', (event) => {
    assertTrustedSender(event);
    return Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused());
  });

  ipcMain.handle('telium:import-discord-gifs', async (event) => {
    assertTrustedSender(event);
    return openDiscordAuthWindowAndExtract(mainWindow);
  });

  ipcMain.handle('telium:screen-share-audio-start', (event) => {
    assertTrustedSender(event);
    return screenShareAudio.startSystem();
  });

  ipcMain.handle('telium:screen-share-audio-stop', (event) => {
    assertTrustedSender(event);
    return screenShareAudio.stop();
  });

  ipcMain.handle('telium:desktop-integration', async (event) => {
    assertTrustedSender(event);
    if (process.platform === 'win32') return windowsDesktopIntegration.state();
    const state = await linuxDesktopIntegration.state();
    return {
      ...state,
      platform: 'linux',
      launcherConfigurable: true,
    };
  });

  ipcMain.handle('telium:set-desktop-launcher-installed', async (event, enabled) => {
    assertTrustedSender(event);
    if (process.platform !== 'linux') {
      throw new Error('The application launcher is managed by the Windows installer.');
    }
    const state = await linuxDesktopIntegration.setLauncherInstalled(Boolean(enabled));
    return {
      ...state,
      platform: 'linux',
      launcherConfigurable: true,
    };
  });

  ipcMain.handle('telium:set-desktop-start-on-login', async (event, enabled) => {
    assertTrustedSender(event);
    if (process.platform === 'win32') {
      return windowsDesktopIntegration.setStartOnLogin(Boolean(enabled));
    }
    const state = await linuxDesktopIntegration.setStartOnLogin(Boolean(enabled));
    return {
      ...state,
      platform: 'linux',
      launcherConfigurable: true,
    };
  });

  ipcMain.handle('telium:linux-desktop-integration', (event) => {
    assertTrustedSender(event);
    return linuxDesktopIntegration?.state() || {
      supported: false,
      launcherInstalled: false,
      startOnLogin: false,
    };
  });

  ipcMain.handle('telium:set-linux-launcher-installed', (event, enabled) => {
    assertTrustedSender(event);
    return linuxDesktopIntegration.setLauncherInstalled(Boolean(enabled));
  });

  ipcMain.handle('telium:set-linux-start-on-login', (event, enabled) => {
    assertTrustedSender(event);
    return linuxDesktopIntegration.setStartOnLogin(Boolean(enabled));
  });
}

function installSessionPolicy() {
  const ses = session.defaultSession;

  // Installed before the window exists so no page loads without the deny rule.
  relayGuard.install(ses);
  const allowedPermission = (webContents, permission) => {
    if (!trustedWebContents(webContents)) return false;
    return permission === 'media'
      || permission === 'speaker-selection'
      || permission === 'display-capture'
      || permission === 'fullscreen'
      || permission === 'notifications';
  };

  ses.setPermissionCheckHandler((webContents, permission) => (
    allowedPermission(webContents, permission)
  ));
  ses.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(allowedPermission(webContents, permission));
  });

  // Prefer the system capture picker; else share the primary display rather than reject getDisplayMedia.
  ses.setDisplayMediaRequestHandler(async (request, callback) => {
    const requestFrame = request.frame || null;
    const mainFrame = mainWindow?.webContents.mainFrame || null;
    const trustedFrame = Boolean(requestFrame && mainFrame && requestFrame.top === mainFrame);
    const requestUrl = requestFrame?.url
      || mainWindow?.webContents.getURL()
      || request.securityOrigin
      || '';
    if (!trustedFrame && !trustedRendererUrl(requestUrl)) {
      callback({});
      return;
    }
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen', 'window'],
        fetchWindowIcons: false,
        thumbnailSize: { width: 0, height: 0 },
      });
      const source = sources.find((entry) => entry.id.startsWith('screen:')) || sources[0];
      if (!source) {
        callback({});
        return;
      }
      callback(process.platform === 'win32'
        ? {
          video: source,
          ...(request.audioRequested ? { audio: 'loopback' } : {}),
        }
        : { video: source });
    } catch {
      callback({});
    }
  }, { useSystemPicker: true });
}

function createWindow({ showOnReady = true } = {}) {
  const window = new BrowserWindow({
    title: PRODUCT,
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0b0d0f',
    icon: desktopIcon('icon'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  mainWindow = window;
  // autoHideMenuBar still reveals the menu on Alt on Windows; remove it instead.
  if (process.platform === 'win32') window.removeMenu();
  // No menu means no zoom accelerators (see `page-zoom.cjs`).
  installPageZoom(window);

  const sendFocus = (focused) => {
    if (!window.isDestroyed()) window.webContents.send('telium:window-focus', Boolean(focused));
  };
  window.on('focus', () => sendFocus(true));
  window.on('blur', () => sendFocus(false));
  window.on('close', (event) => {
    trayController?.handleWindowClose(event, window);
  });

  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null;
    // These tunnels still count against the relay's per-account budgets.
    relay.reset();
    relayGuard.setProtectedHosts([]);
  });

  // Navigation ends tunnels too, so a crashing renderer's reload loop cannot strand them; same-document navigations change nothing.
  window.webContents.on('did-start-navigation', (details) => {
    if (details?.isMainFrame === false || details?.isSameDocument === true) return;
    relay.reset();
    relayGuard.setProtectedHosts([]);
  });
  window.once('ready-to-show', () => {
    if (showOnReady) {
      window.show();
      sendFocus(window.isFocused());
    } else {
      sendFocus(false);
    }
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = validateHttpUrl(url);
      void shell.openExternal(parsed.href);
    } catch { /* deny non-web popups */ }
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (trustedRendererUrl(url)) return;
    event.preventDefault();
    try {
      const parsed = validateHttpUrl(url);
      void shell.openExternal(parsed.href);
    } catch { /* stay in Telium */ }
  });

  installRendererCrashHandlers({
    window,
    dialog,
    clipboard,
    shell,
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron || 'unknown',
    chromeVersion: process.versions.chrome || 'unknown',
    platform: `${process.platform} ${process.arch}`,
  });

  // Log the WebRTC capability so a regression names the missing API.
  window.webContents.on('did-finish-load', async () => {
    try {
      const capabilities = await window.webContents.executeJavaScript(`({
        secureContext: window.isSecureContext,
        peerConnection: typeof RTCPeerConnection !== 'undefined',
        addTransceiver: typeof RTCPeerConnection !== 'undefined'
          && 'addTransceiver' in RTCPeerConnection.prototype,
        addTrack: typeof RTCPeerConnection !== 'undefined'
          && 'addTrack' in RTCPeerConnection.prototype,
        getUserMedia: Boolean(navigator.mediaDevices?.getUserMedia),
        getDisplayMedia: Boolean(navigator.mediaDevices?.getDisplayMedia),
      })`, true);
      console.info('[Telium desktop] WebRTC capabilities:', capabilities);
      const liveKitSupported = capabilities.peerConnection
        && (capabilities.addTransceiver || capabilities.addTrack);
      if (!liveKitSupported) {
        console.error('[Telium desktop] Chromium does not satisfy LiveKit browser support.');
      }
      if (SMOKE) {
        console.info(`[Telium desktop] smoke=${JSON.stringify({ ...capabilities, liveKitSupported })}`);
        app.exit(liveKitSupported ? 0 : 2);
      }
    } catch (error) {
      console.error('[Telium desktop] Could not inspect WebRTC capabilities:', error);
      if (SMOKE) app.exit(3);
    }
  });

  if (SMOKE) window.loadFile(path.join(__dirname, 'renderer', 'smoke.html'));
  else if (DEV_URL) window.loadURL(DEV_URL);
  else window.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

// Chromium's Windows Graphics Capture is far more latent than the Linux path; use DXGI for whole-screen capture.
if (process.platform === 'win32') {
  app.commandLine.appendSwitch('disable-features', 'WebRtcAllowWgcScreenCapturer');
}

app.setName(PRODUCT);
if (process.platform === 'win32') app.setAppUserModelId(APP_USER_MODEL_ID);
const enforceSingleInstance = ['linux', 'win32'].includes(process.platform) && app.isPackaged && !SMOKE;
const ownsSingleInstance = !enforceSingleInstance || app.requestSingleInstanceLock();
if (!ownsSingleInstance) {
  app.quit();
} else if (enforceSingleInstance) {
  app.on('second-instance', (_event, argv) => {
    if (hasStartInTrayFlag(argv)) return;
    if (trayController) trayController.show();
    else revealOnReady = true;
  });
}

app.whenReady().then(async () => {
  if (!ownsSingleInstance) return;
  linuxDesktopIntegration = createLinuxDesktopIntegration({
    isPackaged: app.isPackaged,
    appImagePath: process.env.APPIMAGE,
    iconBase64Path: path.join(__dirname, 'assets', 'icon.png.base64'),
  });
  try {
    await linuxDesktopIntegration.refreshExisting();
  } catch (error) {
    console.warn('[Telium desktop] Could not refresh Linux desktop integration:', error?.message || error);
  }
  windowsDesktopIntegration = createWindowsDesktopIntegration({
    app,
    isPackaged: app.isPackaged,
  });

  installDesktopBridges();
  installUpdateBridge();
  installSessionPolicy();

  trayController = createTrayController({
    app,
    Menu,
    Tray,
    product: PRODUCT,
    icon: desktopIcon('tray-icon'),
    getWindow: () => mainWindow,
    createWindow,
    onWindowHidden: (window) => {
      if (!window.isDestroyed()) window.webContents.send('telium:window-focus', false);
    },
    // The renderer opens its own feedback pane; this only says somebody asked.
    openFeedback: () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('telium:open-feedback');
      }
    },
  });
  createWindow({ showOnReady: !START_IN_TRAY || revealOnReady });
  if (!SMOKE) {
    try {
      trayController.install();
    } catch (error) {
      console.warn('[Telium desktop] Could not create system tray:', error?.message || error);
    }

    // The signed path takes precedence once a build has a key; running both would leave a signed build with an unsigned way to update.
    const signedUpdatesConfigured = Boolean(publisher.url && publisher.publicKey);
    if (signedUpdatesConfigured) {
      console.info('[Telium desktop] Publisher key present; using the signed update path.');
    } else {
      desktopUpdater = createDesktopUpdater({
        app,
        autoUpdater,
        dialog,
        Notification,
        getWindow: () => mainWindow,
        showWindow: () => trayController?.show(),
      });
      desktopUpdater.start();
    }
  }

  app.on('activate', () => {
    trayController.show();
  });
});

app.on('web-contents-created', (_event, contents) => {
  contents.on('will-attach-webview', (event) => event.preventDefault());
});

app.on('before-quit', () => {
  trayController?.beginQuit();
  desktopUpdater?.dispose();
  screenShareAudio.dispose();
  relay.dispose();
  trayController?.dispose();
});

app.on('window-all-closed', () => {
  if (!trayController?.hasTray()) app.quit();
});
