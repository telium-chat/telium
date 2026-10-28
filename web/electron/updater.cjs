'use strict';

// The half of the updater allowed to write to disk. Accepts no URL, digest or version from the renderer: everything is re-derived from the publisher URL and public key baked into this build.

const { createHash, createPublicKey, verify: edVerify } = require('node:crypto');
const { chmodSync, copyFileSync, createWriteStream, mkdirSync, renameSync, rmSync, statSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { dirname, join } = require('node:path');
const { pipeline } = require('node:stream/promises');
const { Readable } = require('node:stream');

/// Must match `STATEMENT_VERSION` in `web/src/lib/updates.js`; differs from the server manifest's prefix for domain separation (same key).
const STATEMENT_VERSION = 'telium-client-manifest-v1';
const MANIFEST_KIND = 'telium.client_releases';
const MANIFEST_VERSION = 1;

const MAX_MANIFEST_BYTES = 512 * 1024;
/// Generous: the digest is the real check; this only stops an endpoint streaming until the disk fills.
const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;
/// Progress is throttled to this many ms between reports; the renderer renders at most that stale.
const PROGRESS_THROTTLE_MS = 200;

const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

const Fault = {
  NoKey: 'no-key',
  Unreachable: 'unreachable',
  Unreadable: 'unreadable',
  Forged: 'forged',
  NoArtifact: 'no-artifact',
  Corrupt: 'corrupt',
  NotWritable: 'not-writable',
};

const fromUrlB64 = (text) => {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]+$/.test(text)) return null;
  const padded = text.replace(/-/g, '+').replace(/_/g, '/')
    + '='.repeat((4 - (text.length % 4)) % 4);
  return Buffer.from(padded, 'base64');
};

const statementFor = (bytes) =>
  `${STATEMENT_VERSION} sha256=${createHash('sha256').update(bytes).digest('hex')}`;

function verifyManifestSignature(bytes, signature, publicKey) {
  if (typeof publicKey !== 'string' || !publicKey) return false;
  if (!signature || typeof signature !== 'object') return false;
  if (signature.alg !== 'ed25519') return false;
  const expected = statementFor(bytes);
  // Compared before the signature: a validly signed but stale manifest could otherwise be replayed.
  if (signature.statement !== expected) return false;
  const sig = fromUrlB64(signature.signature);
  const raw = fromUrlB64(publicKey);
  if (!sig || sig.length !== 64 || !raw || raw.length !== 32) return false;
  try {
    return edVerify(
      null,
      Buffer.from(expected, 'utf8'),
      createPublicKey({
        key: Buffer.concat([SPKI_ED25519_PREFIX, raw]),
        format: 'der',
        type: 'spki',
      }),
      sig,
    );
  } catch {
    return false;
  }
}

