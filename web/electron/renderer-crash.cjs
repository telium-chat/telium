'use strict';

// Native dialog on renderer loss (the renderer cannot draw its own failure); nothing is written or sent unless the user chooses.

const ISSUE_BASE = 'https://github.com/telium-chat/telium/issues/new';

const clip = (text, n) => (text.length > n ? `${text.slice(0, n)}\n... truncated` : text);

function environmentLines(facts) {
  return [
    `- Build: \`${facts.appVersion} (desktop shell)\``,
    `- Electron: \`${facts.electronVersion}\``,
    `- Chromium: \`${facts.chromeVersion}\``,
    `- Platform: \`${facts.platform}\``,
    `- When: ${facts.when}`,
  ];
}

function crashDetailsText(details, facts) {
  return [
    'The desktop renderer went away.',
    `reason: ${details.reason}`,
    `exitCode: ${details.exitCode ?? 'unknown'}`,
    ...environmentLines(facts).map((line) => line.replace(/`/g, '')),
    '',
    'This text was assembled by Telium and left on the clipboard by your choice.',
  ].join('\n');
}

function crashIssueUrl(details, facts) {
  const body = [
    '### What I was doing',
    '',
    '<!-- Replace this line: what were you doing when the app went white? -->',
    '',
    '### What happened',
    '',
    'The desktop renderer went away: '
      + `reason \`${details.reason}\`, exit code \`${details.exitCode ?? 'unknown'}\`.`,
    '',
    '### Environment',
    '',
    ...environmentLines(facts),
  ].join('\n');
  const title = `Desktop renderer gone: ${clip(String(details.reason || 'unknown'), 60)}`;
  return `${ISSUE_BASE}?labels=bug&title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
}

// `showMessageBox` resolved to a bare index before Electron 28 and to `{ response }` since.
function normalizeResponse(result) {
  return typeof result === 'object' && result !== null ? result.response : result;
}

function installRendererCrashHandlers({
  window,
  dialog,
  clipboard,
  shell,
  appVersion,
  electronVersion,
  chromeVersion,
  platform,
  now = () => new Date().toISOString(),
}) {
  const facts = () => ({
    appVersion, electronVersion, chromeVersion, platform, when: now(),
  });
  // One guard for both dialogs so repeated crashes do not stack them.
  let open = false;

  window.webContents.on('render-process-gone', async (_event, details) => {
    // Deliberate exits (window closing, app quitting) are not crashes.
    if (!details || details.reason === 'clean-exit') return;
    if (open || window.isDestroyed()) return;
    open = true;
    try {
      const choice = normalizeResponse(await dialog.showMessageBox(window, {
        type: 'error',
        buttons: ['Reload', 'Report on GitHub', 'Copy details', 'Dismiss'],
        defaultId: 0,
        cancelId: 3,
        message: 'Telium hit a problem it could not recover from',
        detail: `The part of the app that draws the screen stopped working`
          + ` (${details.reason}${details.exitCode ? `, exit code ${details.exitCode}` : ''}).`
          + ' Nothing was sent anywhere. Reloading starts the app fresh; you stay signed in.',
      }));
      if (window.isDestroyed()) return;
      if (choice === 0) window.webContents.reload();
      else if (choice === 1) {
        try { await shell.openExternal(crashIssueUrl(details, facts())); } catch { /* nothing sensible left to do */ }
      } else if (choice === 2) {
        try { clipboard.writeText(crashDetailsText(details, facts())); } catch { /* as above */ }
      }
    } finally {
      open = false;
    }
  });

  window.webContents.on('unresponsive', async () => {
    if (open || window.isDestroyed()) return;
    open = true;
    try {
      const choice = normalizeResponse(await dialog.showMessageBox(window, {
        type: 'warning',
        buttons: ['Wait', 'Reload'],
        defaultId: 0,
        cancelId: 0,
        message: 'Telium is not responding',
        detail: 'The screen has stopped answering. It may still recover on its own;'
          + ' reloading starts the app fresh instead, and you stay signed in.',
      }));
      if (!window.isDestroyed() && choice === 1) window.webContents.reload();
    } finally {
      open = false;
    }
  });
}

module.exports = {
  crashDetailsText,
  crashIssueUrl,
  installRendererCrashHandlers,
};
