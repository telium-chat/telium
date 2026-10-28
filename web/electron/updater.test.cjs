'use strict';

// The signed update service's platform half, with real Ed25519 signatures; the statement format is in `sign-client-manifest.test.mjs`.

const assert = require('node:assert/strict');
const { createHash, generateKeyPairSync, sign: edSign } = require('node:crypto');
const { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { Readable } = require('node:stream');
const test = require('node:test');

const {
  Fault,
  Phase,
  artifactKeyFor,
  createUpdateService,
  downloadArtifact,
  stageAppImage,
  stageInstaller,
  statementFor,
} = require('./updater.cjs');

/// Key pair plus a signed fetch stub; `artifactKey` must be the key the service asks for.
function signedPublisher({ artifactKey, document: base }) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  // Raw key is the last 32 bytes of SPKI, seed the last 32 of PKCS#8; both url-safe base64.
  const publicKeyB64 = publicKey.export({ type: 'spki', format: 'der' })
    .subarray(-32).toString('base64url');

  const payload = Buffer.from('the bytes of a verified artifact');
  const manifestUrl = 'https://publisher.example/client-releases.json';
  const document = {
    kind: 'telium.client_releases',
    version: 1,
    channel: 'stable',
    generated_at: 1,
    releases: [{
      version: '9.9.9',
      released_at: 1,
      security: false,
      artifacts: {
        [artifactKey]: {
          url: 'https://downloads.example/verified-artifact',
          sha256: createHash('sha256').update(payload).digest('hex'),
          size: payload.length,
        },
      },
    }],
    ...base,
  };
  const bytes = Buffer.from(JSON.stringify(document, null, 2), 'utf8');
  const statement = statementFor(bytes);
  const signature = edSign(null, Buffer.from(statement, 'utf8'), privateKey)
    .toString('base64url');

  const fetchImpl = async (url) => {
    if (url === manifestUrl) {
      return { ok: true, arrayBuffer: async () => bytes, text: async () => '' };
    }
    if (url === `${manifestUrl}.sig`) {
      return {
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(0),
        text: async () => JSON.stringify({ alg: 'ed25519', statement, signature }),
      };
    }
    if (url === document.releases[0].artifacts[artifactKey].url) {
      return { ok: true, body: Readable.from([payload]) };
    }
    return { ok: false };
  };

  return { payload, manifestUrl, publicKeyB64, fetchImpl };
}

test('the artifact key names the shape each platform actually ships', () => {
  assert.equal(artifactKeyFor('linux', 'x64'), 'desktop-linux-x86_64-appimage');
  assert.equal(artifactKeyFor('linux', 'arm64'), 'desktop-linux-aarch64-appimage');
  assert.equal(artifactKeyFor('win32', 'x64'), 'desktop-windows-x86_64');
  assert.equal(artifactKeyFor('darwin', 'arm64'), 'desktop-macos-aarch64');
});

