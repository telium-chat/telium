'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const {
  crashDetailsText,
  crashIssueUrl,
  installRendererCrashHandlers,
} = require('./renderer-crash.cjs');

// Records installed handlers so tests can fire events.
class FakeContents extends EventEmitter {
  constructor() {
    super();
    this.reloads = 0;
  }

  reload() { this.reloads += 1; }
}

class FakeWindow {
  constructor() {
    this.webContents = new FakeContents();
    this.destroyed = false;
  }

  isDestroyed() { return this.destroyed; }
}

// Records dialogs and replays an answer.
class FakeDialog {
  constructor() {
    this.shown = [];
    this.nextResponse = 0;
  }

  async showMessageBox(_window, options) {
    this.shown.push(options);
    return { response: this.nextResponse };
  }
}

class FakeClipboard {
  constructor() { this.text = null; }
  writeText(text) { this.text = text; }
}

class FakeShell {
  constructor() { this.opened = []; }
  async openExternal(url) { this.opened.push(url); }
}

const FACTS = {
  appVersion: '0.1.0',
  electronVersion: '44.3.0',
  chromeVersion: '130.0.0.0',
  platform: 'linux x64',
  when: '2026-10-14T00:00:00Z',
};

// Handlers are async; yield once before asserting.
const flush = () => new Promise((resolve) => setImmediate(resolve));

function installed() {
  const window = new FakeWindow();
  const dialog = new FakeDialog();
  const clipboard = new FakeClipboard();
  const shell = new FakeShell();
  installRendererCrashHandlers({ window, dialog, clipboard, shell, ...FACTS });
  return { window, dialog, clipboard, shell };
}

test('a clean exit is not a crash and is announced as nothing', async () => {
  const { window, dialog } = installed();
  window.webContents.emit('render-process-gone', {}, { reason: 'clean-exit', exitCode: 0 });
  assert.equal(dialog.shown.length, 0);
});

test('a gone renderer offers reload, report, copy and dismiss', async () => {
  const { window, dialog } = installed();
  window.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
  assert.equal(dialog.shown.length, 1);
  assert.deepEqual(dialog.shown[0].buttons, ['Reload', 'Report on GitHub', 'Copy details', 'Dismiss']);
});

test('choosing reload reloads the page', async () => {
  const { window, dialog } = installed();
  dialog.nextResponse = 0;
  window.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
  await flush();
  assert.equal(window.webContents.reloads, 1);
});

test('choosing report opens the pre-filled issue, headed like the template', async () => {
  const { window, dialog, shell } = installed();
  dialog.nextResponse = 1;
  window.webContents.emit('render-process-gone', {}, { reason: 'oom', exitCode: 137 });
  await flush();
  assert.equal(shell.opened.length, 1);
  const url = new URL(shell.opened[0]);
  assert.equal(url.origin + url.pathname, 'https://github.com/telium-chat/telium/issues/new');
  assert.equal(url.searchParams.get('labels'), 'bug');
  assert.match(url.searchParams.get('title'), /^Desktop renderer gone: oom/);
  const body = url.searchParams.get('body');
  for (const heading of ['### What I was doing', '### What happened', '### Environment']) {
    assert.ok(body.includes(heading), `body should carry "${heading}"`);
  }
  assert.ok(body.includes('reason `oom`'));
  assert.ok(body.includes('exit code `137`'));
  assert.ok(body.includes('- Build: `0.1.0 (desktop shell)`'));
});

test('choosing copy puts the whole evidence on the clipboard', async () => {
  const { window, dialog, clipboard } = installed();
  dialog.nextResponse = 2;
  window.webContents.emit('render-process-gone', {}, { reason: 'oom', exitCode: 137 });
  await flush();
  assert.match(clipboard.text, /reason: oom/);
  assert.match(clipboard.text, /exitCode: 137/);
  assert.match(clipboard.text, /Platform: linux x64/);
});

test('an unknown exit code says so rather than printing "undefined"', async () => {
  const { window, dialog, shell } = installed();
  dialog.nextResponse = 1;
  window.webContents.emit('render-process-gone', {}, { reason: 'oom' });
  await flush();
  const body = new URL(shell.opened[0]).searchParams.get('body');
  assert.ok(body.includes('exit code `unknown`'));
  assert.ok(!body.includes('undefined'));
});

test('a second crash while the dialog is up does not stack a second dialog', async () => {
  const { window, dialog } = installed();
  // Never resolves, so the guard stays closed.
  dialog.showMessageBox = (_window, options) => {
    dialog.shown.push(options);
    return new Promise(() => {});
  };
  window.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
  window.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
  assert.equal(dialog.shown.length, 1);
});

test('unresponsive asks wait-or-reload, and reload is the second answer', async () => {
  const { window, dialog } = installed();
  dialog.nextResponse = 1;
  window.webContents.emit('unresponsive');
  assert.equal(dialog.shown.length, 1);
  assert.deepEqual(dialog.shown[0].buttons, ['Wait', 'Reload']);
  await flush();
  assert.equal(window.webContents.reloads, 1);
});

test('a crash and an unresponsive share one guard', async () => {
  const { window, dialog } = installed();
  dialog.showMessageBox = (_window, options) => {
    dialog.shown.push(options);
    return new Promise(() => {});
  };
  window.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
  window.webContents.emit('unresponsive');
  assert.equal(dialog.shown.length, 1);
});

test('crashDetailsText is the plain-text twin of the issue body', () => {
  const text = crashDetailsText({ reason: 'oom', exitCode: 137 }, FACTS);
  for (const line of ['reason: oom', 'exitCode: 137', 'Build: 0.1.0 (desktop shell)', 'When: 2026-10-14T00:00:00Z']) {
    assert.ok(text.includes(line), `details should carry "${line}"`);
  }
});
