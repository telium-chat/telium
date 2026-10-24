// Wine/Proton Discord-RPC orchestration: Steam prefixes run the bridge as a Wine auto-start service inside the game's wineserver (Pressure Vessel isolates /tmp); never host-launch Wine into an active prefix.

import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { dirname, join } from 'node:path';
import {
  bridgeEnvironment,
  bridgeLaunchSpec,
  discoverWineSessions,
  isBridgeLaunchableSession,
} from './wine-rpc-bridge.mjs';

const DEFAULT_SCAN_MS = 250;
const RETRY_MS = 10_000;
const MISSING_GRACE_SCANS = 6;
const IDLE_INSTALL_DELAY_MS = 2_000;
const SERVICE_READY_TIMEOUT_MS = 15_000;
const AUTH_LIMIT = 256;
const AUTH_TIMEOUT_MS = 5_000;
// Bump this whenever the on-disk service protocol/binary needs a forced refresh.
const AUTO_SERVICE_VERSION = 'telium-wine-rpc-auto-v2';
const AUTO_MARKER_NAME = 'telium-rpc-auto-service.version';
const AUTO_CONFIG_NAME = 'telium-rpc-endpoint.txt';

function steamAppId(env = {}) {
  const value = env.STEAM_COMPAT_APP_ID || env.SteamAppId || env.SteamGameId || env.STEAM_APP_ID;
  return value && value !== '0' ? String(value) : null;
}

export function isSteamSession(session) {
  return Boolean(session?.env?.STEAM_COMPAT_DATA_PATH && steamAppId(session.env));
}

export function steamAutoServicePaths(session) {
  if (!session?.prefix) throw new Error('Wine session has no prefix');
  const directory = join(session.prefix, 'drive_c', 'windows', 'temp');
  return {
    directory,
    marker: join(directory, AUTO_MARKER_NAME),
    config: join(directory, AUTO_CONFIG_NAME),
  };
}

