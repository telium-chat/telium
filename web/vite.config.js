import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Emits the service worker with the build's own asset list baked in.
//
// A precache manifest has to be written by whoever knows the hashed filenames,
// which is the bundler and nobody else. Hand-maintaining the list is how a
// service worker ends up serving half of last week's build: the shell it
// cached and the chunks it did not.
//
// Only the critical shell is precached: the document, the stylesheet and the
// entry chunk. The lazily-imported emoji datasets and the two dozen font
// subsets for scripts this user may never read are left to be cached on first
// use by the same cache-first rule -- they are content-hashed either way, so
// the only difference is whether the install pays for them up front. It also
// keeps `addAll` honest: it is atomic, and a thirty-file manifest is thirty
// chances for one 404 to fail the whole installation.
function serviceWorker() {
  return {
    name: 'telium-service-worker',
    configureServer(server) {
      // Production emits the worker as a build asset. Development needs the
      // same Gofile request adapter, but none of the shell caching that made an
      // old production worker poison a Vite session. Serve a live worker with
      // an empty precache and a fixed dev cache name.
      server.middlewares.use((req, res, next) => {
        const path = (req.url || '').split('?', 1)[0];
        if (path === '/notification-inbox-runtime.js') {
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
          res.setHeader('Cache-Control', 'no-store');
          res.end(readFileSync('src/lib/browser-notification-inbox-runtime.js', 'utf8'));
          return;
        }
        if (path !== '/sw.js') { next(); return; }
        const source = readFileSync('src/sw.js', 'utf8')
          .replace('self.__PRECACHE__', '[]')
          .replace('self.__PRECACHE_VERSION__', JSON.stringify('dev'));
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.end(source);
      });
    },
    generateBundle(_options, bundle) {
      const critical = Object.entries(bundle)
        .filter(([name, chunk]) => chunk.isEntry || name.endsWith('.css'))
        .map(([name]) => `/${name}`);
      const shell = ['/index.html', ...critical];
      const source = readFileSync('src/sw.js', 'utf8')
        .replace('self.__PRECACHE__', JSON.stringify(shell))
        .replace('self.__SHELL_URL__', JSON.stringify(shell[0]))
        // The version is the manifest itself: a build that emits identical
        // assets should not evict a cache that already holds them.
        .replace('self.__PRECACHE_VERSION__', JSON.stringify(hash(shell.join('|'))));
      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
      this.emitFile({
        type: 'asset',
        fileName: 'notification-inbox-runtime.js',
        source: readFileSync('src/lib/browser-notification-inbox-runtime.js', 'utf8'),
      });
    },
  };
}

/// FNV-1a. Not a security hash -- it names a cache bucket.
function hash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

// The client talks to whatever servers the session names, by absolute URL, so
// there is nothing to bake in at build time. The proxy below exists only so
// that `bun run dev` on :5173 can still guess `location.origin` as the home
// server and reach a real one; set TELIUM_ORIGIN to point it somewhere else.
// By name rather than by literal address: a server bound to IPv6 loopback and
// a browser that resolves `localhost` to the other family are otherwise a
// connection refused that looks like the dev server being down.
const origin = process.env.TELIUM_ORIGIN || 'http://localhost:8448';

// What the settings footer says the app is, and what a bug report needs it to
// say. The version is the one people quote at each other; the build id is the
// one that actually identifies the code, because a version number sits still
// for months while the thing deployed under it moves every afternoon. Both are
// read here rather than typed into the component, so the footer cannot drift
// from `package.json` and cannot claim a build it isn't.
//
// `TELIUM_APP_VERSION` overrides it for a release build, because the release
// tag is the version and the package file is not. The Android release workflow
// sets it from an `android-v*` tag, and `build-android.sh` stamps the same
// string into the APK's `versionName` -- one number, so the build a phone
// reports in its footer, the build the manifest compares, and the tag somebody
// pushed all agree. Nothing else sets it, so every other build still reads
// `package.json`.
const version = process.env.TELIUM_APP_VERSION
  || JSON.parse(readFileSync('package.json', 'utf8')).version;

// Which shell this bundle is being built for.
//
// The same source builds four things -- a web client, an Electron desktop app,
// an Android app and the copy the homeserver serves -- and a bug report that
// does not say which one it came from is a bug report that starts with a round
// of questions. Vite already knows: Tauri and Electron each set an environment
// variable that the `base` option below is keyed off. This reads the same two.
const runtime = process.env.TAURI_ENV_PLATFORM
  ? (process.env.TAURI_ENV_PLATFORM === 'android' ? 'android' : 'desktop-tauri')
  : process.env.TELIUM_ELECTRON ? 'desktop'
  : 'web';

// When this bundle was built, as a whole second, ISO-8601, UTC.
//
// A build id identifies the source; this identifies the build. They are not
// the same question and the gap between them is exactly the thing that goes
// wrong in a container deployment: an image built in March from a commit made
// in March is fine, and an image built in March that somebody is still running
// in September is the entire subject of `server/src/updates.rs`.
//
// `TELIUM_BUILD_TIME` is seconds since the epoch, the same variable and the
// same units the server's `build.rs` reads, so a container's client and its
// server report the same instant rather than two that differ by the length of
// a Rust compile.
const buildTime = process.env.TELIUM_BUILD_TIME
  ? new Date(Number(process.env.TELIUM_BUILD_TIME) * 1000).toISOString().replace(/\.\d+Z$/, 'Z')
  : new Date().toISOString().replace(/\.\d+Z$/, 'Z');

