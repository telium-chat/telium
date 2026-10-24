'use strict';

const START_IN_TRAY_FLAG = '--start-in-tray';

function createWindowsDesktopIntegration({
  app,
  platform = process.platform,
  isPackaged = false,
} = {}) {
  const supported = platform === 'win32'
    && Boolean(isPackaged)
    && typeof app?.getLoginItemSettings === 'function'
    && typeof app?.setLoginItemSettings === 'function';

  const loginOptions = {
    args: [START_IN_TRAY_FLAG],
  };

  const state = async () => {
    if (!supported) {
      return {
        supported: false,
        platform: 'windows',
        launcherInstalled: false,
        launcherConfigurable: false,
        startOnLogin: false,
        startupRegistered: false,
        startupDisabledBySystem: false,
      };
    }

    const settings = app.getLoginItemSettings(loginOptions);
    const startupRegistered = Boolean(settings?.openAtLogin);
    const executableWillLaunch = settings?.executableWillLaunchAtLogin;
    const startupDisabledBySystem = startupRegistered && executableWillLaunch === false;

    return {
      supported: true,
      platform: 'windows',
      // NSIS owns shortcuts; present only for Linux state-shape parity.
      launcherInstalled: true,
      launcherConfigurable: false,
      startOnLogin: startupRegistered && !startupDisabledBySystem,
      startupRegistered,
      startupDisabledBySystem,
    };
  };

  const setStartOnLogin = async (enabled) => {
    if (!supported) {
      throw new Error('Windows desktop integration is available only in a packaged Telium app.');
    }

    app.setLoginItemSettings({
      openAtLogin: Boolean(enabled),
      enabled: Boolean(enabled),
      ...loginOptions,
    });
    return state();
  };

  return {
    setStartOnLogin,
    state,
    supported,
  };
}

module.exports = {
  START_IN_TRAY_FLAG,
  createWindowsDesktopIntegration,
};
