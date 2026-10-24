// Version, build id, build time and shell, gathered once so footers and bug reports don't disagree. Substituted by Vite at build time.

/// Guarded: hosts that skip the Vite `define` (tests, Storybook) leave these undefined, and a bare reference would throw.
const read = (fn, fallback) => {
  try {
    const value = fn();
    return value === undefined || value === null ? fallback : value;
  } catch {
    return fallback;
  }
};

export const version = read(() => __APP_VERSION__, '0.0.0');

/// `dev` means the build could not establish a commit; shown as is.
export const buildId = read(() => __BUILD_ID__, 'dev');

export const builtAt = read(() => __BUILD_TIME__, '');

/// `web`, `desktop` (Electron), `desktop-tauri`, or `android`.
export const runtime = read(() => __RUNTIME__, 'web');

/// The installed desktop shell version when it differs from the bundle's (an updater replaced one and not the other); '' otherwise.
export function shellVersion() {
  const installed = read(() => globalThis.teliumDesktop?.versions?.app, '');
  return installed && installed !== version ? installed : '';
}

/// e.g. `0.1.0 · 1a2b3c4 · android · 2026-09-20T11:04:00Z`. A missing build time is dropped.
export function buildLine() {
  const shell = shellVersion();
  return [version, buildId, runtime, builtAt, shell && `shell ${shell}`]
    .filter(Boolean).join(' · ');
}

export function buildTitle() {
  const when = builtAt ? `, built ${builtAt}` : '';
  return `Telium v${version}, build ${buildId} (${runtime})${when}`;
}
