'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const DESKTOP_ID = 'chat.telium.Telium';
const DESKTOP_FILENAME = `${DESKTOP_ID}.desktop`;
const ICON_FILENAME = `${DESKTOP_ID}.png`;
const START_IN_TRAY_FLAG = '--start-in-tray';

function absoluteXdgDir(candidate, fallback) {
  return candidate && path.isAbsolute(candidate) ? candidate : fallback;
}

function validateAppImagePath(value) {
  if (!value || !path.isAbsolute(value) || /[\r\n\0]/.test(value)) return null;
  return value;
}

// Quote the Exec path, escape special chars, double `%` against field codes.
function quoteDesktopExecArg(value) {
  const raw = String(value);
  if (/[\r\n\0]/.test(raw)) throw new Error('Desktop launcher arguments cannot contain line breaks.');
  return `"${raw
    .replaceAll('%', '%%')
    .replace(/[\\"`$]/g, (character) => `\\${character}`)}"`;
}

function desktopEntry(appImagePath, { startInTray = false } = {}) {
  const exec = `${quoteDesktopExecArg(appImagePath)}${startInTray ? ` ${START_IN_TRAY_FLAG}` : ''}`;
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Version=1.0',
    'Name=Telium',
    startInTray ? 'Comment=Start Telium in the system tray' : 'Comment=Private decentralized chat',
    `Exec=${exec}`,
    `Icon=${DESKTOP_ID}`,
    'Terminal=false',
    'Categories=Network;InstantMessaging;',
    `StartupWMClass=${DESKTOP_ID}`,
    'StartupNotify=true',
    ...(startInTray ? ['X-GNOME-Autostart-enabled=true'] : []),
    '',
  ].join('\n');
}

function hasStartInTrayFlag(argv = process.argv) {
  return Array.isArray(argv) && argv.includes(START_IN_TRAY_FLAG);
}

function createLinuxDesktopIntegration({
  platform = process.platform,
  isPackaged = false,
  appImagePath = process.env.APPIMAGE,
  homeDir = os.homedir(),
  xdgDataHome = process.env.XDG_DATA_HOME,
  xdgConfigHome = process.env.XDG_CONFIG_HOME,
  iconBase64Path = path.join(__dirname, 'assets', 'icon.png.base64'),
  fileSystem = fs,
} = {}) {
  const currentAppImage = validateAppImagePath(appImagePath);
  const supported = platform === 'linux' && Boolean(isPackaged) && Boolean(currentAppImage);
  const dataHome = absoluteXdgDir(xdgDataHome, path.join(homeDir, '.local', 'share'));
  const configHome = absoluteXdgDir(xdgConfigHome, path.join(homeDir, '.config'));
  const launcherPath = path.join(dataHome, 'applications', DESKTOP_FILENAME);
  const autostartPath = path.join(configHome, 'autostart', DESKTOP_FILENAME);
  const iconPath = path.join(dataHome, 'icons', 'hicolor', '256x256', 'apps', ICON_FILENAME);

  const exists = async (target) => {
    try {
      await fileSystem.access(target);
      return true;
    } catch (error) {
      if (error?.code === 'ENOENT') return false;
      throw error;
    }
  };

  const state = async () => ({
    supported,
    launcherInstalled: supported ? await exists(launcherPath) : false,
    startOnLogin: supported ? await exists(autostartPath) : false,
  });

  const requireSupport = () => {
    if (!supported) {
      throw new Error('Linux desktop integration is available only in a packaged Telium AppImage.');
    }
  };

  const writeEntry = async (target, contents) => {
    await fileSystem.mkdir(path.dirname(target), { recursive: true });
    await fileSystem.writeFile(target, contents, { encoding: 'utf8', mode: 0o644 });
  };

  const installIcon = async () => {
    const encoded = (await fileSystem.readFile(iconBase64Path, 'utf8')).replace(/\s+/g, '');
    const bytes = Buffer.from(encoded, 'base64');
    if (!bytes.length) throw new Error('Telium desktop icon is empty.');
    await fileSystem.mkdir(path.dirname(iconPath), { recursive: true });
    await fileSystem.writeFile(iconPath, bytes, { mode: 0o644 });
  };

  const removeIfPresent = async (target) => {
    try {
      await fileSystem.unlink(target);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  };

  const cleanUnusedIcon = async () => {
    if (!(await exists(launcherPath)) && !(await exists(autostartPath))) {
      await removeIfPresent(iconPath);
    }
  };

  const setLauncherInstalled = async (enabled) => {
    requireSupport();
    if (enabled) {
      await installIcon();
      await writeEntry(launcherPath, desktopEntry(currentAppImage));
    } else {
      await removeIfPresent(launcherPath);
      await cleanUnusedIcon();
    }
    return state();
  };

  const setStartOnLogin = async (enabled) => {
    requireSupport();
    if (enabled) {
      await installIcon();
      await writeEntry(autostartPath, desktopEntry(currentAppImage, { startInTray: true }));
    } else {
      await removeIfPresent(autostartPath);
      await cleanUnusedIcon();
    }
    return state();
  };

  // Keep enabled options pointed at the running AppImage, which electron-updater may rename.
  const refreshExisting = async () => {
    if (!supported) return state();
    const [launcherInstalled, startOnLogin] = await Promise.all([
      exists(launcherPath),
      exists(autostartPath),
    ]);
    if (launcherInstalled || startOnLogin) await installIcon();
    if (launcherInstalled) await writeEntry(launcherPath, desktopEntry(currentAppImage));
    if (startOnLogin) {
      await writeEntry(autostartPath, desktopEntry(currentAppImage, { startInTray: true }));
    }
    return state();
  };

  return {
    paths: { launcherPath, autostartPath, iconPath },
    refreshExisting,
    setLauncherInstalled,
    setStartOnLogin,
    state,
    supported,
  };
}

module.exports = {
  DESKTOP_ID,
  START_IN_TRAY_FLAG,
  createLinuxDesktopIntegration,
  desktopEntry,
  hasStartInTrayFlag,
  quoteDesktopExecArg,
};
