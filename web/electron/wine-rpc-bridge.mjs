// Wine/Proton Discord-RPC bridging (after EnderIce2/rpc-bridge, MIT): a Wine demand service relays to an authenticated 127.0.0.1 endpoint owned by this process, never a persistent host-launched Wine process.

import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, readFile, readdir, readlink, realpath } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BRIDGE_MARKER = 'TELIUM_WINE_RPC_BRIDGE';
const DEFAULT_SCAN_MS = 250;
const RETRY_MS = 10_000;
const MISSING_GRACE_SCANS = 6;
const AUTH_LIMIT = 256;
const AUTH_TIMEOUT_MS = 5_000;
const SERVICE_READY_TIMEOUT_MS = 10_000;

const INFRASTRUCTURE_NAMES = new Set([
  'wineserver', 'wineserver64', 'wine', 'wine64', 'wine-preloader', 'wine64-preloader',
  'services.exe', 'winedevice.exe', 'explorer.exe', 'rpcss.exe', 'plugplay.exe',
  'svchost.exe', 'conhost.exe', 'wineboot.exe', 'winemenubuilder.exe', 'start.exe',
  'bridge.exe', 'telium-rpc-bridge.exe', 'proton', 'pressure-vessel-wrap', 'pv-bwrap',
  'reaper', 'steam-launch-wrapper',
]);

function processName(raw) {
  if (!raw) return '';
  const value = String(raw).replaceAll('\\', '/');
  return value.slice(value.lastIndexOf('/') + 1).trim().toLowerCase();
}

export function parseEnvironment(buffer) {
  const out = {};
  for (const entry of Buffer.from(buffer || '').toString().split('\0')) {
    if (!entry) continue;
    const split = entry.indexOf('=');
    if (split <= 0) continue;
    out[entry.slice(0, split)] = entry.slice(split + 1);
  }
  return out;
}

function steamAppId(env = {}) {
  return env.STEAM_COMPAT_APP_ID || env.SteamAppId || env.SteamGameId || env.STEAM_APP_ID || null;
}

export function isSteamCompatProcess(env = {}) {
  const appId = steamAppId(env);
  return Boolean(env.STEAM_COMPAT_DATA_PATH && appId && appId !== '0');
}

function prefixForEnvironment(env = {}) {
  if (env.WINEPREFIX) return env.WINEPREFIX;
  if (isSteamCompatProcess(env)) return join(env.STEAM_COMPAT_DATA_PATH, 'pfx');
  return null;
}

export function isWineUserProcess({ env = {}, comm = '', cmdline = [] } = {}) {
  if (!prefixForEnvironment(env) || env[BRIDGE_MARKER] === '1') return false;

  const names = [comm, ...cmdline.slice(0, 2)].map(processName).filter(Boolean);
  const windowsNames = names.filter((name) => name.endsWith('.exe'));
  if (windowsNames.some((name) => !INFRASTRUCTURE_NAMES.has(name))) return true;

  if (isSteamCompatProcess(env)) {
    return names.some((name) => !INFRASTRUCTURE_NAMES.has(name));
  }
  return false;
}

export function isBridgeLaunchableSession(session) {
  // A Steam session may be the earliest Proton bootstrap, launchable once the host starter exits.
  return Boolean(session);
}

