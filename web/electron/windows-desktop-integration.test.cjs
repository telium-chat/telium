'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  START_IN_TRAY_FLAG,
  createWindowsDesktopIntegration,
} = require('./windows-desktop-integration.cjs');

function fakeApp(initial = {}) {
  let settings = {
    openAtLogin: false,
    executableWillLaunchAtLogin: false,
    ...initial,
  };
  const calls = [];
  return {
    calls,
    getLoginItemSettings(options) {
      calls.push(['get', options]);
      return { ...settings };
    },
    setLoginItemSettings(next) {
      calls.push(['set', next]);
      settings = {
        ...settings,
        openAtLogin: Boolean(next.openAtLogin),
        executableWillLaunchAtLogin: Boolean(next.openAtLogin && next.enabled !== false),
      };
    },
  };
}

test('integration is limited to packaged Windows builds', async () => {
  for (const options of [
    { platform: 'linux', isPackaged: true, app: fakeApp() },
    { platform: 'win32', isPackaged: false, app: fakeApp() },
    { platform: 'win32', isPackaged: true, app: {} },
  ]) {
    const integration = createWindowsDesktopIntegration(options);
    assert.deepEqual(await integration.state(), {
      supported: false,
      platform: 'windows',
      launcherInstalled: false,
      launcherConfigurable: false,
      startOnLogin: false,
      startupRegistered: false,
      startupDisabledBySystem: false,
    });
  }
});

test('start-on-login registers Telium with the tray-only flag', async () => {
  const app = fakeApp();
  const integration = createWindowsDesktopIntegration({
    app,
    platform: 'win32',
    isPackaged: true,
  });

  assert.deepEqual(await integration.setStartOnLogin(true), {
    supported: true,
    platform: 'windows',
    launcherInstalled: true,
    launcherConfigurable: false,
    startOnLogin: true,
    startupRegistered: true,
    startupDisabledBySystem: false,
  });

  const setCall = app.calls.find(([kind]) => kind === 'set');
  assert.deepEqual(setCall, ['set', {
    openAtLogin: true,
    enabled: true,
    args: [START_IN_TRAY_FLAG],
  }]);

  const getCall = app.calls.find(([kind]) => kind === 'get');
  assert.deepEqual(getCall, ['get', { args: [START_IN_TRAY_FLAG] }]);
});

test('turning startup off removes the same tray-only login item', async () => {
  const app = fakeApp({ openAtLogin: true, executableWillLaunchAtLogin: true });
  const integration = createWindowsDesktopIntegration({
    app,
    platform: 'win32',
    isPackaged: true,
  });

  const state = await integration.setStartOnLogin(false);
  assert.equal(state.startOnLogin, false);
  assert.equal(state.startupRegistered, false);

  const setCall = app.calls.find(([kind]) => kind === 'set');
  assert.deepEqual(setCall, ['set', {
    openAtLogin: false,
    enabled: false,
    args: [START_IN_TRAY_FLAG],
  }]);
});

test('Windows-disabled startup is reported as disabled without losing registration state', async () => {
  const app = fakeApp({ openAtLogin: true, executableWillLaunchAtLogin: false });
  const integration = createWindowsDesktopIntegration({
    app,
    platform: 'win32',
    isPackaged: true,
  });

  assert.deepEqual(await integration.state(), {
    supported: true,
    platform: 'windows',
    launcherInstalled: true,
    launcherConfigurable: false,
    startOnLogin: false,
    startupRegistered: true,
    startupDisabledBySystem: true,
  });
});