export default defineConfig({
  plugins: [react(), tailwindcss(), serviceWorker()],
  define: {
    __APP_VERSION__: JSON.stringify(version),
    __BUILD_TIME__: JSON.stringify(buildTime),
    __RUNTIME__: JSON.stringify(runtime),
    __BUILD_ID__: JSON.stringify(
      process.env.TELIUM_BUILD_ID
      || (() => {
        try {
          return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
            .toString().trim();
        } catch { return 'dev'; }
      })(),
    ),
  },
  // Tauri and Electron both load production assets from an application-local
  // URL rather than from a web-server root. Electron uses file:// for the
  // packaged renderer, so its asset references must be relative as well.
  base: process.env.TAURI_ENV_PLATFORM || process.env.TELIUM_ELECTRON ? './' : '/',
  // Dependency discovery only needs the actual web entry. Without this Vite
  // treats every generated .html file under src-tauri/target as a possible
  // application entry, which makes Android/Desktop build artifacts participate
  // in dev-server parsing and can surface stale generated sources as web errors.
  optimizeDeps: {
    entries: ['index.html'],
  },
  build: {
    outDir: 'dist',
    // The Rust server serves this directory with an index.html fallback, so the
    // asset paths have to be absolute from the site root in normal web builds.
    assetsDir: 'assets',
    // Source maps for the bundle a homeserver serves, and only for that one.
    //
    // A self-hosted operator debugging a production build is the case this
    // exists for, and there the maps are fetched on demand by a devtools
    // window that somebody deliberately opened. In a packaged client they are
    // dead weight: nothing loads them, and Tauri embeds the whole `dist`
    // directory into the app's native library, so they ship to every phone
    // and every desktop install. Measured on the Android release APK, turning
    // them off takes it from 23.9 MB to 19.7 MB -- 4 MB of nobody's source,
    // in a file people download over mobile data.
    sourcemap: runtime === 'web',
  },
  server: {
    host: '0.0.0.0',
    allowedHosts: true,
    // Vite's CORS middleware runs before its proxy middleware and handles
    // OPTIONS itself. Disable it so Telium API preflights are forwarded to the
    // homeserver, whose CORS policy intentionally allows cross-origin clients.
    cors: false,
    port: 5173,
    proxy: {
      '/_telium': { target: origin, changeOrigin: true },
      '/.well-known': { target: origin, changeOrigin: true },
      '/gateway': { target: origin, ws: true, changeOrigin: true },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.js'],
    // Password hardening at RFC parameters, under jsdom, times a hundred and
    // thirty sign-ins. See the module for what this does and does not change.
    // Anchored, so the wrapper's own deep import reaches the real package.
    alias: [{
      find: /^@serenity-kit\/opaque$/,
      replacement: new URL('./src/test/opaque-ksf.js', import.meta.url).pathname,
    }, {
      // The Linux desktop build's D-Bus binding is a packaging-time native
      // dependency and is not in this tree. The MPRIS source imports it
      // dynamically and copes when it is missing, but Vite resolves the
      // specifier to transform the file either way, so testing that module's
      // pure halves needs something at the name. See the stub for why it bites.
      find: /^@jellybrick\/dbus-next$/,
      replacement: new URL('./src/test/dbus-absent.js', import.meta.url).pathname,
    }],
    include: ['src/test/**/*.{test,spec}.{js,jsx,ts,tsx}'],
    // One number, and it is this one.
    //
    // Vitest's per-test timeout -- the third argument to `it(...)` -- is not a
    // restatement of this default and not a floor. It is a hard value that
    // *replaces* the default and *beats the command line*, so it caps a test
    // just as readily as it raises one. `--testTimeout=240000` does nothing at
    // all for any test carrying a literal, which is how the slow suites here
    // earned their reputation: 148 tests passed `30_000` individually and the
    // whole-app ones passed `60_000` or `90_000`, so under parallel load the
    // one lever that grants more time was the one lever they all ignored, and
    // `dm-actions`, `repro-picker` and `smoke` were written off as flaky for
    // it. Raising the CLI to four minutes and watching three of them still
    // fail at exactly 60000ms is what settled the argument.
    //
    // So every literal is gone and the budget lives here, set to what the
    // slowest test in the suite needs rather than what the median one does.
    // That is the cost of the property being bought: a genuinely hung test now
    // takes a minute and a half to say so instead of thirty seconds, in
    // exchange for `--testTimeout` meaning something on every test in the
    // tree, which is what a loaded CI box and a laptop running the suite
    // alongside fifteen other things both need. Change the number here, or
    // pass `--testTimeout`; do not give `it(...)` a third argument.
    testTimeout: 90_000,
    hookTimeout: 90_000,
  },
});
