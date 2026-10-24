'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createTrayController } = require('./tray-lifecycle.cjs');

function fakeWindow({ minimized = false, visible = true, destroyed = false } = {}) {
  const calls = [];
  return {
    calls,
    isDestroyed: () => destroyed,
    isMinimized: () => minimized,
    isVisible: () => visible,
    restore() { calls.push('restore'); minimized = false; },
    show() { calls.push('show'); visible = true; },
    focus() { calls.push('focus'); },
    hide() { calls.push('hide'); visible = false; },
  };
}

function harness(window = fakeWindow(), extra = {}) {
  const appCalls = [];
  const trayCalls = [];
  const menus = [];
  let currentWindow = window;
  let created = 0;

  class FakeTray {
    constructor(icon) {
      this.icon = icon;
      this.handlers = new Map();
      this.destroyed = false;
      trayCalls.push(['new', icon]);
    }
    setToolTip(value) { trayCalls.push(['tooltip', value]); }
    setContextMenu(value) { trayCalls.push(['menu', value]); }
    on(event, handler) { this.handlers.set(event, handler); }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; trayCalls.push(['destroy']); }
  }

  const controller = createTrayController({
    app: { quit() { appCalls.push('quit'); } },
    Menu: {
      buildFromTemplate(template) {
        menus.push(template);
        return template;
      },
    },
    Tray: FakeTray,
    product: 'Telium',
    icon: { kind: 'tray-icon' },
    getWindow: () => currentWindow,
    createWindow: () => {
      created += 1;
      currentWindow = fakeWindow();
      return currentWindow;
    },
    onWindowHidden: (hidden) => hidden.calls.push('hidden-focus-false'),
    ...extra,
  });

  return {
    appCalls,
    controller,
    get created() { return created; },
    menus,
    trayCalls,
    window,
  };
}

test('tray installs once with open and explicit quit actions', () => {
  const h = harness();
  const first = h.controller.install();
  const second = h.controller.install();

  assert.equal(first, second);
  assert.deepEqual(h.trayCalls.slice(0, 3), [
    ['new', { kind: 'tray-icon' }],
    ['tooltip', 'Telium'],
    ['menu', h.menus[0]],
  ]);
  assert.deepEqual(h.menus[0].map((entry) => entry.label || entry.type), [
    'Open Telium',
    'separator',
    'Quit Telium',
  ]);
});

test('a tray with nowhere to send feedback does not offer the item', () => {
  const h = harness();
  h.controller.install();
  assert.deepEqual(h.menus[0].map((entry) => entry.label || entry.type), [
    'Open Telium',
    'separator',
    'Quit Telium',
  ]);
});

test('an openFeedback callback adds report-a-bug, and clicking reveals then signals', () => {
  const feedbackCalls = [];
  const h = harness(fakeWindow(), { openFeedback: () => feedbackCalls.push('feedback') });
  h.controller.install();

  assert.deepEqual(h.menus[0].map((entry) => entry.label || entry.type), [
    'Open Telium',
    'Report a bug…',
    'separator',
    'Quit Telium',
  ]);

  h.window.hide();
  h.menus[0].find((entry) => entry.label === 'Report a bug…').click();
  assert.deepEqual(h.window.calls, ['hide', 'show', 'focus']);
  assert.deepEqual(feedbackCalls, ['feedback']);
});

test('show restores, reveals, and focuses the existing window', () => {
  const window = fakeWindow({ minimized: true, visible: false });
  const h = harness(window);

  assert.equal(h.controller.show(), window);
  assert.deepEqual(window.calls, ['restore', 'show', 'focus']);
  assert.equal(h.created, 0);
});

test('show creates a new window only when the old one is gone', () => {
  const h = harness(null);

  const created = h.controller.show();

  assert.ok(created);
  assert.equal(h.created, 1);
});

test('normal close hides Telium without ending the process', () => {
  const window = fakeWindow();
  const h = harness(window);
  h.controller.install();
  let prevented = 0;

  const hidden = h.controller.handleWindowClose({
    preventDefault() { prevented += 1; },
  }, window);

  assert.equal(hidden, true);
  assert.equal(prevented, 1);
  assert.deepEqual(window.calls, ['hidden-focus-false', 'hide']);
  assert.deepEqual(h.appCalls, []);
});

test('close is not intercepted when no tray is available', () => {
  const window = fakeWindow();
  const h = harness(window);

  const hidden = h.controller.handleWindowClose({
    preventDefault() { throw new Error('must not hide without a tray'); },
  }, window);

  assert.equal(hidden, false);
  assert.equal(h.controller.hasTray(), false);
  assert.deepEqual(window.calls, []);
});

test('explicit quit allows the BrowserWindow to close', () => {
  const window = fakeWindow();
  const h = harness(window);
  h.controller.quit();

  let prevented = 0;
  const hidden = h.controller.handleWindowClose({
    preventDefault() { prevented += 1; },
  }, window);

  assert.equal(h.controller.isQuitting(), true);
  assert.deepEqual(h.appCalls, ['quit']);
  assert.equal(hidden, false);
  assert.equal(prevented, 0);
  assert.deepEqual(window.calls, []);
});

test('OS before-quit also bypasses close-to-tray', () => {
  const window = fakeWindow();
  const h = harness(window);
  h.controller.beginQuit();

  const hidden = h.controller.handleWindowClose({
    preventDefault() { throw new Error('must not intercept shutdown'); },
  }, window);

  assert.equal(hidden, false);
  assert.deepEqual(window.calls, []);
});
