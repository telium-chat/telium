'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { createDesktopUpdater } = require('./desktop-updater.cjs');

class FakeUpdater extends EventEmitter {
  constructor() {
    super();
    this.checks = 0;
    this.downloads = 0;
    this.installs = 0;
  }

  async checkForUpdates() { this.checks += 1; }
  async downloadUpdate() { this.downloads += 1; }
  quitAndInstall() { this.installs += 1; }
}

class FakeNotification extends EventEmitter {
  static supported = true;
  static shown = [];
  static isSupported() { return FakeNotification.supported; }

  constructor(options) {
    super();
    this.options = options;
  }

  show() { FakeNotification.shown.push(this); }
}

function immediateTimers() {
  return {
    setTimeoutFn: () => 1,
    clearTimeoutFn: () => {},
    setIntervalFn: () => 2,
    clearIntervalFn: () => {},
  };
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

test('self-update is limited to packaged Linux AppImages and packaged Windows builds', () => {
  const common = {
    autoUpdater: new FakeUpdater(),
    dialog: { showMessageBox: async () => ({ response: 1 }) },
    Notification: FakeNotification,
    getWindow: () => null,
    ...immediateTimers(),
  };
  assert.equal(createDesktopUpdater({ ...common, app: { isPackaged: false }, platform: 'linux', appImagePath: '/tmp/Telium.AppImage' }).supported, false);
  assert.equal(createDesktopUpdater({ ...common, app: { isPackaged: true }, platform: 'darwin', appImagePath: '/tmp/Telium.AppImage' }).supported, false);
  assert.equal(createDesktopUpdater({ ...common, app: { isPackaged: true }, platform: 'linux', appImagePath: '' }).supported, false);
  assert.equal(createDesktopUpdater({ ...common, app: { isPackaged: true }, platform: 'linux', appImagePath: '/tmp/Telium.AppImage' }).supported, true);
  assert.equal(createDesktopUpdater({ ...common, app: { isPackaged: true }, platform: 'win32', appImagePath: '' }).supported, true);
});

test('Update & restart downloads once and installs when the AppImage is ready', async () => {
  const autoUpdater = new FakeUpdater();
  const prompts = [];
  const service = createDesktopUpdater({
    app: { isPackaged: true },
    autoUpdater,
    dialog: {
      async showMessageBox(...args) {
        prompts.push(args.at(-1));
        return { response: 0 };
      },
    },
    Notification: FakeNotification,
    getWindow: () => ({ isDestroyed: () => false, isVisible: () => true, isFocused: () => true }),
    platform: 'linux',
    appImagePath: '/tmp/Telium.AppImage',
    ...immediateTimers(),
  });

  assert.equal(service.start(), true);
  autoUpdater.emit('update-available', { version: '0.2.0' });
  await tick();
  assert.equal(prompts.length, 1);
  assert.match(prompts[0].message, /0\.2\.0/);
  assert.equal(autoUpdater.downloads, 1);

  autoUpdater.emit('update-downloaded', { version: '0.2.0' });
  assert.equal(autoUpdater.installs, 1);
  service.dispose();
});

test('a hidden app uses a notification and opens the update prompt on click', async () => {
  FakeNotification.shown = [];
  const autoUpdater = new FakeUpdater();
  let shown = 0;
  let prompts = 0;
  const service = createDesktopUpdater({
    app: { isPackaged: true },
    autoUpdater,
    dialog: { showMessageBox: async () => { prompts += 1; return { response: 1 }; } },
    Notification: FakeNotification,
    getWindow: () => ({ isDestroyed: () => false, isVisible: () => false, isFocused: () => false }),
    showWindow: () => { shown += 1; },
    platform: 'linux',
    appImagePath: '/tmp/Telium.AppImage',
    ...immediateTimers(),
  });

  service.start();
  autoUpdater.emit('update-available', { version: '0.2.0' });
  assert.equal(FakeNotification.shown.length, 1);
  assert.equal(prompts, 0);

  FakeNotification.shown[0].emit('click');
  await tick();
  assert.equal(shown, 1);
  assert.equal(prompts, 1);
  service.dispose();
});

test('Later suppresses repeat prompts for the same version during this run', async () => {
  const autoUpdater = new FakeUpdater();
  let prompts = 0;
  const service = createDesktopUpdater({
    app: { isPackaged: true },
    autoUpdater,
    dialog: { showMessageBox: async () => { prompts += 1; return { response: 1 }; } },
    Notification: FakeNotification,
    getWindow: () => ({ isDestroyed: () => false, isVisible: () => true, isFocused: () => true }),
    platform: 'linux',
    appImagePath: '/tmp/Telium.AppImage',
    ...immediateTimers(),
  });

  service.start();
  autoUpdater.emit('update-available', { version: '0.2.0' });
  await tick();
  autoUpdater.emit('update-available', { version: '0.2.0' });
  await tick();
  assert.equal(prompts, 1);
  assert.equal(autoUpdater.downloads, 0);
  service.dispose();
});
