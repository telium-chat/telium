// Serves the merged portal build locally under the same rules `worker.ts`
// applies in production: the site at its own paths, the client's app routes
// answered by app.html, the site's 404 for anything else, and the client's
// security headers on everything.
//
//   node scripts/preview-portal.mjs [dist-dir]     # PORT env overrides :8787
//
// A preview, not a development server: it serves a finished `dist-portal`
// (see build-portal.mjs) and never rebuilds anything. For the
// production-equivalent including the real worker runtime, use
// `npx wrangler dev` against the same directory.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

const root = resolve(process.argv[2] ?? 'dist-portal');
const port = Number(process.env.PORT ?? 8787);

const APP_SHELL = '/app.html';
const APP_ROUTES = ['/channels', '/invite', '/u', '/login'];

// Mirrors worker.ts, which mirrors server/src/security_headers.rs.
const SECURITY_HEADERS = {
  'content-security-policy': "object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
};

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.mp4': 'video/mp4',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
};

const typeFor = (path) => TYPES[path.slice(path.lastIndexOf('.')).toLowerCase()] ?? 'application/octet-stream';

function isAppRoute(pathname) {
  return APP_ROUTES.some((route) => pathname === route || pathname.startsWith(`${route}/`));
}

// Candidates in the order a static host would try them: the exact file, an
// index beside a trailing slash, a directory's index (the site builds
// /download as download/index.html), and a bare `.html` name.
function candidatesFor(pathname) {
  const safe = pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  const list = [safe];
  if (pathname.endsWith('/')) list.push(safe + '/index.html');
  else list.push(safe + '/index.html', safe + '.html');
  return list;
}

async function firstFile(pathname) {
  for (const candidate of candidatesFor(pathname)) {
    const resolved = resolve(join(root, '.' + candidate));
    // A resolved path outside the root is traversal, whatever it decoded from.
    if (resolved !== root && !resolved.startsWith(root + sep)) continue;
    try {
      const info = await stat(resolved);
      if (info.isDirectory()) {
        const index = join(resolved, 'index.html');
        await stat(index);
        return index;
      }
      return resolved;
    } catch { /* try the next shape */ }
  }
  return null;
}

const server = createServer(async (req, res) => {
  const send = (status, body, path) => {
    res.writeHead(status, {
      'content-type': path ? typeFor(path) : 'text/plain; charset=utf-8',
      'cache-control': 'no-cache',
      ...SECURITY_HEADERS,
    });
    res.end(body);
  };

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(405, 'Method not allowed');
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    return send(400, 'Bad request');
  }
  if (pathname.includes('\0')) return send(400, 'Bad request');

  const file = isAppRoute(pathname)
    ? join(root, APP_SHELL)
    : await firstFile(pathname);
  if (!file) {
    const notFound = await firstFile('/404.html');
    if (notFound) {
      try {
        return send(404, await readFile(notFound), notFound);
      } catch { /* fall through to the plain body */ }
    }
    return send(404, 'Not found');
  }

  try {
    send(200, req.method === 'HEAD' ? undefined : await readFile(file), file);
  } catch {
    send(500, 'Could not read the build output');
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`preview-portal: serving ${root} at http://localhost:${port}`);
  console.log('preview-portal: app routes (/channels, /invite, /u, /login) answer with the client shell.');
});
