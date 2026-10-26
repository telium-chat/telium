// The worker in front of telium.chat's static assets. Two jobs, both of them
// about the app routes (`/channels/*`, `/invite/*`, `/u/*`, `/login`) that the
// web client owns on this domain:
//
//   - they answer with the app shell (`app.html`, the client's own index.html
//     renamed by build-portal.mjs), because a static directory cannot fall
//     back per-path the way a homeserver serving the client does;
//   - every response carries the security headers a homeserver sets for this
//     same client. On a homeserver they come from server/src/security_headers.rs;
//     here the worker is the origin, so it sets the same ones.
//
// Everything else passes through to the assets untouched, so the marketing
// site behaves exactly as it would without a worker.

const APP_SHELL = '/app.html';

const APP_ROUTES = ['/channels', '/invite', '/u', '/login'];

// Mirrors server/src/security_headers.rs, CSP included. The CSP deliberately
// has no connect-src: the client talks to whatever homeserver an account
// names, by absolute URL, and the server's own policy for this client does
// the same.
const SECURITY_HEADERS: Array<[string, string]> = [
  ['content-security-policy', "object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"],
  ['x-content-type-options', 'nosniff'],
  ['x-frame-options', 'DENY'],
  ['referrer-policy', 'strict-origin-when-cross-origin'],
];

function isAppRoute(pathname: string): boolean {
  return APP_ROUTES.some((route) => pathname === route || pathname.startsWith(`${route}/`));
}

interface Env {
  ASSETS: { fetch: (request: Request) => Promise<Response> };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', {
        status: 405,
        headers: { allow: 'GET, HEAD' },
      });
    }

    const url = new URL(request.url);
    const target = isAppRoute(url.pathname) ? new URL(APP_SHELL, url) : url;
    const asset = await env.ASSETS.fetch(new Request(target, {
      method: request.method,
      headers: request.headers,
    }));

    // Rebuilt rather than passed through: a forwarded content-length would
    // describe the asset, not this response, and body reuse makes it stale.
    const headers = new Headers(asset.headers);
    headers.delete('content-length');
    headers.delete('content-encoding');
    for (const [name, value] of SECURITY_HEADERS) headers.set(name, value);
    return new Response(asset.body, {
      status: asset.status,
      statusText: asset.statusText,
      headers,
    });
  },
};
