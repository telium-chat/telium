// Runs arRPC in a utility process: it accepts arbitrary local RPC clients and scans the process table, so a bad client must not take the chat client down.
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import RPCServer from 'arrpc';
import { createMprisSource } from './mpris-source.mjs';
import {
  cleanApplicationName,
  createApplicationNameResolver,
} from './rich-presence-name.mjs';
import { createWineRpcBridgeManager } from './wine-rpc-container-bridge.mjs';
import { createWindowsMediaSource } from './windows-media-source.mjs';
import {
  createWindowsRpcPrimaryPromoter,
  rpcPipeSlot,
} from './windows-rpc-primary.mjs';

const parent = process.parentPort;
const workerDir = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
let ready = false;
let probePending = false;
let wineBridge = null;
let mprisSource = null;
let windowsMediaSource = null;
let windowsRpcPromoter = null;
let ipcServerClassPromise = null;
let stopping = false;
let detectableMetadataPromise = null;
const activityRevisions = new Map();

function post(message) {
  try { parent?.postMessage(message); } catch (error) {
    console.warn('[Telium rich presence worker] parent message failed:', error);
  }
}

async function ipcServerClass() {
  if (!ipcServerClassPromise) {
    ipcServerClassPromise = (async () => {
      const packageJson = require.resolve('arrpc/package.json');
      const moduleUrl = pathToFileURL(
        join(dirname(packageJson), 'src', 'transports', 'ipc.js'),
      ).href;
      return (await import(moduleUrl)).default;
    })();
  }
  return ipcServerClassPromise;
}

async function replacementIpcServer(server) {
  const IPCServer = await ipcServerClass();
  return new IPCServer({
    connection: server.onConnection,
    message: server.onMessage,
    close: server.onClose,
  });
}

function wineBridgeExecutable() {
  if (process.env.TELIUM_WINE_RPC_BRIDGE_EXE) return process.env.TELIUM_WINE_RPC_BRIDGE_EXE;
  if (workerDir.includes('app.asar.unpacked') && process.resourcesPath) {
    return join(process.resourcesPath, 'wine-rpc', 'bridge.exe');
  }
  return join(workerDir, 'vendor', 'rpc-bridge', 'bridge.exe');
}

async function bundledApplicationMetadata(applicationId) {
  if (!detectableMetadataPromise) {
    detectableMetadataPromise = (async () => {
      const packageJson = require.resolve('arrpc/package.json');
      const raw = await readFile(join(dirname(packageJson), 'src', 'process', 'detectable.json'), 'utf8');
      const entries = JSON.parse(raw);
      const metadata = new Map();
      for (const entry of entries) {
        if (entry?.id == null) continue;
        const name = cleanApplicationName(entry.name);
        const icon = typeof entry.icon_hash === 'string' ? entry.icon_hash : null;
        if (name || icon) metadata.set(String(entry.id), { name, icon_hash: icon });
      }
      return metadata;
    })().catch((error) => {
      console.warn('[Telium rich presence worker] could not load arRPC application metadata:', error?.message || error);
      return new Map();
    });
  }
  return (await detectableMetadataPromise).get(String(applicationId)) || null;
}

const applications = createApplicationNameResolver({
  localLookup: bundledApplicationMetadata,
});

function activityRevisionKey(data) {
  if (data?.socketId !== undefined && data?.socketId !== null) {
    return `socket:${String(data.socketId).slice(0, 128)}`;
  }
  if (data?.pid !== undefined && data?.pid !== null) return `pid:${String(data.pid).slice(0, 64)}`;
  return 'default';
}

async function forwardActivity(data) {
  const key = activityRevisionKey(data);
  const revision = (activityRevisions.get(key) || 0) + 1;
  activityRevisions.set(key, revision);

  const activity = data?.activity;
  if (!activity || typeof activity !== 'object') {
    post({ type: 'activity', data });
    return;
  }

  const applicationId = activity.application_id;
  const providedName = cleanApplicationName(activity.name);
  if (providedName) applications.remember(applicationId, providedName);

  // Presence text never waits on Discord: forward first, fill in app metadata and artwork when the lookup completes.
  const cachedName = providedName || applications.peek(applicationId);
  post({
    type: 'activity',
    data: cachedName && cachedName !== activity.name ? {
      ...data,
      activity: { ...activity, name: cachedName },
    } : data,
  });

  // Native sources bring their own identity and artwork; no Discord id to resolve.
  if (data?.source === 'mpris' || data?.source === 'windows-media') return;

  const [resolvedName, artwork] = await Promise.all([
    cachedName ? Promise.resolve(cachedName) : applications.resolve(applicationId),
    applications.resolveArtwork(applicationId, activity.assets),
  ]);
  if (stopping || activityRevisions.get(key) !== revision) return;
  if (!resolvedName && !artwork) return;

  post({
    type: 'activity',
    data: {
      ...data,
      activity: {
        ...activity,
        ...(resolvedName ? { name: resolvedName } : {}),
        ...(artwork ? { assets: artwork } : {}),
      },
    },
  });
}

async function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  try { await mprisSource?.stop(); } catch { /* best effort during shutdown */ }
  try { await windowsMediaSource?.stop(); } catch { /* best effort during shutdown */ }
  try { windowsRpcPromoter?.stop(); } catch { /* best effort during shutdown */ }
  try { await wineBridge?.stop(); } catch { /* best effort during shutdown */ }
  process.exit(code);
}

async function fatal(error) {
  post({ type: 'error', message: String(error?.message || error || 'arRPC worker failed') });
  await shutdown(1);
}

