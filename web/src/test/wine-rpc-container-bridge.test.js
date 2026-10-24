import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  autoServiceInstallSpec,
  clearSteamAutoServiceEndpoint,
  createManagedRpcProxy,
  createWineRpcBridgeManager,
  isSteamAutoServiceInstalled,
  isSteamSession,
  markSteamAutoServiceInstalled,
  steamAutoServicePaths,
  writeSteamAutoServiceEndpoint,
} from '../../electron/wine-rpc-container-bridge.mjs';

const scratch = [];
afterEach(async () => {
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function contentWarningSession(prefix = '/games/steam/compatdata/2881650/pfx') {
  return {
    prefix,
    pid: 240,
    loader: '/steam/Proton/files/bin/wine',
    env: {
      WINEPREFIX: prefix,
      WINELOADER: '/steam/Proton/files/bin/wine',
      PATH: '/steam/Proton/files/bin:/usr/bin',
      LD_LIBRARY_PATH: '/steam/Proton/files/lib64',
      LD_PRELOAD: '/steam/gameoverlayrenderer.so',
      STEAM_COMPAT_DATA_PATH: prefix.replace(/\/pfx$/, ''),
      STEAM_COMPAT_APP_ID: '2881650',
      SteamAppId: '2881650',
      SteamGameId: '2881650',
      PRESSURE_VESSEL_RUNTIME: '/steam/runtime',
    },
  };
}

async function waitFor(check, timeoutMs = 5_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('timed out waiting for Wine RPC test state');
}

async function until(condition, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('Steam Proton auto-start rich presence bridge', () => {
  it('classifies Content Warning as Steam Proton but leaves plain Wine alone', () => {
    expect(isSteamSession(contentWarningSession())).toBe(true);
    expect(isSteamSession({
      prefix: '/games/wine/pfx',
      env: { WINEPREFIX: '/games/wine/pfx' },
    })).toBe(false);
  });

  it('installs the service only through an idle Wine prefix with Steam tracking stripped', () => {
    const session = contentWarningSession();
    const spec = autoServiceInstallSpec(session, '/opt/telium/bridge.exe');

    expect(spec.command).toBe('/steam/Proton/files/bin/wine');
    expect(spec.args).toEqual(['/opt/telium/bridge.exe', '--install-auto-service']);
    expect(spec.launchMode).toBe('steam-auto-install');
    expect(spec.options.env).toMatchObject({
      WINEPREFIX: session.prefix,
      WINELOADER: session.loader,
      PATH: '/steam/Proton/files/bin:/usr/bin',
      LD_LIBRARY_PATH: '/steam/Proton/files/lib64',
      TELIUM_WINE_RPC_BRIDGE: '1',
    });
    expect(spec.options.env.STEAM_COMPAT_APP_ID).toBeUndefined();
    expect(spec.options.env.STEAM_COMPAT_DATA_PATH).toBeUndefined();
    expect(spec.options.env.SteamAppId).toBeUndefined();
    expect(spec.options.env.SteamGameId).toBeUndefined();
    expect(spec.options.env.PRESSURE_VESSEL_RUNTIME).toBeUndefined();
    expect(spec.options.env.LD_PRELOAD).toBeUndefined();
  });

  it('stores a version marker and fresh authenticated endpoint inside the prefix', async () => {
    const root = await mkdtemp(join(tmpdir(), 'telium-auto-service-test-'));
    scratch.push(root);
    const prefix = join(root, 'compatdata', '2881650', 'pfx');
    const session = contentWarningSession(prefix);
    await mkdir(prefix, { recursive: true });

    expect(await isSteamAutoServiceInstalled(session)).toBe(false);
    await markSteamAutoServiceInstalled(session);
    expect(await isSteamAutoServiceInstalled(session)).toBe(true);

    const serviceKey = '0123456789abcdef0123456789abcdef';
    const configPath = await writeSteamAutoServiceEndpoint(
      session,
      { port: 43123, token: 'test-secret-token' },
      serviceKey,
    );
    const paths = steamAutoServicePaths(session);
    expect(configPath).toBe(paths.config);
    expect(await readFile(paths.config, 'utf8')).toBe(
      `43123\ntest-secret-token\n${serviceKey}\n`,
    );

    await clearSteamAutoServiceEndpoint(session);
    await expect(readFile(paths.config, 'utf8')).rejects.toThrow();
  });

  it('never host-launches Wine while Steam is active, then installs and pre-arms after exit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'telium-idle-install-test-'));
    scratch.push(root);
    const procRoot = join(root, 'proc');
    const pidRoot = join(procRoot, '240');
    const prefix = join(root, 'steamapps', 'compatdata', '2881650', 'pfx');
    const loader = join(root, 'fake-wine');
    const bridgeExe = join(root, 'bridge.exe');
    const launchLog = join(root, 'launch.log');
    await mkdir(pidRoot, { recursive: true });
    await mkdir(prefix, { recursive: true });
    await writeFile(bridgeExe, 'fake bridge');
    await writeFile(
      loader,
      `#!/bin/sh\nprintf '%s\\n' "$*" >> "${launchLog}"\nexit 0\n`,
    );
    await chmod(loader, 0o755);

    const env = [
      `WINEPREFIX=${prefix}`,
      `WINELOADER=${loader}`,
      `STEAM_COMPAT_DATA_PATH=${join(root, 'steamapps', 'compatdata', '2881650')}`,
      'STEAM_COMPAT_APP_ID=2881650',
      'SteamAppId=2881650',
      `PATH=${root}:/usr/bin`,
      '',
    ].join('\0');
    await writeFile(join(pidRoot, 'environ'), env);
    await writeFile(join(pidRoot, 'comm'), 'wineserver\n');
    await writeFile(join(pidRoot, 'cmdline'), 'wineserver\0');

    const statuses = [];
    const manager = createWineRpcBridgeManager({
      rpcSocketPath: join(root, 'unused-arrpc.sock'),
      bridgeExe,
      procRoot,
      scanMs: 20,
      onStatus: (status) => statuses.push(status),
      logger: { info() {}, warn() {} },
    });

    await manager.start();
    try {
      await waitFor(() => statuses.some((status) => status.state === 'steam-install-pending'));
      await new Promise((resolve) => setTimeout(resolve, 150));
      await expect(readFile(launchLog, 'utf8')).rejects.toThrow();

      await rm(pidRoot, { recursive: true, force: true });
      await waitFor(() => statuses.some((status) => status.state === 'steam-restart-required'));

      const launch = await readFile(launchLog, 'utf8');
      expect(launch.trim()).toBe(`${bridgeExe} --install-auto-service`);
      expect(await isSteamAutoServiceInstalled(contentWarningSession(prefix))).toBe(true);

      const endpointConfig = await readFile(steamAutoServicePaths(contentWarningSession(prefix)).config, 'utf8');
      const lines = endpointConfig.trim().split('\n');
      expect(lines).toHaveLength(3);
      expect(Number(lines[0])).toBeGreaterThan(0);
      expect(lines[1]).toMatch(/^[a-f0-9]{64}$/);
      expect(lines[2]).toMatch(/^[a-f0-9]{32}$/);
    } finally {
      await manager.stop();
    }
  }, 10_000);

  it('authenticates PROBE without claiming pipe readiness, then authenticates READY', async () => {
    const serviceKey = '0123456789abcdef0123456789abcdef';
    const readyKeys = [];
    const proxy = await createManagedRpcProxy('/tmp/not-used-by-control-messages.sock', {
      isServiceKeyActive: (key) => key === serviceKey,
      onServiceReady: (key) => readyKeys.push(key),
    });

    try {
      const probe = createConnection({ host: '127.0.0.1', port: proxy.endpoint.port });
      await once(probe, 'connect');
      probe.write(`PROBE ${proxy.endpoint.token} ${serviceKey}\n`);
      const [probeAck] = await once(probe, 'data');
      expect(probeAck.toString()).toBe('PROBE-OK\n');
      expect(readyKeys).toEqual([]);
      probe.destroy();

      const ready = createConnection({ host: '127.0.0.1', port: proxy.endpoint.port });
      await once(ready, 'connect');
      ready.write(`READY ${proxy.endpoint.token} ${serviceKey}\n`);
      const [readyAck] = await once(ready, 'data');
      expect(readyAck.toString()).toBe('READY-OK\n');
      expect(readyKeys).toEqual([serviceKey]);
      ready.destroy();
    } finally {
      proxy.close();
    }
  });

  it('relays authenticated game RPC bytes to the exact Unix arRPC socket', async () => {
    const root = await mkdtemp(join(tmpdir(), 'telium-auto-proxy-test-'));
    scratch.push(root);
    const socketPath = join(root, 'arrpc.sock');
    const relayChanges = [];
    const unixServer = createServer((socket) => {
      socket.once('data', (data) => {
        expect(data.toString()).toBe('ping');
        socket.write('pong');
      });
    });
    await new Promise((resolve, reject) => {
      unixServer.once('error', reject);
      unixServer.listen(socketPath, resolve);
    });

    const proxy = await createManagedRpcProxy(socketPath, {
      onRelayChange: (delta) => relayChanges.push(delta),
    });
    const client = createConnection({ host: '127.0.0.1', port: proxy.endpoint.port });
    try {
      await once(client, 'connect');
      client.write(`${proxy.endpoint.token}\n`);
      const [ack] = await once(client, 'data');
      expect(ack.toString()).toBe('OK\n');
      expect(relayChanges).toEqual([1]);

      client.write('ping');
      const [pong] = await once(client, 'data');
      expect(pong.toString()).toBe('pong');
    } finally {
      client.destroy();
      await until(() => relayChanges.includes(-1));
      proxy.close();
      await new Promise((resolve) => unixServer.close(resolve));
    }
    expect(relayChanges).toContain(-1);
  });
});