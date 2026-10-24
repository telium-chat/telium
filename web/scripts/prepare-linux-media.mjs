import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const resourceDir = path.resolve(scriptDir, '../src-tauri/resources/gstreamer-1.0');
const stagedResourceDir = path.resolve(scriptDir, '../src-tauri/target/release/gstreamer-1.0');
const appImageDir = path.resolve(scriptDir, '../src-tauri/target/release/bundle/appimage/Telium.AppDir');
const appImageDebDir = path.resolve(scriptDir, '../src-tauri/target/release/bundle/appimage_deb');
const candidates = [
  process.env.GST_PLUGIN_SYSTEM_PATH,
  '/usr/lib/gstreamer-1.0',
  '/usr/lib64/gstreamer-1.0',
  '/usr/lib/x86_64-linux-gnu/gstreamer-1.0',
].filter(Boolean);
const sourceDir = candidates.find((candidate) => existsSync(candidate));

if (!sourceDir) {
  throw new Error(`Could not find a GStreamer plugin directory. Checked: ${candidates.join(', ')}`);
}

rmSync(resourceDir, { recursive: true, force: true });
rmSync(stagedResourceDir, { recursive: true, force: true });
// Tauri reuses an existing AppDir during incremental builds. Remove it here
// so a plugin excluded above cannot survive from an older bundle.
rmSync(appImageDir, { recursive: true, force: true });
rmSync(appImageDebDir, { recursive: true, force: true });
mkdirSync(resourceDir, { recursive: true });
let copied = 0;
for (const name of readdirSync(sourceDir)) {
  const source = path.join(sourceDir, name);
  // libgstpython loads Python while the scanner probes plugins. That is not
  // needed for browser playback and breaks inside the AppImage because the
  // bundled AppImage Python paths do not contain the full standard library.
  if (name === 'libgstpython.so') continue;
  if (!statSync(source).isFile() || (!name.endsWith('.so') && name !== 'gst-plugin-scanner')) continue;
  cpSync(source, path.join(resourceDir, name));
  copied += 1;
}

if (!copied) throw new Error(`GStreamer plugin directory is empty: ${sourceDir}`);
console.log(`Prepared ${copied} GStreamer plugins from ${sourceDir}`);
