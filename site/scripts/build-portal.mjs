// Merges the marketing site's build with the web client's into one deployable
// directory, so telium.chat can carry both: the site keeps its own paths (and
// `/`), and the client answers its app routes on the same domain.
//
//   node scripts/build-portal.mjs [site-dist] [web-dist] [out]
//
// Defaults: ./dist, ../web/dist, ./dist-portal. The two inputs are the plain
// `astro build` and `vite build` outputs; this script never builds anything.
//
// What the overlay does, and why:
//
//   - web's index.html becomes app.html. The site's index.html must stay at
//     `/`, and a static directory has one index.html, so the client's shell
//     moves to a name of its own and the worker serves it for the app routes.
//     The client's asset paths are absolute from the site root, so the shell
//     works from either name unchanged.
//   - sw.js is rewritten to precache and fall back to /app.html. The client
//     emitted it for a homeserver's copy, where the shell *is* index.html; on
//     the portal that path is the marketing site, and an offline visitor at
//     /channels/@me must get the app, not the homepage.
//   - everything else overlays by exact path. Both builds ship public/ files
//     (brand marks, favicons) under the same names; where a name exists in
//     both, the bytes must match, because one of them is quietly serving the
//     other's file. A difference is a branding bug to fix at the source, not
//     something to resolve by precedence here.
//
// The routing contract this artifact implements lives in the worker
// (`worker.ts`) and is documented in README.md, "The portal build".

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const siteDist = resolve(process.argv[2] ?? 'dist');
const webDist = resolve(process.argv[3] ?? '../web/dist');
const out = resolve(process.argv[4] ?? 'dist-portal');

for (const dir of [siteDist, webDist]) {
  if (!existsSync(dir)) {
    console.error(`build-portal: ${relative(process.cwd(), dir)} does not exist.`);
    console.error('Build both packages first: `bun run --cwd ../web build` and `bun run build`.');
    process.exit(1);
  }
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(siteDist, out, { recursive: true });

// Bytes-for-bytes, so "the same file" is checked rather than assumed.
function sameFile(a, b) {
  if (statSync(a).size !== statSync(b).size) return false;
  return readFileSync(a).equals(readFileSync(b));
}

function overlay(from, to) {
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const src = join(from, entry.name);
    const dest = join(to, entry.name);
    if (entry.isDirectory()) {
      mkdirSync(dest, { recursive: true });
      overlay(src, dest);
      continue;
    }
    // web's index.html is not overlaid: it became app.html above, and the name
    // index.html belongs to the site here.
    if (src === join(webDist, 'index.html')) continue;
    if (existsSync(dest)) {
      if (sameFile(src, dest)) continue;
      console.error(
        `build-portal: ${relative(process.cwd(), src)} and its site counterpart `
        + `differ, but both builds ship that path. One of them is serving the `
        + `other's file; rename one or make them identical.`,
      );
      process.exit(1);
    }
    cpSync(src, dest);
  }
}

// The client's shell, under a name the site does not use, carrying the marker
// the client reads to know it is the portal (`isPortalHost` in
// web/src/lib/homeserver.js).
const shell = readFileSync(join(webDist, 'index.html'), 'utf8');
const marked = shell.replace(
  '</head>',
  '<meta name="telium-portal" content="1"></head>',
);
if (marked === shell) {
  console.error('build-portal: the client index.html has no </head>; refusing to guess.');
  process.exit(1);
}
writeFileSync(join(out, 'app.html'), marked);

overlay(webDist, out);

// sw.js: the shell it precaches and falls back to is app.html here. Both the
// placeholder the build replaced and the precache entry carry the quoted
// literal, and both must move together.
const swPath = join(out, 'sw.js');
const sw = readFileSync(swPath, 'utf8');
const rewritten = sw.replaceAll('"/index.html"', '"/app.html"');
const moved = (sw.match(/"\/index\.html"/g) ?? []).length;
if (!moved) {
  console.error('build-portal: the emitted sw.js does not name /index.html; the shell rewrite found nothing to do.');
  process.exit(1);
}
writeFileSync(swPath, rewritten);

console.log(`build-portal: wrote ${relative(process.cwd(), out)} from `
  + `${relative(process.cwd(), siteDist)} + ${relative(process.cwd(), webDist)} `
  + `(${moved} shell reference${moved === 1 ? '' : 's'} rewritten in sw.js).`);