process.on('uncaughtException', (error) => { void fatal(error); });
process.on('unhandledRejection', (error) => { void fatal(error); });

// The parent probes after attaching its listener, so readiness is a handshake.
parent?.on('message', (event) => {
  const op = event?.data?.op;
  if (op === 'stop') {
    void shutdown(0);
    return;
  }
  if (op === 'probe') {
    if (ready) post({ type: 'ready' });
    else probePending = true;
  }
});

async function initializeWineBridge(server) {
  if (process.platform !== 'linux') {
    post({ type: 'wine-bridge-status', available: false, state: 'unsupported', reason: 'not-linux' });
    return;
  }

  const address = server.ipc?.server?.address?.();
  wineBridge = createWineRpcBridgeManager({
    rpcSocketPath: typeof address === 'string' ? address : null,
    bridgeExe: wineBridgeExecutable(),
    onStatus: (status) => post({ type: 'wine-bridge-status', ...status }),
  });

  let status;
  try {
    status = await wineBridge.start();
  } catch (error) {
    status = { available: false, state: 'error', reason: 'startup-failed' };
    post({ type: 'wine-bridge-error', message: String(error?.message || error) });
  }

  if (stopping) {
    try { await wineBridge.stop(); } catch { /* shutdown already owns cleanup */ }
    return;
  }
  if (status?.available !== true) {
    post({
      type: 'wine-bridge-status',
      available: false,
      state: 'error',
      reason: status?.reason || 'startup-failed',
    });
  }
}

async function initializeWindowsMedia() {
  if (process.platform !== 'win32' || stopping) {
    post({ type: 'windows-media-status', available: false, state: 'unsupported', reason: 'not-windows' });
    return;
  }

  windowsMediaSource = createWindowsMediaSource({
    onActivity: ({ key, activity }) => {
      void forwardActivity({
        socketId: `windows-media:${String(key).slice(0, 100)}`,
        source: 'windows-media',
        activity,
      });
    },
    onStatus: (status) => post({ type: 'windows-media-status', ...status }),
    onError: (error) => {
      console.warn('[Telium rich presence worker] Windows media:', error?.message || error);
    },
  });

  try {
    windowsMediaSource.start();
  } catch (error) {
    console.warn('[Telium rich presence worker] Windows media startup:', error?.message || error);
    post({ type: 'windows-media-status', available: false, state: 'unavailable', reason: 'startup-failed' });
  }
}

async function initializeMpris() {
  if (process.platform !== 'linux' || stopping) {
    post({ type: 'mpris-status', available: false, state: 'unsupported', reason: 'not-linux' });
    return;
  }
  post({ type: 'mpris-status', available: false, state: 'starting', reason: null });
  mprisSource = createMprisSource({
    onActivity: ({ key, activity }) => {
      void forwardActivity({
        socketId: `mpris:${String(key).slice(0, 100)}`,
        source: 'mpris',
        activity,
      });
    },
    onStatus: (status) => post({ type: 'mpris-status', ...status }),
    // A missing session bus is normal in headless environments; MPRIS must never take anything else down.
    onError: (error) => {
      console.warn('[Telium rich presence worker] MPRIS:', error?.message || error);
    },
  });
  try {
    await mprisSource.start();
  } catch (error) {
    console.warn('[Telium rich presence worker] MPRIS startup:', error?.message || error);
    post({ type: 'mpris-status', available: false, state: 'unavailable', reason: 'startup-failed' });
  }
}

try {
  const server = await new RPCServer();
  let rpcConnections = 0;
  let rpcActivitySeen = false;
  const postRpcStatus = () => {
    const slot = rpcPipeSlot(server.ipc?.server?.address?.());
    post({
      type: 'rpc-status',
      available: true,
      state: rpcActivitySeen ? 'relaying' : (rpcConnections > 0 ? 'connected' : 'listening'),
      connections: rpcConnections,
      slot,
      earlierPipeOccupied: process.platform === 'win32' && slot !== null && slot > 0,
    });
  };

  if (process.platform === 'win32') {
    windowsRpcPromoter = createWindowsRpcPrimaryPromoter({
      server,
      createIpc: () => replacementIpcServer(server),
      onPromoted: ({ from, to }) => {
        console.log(`[Telium rich presence worker] reclaimed Discord RPC pipe ${from} -> ${to}`);
        postRpcStatus();
      },
      onError: (error) => {
        console.warn('[Telium rich presence worker] RPC primary-pipe retry:', error?.message || error);
      },
    });
    windowsRpcPromoter.start();
  }

  server.on('connection', () => {
    rpcConnections += 1;
    postRpcStatus();
  });
  server.on('close', () => {
    rpcConnections = Math.max(0, rpcConnections - 1);
    if (rpcConnections === 0) rpcActivitySeen = false;
    postRpcStatus();
  });
  server.on('message', ({ cmd }) => {
    if (cmd === 'SET_ACTIVITY') {
      rpcActivitySeen = true;
      postRpcStatus();
    }
  });
  server.on('activity', (data) => { void forwardActivity(data); });
  postRpcStatus();

  // Keep the core arRPC readiness contract unchanged; optional integrations must not hold it up.
  ready = true;
  post({ type: 'ready' });
  if (probePending) {
    probePending = false;
    post({ type: 'ready' });
  }

  void initializeWineBridge(server);
  void initializeMpris();
  void initializeWindowsMedia();
} catch (error) {
  void fatal(error);
}
