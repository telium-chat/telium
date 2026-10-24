import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// One version number for the desktop app, taken from the same file the
// renderer takes it from.
//
// `electron/package.json` is what electron-builder stamps into the AppImage,
// what `app.getVersion()` returns, and what any desktop update mechanism
// compares to decide whether there is anything to install. `web/package.json`
// is what the client shows in its own footer. They were two hand-maintained
// copies of one fact, which is a bug with a delay fuse: the day they disagree
// is the day an app that has been updated goes on telling its user it has not,
// or the reverse.
//
// Copied here rather than symlinked or imported, because electron-builder
// reads the file from disk and a JSON file is what it needs to find. Written
// only when it actually differs, so a clean tree stays clean.
const webVersion = JSON.parse(readFileSync(path.resolve('package.json'), 'utf8')).version;
const shellPath = path.resolve('electron/package.json');
const shell = JSON.parse(readFileSync(shellPath, 'utf8'));
if (shell.version !== webVersion) {
  shell.version = webVersion;
  writeFileSync(shellPath, `${JSON.stringify(shell, null, 2)}\n`);
  console.log(`Set the desktop shell version to ${webVersion}.`);
}

// Who publishes this build, written where the main process can find it.
//
// The renderer gets `VITE_TELIUM_UPDATE_URL` and `VITE_TELIUM_UPDATE_PUBLIC_KEY`
// the ordinary Vite way: they are read at build time and substituted into the
// bundle, so a packaged client carries its publisher's identity as data rather
// than fetching it from anywhere. The main process cannot use that route --
// `desktop-main.cjs` is copied into the asar verbatim and runs months later on
// somebody else's machine, where `process.env` holds whatever their shell holds
// and certainly not a build variable from a CI runner.
//
// So the same two values are frozen into a file here, at the same moment and
// from the same source, and packed into the asar alongside the code. The
// alternatives were considered and lost:
//
//   * electron-builder's `extraMetadata` would put them in the packaged
//     `package.json`. It works, but it hides two security-critical values
//     inside a file that is mostly build configuration, where the next person
//     to edit the build config has no reason to look and every reason to
//     reformat.
//   * Reading them from `process.env` at runtime, the way `TELIUM_APP_VERSION`
//     is passed to the preload, is not merely useless here but dangerous: an
//     environment variable is settable by whoever launches the app, so a
//     desktop entry or a shell alias could repoint the update publisher of an
//     already-installed client. A pinned key that anything outside the bundle
//     can change is not pinned.
//   * Letting the renderer tell the main process, which is the shape most
//     Electron updaters end up in, is the hole `electron/updater.cjs` opens
//     with a long comment about. The renderer is the process that loads remote
//     content; it does not get to name the publisher.
//
// The file is written unconditionally, including when the variables are absent.
// A build with no publisher produces `{"url":"","publicKey":""}` and the client
// says so in its settings footer, which is the loud version of the state; a
// missing file would be the quiet version, indistinguishable at runtime from a
// packaging mistake.
const publisher = {
  url: process.env.VITE_TELIUM_UPDATE_URL || '',
  publicKey: process.env.VITE_TELIUM_UPDATE_PUBLIC_KEY || '',
};
writeFileSync(
  path.resolve('electron/publisher.json'),
  `${JSON.stringify(publisher, null, 2)}\n`,
);
console.log(
  publisher.url && publisher.publicKey
    ? `Desktop updates will check ${publisher.url}.`
    : 'No update publisher configured; this desktop build will not check for updates.',
);

const bun = process.platform === 'win32' ? 'bun.exe' : 'bun';
const result = spawnSync(bun, ['run', 'build'], {
  cwd: process.cwd(),
  env: { ...process.env, TELIUM_ELECTRON: '1' },
  stdio: 'inherit',
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

// React inserts the Telium mark after routing has already initialised. In a
// packaged file:// renderer, history changes can therefore make an otherwise
// valid relative `./brand/...` URL resolve against the wrong filesystem path.
// The mark is only ~1 KiB, so make it route-independent in the desktop build by
// inlining the canonical public SVG into the generated JS. The normal web build
// continues to use /brand/telium-mark-gradient.svg and remains cacheable.
const markSvg = readFileSync(path.resolve('public/brand/telium-mark-gradient.svg'));
const markDataUrl = `data:image/svg+xml;base64,${markSvg.toString('base64')}`;
const dist = path.resolve('dist');
let markReferences = 0;
for (const name of readdirSync(path.join(dist, 'assets'))) {
  if (!name.endsWith('.js') && !name.endsWith('.css')) continue;
  const file = path.join(dist, 'assets', name);
  const source = readFileSync(file, 'utf8');
  let fixed = source;
  for (const reference of [
    '/brand/telium-mark-gradient.svg',
    './brand/telium-mark-gradient.svg',
  ]) {
    const occurrences = fixed.split(reference).length - 1;
    if (!occurrences) continue;
    markReferences += occurrences;
    fixed = fixed.replaceAll(reference, markDataUrl);
  }
  if (fixed !== source) writeFileSync(file, fixed);
}
if (!markReferences) {
  throw new Error('Electron build did not find the Telium mark reference to inline.');
}
console.log(`Inlined ${markReferences} Telium mark reference(s) for file:// rendering.`);

const renderer = path.resolve('electron/renderer');
const build = path.resolve('electron/build');
rmSync(renderer, { recursive: true, force: true });
mkdirSync(renderer, { recursive: true });
mkdirSync(build, { recursive: true });
cpSync(dist, renderer, { recursive: true });
writeFileSync(
  path.join(renderer, 'smoke.html'),
  '<!doctype html><html><head><meta charset="utf-8"><title>Telium desktop smoke</title></head><body></body></html>\n',
);

const iconBase64 = readFileSync(path.resolve('electron/assets/icon.png.base64'), 'utf8')
  .replace(/\s+/g, '');
writeFileSync(path.join(build, 'icon.png'), Buffer.from(iconBase64, 'base64'));

console.log('Staged the Telium web client for Electron.');
