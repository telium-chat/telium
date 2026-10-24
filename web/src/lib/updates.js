// Whether this client is current. The publisher is a build input (`VITE_TELIUM_UPDATE_URL` and `VITE_TELIUM_UPDATE_PUBLIC_KEY`), never a homeserver, since trusting one for the next build would let a guild operator run code on the user's machine. No pinned key means no manifest is fetched. Only writing bytes is runtime-specific (`electron/updater.cjs`).

import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { runtime as buildRuntime, version as buildVersion } from './build.js';
import { unb64 } from './util.js';

/// Neither has a default: a compiled-in key would be the pin an attacker would choose.
export const PUBLISHER_URL = import.meta.env?.VITE_TELIUM_UPDATE_URL || '';
export const PUBLISHER_KEY = import.meta.env?.VITE_TELIUM_UPDATE_PUBLIC_KEY || '';

/// Distinct from the server manifest's prefix, which is signed by the same key; sharing one would let a server list verify as a client list.
export const STATEMENT_VERSION = 'telium-client-manifest-v1';

export const MANIFEST_KIND = 'telium.client_releases';
export const MANIFEST_VERSION = 1;

/// Ceilings so a hostile publisher can't send a huge document.
const MAX_MANIFEST_BYTES = 512 * 1024;
const MAX_RELEASES = 500;

/// All three states are named so none collapses into a silent false.
export const Publisher = {
  /// A URL and a key. The only state in which anything is fetched.
  Configured: 'configured',
  /// A URL or a key but not both: a mistake, reported as one.
  Unkeyed: 'unkeyed',
  /// Development builds, homeserver bundles and forks. Not an error.
  Unconfigured: 'unconfigured',
};

/// Reads `import.meta.env` per call so tests can exercise both builds.
export function publisherState(env = import.meta.env) {
  const url = env?.VITE_TELIUM_UPDATE_URL || '';
  const key = env?.VITE_TELIUM_UPDATE_PUBLIC_KEY || '';
  if (url && key) return Publisher.Configured;
  if (url || key) return Publisher.Unkeyed;
  return Publisher.Unconfigured;
}

