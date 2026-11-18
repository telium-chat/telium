'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createProgramIcons, execProgram, parseDesktopEntry } = require('./program-icons.cjs');
const { createLocalArtworkRegistry } = require('./rich-presence-local-art.cjs');

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 1, 2, 3]);

function fakeFs(files) {
  return {
    readdir: async (dir) => {
      const names = Object.keys(files).filter((f) => f.startsWith(`${dir}/`) && !f.slice(dir.length + 1).includes('/'));
      if (!names.length) throw new Error('ENOENT');
      return names.map((f) => f.slice(dir.length + 1));
    },
    readFile: async (file) => { if (!(file in files)) throw new Error('ENOENT'); return files[file]; },
    stat: async (file) => {
      if (!(file in files)) throw new Error('ENOENT');
      return { isFile: () => true, size: Buffer.byteLength(files[file]) };
    },
  };
}

test('Exec lines resolve to the program, skipping env and quotes', () => {
  assert.equal(execProgram('blender %f'), 'blender');
  assert.equal(execProgram('env FOO=1 "/opt/My App/MyApp" --x'), 'myapp');
  assert.equal(execProgram(''), null);
});

test('desktop entries: main group only, hidden ones dropped', () => {
  assert.deepEqual(parseDesktopEntry('[Desktop Entry]\nExec=blender %f\nIcon=blender\n[Desktop Action x]\nExec=other\n'), { exec: 'blender %f', icon: 'blender' });
  assert.equal(parseDesktopEntry('[Desktop Entry]\nHidden=true\nExec=x\n'), null);
});

test('Linux: finds the icon through the desktop entry and the hicolor theme', async () => {
  const files = {
    '/h/.local/share/applications/blender.desktop': '[Desktop Entry]\nExec=blender %f\nIcon=blender\n',
    '/usr/share/icons/hicolor/48x48/apps/blender.png': PNG,
    '/usr/share/icons/hicolor/256x256/apps/blender.png': PNG,
  };
  const icons = createProgramIcons({ platform: 'linux', home: '/h', ...fakeFs(files), toPng: (b, size) => Buffer.concat([b, Buffer.from([size])]) });
  const out = await icons.iconFor('Blender', '/usr/bin/blender', 64);
  assert.equal(out[out.length - 1], 64);
  assert.equal(await icons.iconFor('unknown', '/usr/bin/unknown'), null);
});

test('Linux: a Windows path (Proton) has no icon, and SVG-only themes give none', async () => {
  const files = {
    '/h/.local/share/applications/app.desktop': '[Desktop Entry]\nExec=app\nIcon=app\n',
    '/usr/share/icons/hicolor/scalable/apps/app.svg': '<svg/>',
  };
  const icons = createProgramIcons({ platform: 'linux', home: '/h', ...fakeFs(files) });
  assert.equal(await icons.iconFor('app', 'S:\\Games\\app.exe'), null);
});

test('Windows: reads the icon from the executable and resizes it', async () => {
  const seen = [];
  const icons = createProgramIcons({
    platform: 'win32', getFileIcon: async (f) => { seen.push(f); return PNG; }, toPng: (b) => b,
  });
  assert.equal(await icons.iconFor('app.exe', '/x/app.exe'), PNG);
  assert.equal(await icons.iconFor('app.exe', '/x/app.exe'), PNG);
  assert.equal(seen.length, 1);
});

test('the artwork registry hands out an opaque handle for icon bytes and only accepts PNG', async () => {
  const registry = createLocalArtworkRegistry();
  const handle = registry.registerBytes('blender', PNG);
  assert.match(handle, /^program-icon:/);
  const read = await registry.read(handle);
  assert.equal(read.mime, 'image/png');
  assert.equal(Buffer.from(read.bytes).equals(PNG), true);
  assert.equal(registry.registerBytes('x', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), null);
});
