'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  START_IN_TRAY_FLAG,
  createLinuxDesktopIntegration,
  hasStartInTrayFlag,
  quoteDesktopExecArg,
} = require('./linux-desktop-integration.cjs');

async function harness(appImagePath = '/opt/Telium 0.2.AppImage') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'telium-desktop-integration-'));
  const iconBase64Path = path.join(root, 'icon.base64');
  await fs.writeFile(iconBase64Path, Buffer.from('png-bytes').toString('base64'));
  const integration = createLinuxDesktopIntegration({
    platform: 'linux',
    isPackaged: true,
    appImagePath,
    homeDir: root,
    xdgDataHome: path.join(root, 'data'),
    xdgConfigHome: path.join(root, 'config'),
    iconBase64Path,
  });
  return { integration, root };
}

test('integration is limited to packaged Linux AppImages', async () => {
  for (const options of [
    { platform: 'darwin', isPackaged: true, appImagePath: '/tmp/Telium.AppImage' },
    { platform: 'linux', isPackaged: false, appImagePath: '/tmp/Telium.AppImage' },
    { platform: 'linux', isPackaged: true, appImagePath: null },
    { platform: 'linux', isPackaged: true, appImagePath: 'relative.AppImage' },
  ]) {
    const integration = createLinuxDesktopIntegration(options);
    assert.deepEqual(await integration.state(), {
      supported: false,
      launcherInstalled: false,
      startOnLogin: false,
    });
  }
});

test('application launcher toggle installs a per-user desktop entry and icon', async (t) => {
  const { integration, root } = await harness();
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  assert.deepEqual(await integration.setLauncherInstalled(true), {
    supported: true,
    launcherInstalled: true,
    startOnLogin: false,
  });
  const entry = await fs.readFile(integration.paths.launcherPath, 'utf8');
  assert.match(entry, /^\[Desktop Entry\]/);
  assert.match(entry, /^Exec="\/opt\/Telium 0\.2\.AppImage"$/m);
  assert.match(entry, /^StartupWMClass=chat\.telium\.Telium$/m);
  assert.doesNotMatch(entry, new RegExp(START_IN_TRAY_FLAG));
  assert.equal(await fs.readFile(integration.paths.iconPath, 'utf8'), 'png-bytes');

  await integration.setLauncherInstalled(false);
  assert.equal((await integration.state()).launcherInstalled, false);
  await assert.rejects(fs.access(integration.paths.launcherPath), { code: 'ENOENT' });
  await assert.rejects(fs.access(integration.paths.iconPath), { code: 'ENOENT' });
});

test('login startup uses the tray-only flag and remains independent of the launcher', async (t) => {
  const { integration, root } = await harness();
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const state = await integration.setStartOnLogin(true);
  assert.deepEqual(state, {
    supported: true,
    launcherInstalled: false,
    startOnLogin: true,
  });
  const entry = await fs.readFile(integration.paths.autostartPath, 'utf8');
  assert.match(entry, /^Exec="\/opt\/Telium 0\.2\.AppImage" --start-in-tray$/m);
  assert.match(entry, /^X-GNOME-Autostart-enabled=true$/m);

  await integration.setStartOnLogin(false);
  assert.equal((await integration.state()).startOnLogin, false);
});

test('desktop Exec quoting handles special AppImage path characters', () => {
  assert.equal(
    quoteDesktopExecArg('/tmp/Te%li$um` "x"\\build.AppImage'),
    '"/tmp/Te%%li\\$um\\` \\"x\\"\\\\build.AppImage"',
  );
});

test('tray-only startup flag is detected from argv', () => {
  assert.equal(hasStartInTrayFlag(['electron', '/tmp/Telium.AppImage', START_IN_TRAY_FLAG]), true);
  assert.equal(hasStartInTrayFlag(['electron', '/tmp/Telium.AppImage']), false);
});

test('existing desktop entries are repointed after an AppImage filename changes', async (t) => {
  const first = await harness('/downloads/Telium_0.2.0_x64.AppImage');
  t.after(() => fs.rm(first.root, { recursive: true, force: true }));
  await first.integration.setLauncherInstalled(true);
  await first.integration.setStartOnLogin(true);

  const second = createLinuxDesktopIntegration({
    platform: 'linux',
    isPackaged: true,
    appImagePath: '/downloads/Telium_0.3.0_x64.AppImage',
    homeDir: first.root,
    xdgDataHome: path.join(first.root, 'data'),
    xdgConfigHome: path.join(first.root, 'config'),
    iconBase64Path: path.join(first.root, 'icon.base64'),
  });

  await second.refreshExisting();
  const launcher = await fs.readFile(second.paths.launcherPath, 'utf8');
  const autostart = await fs.readFile(second.paths.autostartPath, 'utf8');
  assert.match(launcher, /Telium_0\.3\.0_x64\.AppImage/);
  assert.match(autostart, /Telium_0\.3\.0_x64\.AppImage" --start-in-tray/);
  assert.doesNotMatch(launcher, /Telium_0\.2\.0/);
  assert.doesNotMatch(autostart, /Telium_0\.2\.0/);
});
