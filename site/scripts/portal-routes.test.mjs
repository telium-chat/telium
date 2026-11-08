import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const lines = (contents) => contents.split(/\r?\n/).map((line) => line.trim())
  .filter((line) => line && !line.startsWith('#'));
const routes = lines(read('../public/_redirects')).map((line) => {
  const fields = line.split(/\s+/);
  assert.equal(fields.length, 3, 'bad redirect rule: ' + line);
  const [source, destination, status] = fields;
  assert.ok(source.startsWith('/'), source);
  assert.equal(destination, '/app.html', line);
  assert.equal(status, '200', line);
  return source;
});
const matches = (pathname) => routes.some((source) => source.endsWith('/*')
  ? pathname.startsWith(source.slice(0, -1))
  : pathname === source);

test('static rewrites preserve all SPA deep links and the migration handoff', () => {
  for (const path of [
    '/receive-move', '/receive-move/step', '/channels', '/channels/@me',
    '/invite', '/invite/abc', '/u', '/u/alice', '/login', '/login/method',
  ]) assert.equal(matches(path), true, 'client route: ' + path);
  for (const path of [
    '/', '/servers', '/download', '/receive-movements', '/assets/app.js',
    '/_telium/v1/capabilities', '/.well-known/telium/server',
  ]) assert.equal(matches(path), false, 'not a client route: ' + path);
});

test('local preview matches the Cloudflare static routing table', () => {
  const preview = read('./preview-portal.mjs');
  const m = preview.match(/const APP_ROUTES\s*=\s*(\[[^\n]+\]);/);
  assert.ok(m, 'preview must declare APP_ROUTES');
  const previewRoutes = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  const staticRoutes = routes.filter((r) => !r.endsWith('/*'));
  assert.deepEqual(previewRoutes, staticRoutes, 'preview and static rules must match');
  for (const route of previewRoutes) {
    assert.ok(routes.includes(route + '/*'), 'missing wildcard for ' + route);
  }
});

test('Cloudflare deploys static assets only, with no Worker script', () => {
  const config = read('../wrangler.jsonc');
  assert.match(config, /"directory"\s*:\s*"\.\/dist-portal"/);
  assert.match(config, /"not_found_handling"\s*:\s*"404-page"/);
  assert.doesNotMatch(config, /^\s*"main"\s*:/m);
  assert.doesNotMatch(config, /^\s*"run_worker_first"\s*:/m);
  assert.doesNotMatch(config, /^\s*"binding"\s*:/m);
  assert.equal(existsSync(new URL('../worker.ts', import.meta.url)), false);
});

test('static _headers retains all four browser security protections', () => {
  const [path, ...entries] = lines(read('../public/_headers'));
  assert.equal(path, '/*');
  const headers = Object.fromEntries(entries.map((line) => {
    const colon = line.indexOf(':');
    assert.ok(colon > 0, line);
    return [line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim()];
  }));
  assert.equal(headers['content-security-policy'],
    "object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  assert.equal(headers['x-content-type-options'], 'nosniff');
  assert.equal(headers['x-frame-options'], 'DENY');
  assert.equal(headers['referrer-policy'], 'strict-origin-when-cross-origin');
});

test('the built static portal includes the SPA shell and deploy routing rules', () => {
  const out = new URL('../dist-portal/', import.meta.url);
  for (const path of ['app.html', '_redirects', '_headers', 'index.html', '404.html']) {
    assert.ok(existsSync(new URL(path, out)), 'missing dist-portal/' + path);
  }
  assert.equal(readFileSync(new URL('_redirects', out), 'utf8'), read('../public/_redirects'));
  assert.equal(readFileSync(new URL('_headers', out), 'utf8'), read('../public/_headers'));
  assert.match(readFileSync(new URL('app.html', out), 'utf8'),
    /<meta name="telium-portal" content="1">/);
});