async function atomicWrite(path, content) {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const temporary = `${path}.${process.pid}.${randomBytes(5).toString('hex')}.tmp`;
  try {
    await writeFile(temporary, content, { mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

export async function isSteamAutoServiceInstalled(session) {
  try {
    const value = await readFile(steamAutoServicePaths(session).marker, 'utf8');
    return value.trim() === AUTO_SERVICE_VERSION;
  } catch {
    return false;
  }
}

export async function markSteamAutoServiceInstalled(session) {
  const { marker } = steamAutoServicePaths(session);
  await atomicWrite(marker, `${AUTO_SERVICE_VERSION}\n`);
}

export async function writeSteamAutoServiceEndpoint(session, endpoint, serviceKey) {
  if (!endpoint?.port || !endpoint?.token) throw new Error('Wine RPC endpoint is unavailable');
  if (!/^[a-f0-9]{16,128}$/i.test(serviceKey || '')) throw new Error('Wine RPC service key is invalid');
  const { config } = steamAutoServicePaths(session);
  await atomicWrite(config, `${endpoint.port}\n${endpoint.token}\n${serviceKey}\n`);
  return config;
}

export async function clearSteamAutoServiceEndpoint(session) {
  const { config } = steamAutoServicePaths(session);
  await rm(config, { force: true }).catch(() => {});
}

export function autoServiceInstallSpec(session, bridgeExe) {
  if (!session?.loader) throw new Error('Wine session has no loader');
  return {
    command: session.loader,
    args: [bridgeExe, '--install-auto-service'],
    options: {
      env: bridgeEnvironment(session),
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    },
    launchMode: 'steam-auto-install',
  };
}

function safeTokenEquals(presented, expected) {
  const left = Buffer.from(String(presented || ''), 'utf8');
  const right = Buffer.from(String(expected || ''), 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

function validServiceKey(value) {
  return /^[a-f0-9]{16,128}$/i.test(value || '');
}

// PROBE is separate from READY so the UI does not claim the pipe exists before CreateNamedPipe succeeded.
export async function createManagedRpcProxy(
  rpcSocketPath,
  { onRelayChange, onServiceReady, isServiceKeyActive } = {},
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

    const controlAllowed = (presented, serviceKey) => {
      if (!safeTokenEquals(presented, token) || !validServiceKey(serviceKey)) return false;
      try { return isServiceKeyActive ? Boolean(isServiceKeyActive(serviceKey)) : true; }
      catch { return false; }
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

      if (line.startsWith('PROBE ') || line.startsWith('READY ')) {
        const parts = line.split(' ');
        const verb = parts[0];
        const presented = parts[1] || '';
        const serviceKey = parts[2] || '';
        if (parts.length !== 3 || !controlAllowed(presented, serviceKey)) {
          closePair();
          return;
        }
        authenticated = true;
        client.setTimeout(0);
        client.removeListener('data', onAuthData);
        if (verb === 'READY') {
          try { onServiceReady?.(serviceKey); } catch { /* diagnostics only */ }
          client.end('READY-OK\n');
        } else {
          client.end('PROBE-OK\n');
        }
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
    ['TELIUM_RPC:error:service-path', 'service-path-failed'],
    ['TELIUM_RPC:error:service-manager', 'service-manager-failed'],
    ['TELIUM_RPC:error:service-stop', 'service-stop-failed'],
    ['TELIUM_RPC:error:service-copy', 'service-copy-failed'],
    ['TELIUM_RPC:error:service-install', 'service-register-failed'],
    ['TELIUM_RPC:error:service-config', 'service-config-failed'],
    ['TELIUM_RPC:error:service-start', 'service-start-failed'],
  ];
  return mappings.find(([prefix]) => line.startsWith(prefix))?.[1] || null;
}

export function createWineRpcBridgeManager({
  rpcSocketPath,
  bridgeExe,
  procRoot = '/proc',
  scanMs = DEFAULT_SCAN_MS,
  logger = console,
  onStatus,
} = {}) {
  let stopped = true;
  let timer = null;
  let scanning = false;
  let sessionCount = 0;
  let relayCount = 0;
  let lastReason = null;
  let lastPublished = '';
  let rpcProxy = null;
  let rpcEndpoint = null;
  const records = new Map();
  const retryAfter = new Map();

  const log = (message) => logger.info?.(`[Telium Wine RPC] ${message}`);
  const warn = (message) => logger.warn?.(`[Telium Wine RPC] ${message}`);

  const activeServiceKeys = () => new Set(
    [...records.values()].map((record) => record.serviceKey).filter(Boolean),
  );

  const aggregateState = () => {
    if (relayCount > 0) return 'relaying';
    const phases = [...records.values()].map((record) => record.phase);
    if (phases.includes('bridge-ready')) return 'bridge-ready';
    if (phases.includes('steam-installing')) return 'steam-installing';
    if (phases.includes('steam-install-pending')) return 'steam-install-pending';
    if (phases.includes('steam-restart-required')) return 'steam-restart-required';
    if (phases.includes('bridge-starting') || phases.includes('direct-starting')) return 'bridge-starting';
    if (sessionCount) return 'wine-detected';
    return 'watching';
  };

  const publishStatus = (extra = {}) => {
    const modes = [...new Set([...records.values()].map((record) => record.launchMode).filter(Boolean))];
    const status = {
      available: true,
      state: aggregateState(),
      sessions: sessionCount,
      activeBridges: [...records.values()].filter((record) => (
        record.phase === 'bridge-starting'
        || record.phase === 'bridge-ready'
        || record.phase === 'direct-starting'
      )).length,
      relays: relayCount,
      launchMode: modes.length === 1 ? modes[0] : modes.length ? 'mixed' : null,
      // A live relay beats any earlier readiness timeout; never show a stale repair warning.
      reason: relayCount > 0 ? null : lastReason,
      ...extra,
    };
    const encoded = JSON.stringify(status);
    if (encoded === lastPublished) return;
    lastPublished = encoded;
    try { onStatus?.(status); } catch { /* diagnostics only */ }
  };

  const clearReadyTimer = (record) => {
    if (record?.readyTimer) clearTimeout(record.readyTimer);
    if (record) record.readyTimer = null;
  };

  const stopChild = (record) => {
    const child = record?.child;
    record.child = null;
    if (!child) return;
    try { child.kill('SIGTERM'); } catch { /* already exited */ }
    const killTimer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already exited */ }
    }, 1_000);
    killTimer.unref?.();
  };

  const startReadyTimer = (record, prefix, steam) => {
    clearReadyTimer(record);
    record.readyTimer = setTimeout(() => {
      if (records.get(prefix) !== record || record.phase === 'bridge-ready' || record.relayObserved) return;
      lastReason = steam ? 'steam-auto-service-not-ready' : 'service-ready-timeout';
      if (steam) record.reinstallOnIdle = true;
      warn(steam
        ? 'Wine auto-start service did not prove named-pipe readiness; will repair it when the game closes'
        : 'Wine RPC service did not prove named-pipe readiness in time');
      publishStatus();
    }, SERVICE_READY_TIMEOUT_MS);
    record.readyTimer.unref?.();
  };

  const markServiceReady = (serviceKey) => {
    for (const record of records.values()) {
      if (record.serviceKey !== serviceKey) continue;
      record.phase = 'bridge-ready';
      record.reinstallOnIdle = false;
      clearReadyTimer(record);
      lastReason = null;
      publishStatus();
      return;
    }
  };

  const markActiveRelay = () => {
    // No per-service ids, so use present records; a working RPC connection proves one is healthy. Never repair a prefix actively delivering RPC.
    for (const record of records.values()) {
      if (!record.present) continue;
      record.relayObserved = true;
      record.reinstallOnIdle = false;
      clearReadyTimer(record);
      if (record.phase === 'bridge-starting' || record.phase === 'direct-starting') {
        record.phase = 'bridge-ready';
      }
    }
    lastReason = null;
  };

  const attachDiagnostics = (child, record) => {
    child.stderr?.setEncoding?.('utf8');
    child.stderr?.on('data', (chunk) => {
      record.stderrBuffer += String(chunk);
      const lines = record.stderrBuffer.split(/\r?\n/);
      record.stderrBuffer = lines.pop() || '';
      for (const raw of lines) {
        const line = raw.trim();
        if (!line.startsWith('TELIUM_RPC:')) continue;
        const reason = diagnosticReason(line);
        if (reason) {
          lastReason = reason;
          warn(`Wine helper reported ${reason}`);
          publishStatus();
        }
      }
    });
  };

  const armSteamService = async (record, phase) => {
    if (!rpcEndpoint) return false;
    if (!record.serviceKey) record.serviceKey = randomBytes(16).toString('hex');
    try {
      await writeSteamAutoServiceEndpoint(record.session, rpcEndpoint, record.serviceKey);
    } catch (error) {
      lastReason = 'config-write-failed';
      warn(`could not write Wine RPC endpoint config: ${error?.message || error}`);
      publishStatus();
      return false;
    }
    record.phase = phase;
    record.launchMode = 'steam-auto-service';
    lastReason = null;
    return true;
  };

  const activateSteamService = async (record) => {
    if (!record.present) return;
    record.relayObserved = false;
    const armed = await armSteamService(record, 'bridge-starting');
    if (!armed) return;
    record.reinstallOnIdle = false;
    startReadyTimer(record, record.session.prefix, true);
    log(`armed auto-start Wine RPC service for active Steam prefix ${record.session.prefix}`);
    publishStatus();
  };

  const installSteamService = async (record) => {
    if (stopped || record.present || record.child || record.finalizing || !record.session) return;
    const prefix = record.session.prefix;
    if ((retryAfter.get(prefix) || 0) > Date.now()) return;

    await clearSteamAutoServiceEndpoint(record.session);
    record.serviceKey = null;
    const spec = autoServiceInstallSpec(record.session, bridgeExe);
    let child;
    try {
      child = spawn(spec.command, spec.args, spec.options);
    } catch (error) {
      retryAfter.set(prefix, Date.now() + RETRY_MS);
      lastReason = 'auto-install-failed';
      warn(`could not start idle Wine auto-service installer: ${error?.message || error}`);
      publishStatus();
      return;
    }

    record.child = child;
    record.phase = 'steam-installing';
    record.launchMode = 'steam-auto-install';
    record.stderrBuffer = '';
    record.relayObserved = false;
    lastReason = null;
    attachDiagnostics(child, record);
    log(`installing Wine RPC auto-start service in idle Steam prefix ${prefix}`);
    publishStatus();

    child.once('error', (error) => {
      if (records.get(prefix) !== record || record.child !== child) return;
      record.child = null;
      record.phase = 'steam-install-pending';
      retryAfter.set(prefix, Date.now() + RETRY_MS);
      lastReason = 'auto-install-failed';
      warn(`Wine auto-service installer failed: ${error?.message || error}`);
      publishStatus();
    });

    child.once('exit', async (code) => {
      if (records.get(prefix) !== record || record.child !== child) return;
      record.child = null;
      if (code !== 0) {
        record.phase = 'steam-install-pending';
        retryAfter.set(prefix, Date.now() + RETRY_MS);
        lastReason ||= 'auto-install-failed';
        warn(`Wine auto-service installer exited with ${code ?? 'signal'}`);
        publishStatus();
        return;
      }
      record.finalizing = true;
      try {
        await markSteamAutoServiceInstalled(record.session);
        record.installed = true;
        record.reinstallOnIdle = false;
        record.relayObserved = false;
        // Pre-arm before telling the user to restart so the next services.exe authenticates immediately.
        const armed = await armSteamService(record, 'steam-restart-required');
        if (!armed) throw new Error('could not pre-arm installed Wine RPC service');
      } catch (error) {
        record.phase = 'steam-install-pending';
        retryAfter.set(prefix, Date.now() + RETRY_MS);
        lastReason ||= 'auto-install-marker-failed';
        warn(`could not finalize Wine auto-service installation: ${error?.message || error}`);
        publishStatus();
        return;
      } finally {
        record.finalizing = false;
      }
      record.launchMode = 'steam-auto-service';
      log(`Wine RPC auto-start service installed and pre-armed in ${prefix}; restart the game once`);
      publishStatus();
    });
  };

  const observeSteam = async (session) => {
    const prefix = session.prefix;
    let record = records.get(prefix);
    if (!record || record.kind !== 'steam') {
      if (record) {
        clearReadyTimer(record);
        stopChild(record);
      }
      record = {
        kind: 'steam',
        session,
        present: true,
        missingScans: 0,
        absentSince: null,
        phase: 'steam-checking',
        installed: null,
        reinstallOnIdle: false,
        relayObserved: false,
        child: null,
        serviceKey: null,
        readyTimer: null,
        launchMode: 'steam-auto-service',
        stderrBuffer: '',
      };
      records.set(prefix, record);
    }

    record.session = session;
    record.present = true;
    record.missingScans = 0;
    record.absentSince = null;

    if (record.phase === 'steam-installing' && record.child) {
      // Never let the host-side idle installer overlap a relaunched Proton game.
      stopChild(record);
      record.phase = 'steam-install-pending';
      record.installed = false;
      lastReason = null;
      publishStatus();
      return;
    }

    if (record.installed === null) {
      record.installed = await isSteamAutoServiceInstalled(session);
      record.phase = record.installed ? 'steam-armed' : 'steam-install-pending';
    }

    if (!record.installed || record.reinstallOnIdle) {
      record.phase = 'steam-install-pending';
      publishStatus();
      return;
    }

    // After a Telium restart the version marker can exist without an in-memory serviceKey; arm first.
    if (!record.serviceKey) {
      await activateSteamService(record);
      return;
    }

    if (record.phase === 'steam-armed' || record.phase === 'steam-restart-required') {
      record.relayObserved = false;
      record.phase = 'bridge-starting';
      record.launchMode = 'steam-auto-service';
      startReadyTimer(record, prefix, true);
      publishStatus();
    }
  };

  const observeDirectWine = (session) => {
    const prefix = session.prefix;
    let record = records.get(prefix);
    if (record?.kind === 'direct') {
      record.present = true;
      record.missingScans = 0;
      return;
    }
    if (record) {
      clearReadyTimer(record);
      stopChild(record);
    }
    if (!rpcEndpoint || (retryAfter.get(prefix) || 0) > Date.now()) return;

    const serviceKey = randomBytes(16).toString('hex');
    const spec = bridgeLaunchSpec(session, bridgeExe, rpcEndpoint, serviceKey);
    let child;
    try {
      child = spawn(spec.command, spec.args, spec.options);
    } catch (error) {
      retryAfter.set(prefix, Date.now() + RETRY_MS);
      lastReason = 'spawn-failed';
      warn(`could not start Wine service starter: ${error?.message || error}`);
      publishStatus();
      return;
    }

    record = {
      kind: 'direct',
      session,
      present: true,
      missingScans: 0,
      phase: 'direct-starting',
      child,
      serviceKey,
      relayObserved: false,
      readyTimer: null,
      launchMode: 'direct-wine',
      stderrBuffer: '',
    };
    records.set(prefix, record);
    attachDiagnostics(child, record);
    startReadyTimer(record, prefix, false);
    log(`starting demand-service RPC bridge for Wine prefix ${prefix}`);
    publishStatus();

    child.once('error', (error) => {
      if (records.get(prefix) !== record) return;
      clearReadyTimer(record);
      records.delete(prefix);
      retryAfter.set(prefix, Date.now() + RETRY_MS);
      lastReason = 'spawn-failed';
      warn(`Wine service starter failed: ${error?.message || error}`);
      publishStatus();
    });

    child.once('exit', (code) => {
      if (records.get(prefix) !== record) return;
      record.child = null;
      if (code === 0) return;
      clearReadyTimer(record);
      records.delete(prefix);
      if (!stopped) {
        retryAfter.set(prefix, Date.now() + RETRY_MS);
        lastReason ||= 'service-start-failed';
      }
      publishStatus();
    });
  };

  const handleMissingRecords = async (seenPrefixes) => {
    const now = Date.now();
    for (const [prefix, record] of [...records]) {
      if (seenPrefixes.has(prefix)) continue;
      record.present = false;
      record.missingScans += 1;
      if (record.missingScans < MISSING_GRACE_SCANS) continue;

      if (record.kind === 'direct') {
        clearReadyTimer(record);
        stopChild(record);
        records.delete(prefix);
        continue;
      }

      if (!record.absentSince) record.absentSince = now;
      clearReadyTimer(record);
      // The installer has exited but its marker and endpoint are still being written.
      if (record.finalizing) continue;

      const needsInstall = !record.installed || record.reinstallOnIdle;
      if (needsInstall) {
        await clearSteamAutoServiceEndpoint(record.session);
        record.serviceKey = null;
        record.phase = record.child ? 'steam-installing' : 'steam-install-pending';
        if (!record.child && now - record.absentSince >= IDLE_INSTALL_DELAY_MS) {
          await installSteamService(record);
        }
        continue;
      }

      // Keep installed prefixes pre-armed to avoid the process-discovery race.
      if (!record.serviceKey) {
        const armed = await armSteamService(record, 'steam-armed');
        if (!armed) continue;
      }
      if (record.phase !== 'steam-restart-required') record.phase = 'steam-armed';
    }
  };

  const scan = async () => {
    if (stopped || scanning) return;
    scanning = true;
    try {
      const sessions = await discoverWineSessions(procRoot);
      if (stopped) return;
      sessionCount = sessions.length;
      const seenPrefixes = new Set();

      for (const session of sessions) {
        if (!isBridgeLaunchableSession(session)) continue;
        seenPrefixes.add(session.prefix);
        if (isSteamSession(session)) await observeSteam(session);
        else observeDirectWine(session);
      }

      await handleMissingRecords(seenPrefixes);
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
      if (!bridgeExe) return { available: false, reason: 'bridge-missing' };
      try { await access(bridgeExe, fsConstants.R_OK); } catch {
        return { available: false, reason: 'bridge-missing' };
      }

      try {
        rpcProxy = await createManagedRpcProxy(rpcSocketPath, {
          onRelayChange(delta) {
            relayCount = Math.max(0, relayCount + delta);
            if (delta > 0) markActiveRelay();
            publishStatus();
          },
          onServiceReady: markServiceReady,
          isServiceKeyActive(key) {
            return activeServiceKeys().has(key);
          },
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
      for (const record of records.values()) {
        clearReadyTimer(record);
        stopChild(record);
        if (record.kind === 'steam') await clearSteamAutoServiceEndpoint(record.session);
      }
      records.clear();
      retryAfter.clear();
      sessionCount = 0;
      relayCount = 0;
      rpcEndpoint = null;
      rpcProxy?.close();
      rpcProxy = null;
      publishStatus({
        available: false,
        state: 'stopped',
        sessions: 0,
        activeBridges: 0,
        relays: 0,
        launchMode: null,
        reason: null,
      });
    },
  });
}