async function executable(path) {
  if (!path) return false;
  try {
    await access(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function onPath(name, pathValue) {
  if (!name || name.includes('/') || name.includes('\\')) return null;
  for (const dir of String(pathValue || '').split(':').filter(Boolean)) {
    const candidate = join(dir, name);
    if (await executable(candidate)) return candidate;
  }
  return null;
}

function protonToolPaths(env = {}) {
  const raw = env.STEAM_COMPAT_TOOL_PATHS || env.STEAM_COMPAT_TOOL_PATH || '';
  return String(raw).split(':').filter(Boolean);
}

export async function resolveWineLoader(env = {}, procExe = null) {
  const candidates = [env.WINELOADER, env.WINE];
  if (env.WINESERVER) {
    candidates.push(join(dirname(env.WINESERVER), 'wine'));
    candidates.push(join(dirname(env.WINESERVER), 'wine64'));
  }
  for (const tool of protonToolPaths(env)) {
    candidates.push(join(tool, 'files', 'bin', 'wine'));
    candidates.push(join(tool, 'files', 'bin', 'wine64'));
    candidates.push(join(tool, 'dist', 'bin', 'wine'));
    candidates.push(join(tool, 'dist', 'bin', 'wine64'));
  }
  if (procExe) {
    candidates.push(join(dirname(procExe), 'wine'));
    candidates.push(join(dirname(procExe), 'wine64'));
  }
  candidates.push('/usr/bin/wine', '/usr/bin/wine64');

  for (const raw of candidates.filter(Boolean)) {
    if (isAbsolute(raw)) {
      if (await executable(raw)) return raw;
      continue;
    }
    const resolved = await onPath(raw, env.PATH);
    if (resolved) return resolved;
  }
  return null;
}

async function safeRead(path, fallback = null) {
  try { return await readFile(path); } catch { return fallback; }
}

async function safeReadlink(path) {
  try { return await readlink(path); } catch { return null; }
}

async function canonicalPrefix(path) {
  try { return await realpath(path); } catch { return path; }
}

/// Proton bootstraps are kept so the service is ready before the game's SDK init; a real game replaces one but inherits its Steam metadata.
export async function discoverWineSessions(procRoot = '/proc') {
  if (process.platform !== 'linux' && procRoot === '/proc') return [];

  let entries;
  try { entries = await readdir(procRoot, { withFileTypes: true }); } catch { return []; }
  const sessions = new Map();
  const serviceManagerPrefixes = new Set();

  // Ascending pid: readdir order is arbitrary, and the lowest pid started first.
  const pids = entries
    .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
    .map((entry) => Number(entry.name))
    .sort((a, b) => a - b);

  for (const pid of pids) {
    const root = join(procRoot, String(pid));
    const rawEnv = await safeRead(join(root, 'environ'));
    if (!rawEnv) continue;
    if (!rawEnv.includes(Buffer.from('WINEPREFIX='))
      && !rawEnv.includes(Buffer.from('STEAM_COMPAT_DATA_PATH='))) continue;

    const env = parseEnvironment(rawEnv);
    const rawPrefix = prefixForEnvironment(env);
    if (!rawPrefix || env[BRIDGE_MARKER] === '1') continue;
    const prefix = await canonicalPrefix(rawPrefix);

    const rawComm = await safeRead(join(root, 'comm'), Buffer.alloc(0));
    const rawCmd = await safeRead(join(root, 'cmdline'), Buffer.alloc(0));
    const comm = rawComm.toString().trim();
    const cmdline = rawCmd.toString().split('\0').filter(Boolean);
    const names = [comm, ...cmdline.slice(0, 2)].map(processName).filter(Boolean);
    if (names.includes('services.exe')) serviceManagerPrefixes.add(prefix);

    const userProcess = isWineUserProcess({ env, comm, cmdline });
    const steamBootstrap = isSteamCompatProcess(env);
    if (!userProcess && !steamBootstrap) continue;

    const early = !userProcess;
    const existing = sessions.get(prefix);

    // The game may not retain the bootstrap's Steam variables; preserve them so the prefix is not reclassified as plain Wine.
    if (existing && steamBootstrap && !isSteamCompatProcess(existing.env)) {
      existing.env = { ...env, ...existing.env, WINEPREFIX: prefix };
    }
    if (existing && (!existing.early || early)) continue;

    const inheritedSteamEnv = existing && isSteamCompatProcess(existing.env) && !steamBootstrap
      ? existing.env
      : null;
    const selectedEnv = { ...(inheritedSteamEnv || {}), ...env, WINEPREFIX: prefix };
    const procExe = await safeReadlink(join(root, 'exe'));
    const loader = await resolveWineLoader(selectedEnv, procExe) || existing?.loader;
    if (!loader) continue;
    sessions.set(prefix, {
      prefix,
      loader,
      env: selectedEnv,
      pid,
      early,
    });
  }

  return [...sessions.values()].map((session) => ({
    ...session,
    serviceManagerReady: serviceManagerPrefixes.has(session.prefix),
  }));
}

export function defaultBridgeExecutable() {
  if (process.env.TELIUM_WINE_RPC_BRIDGE_EXE) return process.env.TELIUM_WINE_RPC_BRIDGE_EXE;
  if (process.resourcesPath) return join(process.resourcesPath, 'wine-rpc', 'bridge.exe');
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, 'vendor', 'rpc-bridge', 'bridge.exe');
}

function isSteamTrackingKey(key) {
  return /^steam/i.test(key)
    || /^pressure_vessel/i.test(key)
    || /^pv_/i.test(key)
    || key === 'LD_PRELOAD';
}

export function bridgeEnvironment(session) {
  const env = {};
  for (const [key, value] of Object.entries(session.env || {})) {
    if (isSteamTrackingKey(key)) continue;
    env[key] = value;
  }
  env.WINEPREFIX = session.prefix || session.env?.WINEPREFIX;
  env[BRIDGE_MARKER] = '1';
  return env;
}

export function bridgeLaunchSpec(session, bridgeExe, endpoint, serviceKey) {
  return {
    command: session.loader,
    args: [bridgeExe, '--start-service', String(endpoint.port), endpoint.token, serviceKey],
    options: {
      env: bridgeEnvironment(session),
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    },
  };
}

function safeTokenEquals(presented, expected) {
  const left = Buffer.from(presented, 'utf8');
  const right = Buffer.from(expected, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function createAuthenticatedRpcProxy(
  rpcSocketPath,
  { onRelayChange, onServiceReady } = {},
) {
  const token = randomBytes(32).toString('hex');
  const sockets = new Set();

  const server = createServer((client) => {
    sockets.add(client);
    client.setNoDelay(true);
    client.setTimeout(AUTH_TIMEOUT_MS, () => client.destroy());
    let pending = Buffer.alloc(0);
    let authenticated = false;
    let upstream = null;
    let relayActive = false;

    const closePair = () => {
      if (relayActive) {
        relayActive = false;
        try { onRelayChange?.(-1); } catch { /* diagnostics only */ }
      }
      sockets.delete(client);
      if (upstream) sockets.delete(upstream);
      try { client.destroy(); } catch { /* already closed */ }
      try { upstream?.destroy(); } catch { /* already closed */ }
    };

    const onAuthData = (chunk) => {
      if (authenticated) return;
      pending = Buffer.concat([pending, chunk]);
      if (pending.length > AUTH_LIMIT) {
        closePair();
        return;
      }
      const newline = pending.indexOf(0x0a);
      if (newline < 0) return;
      const line = pending.subarray(0, newline).toString('utf8').trim();

      if (line.startsWith('READY ')) {
        const parts = line.split(' ');
        const presented = parts[1] || '';
        const serviceKey = parts[2] || '';
        if (parts.length !== 3 || !safeTokenEquals(presented, token)
          || !/^[a-f0-9]{16,128}$/i.test(serviceKey)) {
          closePair();
          return;
        }
        authenticated = true;
        client.setTimeout(0);
        client.removeListener('data', onAuthData);
        try { onServiceReady?.(serviceKey); } catch { /* diagnostics only */ }
        client.end('READY-OK\n');
        return;
      }

      if (!safeTokenEquals(line, token)) {
        closePair();
        return;
      }

      authenticated = true;
      client.setTimeout(0);
      client.removeListener('data', onAuthData);
      const remainder = pending.subarray(newline + 1);
      pending = Buffer.alloc(0);

      upstream = createConnection(rpcSocketPath);
      sockets.add(upstream);
      upstream.once('connect', () => {
        relayActive = true;
        try { onRelayChange?.(1); } catch { /* diagnostics only */ }
        client.write('OK\n');
        if (remainder.length) upstream.write(remainder);
        client.pipe(upstream);
        upstream.pipe(client);
      });
      upstream.on('error', closePair);
      upstream.on('close', closePair);
    };

    client.on('data', onAuthData);
    client.on('error', closePair);
    client.on('close', closePair);
  });

  const endpoint = await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      const address = server.address();
      if (!address || typeof address === 'string') {
        try { server.close(); } catch { /* best effort */ }
        reject(new Error('Wine RPC loopback proxy did not get a TCP address.'));
        return;
      }
      resolve({ port: address.port, token });
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, '127.0.0.1');
  });
  server.unref?.();

  return {
    endpoint,
    close() {
      for (const socket of sockets) {
        try { socket.destroy(); } catch { /* best effort */ }
      }
      sockets.clear();
      try { server.close(); } catch { /* already closed */ }
    },
  };
}

function diagnosticReason(line) {
  const mappings = [
    ['TELIUM_RPC:error:auth-missing', 'proxy-auth-missing'],
    ['TELIUM_RPC:error:service-path', 'service-install-failed'],
    ['TELIUM_RPC:error:service-manager', 'service-install-failed'],
    ['TELIUM_RPC:error:service-stop', 'service-start-failed'],
    ['TELIUM_RPC:error:service-copy', 'service-install-failed'],
    ['TELIUM_RPC:error:service-install', 'service-install-failed'],
    ['TELIUM_RPC:error:service-config', 'service-install-failed'],
    ['TELIUM_RPC:error:service-start', 'service-start-failed'],
  ];
  return mappings.find(([prefix]) => line.startsWith(prefix))?.[1] || null;
}

export function createWineRpcBridgeManager({
  rpcSocketPath,
  bridgeExe = defaultBridgeExecutable(),
  procRoot = '/proc',
  scanMs = DEFAULT_SCAN_MS,
  logger = console,
  onStatus,
} = {}) {
  let stopped = true;
  let timer = null;
  let scanning = false;
  let warnedUnavailable = false;
  let sessionCount = 0;
  let launchableCount = 0;
  let relayCount = 0;
  let lastReason = null;
  let lastPublished = '';
  let rpcProxy = null;
  let rpcEndpoint = null;
  const active = new Map();
  const retryAfter = new Map();

  const log = (message) => logger.info?.(`[Telium Wine RPC] ${message}`);
  const warn = (message) => logger.warn?.(`[Telium Wine RPC] ${message}`);

  const aggregateState = () => {
    if (relayCount > 0) return 'relaying';
    const states = [...active.values()].map((record) => record.state);
    if (states.includes('bridge-ready')) return 'bridge-ready';
    if (active.size) return 'bridge-starting';
    if (sessionCount && !launchableCount) return 'proton-starting';
    if (sessionCount) return 'wine-detected';
    return 'watching';
  };

  const publishStatus = (extra = {}) => {
    const status = {
      available: true,
      state: aggregateState(),
      sessions: sessionCount,
      launchableSessions: launchableCount,
      activeBridges: active.size,
      relays: relayCount,
      reason: lastReason,
      ...extra,
    };
    const encoded = JSON.stringify(status);
    if (encoded === lastPublished) return;
    lastPublished = encoded;
    try { onStatus?.(status); } catch { /* diagnostics must never break RPC */ }
  };

  const stopRecord = (prefix, record) => {
    active.delete(prefix);
    if (record?.readyTimer) clearTimeout(record.readyTimer);
    const child = record?.child;
    if (!child) return;
    try { child.kill('SIGTERM'); } catch { /* already exited */ }
    const killTimer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already exited */ }
    }, 1_000);
    killTimer.unref?.();
  };

  const handleDiagnostic = (record, line) => {
    if (line === 'TELIUM_RPC:service-started') record.starterComplete = true;
    const reason = diagnosticReason(line);
    if (reason) {
      lastReason = reason;
      warn(`service starter reported ${reason}`);
    }
    publishStatus();
  };

  const markServiceReady = (serviceKey) => {
    for (const record of active.values()) {
      if (record.serviceKey !== serviceKey) continue;
      record.serviceReady = true;
      record.state = 'bridge-ready';
      if (record.readyTimer) clearTimeout(record.readyTimer);
      record.readyTimer = null;
      lastReason = null;
      publishStatus();
      return;
    }
  };

  const launch = (session) => {
    if (!isBridgeLaunchableSession(session) || !rpcEndpoint || active.has(session.prefix)) return;
    if ((retryAfter.get(session.prefix) || 0) > Date.now()) return;

    const serviceKey = randomBytes(16).toString('hex');
    const spec = bridgeLaunchSpec(session, bridgeExe, rpcEndpoint, serviceKey);
    let child;
    try {
      child = spawn(spec.command, spec.args, spec.options);
    } catch (error) {
      retryAfter.set(session.prefix, Date.now() + RETRY_MS);
      lastReason = 'spawn-failed';
      warn(`could not start Wine service starter: ${error?.message || error}`);
      publishStatus();
      return;
    }

    const record = {
      child,
      serviceKey,
      serviceReady: false,
      readyTimer: null,
      missingScans: 0,
      startedAt: Date.now(),
      state: 'bridge-starting',
      starterComplete: false,
      stderrBuffer: '',
    };
    active.set(session.prefix, record);
    lastReason = null;
    log(`starting demand-service bridge for ${session.early ? 'Proton bootstrap prefix' : 'active Wine game prefix'} ${session.prefix}`);
    publishStatus();

    record.readyTimer = setTimeout(() => {
      if (active.get(session.prefix) !== record || record.serviceReady) return;
      lastReason = 'service-ready-timeout';
      warn('Wine RPC service did not prove named-pipe readiness in time');
      publishStatus();
    }, SERVICE_READY_TIMEOUT_MS);
    record.readyTimer.unref?.();

    child.stderr?.setEncoding?.('utf8');
    child.stderr?.on('data', (chunk) => {
      record.stderrBuffer += String(chunk);
      const lines = record.stderrBuffer.split(/\r?\n/);
      record.stderrBuffer = lines.pop() || '';
      for (const line of lines) {
        if (line.startsWith('TELIUM_RPC:')) handleDiagnostic(record, line.trim());
      }
    });

    child.once('error', (error) => {
      if (active.get(session.prefix) !== record) return;
      if (record.readyTimer) clearTimeout(record.readyTimer);
      active.delete(session.prefix);
      retryAfter.set(session.prefix, Date.now() + RETRY_MS);
      lastReason = 'spawn-failed';
      warn(`Wine service starter failed: ${error?.message || error}`);
      publishStatus();
    });

    child.once('exit', (code) => {
      if (record.stderrBuffer.startsWith('TELIUM_RPC:')) {
        handleDiagnostic(record, record.stderrBuffer.trim());
      }
      if (active.get(session.prefix) !== record) return;

      record.child = null;
      if (code === 0) {
        record.starterComplete = true;
        publishStatus();
        return;
      }

      if (record.readyTimer) clearTimeout(record.readyTimer);
      active.delete(session.prefix);
      if (!stopped) {
        retryAfter.set(session.prefix, Date.now() + RETRY_MS);
        lastReason ||= 'service-start-failed';
        warn(`Wine service starter exited with ${code ?? 'signal'}; retrying later`);
      }
      publishStatus();
    });
  };

  const scan = async () => {
    if (stopped || scanning) return;
    scanning = true;
    try {
      const sessions = await discoverWineSessions(procRoot);
      if (stopped) return;
      sessionCount = sessions.length;
      const launchable = sessions.filter(isBridgeLaunchableSession);
      launchableCount = launchable.length;
      const launchablePrefixes = new Set(launchable.map((session) => session.prefix));

      for (const session of launchable) {
        const record = active.get(session.prefix);
        if (record) record.missingScans = 0;
        else launch(session);
      }

      for (const [prefix, record] of [...active]) {
        if (launchablePrefixes.has(prefix)) continue;
        record.missingScans += 1;
        if (record.missingScans >= MISSING_GRACE_SCANS) stopRecord(prefix, record);
      }
      publishStatus();
    } catch (error) {
      lastReason = 'scan-failed';
      warn(`Wine session scan failed: ${error?.message || error}`);
      publishStatus();
    } finally {
      scanning = false;
    }
  };

  return Object.freeze({
    async start() {
      if (process.platform !== 'linux') return { available: false, reason: 'not-linux' };
      if (!rpcSocketPath || typeof rpcSocketPath !== 'string') {
        return { available: false, reason: 'rpc-socket-unavailable' };
      }
      try {
        await access(bridgeExe, fsConstants.R_OK);
      } catch {
        if (!warnedUnavailable) {
          warnedUnavailable = true;
          warn(`rpc-bridge helper is missing at ${bridgeExe}`);
        }
        return { available: false, reason: 'bridge-missing' };
      }

      try {
        rpcProxy = await createAuthenticatedRpcProxy(rpcSocketPath, {
          onRelayChange(delta) {
            relayCount = Math.max(0, relayCount + delta);
            publishStatus();
          },
          onServiceReady: markServiceReady,
        });
        rpcEndpoint = rpcProxy.endpoint;
      } catch (error) {
        warn(`could not start local Wine RPC proxy: ${error?.message || error}`);
        return { available: false, reason: 'proxy-start-failed' };
      }

      stopped = false;
      publishStatus({ state: 'watching', reason: null });
      void scan();
      timer = setInterval(scan, scanMs);
      timer.unref?.();
      return { available: true };
    },

    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
      for (const [prefix, record] of [...active]) stopRecord(prefix, record);
      retryAfter.clear();
      sessionCount = 0;
      launchableCount = 0;
      relayCount = 0;
      rpcEndpoint = null;
      rpcProxy?.close();
      rpcProxy = null;
      publishStatus({
        available: false,
        state: 'stopped',
        sessions: 0,
        launchableSessions: 0,
        activeBridges: 0,
        relays: 0,
        reason: null,
      });
    },
  });
}