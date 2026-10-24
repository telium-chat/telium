import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  bridgeEnvironment,
  bridgeLaunchSpec,
  createAuthenticatedRpcProxy,
  discoverWineSessions,
  isBridgeLaunchableSession,
  isSteamCompatProcess,
  isWineUserProcess,
  parseEnvironment,
} from '../../electron/wine-rpc-bridge.mjs';

const scratch = [];
afterEach(async () => {
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function until(condition, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function fakeProcess(procRoot, pid, { env, comm, cmdline }) {
  const root = join(procRoot, String(pid));
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'environ'), `${Object.entries(env).map(([key, value]) => `${key}=${value}`).join('\0')}\0`);
  await writeFile(join(root, 'comm'), `${comm}\n`);
  await writeFile(join(root, 'cmdline'), `${cmdline.join('\0')}\0`);
}

describe('Wine rich presence bridge', () => {
  it('parses procfs environments without losing values containing equals signs', () => {
    expect(parseEnvironment(Buffer.from('WINEPREFIX=/games/pfx\0TOKEN=a=b=c\0'))).toEqual({
      WINEPREFIX: '/games/pfx',
      TOKEN: 'a=b=c',
    });
  });

  it('distinguishes a Wine game from Wine infrastructure and Telium itself', () => {
    const base = { WINEPREFIX: '/games/pfx', STEAM_COMPAT_DATA_PATH: '/games/compat', SteamAppId: '322170' };
    expect(isSteamCompatProcess(base)).toBe(true);
    expect(isWineUserProcess({ env: base, comm: 'GeometryDash.exe' })).toBe(true);
    expect(isWineUserProcess({ env: base, comm: 'services.exe' })).toBe(false);
    expect(isWineUserProcess({ env: { ...base, TELIUM_WINE_RPC_BRIDGE: '1' }, comm: 'bridge.exe' })).toBe(false);
    expect(isWineUserProcess({ env: base, comm: 'telium-rpc-bridge.exe' })).toBe(false);
  });

  it('discovers one launchable client per active prefix and reuses its Wine loader', async () => {
    const root = await mkdtemp(join(tmpdir(), 'telium-wine-test-'));
    scratch.push(root);
    const loader = join(root, 'proton', 'wine');
    await mkdir(join(root, 'proton'), { recursive: true });
    await writeFile(loader, '#!/bin/sh\nexit 0\n');
    await chmod(loader, 0o755);

    const common = {
      WINEPREFIX: '/games/steam/compatdata/322170/pfx',
      WINELOADER: loader,
      STEAM_COMPAT_DATA_PATH: '/games/steam/compatdata/322170',
      SteamAppId: '322170',
      PATH: '/usr/bin',
    };
    await fakeProcess(root, 101, {
      env: common,
      comm: 'GeometryDash.exe',
      cmdline: ['Z:\\games\\GeometryDash.exe'],
    });
    await fakeProcess(root, 102, {
      env: common,
      comm: 'services.exe',
      cmdline: ['C:\\windows\\system32\\services.exe'],
    });
    await fakeProcess(root, 103, {
      env: { ...common, TELIUM_WINE_RPC_BRIDGE: '1' },
      comm: 'bridge.exe',
      cmdline: ['Z:\\telium\\bridge.exe'],
    });

    const sessions = await discoverWineSessions(root);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      prefix: common.WINEPREFIX,
      loader,
      pid: 101,
      early: false,
      serviceManagerReady: true,
    });
    expect(isBridgeLaunchableSession(sessions[0])).toBe(true);
  });

  it('uses the earliest Proton bootstrap to prepare RPC before Wine SCM is visible', async () => {
    const root = await mkdtemp(join(tmpdir(), 'telium-proton-bootstrap-test-'));
    scratch.push(root);
    const tool = join(root, 'Proton Experimental');
    const loader = join(tool, 'files', 'bin', 'wine');
    await mkdir(join(tool, 'files', 'bin'), { recursive: true });
    await writeFile(loader, '#!/bin/sh\nexit 0\n');
    await chmod(loader, 0o755);

    const compat = join(root, 'steamapps', 'compatdata', '2881650');
    const env = {
      STEAM_COMPAT_DATA_PATH: compat,
      STEAM_COMPAT_TOOL_PATHS: tool,
      SteamAppId: '2881650',
      PATH: '/usr/bin',
    };
    await fakeProcess(root, 201, {
      env,
      comm: 'wineserver',
      cmdline: [join(tool, 'files', 'bin', 'wineserver')],
    });

    const sessions = await discoverWineSessions(root);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      prefix: join(compat, 'pfx'),
      loader,
      pid: 201,
      early: true,
      serviceManagerReady: false,
    });
    expect(sessions[0].env.WINEPREFIX).toBe(join(compat, 'pfx'));
    expect(isBridgeLaunchableSession(sessions[0])).toBe(true);
  });

  it('keeps the same bootstrap launchable once Wine services.exe becomes visible', async () => {
    const root = await mkdtemp(join(tmpdir(), 'telium-proton-scm-test-'));
    scratch.push(root);
    const tool = join(root, 'Proton Experimental');
    const loader = join(tool, 'files', 'bin', 'wine');
    await mkdir(join(tool, 'files', 'bin'), { recursive: true });
    await writeFile(loader, '#!/bin/sh\nexit 0\n');
    await chmod(loader, 0o755);

    const compat = join(root, 'steamapps', 'compatdata', '2881650');
    const env = {
      WINEPREFIX: join(compat, 'pfx'),
      STEAM_COMPAT_DATA_PATH: compat,
      STEAM_COMPAT_TOOL_PATHS: tool,
      SteamAppId: '2881650',
      PATH: '/usr/bin',
    };
    await fakeProcess(root, 201, {
      env,
      comm: 'wineserver',
      cmdline: [join(tool, 'files', 'bin', 'wineserver')],
    });
    await fakeProcess(root, 202, {
      env,
      comm: 'services.exe',
      cmdline: ['C:\\windows\\system32\\services.exe'],
    });

    const sessions = await discoverWineSessions(root);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      prefix: env.WINEPREFIX,
      pid: 201,
      early: true,
      serviceManagerReady: true,
    });
    expect(isBridgeLaunchableSession(sessions[0])).toBe(true);
  });

  it('settles on the first bootstrap of a prefix, not the first one procfs lists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'telium-proton-order-test-'));
    scratch.push(root);
    const tool = join(root, 'Proton Experimental');
    const loader = join(tool, 'files', 'bin', 'wine');
    await mkdir(join(tool, 'files', 'bin'), { recursive: true });
    await writeFile(loader, '#!/bin/sh\nexit 0\n');
    await chmod(loader, 0o755);

    const compat = join(root, 'steamapps', 'compatdata', '2881650');
    const env = {
      WINEPREFIX: join(compat, 'pfx'),
      STEAM_COMPAT_DATA_PATH: compat,
      STEAM_COMPAT_TOOL_PATHS: tool,
      SteamAppId: '2881650',
      PATH: '/usr/bin',
    };
    for (const [pid, name] of [
      [808, 'winemenubuilder.exe'], [707, 'plugplay.exe'], [606, 'rpcss.exe'],
      [505, 'explorer.exe'], [404, 'services.exe'], [303, 'wineserver'],
    ]) {
      await fakeProcess(root, pid, {
        env,
        comm: name,
        cmdline: name.endsWith('.exe')
          ? [`C:\\windows\\system32\\${name}`]
          : [join(tool, 'files', 'bin', name)],
      });
    }

    const sessions = await discoverWineSessions(root);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ prefix: env.WINEPREFIX, pid: 303, early: true });
  });

  it('replaces a lower-pid Proton bootstrap candidate when the real game appears', async () => {
    const root = await mkdtemp(join(tmpdir(), 'telium-proton-game-test-'));
    scratch.push(root);
    const tool = join(root, 'Proton Experimental');
    const loader = join(tool, 'files', 'bin', 'wine');
    await mkdir(join(tool, 'files', 'bin'), { recursive: true });
    await writeFile(loader, '#!/bin/sh\nexit 0\n');
    await chmod(loader, 0o755);

    const compat = join(root, 'steamapps', 'compatdata', '2881650');
    const env = {
      WINEPREFIX: join(compat, 'pfx'),
      STEAM_COMPAT_DATA_PATH: compat,
      STEAM_COMPAT_TOOL_PATHS: tool,
      SteamAppId: '2881650',
      PATH: '/usr/bin',
    };
    await fakeProcess(root, 200, {
      env,
      comm: 'wineserver',
      cmdline: [join(tool, 'files', 'bin', 'wineserver')],
    });
    await fakeProcess(root, 240, {
      env,
      comm: 'Content Warning.exe',
      cmdline: ['Z:\\steamapps\\common\\Content Warning\\Content Warning.exe'],
    });

    const sessions = await discoverWineSessions(root);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      prefix: env.WINEPREFIX,
      loader,
      pid: 240,
      early: false,
    });
    expect(isBridgeLaunchableSession(sessions[0])).toBe(true);
  });

  it('preserves Proton identity when the real game process drops Steam metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'telium-proton-identity-test-'));
    scratch.push(root);
    const tool = join(root, 'Proton Experimental');
    const loader = join(tool, 'files', 'bin', 'wine');
    const compat = join(root, 'steamapps', 'compatdata', '2881650');
    const prefix = join(compat, 'pfx');
    await mkdir(join(tool, 'files', 'bin'), { recursive: true });
    await mkdir(prefix, { recursive: true });
    await writeFile(loader, '#!/bin/sh\nexit 0\n');
    await chmod(loader, 0o755);

    await fakeProcess(root, 200, {
      env: {
        WINEPREFIX: prefix,
        STEAM_COMPAT_DATA_PATH: compat,
        STEAM_COMPAT_TOOL_PATHS: tool,
        SteamAppId: '2881650',
        PATH: '/usr/bin',
      },
      comm: 'wineserver',
      cmdline: [join(tool, 'files', 'bin', 'wineserver')],
    });
    await fakeProcess(root, 240, {
      env: {
        WINEPREFIX: prefix,
        WINELOADER: loader,
        PATH: '/usr/bin',
      },
      comm: 'Content Warning.exe',
      cmdline: ['Z:\\steamapps\\common\\Content Warning\\Content Warning.exe'],
    });

    const sessions = await discoverWineSessions(root);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      prefix: await realpath(prefix),
      pid: 240,
      early: false,
      loader,
    });
    expect(isSteamCompatProcess(sessions[0].env)).toBe(true);
    expect(sessions[0].env.SteamAppId).toBe('2881650');
    expect(sessions[0].env.STEAM_COMPAT_DATA_PATH).toBe(compat);
  });

  it('starts only a short-lived Wine service starter and strips Steam launch tracking', () => {
    const session = {
      prefix: '/games/pfx',
      loader: '/proton/files/bin/wine',
      env: {
        WINEPREFIX: '/games/pfx',
        WINELOADER: '/proton/files/bin/wine',
        PATH: '/proton/files/bin:/usr/bin',
        LD_LIBRARY_PATH: '/proton/files/lib64',
        LD_PRELOAD: '/steam/gameoverlayrenderer.so',
        SteamAppId: '322170',
        SteamGameId: '322170',
        STEAM_COMPAT_APP_ID: '322170',
        STEAM_COMPAT_DATA_PATH: '/games/compatdata/322170',
        PRESSURE_VESSEL_RUNTIME: '/steam/runtime',
      },
    };
    const endpoint = { port: 43123, token: 'test-secret-token' };
    const serviceKey = '0123456789abcdef0123456789abcdef';
    const spec = bridgeLaunchSpec(session, '/opt/telium/bridge.exe', endpoint, serviceKey);
    expect(spec.command).toBe('/proton/files/bin/wine');
    expect(spec.args).toEqual([
      '/opt/telium/bridge.exe', '--start-service', '43123', 'test-secret-token', serviceKey,
    ]);
    expect(spec.options.env).toMatchObject({
      WINEPREFIX: '/games/pfx',
      WINELOADER: '/proton/files/bin/wine',
      PATH: '/proton/files/bin:/usr/bin',
      LD_LIBRARY_PATH: '/proton/files/lib64',
      TELIUM_WINE_RPC_BRIDGE: '1',
    });
    expect(spec.options.env.SteamAppId).toBeUndefined();
    expect(spec.options.env.SteamGameId).toBeUndefined();
    expect(spec.options.env.STEAM_COMPAT_APP_ID).toBeUndefined();
    expect(spec.options.env.STEAM_COMPAT_DATA_PATH).toBeUndefined();
    expect(spec.options.env.PRESSURE_VESSEL_RUNTIME).toBeUndefined();
    expect(spec.options.env.LD_PRELOAD).toBeUndefined();
    expect(spec.options.env.TELIUM_RPC_SOCKET).toBeUndefined();
    expect(spec.options.stdio).toEqual(['ignore', 'ignore', 'pipe']);

    const clean = bridgeEnvironment(session);
    expect(clean.WINEPREFIX).toBe('/games/pfx');
    expect(clean.TELIUM_WINE_RPC_BRIDGE).toBe('1');
  });

  it('authenticates service readiness separately from RPC relay traffic', async () => {
    const root = await mkdtemp(join(tmpdir(), 'telium-wine-ready-test-'));
    scratch.push(root);
    const socketPath = join(root, 'arrpc.sock');
    const readyKeys = [];
    const unixServer = createServer();
    await new Promise((resolve, reject) => {
      unixServer.once('error', reject);
      unixServer.listen(socketPath, resolve);
    });

    const proxy = await createAuthenticatedRpcProxy(socketPath, {
      onServiceReady: (key) => readyKeys.push(key),
    });
    const client = createConnection({ host: '127.0.0.1', port: proxy.endpoint.port });
    const serviceKey = '0123456789abcdef0123456789abcdef';
    try {
      await once(client, 'connect');
      client.write(`READY ${proxy.endpoint.token} ${serviceKey}\n`);
      const [ack] = await once(client, 'data');
      expect(ack.toString()).toBe('READY-OK\n');
      expect(readyKeys).toEqual([serviceKey]);
    } finally {
      client.destroy();
      proxy.close();
      await new Promise((resolve) => unixServer.close(resolve));
    }
  });

  it('authenticates the loopback transport before proxying bytes to the Unix RPC socket', async () => {
    const root = await mkdtemp(join(tmpdir(), 'telium-wine-proxy-test-'));
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

    const proxy = await createAuthenticatedRpcProxy(socketPath, {
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