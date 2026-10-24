import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

const APPIMAGETOOL_URL =
  'https://github.com/AppImage/appimagetool/releases/download/1.9.1/appimagetool-x86_64.AppImage';
const APPIMAGETOOL_SHA256 = 'ed4ce84f0d9caff66f50bcca6ff6f35aae54ce8135408b3fa33abfc3cb384eb0';
const WAYLAND_LIBRARY = /^libwayland-.*\.so(?:\..*)?$/;

function run(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: 'inherit',
    });
    child.on('error', rejectPromise);
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolvePromise();
      } else {
        rejectPromise(new Error(`${basename(command)} failed (${signal ?? `exit ${code}`})`));
      }
    });
  });
}

async function findBundledWaylandLibraries(root) {
  const matches = [];
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else if ((entry.isFile() || entry.isSymbolicLink()) && WAYLAND_LIBRARY.test(entry.name)) {
        matches.push(path);
      }
    }
  };
  await walk(root);
  return matches;
}

async function downloadVerifiedAppImageTool(destination) {
  const response = await fetch(APPIMAGETOOL_URL);
  if (!response.ok) {
    throw new Error(`Could not download appimagetool: HTTP ${response.status}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== APPIMAGETOOL_SHA256) {
    throw new Error(`appimagetool checksum mismatch: ${digest}`);
  }
  await writeFile(destination, bytes, { mode: 0o755 });
}

async function extract(appImage, directory) {
  await mkdir(directory, { recursive: true });
  await run(appImage, ['--appimage-extract'], { cwd: directory });
  return join(directory, 'squashfs-root');
}

async function main() {
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    throw new Error('AppImage repacking is supported only on Linux x86_64.');
  }

  const bundleDirectory = resolve('src-tauri/target/release/bundle/appimage');
  const appImages = (await readdir(bundleDirectory))
    .filter((name) => name.endsWith('.AppImage'))
    .map((name) => join(bundleDirectory, name));
  if (appImages.length !== 1) {
    throw new Error(`Expected exactly one AppImage in ${bundleDirectory}, found ${appImages.length}.`);
  }

  const appImage = appImages[0];
  const workDirectory = await mkdtemp(join(tmpdir(), 'telium-appimage-'));
  const repacked = `${appImage}.repacked.AppImage`;
  try {
    const appDir = await extract(appImage, join(workDirectory, 'before'));
    const bundledWayland = await findBundledWaylandLibraries(appDir);
    if (bundledWayland.length === 0) {
      console.log('AppImage does not bundle libwayland; no compatibility repack is needed.');
      return;
    }

    console.log('Removing host-coupled Wayland libraries from AppImage:');
    for (const library of bundledWayland) {
      console.log(`  ${library.slice(appDir.length + 1)}`);
      await unlink(library);
    }

    const appImageTool = join(workDirectory, 'appimagetool-x86_64.AppImage');
    await downloadVerifiedAppImageTool(appImageTool);
    await chmod(appImageTool, 0o755);
    await rm(repacked, { force: true });
    await run(appImageTool, [appDir, repacked], {
      env: {
        APPIMAGE_EXTRACT_AND_RUN: '1',
        ARCH: 'x86_64',
      },
    });
    await chmod(repacked, 0o755);

    const verifyRoot = await extract(repacked, join(workDirectory, 'after'));
    const remainingWayland = await findBundledWaylandLibraries(verifyRoot);
    if (remainingWayland.length !== 0) {
      throw new Error(`Repacked AppImage still bundles ${remainingWayland.length} Wayland libraries.`);
    }

    await rename(repacked, appImage);
    console.log(`Repacked ${basename(appImage)} without bundled libwayland libraries.`);
  } finally {
    await rm(repacked, { force: true });
    await rm(workDirectory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
