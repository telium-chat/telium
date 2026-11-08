// Run against local Wrangler, not the custom preview server. Cloudflare's
// HTML URL canonicalization previously turned our 200 rewrite to /app.html
// into a 307 redirect to /app, losing /receive-move and the handoff fragment.
import assert from 'node:assert/strict';

const origin = process.env.TELIUM_ASSET_SMOKE_ORIGIN || 'http://127.0.0.1:8787';

async function request(path) {
  const response = await fetch(origin + path, { redirect: 'manual' });
  const body = await response.text();
  return { response, body };
}

let ready = false;
for (let attempt = 0; attempt < 80; attempt += 1) {
  try {
    await request('/');
    ready = true;
    break;
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}
assert.ok(ready, 'Wrangler local asset runtime did not start within 40 seconds');

for (const path of [
  '/receive-move', '/receive-move/', '/channels', '/channels/@me',
  '/invite/test-code', '/u/@alice:example.org', '/login', '/app/',
]) {
  const { response, body } = await request(path);
  assert.equal(response.status, 200, path + ': must serve 200, not a 307 or 404');
  assert.equal(response.headers.get('location'), null, path + ': redirect would lose the handoff fragment');
  assert.match(body, /<meta name="telium-portal" content="1">/, path + ': must serve React client shell');
}

for (const path of ['/', '/download/', '/servers/']) {
  const { response, body } = await request(path);
  assert.equal(response.status, 200, path + ': marketing routes must survive');
  assert.doesNotMatch(body, /<meta name="telium-portal" content="1">/, path + ': must not be the React client');
}

const { response } = await request('/does-not-exist-in-telium');
assert.equal(response.status, 404, 'unrecognized URLs still return a real 404');

console.log('Cloudflare Static Assets smoke test passed: no 307, handoff URL preserved.');
