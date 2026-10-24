'use strict';

function createTrayController({
  app,
  Menu,
  Tray,
  product = 'Telium',
  icon,
  getWindow,
  createWindow,
  onWindowHidden = () => {},
  openFeedback = null,
}) {
  let tray = null;
  let quitting = false;

  const liveWindow = () => {
    const window = getWindow();
    return window && !window.isDestroyed() ? window : null;
  };

  const show = () => {
    const window = liveWindow();
    if (!window) return createWindow();

    if (window.isMinimized()) window.restore();
    if (!window.isVisible()) window.show();
    window.focus();
    return window;
  };

  const quit = () => {
    quitting = true;
    app.quit();
  };

  const reportBug = () => {
    show();
    openFeedback();
  };

  const install = () => {
    if (tray) return tray;

    tray = new Tray(icon);
    tray.setToolTip(product);
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open ' + product, click: show },
      ...(openFeedback ? [{ label: 'Report a bug…', click: reportBug }] : []),
      { type: 'separator' },
      { label: 'Quit ' + product, click: quit },
    ]));
    tray.on('click', show);
    return tray;
  };

  const handleWindowClose = (event, window) => {
    if (quitting || !tray || tray.isDestroyed()) return false;

    event.preventDefault();
    onWindowHidden(window);
    if (!window.isDestroyed()) window.hide();
    return true;
  };

  const beginQuit = () => {
    quitting = true;
  };

  const dispose = () => {
    if (tray && !tray.isDestroyed()) tray.destroy();
    tray = null;
  };

  return {
    beginQuit,
    dispose,
    handleWindowClose,
    hasTray: () => Boolean(tray && !tray.isDestroyed()),
    install,
    isQuitting: () => quitting,
    quit,
    show,
  };
}

module.exports = { createTrayController };
