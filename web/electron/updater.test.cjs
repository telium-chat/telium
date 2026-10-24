'use strict';

// The signed update service's platform half, with real Ed25519 signatures; the statement format is in `sign-client-manifest.test.mjs`.

const assert = require('node:assert/strict');
const { createHash, generateKeyPairSync, sign: edSign } = require('node:crypto');
const { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
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
