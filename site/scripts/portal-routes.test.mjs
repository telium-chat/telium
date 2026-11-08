import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Both the Cloudflare Worker and local preview independently route client deep links.
// Keep the two deploy paths aligned and protect the migration handoff entry point.
function appRoutes(path) {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8');
  const match = source.match(/const APP_ROUTES\s*=\s*(\[[^\n]+\]);/);
  assert.ok(match, `${path} should declare APP_ROUTES`);
  const routes = [...match[1].matchAll(/'([^']+)'/g)].map(([, route]) => route);
  assert.ok(routes.length, `${path} should have app routes`);
  return routes;
}

function matchesAppRoute(routes, pathname) {
  return routes.some((route) => pathname === route || pathname.startsWith(`${route}/`));
}

test('production and preview route migration handoffs to the client', () => {
  const production = appRoutes('../worker.ts');
  const preview = appRoutes('./preview-portal.mjs');
  assert.deepEqual(production, preview, 'preview must mirror the production Worker');
  for (const routes of [production, preview]) {
    for (const pathname of ['/receive-move', '/receive-move/step', '/channels/@me', '/login']) {
      assert.equal(matchesAppRoute(routes, pathname), true, pathname);
    }
    for (const pathname of ['/', '/download', '/receive-movements', '/_telium/v1/capabilities']) {
      assert.equal(matchesAppRoute(routes, pathname), false, pathname);
    }
  }
});