/// Second implementation of `compareVersions` in `web/src/lib/updates.js`: this process cannot import that ES module or take a version from the renderer.
function compareVersions(a, b) {
  const split = (version) => {
    const text = String(version ?? '').trim().replace(/^v/i, '');
    const [core, ...rest] = text.split('-');
    const numbers = core.split('.').map((segment) => {
      const n = Number.parseInt(segment, 10);
      return Number.isFinite(n) && n >= 0 ? n : 0;
    });
    while (numbers.length < 3) numbers.push(0);
    return { numbers, pre: rest.join('-') };
  };
  const left = split(a);
  const right = split(b);
  for (let i = 0; i < Math.max(left.numbers.length, right.numbers.length); i += 1) {
    const diff = (left.numbers[i] || 0) - (right.numbers[i] || 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  if (left.pre === right.pre) return 0;
  if (!left.pre) return 1;
  if (!right.pre) return -1;
  const l = left.pre.split('.');
  const r = right.pre.split('.');
  for (let i = 0; i < Math.max(l.length, r.length); i += 1) {
    if (l[i] === undefined) return -1;
    if (r[i] === undefined) return 1;
    const ln = /^\d+$/.test(l[i]) ? Number(l[i]) : null;
    const rn = /^\d+$/.test(r[i]) ? Number(r[i]) : null;
    if (ln !== null && rn !== null) {
      if (ln !== rn) return ln < rn ? -1 : 1;
    } else if (ln !== null) {
      return -1;
    } else if (rn !== null) {
      return 1;
    } else if (l[i] !== r[i]) {
      return l[i] < r[i] ? -1 : 1;
    }
  }
  return 0;
}

function artifactKeyFor(platform = process.platform, arch = process.arch) {
  const os = platform === 'win32' ? 'windows' : platform === 'darwin' ? 'macos' : 'linux';
  const cpu = arch === 'arm64' ? 'aarch64' : 'x86_64';
  return os === 'linux' ? `desktop-${os}-${cpu}-appimage` : `desktop-${os}-${cpu}`;
}

/// Returns `{ release, artifact }` or `{ fault }`; never throws, since it runs on a background timer.
async function checkForUpdate({
  publisher,
  currentVersion,
  fetchImpl = globalThis.fetch,
  artifactKey = artifactKeyFor(),
}) {
  const url = publisher?.url || '';
  const key = publisher?.publicKey || '';
  // Before anything reaches the network: a manifest nobody can verify has no use here.
  if (!url || !key) return { fault: Fault.NoKey };
  if (typeof fetchImpl !== 'function') return { fault: Fault.Unreachable };

  let bytes;
  let signature;
  try {
    const [manifestResponse, signatureResponse] = await Promise.all([
      fetchImpl(url, { cache: 'no-store' }),
      fetchImpl(`${url}.sig`, { cache: 'no-store' }),
    ]);
    if (!manifestResponse?.ok || !signatureResponse?.ok) return { fault: Fault.Unreachable };
    const buffer = Buffer.from(await manifestResponse.arrayBuffer());
    if (buffer.length > MAX_MANIFEST_BYTES) return { fault: Fault.Unreadable };
    bytes = buffer;
    signature = JSON.parse(await signatureResponse.text());
  } catch {
    return { fault: Fault.Unreachable };
  }

  // Verified before parsed, so the parser never sees unauthenticated input.
  if (!verifyManifestSignature(bytes, signature, key)) return { fault: Fault.Forged };

  let document;
  try {
    document = JSON.parse(bytes.toString('utf8'));
  } catch {
    return { fault: Fault.Unreadable };
  }
  if (document?.kind !== MANIFEST_KIND || document?.version !== MANIFEST_VERSION) {
    return { fault: Fault.Unreadable };
  }
  if (!Array.isArray(document.releases)) return { fault: Fault.Unreadable };

  const newer = document.releases
    .filter((release) => release && typeof release.version === 'string')
    .filter((release) => compareVersions(release.version, currentVersion) > 0)
    .sort((a, b) => compareVersions(b.version, a.version));
  const release = newer[0];
  if (!release) return { release: null, artifact: null };

  const artifact = release.artifacts?.[artifactKey];
  if (
    !artifact
    || typeof artifact.url !== 'string'
    || !/^https:\/\//i.test(artifact.url)
    || typeof artifact.sha256 !== 'string'
    || !/^[0-9a-f]{64}$/i.test(artifact.sha256)
  ) {
    return { release: null, artifact: null, fault: Fault.NoArtifact };
  }
  return { release: { version: release.version, security: release.security === true }, artifact };
}

/// Digest computed as bytes stream past; written to a temp directory so a half-written file never sits beside a running AppImage.
/// `onProgress` gets `{ received, total }` at most every `PROGRESS_THROTTLE_MS`, plus one final report; `total` is 0 when nothing declares a size and the renderer must fall back to an indeterminate state.
async function downloadArtifact({
  artifact,
  fetchImpl = globalThis.fetch,
  directory = join(tmpdir(), 'telium-update'),
  platform = process.platform,
  onProgress = null,
}) {
  let response;
  try {
    response = await fetchImpl(artifact.url, { cache: 'no-store' });
    if (!response?.ok || !response.body) return { fault: Fault.Unreachable };
  } catch {
    return { fault: Fault.Unreachable };
  }

  // Content-Length when the endpoint sends one; the manifest's signed size otherwise.
  const headerTotal = Number(response.headers?.get?.('content-length'));
  const total = Number.isFinite(headerTotal) && headerTotal > 0
    ? headerTotal
    : Number(artifact.size) > 0 ? Number(artifact.size) : 0;

  mkdirSync(directory, { recursive: true });
  // On Windows the staged installer is executed by name, so the extension matters.
  const extension = platform === 'win32' ? '.exe' : '.AppImage';
  const target = join(directory, `telium-${artifact.sha256.slice(0, 16)}${extension}`);
  const hash = createHash('sha256');
  let seen = 0;
  let aborted = false;
  let reportedAt = 0;
  const report = (force = false) => {
    if (typeof onProgress !== 'function') return;
    const at = Date.now();
    if (!force && at - reportedAt < PROGRESS_THROTTLE_MS) return;
    reportedAt = at;
    try {
      onProgress({ received: seen, total });
    } catch {
      // A progress listener that throws must not fail the download.
    }
  };
  try {
    const source = typeof response.body.getReader === 'function'
      ? Readable.fromWeb(response.body)
      : response.body;
    await pipeline(
      source,
      async function* (chunks) {
        for await (const chunk of chunks) {
          seen += chunk.length;
          // Checked as it arrives: Content-Length is the endpoint's own claim and absent on chunked responses.
          if (seen > MAX_ARTIFACT_BYTES) { aborted = true; return; }
          hash.update(chunk);
          report();
          yield chunk;
        }
      },
      createWriteStream(target),
    );
  } catch {
    rmSync(target, { force: true });
    return { fault: Fault.Unreachable };
  }
  if (aborted) {
    rmSync(target, { force: true });
    return { fault: Fault.Unreachable };
  }
  // Always, past the throttle: a bar left short of the end reads as a stalled download.
  report(true);

  const digest = hash.digest('hex');
  if (digest !== artifact.sha256.toLowerCase()) {
    // Removed: a file that failed its digest should not be runnable by accident.
    rmSync(target, { force: true });
    return { fault: Fault.Corrupt };
  }
  return { path: target };
}

/// The old file is moved aside and unlinked only once the new one is in place, so a failure leaves something runnable.
function stageAppImage({ downloaded, appImagePath }) {
  if (!appImagePath) return { fault: Fault.NotWritable };
  const directory = dirname(appImagePath);
  const staged = join(directory, '.telium-update.AppImage');
  const previous = `${appImagePath}.previous`;
  try {
    // Copied, not renamed: the download sits in the temp directory, which on most
    // distributions is a tmpfs while the AppImage sits on the root or home
    // filesystem, and a rename across filesystems fails outright (EXDEV). The
    // final swap below stays inside `directory`, so it stays atomic.
    copyFileSync(downloaded, staged);
    chmodSync(staged, 0o755);
    renameSync(appImagePath, previous);
    try {
      renameSync(staged, appImagePath);
    } catch (error) {
      // Put the old one back: otherwise the desktop entry points at nothing.
      renameSync(previous, appImagePath);
      throw error;
    }
  } catch {
    rmSync(staged, { force: true });
    return { fault: Fault.NotWritable };
  }
  rmSync(previous, { force: true });
  return { path: appImagePath };
}

function stageInstaller({ downloaded, directory = join(tmpdir(), 'telium-update') }) {
  const staged = join(directory, 'telium-setup.exe');
  try {
    mkdirSync(directory, { recursive: true });
    rmSync(staged, { force: true });
    renameSync(downloaded, staged);
  } catch {
    return { fault: Fault.NotWritable };
  }
  return { path: staged };
}

/// `APPIMAGE` is set by the AppImage runtime; without it the build does not self-install.
function runningAppImage(env = process.env) {
  const path = env.APPIMAGE;
  if (!path) return '';
  try {
    return statSync(path).isFile() ? path : '';
  } catch {
    return '';
  }
}

const Phase = {
  Idle: 'idle',
  Checking: 'checking',
  Downloading: 'downloading',
  Verifying: 'verifying',
  Ready: 'ready',
  Failed: 'failed',
};

/// `inFlight` refuses a second download when a timer and a button press arrive together.
function createUpdateService({
  publisher,
  currentVersion,
  appImagePath = runningAppImage(),
  platform = process.platform,
  fetchImpl = globalThis.fetch,
  onChange = () => {},
  downloadDirectory,
}) {
  // Windows runs a downloaded installer; Linux needs an AppImage to swap.
  const canInstall = platform === 'win32' || Boolean(appImagePath);
  let state = { phase: Phase.Idle, version: '', fault: '', received: 0, total: 0, canInstall };
  let inFlight = null;
  let staged = '';

  const publish = (next) => {
    state = { ...state, ...next };
    try {
      onChange(state);
    } catch {
      // A renderer gone mid-restart is normal, not an error.
    }
  };

  async function run(install) {
    publish({ phase: Phase.Checking, fault: '' });
    const found = await checkForUpdate({
      publisher,
      currentVersion,
      fetchImpl,
      artifactKey: artifactKeyFor(platform),
    });
    if (found.fault) {
      publish({ phase: Phase.Failed, fault: found.fault, version: '' });
      return state;
    }
    if (!found.release) {
      publish({ phase: Phase.Idle, fault: '', version: '' });
      return state;
    }
    if (!install) {
      publish({ phase: Phase.Idle, fault: '', version: found.release.version });
      return state;
    }
    // Refused here, not earlier, so a build that cannot self-install still learns it is behind.
    if (!canInstall) {
      publish({ phase: Phase.Failed, fault: Fault.NotWritable, version: found.release.version });
      return state;
    }

    publish({ phase: Phase.Downloading, version: found.release.version, received: 0, total: 0 });
    const downloaded = await downloadArtifact({
      artifact: found.artifact,
      fetchImpl,
      ...(downloadDirectory ? { directory: downloadDirectory } : {}),
      ...(platform === 'win32' ? { platform } : {}),
      onProgress: ({ received, total }) => publish({ received, total }),
    });
    if (downloaded.fault) {
      publish({ phase: Phase.Failed, fault: downloaded.fault, received: 0, total: 0 });
      return state;
    }

    publish({ phase: Phase.Verifying, received: 0, total: 0 });
    const placed = platform === 'win32'
      ? stageInstaller({
        downloaded: downloaded.path,
        ...(downloadDirectory ? { directory: downloadDirectory } : {}),
      })
      : stageAppImage({ downloaded: downloaded.path, appImagePath });
    if (placed.fault) {
      rmSync(downloaded.path, { force: true });
      publish({ phase: Phase.Failed, fault: placed.fault, received: 0, total: 0 });
      return state;
    }
    // The staging copy leaves the temp download behind; nothing else will remove it.
    rmSync(downloaded.path, { force: true });
    staged = placed.path;
    publish({ phase: Phase.Ready, fault: '', received: 0, total: 0 });
    return state;
  }

  const start = (install) => {
    if (inFlight) return inFlight;
    // Once staged only restarting remains; checking again would report "up to date" and wipe the restart message.
    if (state.phase === Phase.Ready) return Promise.resolve(state);
    inFlight = run(install).finally(() => { inFlight = null; });
    return inFlight;
  };

  return {
    state: () => state,
    check: () => start(false),
    install: () => start(true),
    stagedPath: () => staged,
  };
}

module.exports = {
  Fault,
  Phase,
  createUpdateService,
  STATEMENT_VERSION,
  artifactKeyFor,
  checkForUpdate,
  compareVersions,
  downloadArtifact,
  runningAppImage,
  stageAppImage,
  stageInstaller,
  statementFor,
  verifyManifestSignature,
};
