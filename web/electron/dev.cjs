'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');

const electronDir = __dirname;
const webDir = path.resolve(electronDir, '..');
const bun = process.platform === 'win32' ? 'bun.exe' : 'bun';
const electron = path.join(
  electronDir,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'electron.cmd' : 'electron',
);
const url = 'http://127.0.0.1:5173';

let stopping = false;
const vite = spawn(bun, ['run', 'dev', '--', '--host', '127.0.0.1'], {
  cwd: webDir,
  env: process.env,
  stdio: 'inherit',
});

function stop(child) {
  if (!child || child.killed) return;
  try { child.kill('SIGTERM'); } catch { /* already gone */ }
}

async function waitForVite() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (vite.exitCode !== null) throw new Error(`Vite exited with code ${vite.exitCode}.`);
    try {
      const response = await fetch(url, { cache: 'no-store' });
      if (response.ok) return;
    } catch { /* still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error('Timed out waiting for the Telium dev server.');
}

(async () => {
  try {
    await waitForVite();
    const desktop = spawn(electron, ['.'], {
      cwd: electronDir,
      env: { ...process.env, TELIUM_DEV_SERVER_URL: url },
      stdio: 'inherit',
    });
    desktop.on('exit', (code) => {
      if (stopping) return;
      stopping = true;
      stop(vite);
      process.exitCode = code ?? 0;
    });
    for (const signal of ['SIGINT', 'SIGTERM']) {
      process.on(signal, () => {
        if (stopping) return;
        stopping = true;
        stop(desktop);
        stop(vite);
      });
    }
  } catch (error) {
    stopping = true;
    stop(vite);
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
})();
