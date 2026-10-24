import { spawnSync } from 'node:child_process';
import { mkdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const electronRoot = join(here, '..');
const source = join(electronRoot, 'wine-rpc-bridge', 'bridge.c');
const outputDir = join(electronRoot, 'vendor', 'rpc-bridge');
const output = join(outputDir, 'bridge.exe');
const compiler = process.env.MINGW_CC || 'x86_64-w64-mingw32-gcc';
const required = process.env.TELIUM_REQUIRE_WINE_BRIDGE === '1';

function available(command) {
  const result = spawnSync(command, ['--version'], { stdio: 'ignore' });
  return !result.error && result.status === 0;
}

async function existingOutput() {
  try { return (await stat(output)).size > 0; } catch { return false; }
}

if (!available(compiler)) {
  if (required && !(await existingOutput())) {
    throw new Error(
      `Wine Rich Presence helper requires ${compiler}. `
      + 'Install the MinGW-w64 x86_64 compiler or set MINGW_CC to a compatible compiler.',
    );
  }
  console.warn(`[Telium desktop] ${compiler} not found; Wine Rich Presence helper was not rebuilt.`);
  process.exit(0);
}

await mkdir(outputDir, { recursive: true });
const result = spawnSync(compiler, [
  '-std=c17', '-O2', '-s', '-Wall', '-Wextra',
  source,
  '-lws2_32', '-ladvapi32',
  '-o', output,
], { stdio: 'inherit' });

if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`Wine RPC helper compiler exited with status ${result.status}`);
console.log(`Built Wine Rich Presence helper: ${output}`);