/// A non-numeric segment sorts as zero so an odd version isn't invisible.
function parts(version) {
  const text = String(version ?? '').trim().replace(/^v/i, '');
  const [core, ...rest] = text.split('-');
  const pre = rest.join('-');
  const numbers = core.split('.').map((segment) => {
    const n = Number.parseInt(segment, 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  });
  // Padded so `0.2` and `0.2.0` match.
  while (numbers.length < 3) numbers.push(0);
  return { numbers, pre };
}

/// Semver ordering: prerelease is older; numeric identifiers compare as numbers (`rc10` > `rc2`).
export function compareVersions(a, b) {
  const left = parts(a);
  const right = parts(b);
  const width = Math.max(left.numbers.length, right.numbers.length);
  for (let i = 0; i < width; i += 1) {
    const diff = (left.numbers[i] || 0) - (right.numbers[i] || 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  if (left.pre === right.pre) return 0;
  // Exactly one side is a prerelease: that side is older.
  if (!left.pre) return 1;
  if (!right.pre) return -1;
  const leftIds = left.pre.split('.');
  const rightIds = right.pre.split('.');
  for (let i = 0; i < Math.max(leftIds.length, rightIds.length); i += 1) {
    const l = leftIds[i];
    const r = rightIds[i];
    // Fewer identifiers is older when the rest matched.
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    const ln = /^\d+$/.test(l) ? Number(l) : null;
    const rn = /^\d+$/.test(r) ? Number(r) : null;
    if (ln !== null && rn !== null) {
      if (ln !== rn) return ln < rn ? -1 : 1;
    } else if (ln !== null) {
      // Numeric identifiers sort below alphanumeric ones.
      return -1;
    } else if (rn !== null) {
      return 1;
    } else if (l !== r) {
      return l < r ? -1 : 1;
    }
  }
  return 0;
}

export const isNewer = (candidate, current) => compareVersions(candidate, current) > 0;

/// A flat string, since it is a key in the published JSON. Windows ships NSIS, so its key is the platform alone.
export function artifactKey(runtime = buildRuntime, platform = detectPlatform()) {
  if (runtime === 'desktop') {
    return platform.startsWith('linux') ? `desktop-${platform}-appimage` : `desktop-${platform}`;
  }
  if (runtime === 'desktop-tauri') return `desktop-tauri-${platform}`;
  if (runtime === 'android') return 'android-apk';
  return '';
}

/// A coarse `os-arch`, matching the artifacts this repository publishes.
export function detectPlatform(nav = globalThis.navigator) {
  const text = `${nav?.userAgent || ''} ${nav?.platform || ''}`.toLowerCase();
  const os = text.includes('win') ? 'windows'
    : text.includes('mac') ? 'macos'
      : 'linux';
  const arch = /aarch64|arm64/.test(text) ? 'aarch64' : 'x86_64';
  return `${os}-${arch}`;
}

/// Takes bytes, not JSON: the signature covers the bytes, and parsing first would act on unverified content.
export function parseManifest(bytes) {
  // Not `instanceof Uint8Array`: arrays from tests, workers or polyfills may be from another realm.
  if (!ArrayBuffer.isView(bytes) || bytes.BYTES_PER_ELEMENT !== 1) {
    throw new Error('manifest must be bytes');
  }
  if (bytes.length > MAX_MANIFEST_BYTES) throw new Error('manifest is implausibly large');
  let document;
  try {
    document = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error('manifest is not JSON');
  }
  if (!document || typeof document !== 'object') throw new Error('manifest is not an object');
  if (document.kind !== MANIFEST_KIND) throw new Error(`manifest kind is ${document.kind}`);
  if (document.version !== MANIFEST_VERSION) throw new Error(`manifest version is ${document.version}`);
  if (!Array.isArray(document.releases)) throw new Error('manifest has no releases');
  if (document.releases.length > MAX_RELEASES) throw new Error('manifest has too many releases');

  const releases = document.releases
    .filter((release) => release && typeof release.version === 'string' && release.version)
    .map((release) => ({
      version: release.version,
      releasedAt: Number.isFinite(release.released_at) ? release.released_at : 0,
      // Publisher-flagged security release; escalates the notice however far behind the reader is.
      security: release.security === true,
      summary: typeof release.summary === 'string' ? release.summary.slice(0, 240) : '',
      // Not enforced here (the server answers 4015); lets the notice warn early.
      minSupported: typeof release.min_supported === 'string' ? release.min_supported : '',
      // Where to go when this client can't install; https checked here, as for artifacts.
      page: typeof release.page === 'string' && /^https:\/\//i.test(release.page)
        ? release.page
        : '',
      artifacts: sanitiseArtifacts(release.artifacts),
    }))
    .sort((a, b) => compareVersions(b.version, a.version));

  return {
    channel: typeof document.channel === 'string' ? document.channel : 'stable',
    generatedAt: Number.isFinite(document.generated_at) ? document.generated_at : 0,
    releases,
  };
}

function sanitiseArtifacts(raw) {
  const out = new Map();
  if (!raw || typeof raw !== 'object') return out;
  for (const [key, value] of Object.entries(raw)) {
    if (!value || typeof value !== 'object') continue;
    // https only; a valid signature doesn't mean the publisher vetted this URL.
    if (typeof value.url !== 'string' || !/^https:\/\//i.test(value.url)) continue;
    if (typeof value.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(value.sha256)) continue;
    out.set(key, {
      url: value.url,
      sha256: value.sha256.toLowerCase(),
      size: Number.isFinite(value.size) && value.size > 0 ? value.size : 0,
    });
  }
  return out;
}

/// A fixed ASCII statement over a digest of the manifest bytes; detached, so no canonical JSON is needed.
export function statementFor(bytes) {
  const hex = Array.from(sha256(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
  return `${STATEMENT_VERSION} sha256=${hex}`;
}

/// Never throws: every failure means refuse; an empty or malformed key is false.
export function verifyManifestSignature(bytes, signature, publicKey) {
  if (typeof publicKey !== 'string' || !publicKey) return false;
  if (!signature || typeof signature !== 'object') return false;
  if (signature.alg !== 'ed25519') return false;
  if (typeof signature.signature !== 'string' || !signature.signature) return false;
  let expected;
  try {
    expected = statementFor(bytes);
  } catch {
    return false;
  }
  // Checked before the signature: a genuine old manifest must not pass (replay).
  if (signature.statement !== expected) return false;
  try {
    const sig = unb64(signature.signature);
    const key = unb64(publicKey);
    if (sig.length !== 64 || key.length !== 32) return false;
    return ed25519.verify(sig, new TextEncoder().encode(expected), key);
  } catch {
    return false;
  }
}

export const Delivery = {
  /// Packaged Electron on Linux only: the one runtime that owns its executable.
  Install: 'install',
  Reload: 'reload',
  /// A store (Play, F-Droid, sideload) owns the install; link to where.
  Store: 'store',
  /// A package manager or self-built binary; overwriting a distro package would corrupt its database.
  Package: 'package',
};

/// Separate from `Delivery` so a missing key isn't hidden behind a platform limit.
export const Blocked = {
  None: '',
  /// The loud one.
  NoKey: 'no-key',
  Runtime: 'runtime',
  /// A newer release exists but has no artifact for this machine.
  NoArtifact: 'no-artifact',
};

export function deliveryFor(runtime = buildRuntime) {
  if (runtime === 'desktop') return Delivery.Install;
  if (runtime === 'android') return Delivery.Store;
  if (runtime === 'desktop-tauri') return Delivery.Package;
  return Delivery.Reload;
}

/// The state of this client against a verified manifest. Pure, so the policy
/// is testable without a network or clock (`src/test/updates.test.js`).
///
/// @param {object} input
/// @param {object|null} input.manifest   A parsed, verified manifest, or null.
/// @param {string} input.current         The version this build is.
/// @param {string} input.runtime         `build.js`'s runtime.
/// @param {string} input.publisher       One of `Publisher`.
/// @param {string} input.platform        `os-arch`.
/// @param {boolean} input.incompatible   A server has refused this build (4015).
export function assess({
  manifest = null,
  current = buildVersion,
  runtime = buildRuntime,
  publisher = publisherState(),
  platform = detectPlatform(),
  incompatible = false,
} = {}) {
  const delivery = deliveryFor(runtime);

  // Enforced first so no argument combination routes around it. An unkeyed build may know it is incompatible but is never offered an install.
  if (publisher !== Publisher.Configured) {
    return {
      behind: false,
      incompatible,
      security: false,
      latest: null,
      artifact: null,
      delivery,
      canInstall: false,
      blocked: Blocked.NoKey,
      publisher,
    };
  }

  const releases = manifest?.releases ?? [];
  const latest = releases.find((release) => isNewer(release.version, current)) || null;
  const artifact = latest?.artifacts?.get(artifactKey(runtime, platform)) || null;

  // Asked of every missed release: a fix in the second of four must still surface.
  const security = releases.some(
    (release) => release.security && isNewer(release.version, current),
  );

  const canInstall = Boolean(latest && artifact) && delivery === Delivery.Install;
  const blocked = !latest ? Blocked.None
    : delivery !== Delivery.Install ? Blocked.Runtime
      : !artifact ? Blocked.NoArtifact
        : Blocked.None;

  return {
    behind: Boolean(latest),
    incompatible,
    security,
    latest,
    artifact,
    delivery,
    canInstall,
    blocked,
    publisher,
  };
}

/// An unconfigured publisher is not the reader's concern.
export function shouldNotify(state) {
  return Boolean(state?.incompatible || state?.behind);
}

export const Urgency = { Quiet: 'quiet', Urgent: 'urgent' };

export function urgencyOf(state) {
  return state?.incompatible || state?.security ? Urgency.Urgent : Urgency.Quiet;
}

/// Keeps "does not check" distinct from "checked and failed".
export const Unchecked = {
  NoKey: 'no-key',
  Unreachable: 'unreachable',
  Unreadable: 'unreadable',
  /// Kept apart from `Unreachable`: a network failure is noise, a bad signature is news.
  Forged: 'forged',
};

const FETCH_TIMEOUT_MS = 15_000;

/// Never throws, and calls no `fetch` unless URL and key are both configured; the guard is first so no unverified document sits in a variable.
export async function fetchManifest({
  url = PUBLISHER_URL,
  key = PUBLISHER_KEY,
  fetchImpl = globalThis.fetch,
  timeoutMs = FETCH_TIMEOUT_MS,
} = {}) {
  if (!url || !key) return { manifest: null, error: Unchecked.NoKey };
  if (typeof fetchImpl !== 'function') return { manifest: null, error: Unchecked.Unreachable };

  // Requested together to shorten the window where a fresh release makes them disagree.
  const sigUrl = `${url}.sig`;
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  let bytes;
  let signature;
  try {
    const [manifestResponse, signatureResponse] = await Promise.all([
      fetchImpl(url, { cache: 'no-store', signal: controller?.signal }),
      fetchImpl(sigUrl, { cache: 'no-store', signal: controller?.signal }),
    ]);
    if (!manifestResponse?.ok || !signatureResponse?.ok) {
      return { manifest: null, error: Unchecked.Unreachable };
    }
    bytes = new Uint8Array(await manifestResponse.arrayBuffer());
    signature = JSON.parse(await signatureResponse.text());
  } catch {
    return { manifest: null, error: Unchecked.Unreachable };
  } finally {
    if (timer) clearTimeout(timer);
  }

  // Verified before parsed.
  if (!verifyManifestSignature(bytes, signature, key)) {
    return { manifest: null, error: Unchecked.Forged };
  }
  try {
    return { manifest: parseManifest(bytes), error: null };
  } catch {
    return { manifest: null, error: Unchecked.Unreadable };
  }
}

/// Shorter than `lib/version.js`; it always comes back.
const SNOOZE_MS = {
  quiet: 3 * 24 * 60 * 60 * 1000,
  urgent: 8 * 60 * 60 * 1000,
  /// A refused client doesn't work, so it returns within the hour.
  incompatible: 60 * 60 * 1000,
};

export const DISMISS_KEY = 'telium.updates.dismissed';

/// Folds in version and urgency so a dismissal silences a situation, not a subject.
export function noticeKey(state) {
  if (!state) return null;
  return [
    state.incompatible ? 'incompatible' : '',
    state.security ? 'security' : '',
    state.latest?.version || '',
  ].filter(Boolean).join(':') || 'behind';
}

/// Tolerate anything in storage; runs during first render.
export function readDismissal(storage) {
  try {
    const raw = storage?.getItem(DISMISS_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw);
    if (!value || typeof value.key !== 'string' || typeof value.until !== 'number') return null;
    return value;
  } catch {
    return null;
  }
}

export function writeDismissal(storage, key, until) {
  try {
    storage?.setItem(DISMISS_KEY, JSON.stringify({ key, until }));
  } catch {
    // Storage may be unavailable.
  }
}

/// Returned as data; the component turns it into words. Null means say nothing.
export function updateNotice(state, { now = Date.now(), dismissal = null } = {}) {
  if (!shouldNotify(state)) return null;
  const key = noticeKey(state);
  if (dismissal && dismissal.key === key && dismissal.until > now) return null;
  const urgency = urgencyOf(state);
  const snoozeMs = state.incompatible ? SNOOZE_MS.incompatible : SNOOZE_MS[urgency];
  return {
    key,
    urgency,
    snoozeMs,
    incompatible: Boolean(state.incompatible),
    security: Boolean(state.security),
    version: state.latest?.version || '',
    page: state.latest?.page || '',
    canInstall: Boolean(state.canInstall),
    delivery: state.delivery,
    blocked: state.blocked,
  };
}