test('the download lands with the extension the platform executes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'telium-updater-'));
  try {
    const bytes = Buffer.from('pretend installer bytes');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const downloaded = await downloadArtifact({
      artifact: { url: 'https://downloads.example/setup', sha256, size: bytes.length },
      fetchImpl: async () => ({ ok: true, body: Readable.from([bytes]) }),
      directory,
      platform: 'win32',
    });
    assert.equal(downloaded.fault, undefined);
    assert.ok(downloaded.path.endsWith('.exe'), downloaded.path);
    assert.deepEqual(readFileSync(downloaded.path), bytes);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the download reports byte progress, and always the full amount at the end', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'telium-updater-'));
  try {
    const chunks = [Buffer.from('first '), Buffer.from('second '), Buffer.from('third')];
    const payload = Buffer.concat(chunks);
    const sha256 = createHash('sha256').update(payload).digest('hex');
    const reports = [];
    const downloaded = await downloadArtifact({
      artifact: { url: 'https://downloads.example/appimage', sha256, size: 0 },
      fetchImpl: async () => ({
        ok: true,
        headers: { get: (name) => (name === 'content-length' ? String(payload.length) : null) },
        body: Readable.from(chunks),
      }),
      directory,
      onProgress: (report) => reports.push(report),
    });
    assert.equal(downloaded.fault, undefined);
    assert.equal(reports.at(-1).received, payload.length, 'the final report reaches the end');
    assert.equal(reports.at(-1).total, payload.length, 'the header sizes the bar');
    for (const report of reports) {
      assert.ok(report.received <= report.total, 'no report claims more than the whole');
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a download with no Content-Length sizes its bar from the signed manifest', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'telium-updater-'));
  try {
    const payload = Buffer.from('chunked, no header');
    const sha256 = createHash('sha256').update(payload).digest('hex');
    const reports = [];
    const downloaded = await downloadArtifact({
      artifact: { url: 'https://downloads.example/appimage', sha256, size: payload.length },
      fetchImpl: async () => ({ ok: true, body: Readable.from([payload]) }),
      directory,
      onProgress: (report) => reports.push(report),
    });
    assert.equal(downloaded.fault, undefined);
    assert.equal(reports.at(-1).total, payload.length);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('staging an installer gives it one stable name a restart can rely on', () => {
  const directory = mkdtempSync(join(tmpdir(), 'telium-updater-'));
  try {
    const first = join(directory, 'telium-abcdef0123456789.exe');
    writeFileSync(first, 'first');
    const placed = stageInstaller({ downloaded: first, directory });
    assert.equal(placed.fault, undefined);
    assert.equal(placed.path, join(directory, 'telium-setup.exe'));
    // A second check of the same release replaces the staged file rather than collecting hash-named ones.
    const second = join(directory, 'telium-ffffffffffffffff.exe');
    writeFileSync(second, 'second');
    const again = stageInstaller({ downloaded: second, directory });
    assert.equal(again.path, placed.path);
    assert.equal(readFileSync(placed.path, 'utf8'), 'second');
    assert.ok(!existsSync(first));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a Windows machine with no AppImage path installs anyway, and the install is real', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'telium-updater-'));
  try {
    const { payload, manifestUrl, publicKeyB64, fetchImpl } = signedPublisher({
      artifactKey: 'desktop-windows-x86_64',
    });
    const service = createUpdateService({
      publisher: { url: manifestUrl, publicKey: publicKeyB64 },
      currentVersion: '1.0.0',
      appImagePath: '',
      platform: 'win32',
      fetchImpl,
      downloadDirectory: directory,
    });

    await service.install();
    const state = service.state();
    assert.equal(state.phase, Phase.Ready, `phase ${state.phase} fault ${state.fault}`);
    assert.equal(state.canInstall, true);
    assert.equal(service.stagedPath(), join(directory, 'telium-setup.exe'));
    assert.deepEqual(readFileSync(service.stagedPath()), payload);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Linux without an AppImage still learns it is behind, and refuses to pretend', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'telium-updater-'));
  try {
    const { manifestUrl, publicKeyB64, fetchImpl } = signedPublisher({
      artifactKey: 'desktop-linux-x86_64-appimage',
    });
    const service = createUpdateService({
      publisher: { url: manifestUrl, publicKey: publicKeyB64 },
      currentVersion: '1.0.0',
      appImagePath: '',
      platform: 'linux',
      fetchImpl,
      downloadDirectory: directory,
    });

    await service.install();
    const state = service.state();
    // It failed on the install, not the network or signature: nothing here to swap.
    assert.equal(state.phase, Phase.Failed);
    assert.equal(state.fault, Fault.NotWritable);
    assert.equal(state.version, '9.9.9');
    assert.equal(state.canInstall, false);
    assert.equal(service.stagedPath(), '');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('staging an AppImage swaps it in place, executable, with nothing left over', () => {
  const directory = mkdtempSync(join(tmpdir(), 'telium-updater-'));
  try {
    const appImagePath = join(directory, 'Telium.AppImage');
    writeFileSync(appImagePath, 'the old build');
    const downloaded = join(directory, 'telium-abcdef0123456789.AppImage');
    writeFileSync(downloaded, 'the new build');

    const placed = stageAppImage({ downloaded, appImagePath });
    assert.equal(placed.fault, undefined);
    assert.equal(placed.path, appImagePath);
    assert.equal(readFileSync(appImagePath, 'utf8'), 'the new build');
    // The copy does not arrive executable; the swap has to make it so.
    assert.equal(statSync(appImagePath).mode & 0o777, 0o755);
    assert.ok(!existsSync(join(directory, '.telium-update.AppImage')));
    assert.ok(!existsSync(`${appImagePath}.previous`));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('staging an AppImage crosses filesystems, where the machine has two', (t) => {
  // The bug this pins: the download lands in the temp directory, which on most
  // distributions is a tmpfs, while the AppImage sits on another filesystem --
  // and a rename across that line fails outright, which used to fail every
  // update on those machines. Skipped where the two paths share a device.
  let sharedMemory = '';
  try {
    sharedMemory = '/dev/shm';
    if (statSync(sharedMemory).dev === statSync(tmpdir()).dev) sharedMemory = '';
  } catch {
    sharedMemory = '';
  }
  if (!sharedMemory) {
    t.skip('no second filesystem on this machine to stage across');
    return;
  }

  const sourceDirectory = join(sharedMemory, `telium-updater-${process.pid}`);
  const targetDirectory = mkdtempSync(join(tmpdir(), 'telium-updater-'));
  try {
    mkdirSync(sourceDirectory, { recursive: true });
    const downloaded = join(sourceDirectory, 'telium-abcdef0123456789.AppImage');
    writeFileSync(downloaded, 'the new build');
    const appImagePath = join(targetDirectory, 'Telium.AppImage');
    writeFileSync(appImagePath, 'the old build');

    const placed = stageAppImage({ downloaded, appImagePath });
    assert.equal(placed.fault, undefined);
    assert.equal(readFileSync(appImagePath, 'utf8'), 'the new build');
  } finally {
    rmSync(sourceDirectory, { recursive: true, force: true });
    rmSync(targetDirectory, { recursive: true, force: true });
  }
});

test('staging over nothing to swap refuses, and leaves no half-written file behind', () => {
  const directory = mkdtempSync(join(tmpdir(), 'telium-updater-'));
  try {
    const downloaded = join(directory, 'telium-abcdef0123456789.AppImage');
    writeFileSync(downloaded, 'the new build');

    const placed = stageAppImage({ downloaded, appImagePath: join(directory, 'absent.AppImage') });
    assert.equal(placed.fault, Fault.NotWritable);
    assert.ok(!existsSync(join(directory, '.telium-update.AppImage')));
    assert.ok(existsSync(downloaded), 'the download itself belongs to the caller to clean up');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('an install publishes byte progress while downloading and clears it when done', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'telium-updater-'));
  try {
    const { payload, manifestUrl, publicKeyB64, fetchImpl } = signedPublisher({
      artifactKey: 'desktop-windows-x86_64',
    });
    const states = [];
    const service = createUpdateService({
      publisher: { url: manifestUrl, publicKey: publicKeyB64 },
      currentVersion: '1.0.0',
      appImagePath: '',
      platform: 'win32',
      fetchImpl,
      downloadDirectory: directory,
      onChange: (state) => states.push(state),
    });

    await service.install();
    const downloading = states.filter((state) => state.phase === Phase.Downloading);
    assert.ok(downloading.length >= 1, 'the downloading phase is announced');
    assert.ok(downloading.some((state) => state.total === payload.length), 'the bar is sized');
    assert.ok(downloading.some((state) => state.received === payload.length), 'the bar is fed');
    const final = service.state();
    assert.equal(final.phase, Phase.Ready, `phase ${final.phase} fault ${final.fault}`);
    assert.equal(final.received, 0, 'a finished install leaves no counts behind');
    assert.equal(final.total, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
