'use strict';

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const STARTUP_CHECK_DELAY_MS = 12 * 1000;

function createDesktopUpdater({
  app,
  autoUpdater,
  dialog,
  Notification,
  getWindow,
  showWindow,
  platform = process.platform,
  appImagePath = process.env.APPIMAGE || '',
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
}) {
  const supported = Boolean(
    app.isPackaged
      && (platform === 'win32' || (platform === 'linux' && appImagePath)),
  );
  const updateKind = platform === 'win32' ? 'Windows installer' : 'AppImage';
  const deferred = new Set();
  const announced = new Set();
  let startupTimer = null;
  let intervalTimer = null;
  let checking = false;
  let downloading = false;
  let installing = false;
  let availableVersion = null;
  let disposed = false;

  const log = (level, message, value = null) => {
    const sink = console[level] || console.log;
    if (value == null) sink(`[Telium desktop updater] ${message}`);
    else sink(`[Telium desktop updater] ${message}`, value);
  };

  const currentWindow = () => {
    const window = getWindow?.() || null;
    return window && !window.isDestroyed?.() ? window : null;
  };

  const showMessage = async (options) => {
    const window = currentWindow();
    return window ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options);
  };

  const showDownloadFailure = async (error) => {
    if (disposed || deferred.has(availableVersion)) return;
    log('warn', 'Update download failed:', error?.message || error);
    const answer = await showMessage({
      type: 'error',
      title: 'Telium update failed',
      message: 'Telium could not download the update.',
      detail: `Your current version is unchanged. You can retry now or update the ${updateKind} manually later.`,
      buttons: ['Retry', 'Later'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (answer.response === 0) void installAvailableUpdate();
    else if (availableVersion) deferred.add(availableVersion);
  };

  const installAvailableUpdate = async () => {
    if (!supported || disposed || downloading || installing || !availableVersion) return false;
    downloading = true;
    try {
      await autoUpdater.downloadUpdate();
      return true;
    } catch (error) {
      downloading = false;
      await showDownloadFailure(error);
      return false;
    }
  };

  const promptForUpdate = async (version) => {
    if (disposed || deferred.has(version) || installing || downloading) return;
    const answer = await showMessage({
      type: 'info',
      title: 'Telium update available',
      message: `Telium ${version} is available.`,
      detail: `Update & restart downloads the new ${updateKind}, installs it, and reopens Telium automatically.`,
      buttons: ['Update & restart', 'Later'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (answer.response === 0) void installAvailableUpdate();
    else deferred.add(version);
  };

  const announceUpdate = (version) => {
    if (disposed || announced.has(version) || deferred.has(version)) return;
    announced.add(version);

    const window = currentWindow();
    if (window?.isVisible?.() && window?.isFocused?.()) {
      void promptForUpdate(version);
      return;
    }

    if (Notification.isSupported()) {
      const notification = new Notification({
        title: 'Telium update available',
        body: `Telium ${version} is ready. Click to update and restart.`,
      });
      notification.once('click', () => {
        showWindow?.();
        void promptForUpdate(version);
      });
      notification.show();
      return;
    }

    showWindow?.();
    void promptForUpdate(version);
  };

  const onChecking = () => {
    log('info', 'Checking for updates.');
  };
  const onAvailable = (info = {}) => {
    const version = String(info.version || '').trim();
    if (!version) return;
    availableVersion = version;
    log('info', `Version ${version} is available.`);
    announceUpdate(version);
  };
  const onNotAvailable = () => {
    availableVersion = null;
    log('info', 'Telium is current.');
  };
  const onDownloaded = () => {
    downloading = false;
    if (disposed || installing) return;
    installing = true;
    log('info', `Version ${availableVersion || 'update'} downloaded; restarting.`);
    autoUpdater.quitAndInstall(false, true);
  };
  const onError = (error) => {
    // Background-check errors are logged, not shown.
    log('warn', 'Updater error:', error?.message || error);
  };

  const check = async () => {
    if (!supported || disposed || checking || downloading || installing) return false;
    checking = true;
    try {
      await autoUpdater.checkForUpdates();
      return true;
    } catch (error) {
      log('warn', 'Could not check for updates:', error?.message || error);
      return false;
    } finally {
      checking = false;
    }
  };

  const start = () => {
    if (!supported || disposed) return false;

    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.allowPrerelease = false;
    autoUpdater.on('checking-for-update', onChecking);
    autoUpdater.on('update-available', onAvailable);
    autoUpdater.on('update-not-available', onNotAvailable);
    autoUpdater.on('update-downloaded', onDownloaded);
    autoUpdater.on('error', onError);

    startupTimer = setTimeoutFn(() => { void check(); }, STARTUP_CHECK_DELAY_MS);
    intervalTimer = setIntervalFn(() => { void check(); }, CHECK_INTERVAL_MS);
    return true;
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (startupTimer != null) clearTimeoutFn(startupTimer);
    if (intervalTimer != null) clearIntervalFn(intervalTimer);
    if (!supported) return;
    autoUpdater.removeListener('checking-for-update', onChecking);
    autoUpdater.removeListener('update-available', onAvailable);
    autoUpdater.removeListener('update-not-available', onNotAvailable);
    autoUpdater.removeListener('update-downloaded', onDownloaded);
    autoUpdater.removeListener('error', onError);
  };

  return {
    supported,
    start,
    check,
    installAvailableUpdate,
    dispose,
  };
}

module.exports = {
  CHECK_INTERVAL_MS,
  STARTUP_CHECK_DELAY_MS,
  createDesktopUpdater,
};
