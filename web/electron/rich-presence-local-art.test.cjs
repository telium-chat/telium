'use strict';

const assert = require('node:assert/strict');
const { mkdtemp, rm, writeFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');
const { createLocalArtworkRegistry, localFileUrl } = require('./rich-presence-local-art.cjs');

test('local artwork registry exposes opaque handles, not filesystem paths', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'telium-art-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const filename = path.join(dir, 'cover.png');
  await writeFile(filename, Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d,
  ]));

  const registry = createLocalArtworkRegistry();
  const url = pathToFileURL(filename).href;
  const handle = registry.register(url, 'Spotify\0Track one\0Artist');
  assert.match(handle, /^mpris-art:[0-9a-f]{32}$/);
  assert.equal(handle.includes(dir), false);
  assert.equal(registry.register(url, 'Spotify\0Track one\0Artist'), handle);
  assert.notEqual(registry.register(url, 'Spotify\0Track two\0Artist'), handle);

  const payload = await registry.read(handle);
  assert.equal(payload.mime, 'image/png');
  assert.equal(payload.bytes.byteLength, 12);
  registry.clear();
  assert.equal(await registry.read(handle), null);
});

test('local artwork registry rejects non-file and remote file URLs', () => {
  assert.equal(localFileUrl('https://example.com/cover.png'), null);
  assert.equal(localFileUrl('file://remote.example/home/alice/cover.png'), null);
});
