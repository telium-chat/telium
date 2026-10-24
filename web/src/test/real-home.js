import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Api, HttpError } from '../lib/api.js';

export const BINARY = resolve(dirname(fileURLToPath(import.meta.url)), '../../../server/target/debug/telium-server');
export const haveServer = existsSync(BINARY);

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

const throwaway = () => `pw-${crypto.randomUUID()}`;

export class RealHome {
  static async start() {
    const port = await freePort();
    const dir = mkdtempSync(join(tmpdir(), 'telium-web-e2e-'));
    const config = join(dir, 'telium.toml');
    writeFileSync(config, [
      `server_name = "127.0.0.1:${port}"`,
      `public_base_url = "http://127.0.0.1:${port}"`,
      `bind = "127.0.0.1:${port}"`,
      `database_url = "sqlite://${dir}/telium.db?mode=rwc"`,
      `media_dir = "${dir}/media"`,
      '[backup]',
      'enabled = false',
      '[updates]',
      'check = false',
      '[rate_limit]',
      'enabled = false',
      '',
    ].join('\n'), { mode: 0o600 });
    const child = spawn(BINARY, ['--config', config], { cwd: dir, stdio: ['ignore', 'ignore', 'pipe'] });
    let log = '';
    child.stderr.on('data', (d) => { log = (log + d).slice(-8192); });
    const home = new RealHome(child, dir, `http://127.0.0.1:${port}`);
    const deadline = Date.now() + 60_000;
    for (;;) {
      if (child.exitCode !== null) throw new Error(`the server exited at startup:\n${log}`);
      try {
        await fetch(`${home.base}/_telium/v1/whoami`);
        break;
      } catch {
        if (Date.now() > deadline) throw new Error(`the server never answered:\n${log}`);
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    return home;
  }

  constructor(child, dir, base) {
    this.child = child;
    this.dir = dir;
    this.base = base;
    this.domain = new URL(base).host;
    this.passwords = new Map();
  }

  async stop() {
    if (this.child.exitCode === null) {
      const gone = new Promise((r) => this.child.once('exit', r));
      this.child.kill('SIGKILL');
      await gone;
    }
    rmSync(this.dir, { recursive: true, force: true });
  }

  api(session) {
    return new Api({ base: this.base, token: session.access_token, domain: this.domain });
  }

  async register(localpart) {
    const password = throwaway();
    const session = await Api.register(this.base, localpart, password, 'test');
    this.passwords.set(session.user_id, password);
    return this.wrap(session);
  }

  async login(userId) {
    const session = await Api.login(this.base, userId, this.passwords.get(userId), 'test');
    return this.wrap(session);
  }

  wrap(session) {
    return { userId: session.user_id, deviceId: session.device_id, session, api: this.api(session) };
  }
}

export function lossy(api) {
  const armed = [];
  const out = Object.create(api);
  const wrap = (name) => async (...args) => {
    const answer = await api[name](...args);
    const i = armed.findIndex((pick) => pick(name, args));
    if (i >= 0) {
      armed.splice(i, 1);
      throw new HttpError(503, { message: 'the answer was lost' });
    }
    return answer;
  };
  for (const name of ['sendFrame', 'putVault', 'setVaultMode', 'publishKeyPackages']) out[name] = wrap(name);
  out.lose = (pick) => armed.push(pick);
  return out;
}
