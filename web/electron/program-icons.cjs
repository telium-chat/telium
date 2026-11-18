'use strict';

// Icons for programs the user picked by hand. Windows and macOS can read one from the executable; Linux keeps icons in the desktop entry (.desktop) and the icon theme, so the program is looked up there by the name of its executable. Icons are PNG or SVG. An SVG is never rendered here: it travels as inert bytes and is only ever drawn through an <img> in the window, which runs no script and loads nothing outside it, and anything shared with others is re-encoded to a raster first. A program with no icon simply has none.

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const SIZES = ['512x512', '256x256', '192x192', '128x128', '96x96', '64x64', '48x48', '32x32'];
const MAX_ICON_BYTES = 4 * 1024 * 1024;
const MAX_SVG_BYTES = 1024 * 1024;
const DESKTOP_TTL_MS = 5 * 60 * 1000;

function exeKey(value) {
  return String(value || '').replaceAll('\\', '/').split('/').pop().toLowerCase();
}

/// First real command of an Exec= line, skipping `env`, VAR=value and flatpak/wrapper noise; null if there isn't one.
function execProgram(exec) {
  const tokens = String(exec || '').match(/"[^"]*"|\S+/g) || [];
  const words = tokens.map((t) => t.replace(/^"|"$/g, ''));
  let i = 0;
  while (i < words.length && (words[i] === 'env' || /^\w+=/.test(words[i]))) i += 1;
  const first = words[i];
  if (!first) return null;
  return exeKey(first) || null;
}

/// `{ exec, icon }` of a desktop entry's main [Desktop Entry] group.
function parseDesktopEntry(text) {
  const entry = {};
  let inMain = false;
  for (const line of String(text).split(/\r?\n/)) {
    if (line.startsWith('[')) { inMain = line.trim() === '[Desktop Entry]'; continue; }
    if (!inMain) continue;
    const m = /^(Exec|Icon|NoDisplay|Hidden)=(.*)$/.exec(line);
    if (m && entry[m[1]] === undefined) entry[m[1]] = m[2].trim();
  }
  if (entry.Hidden === 'true') return null;
  return { exec: entry.Exec || '', icon: entry.Icon || '' };
}

function createProgramIcons({
  platform = process.platform,
  getFileIcon = null,
  toPng = (bytes) => bytes,
  home = os.homedir(),
  readdir = fs.readdir,
  readFile = fs.readFile,
  stat = fs.stat,
  now = Date.now,
} = {}) {
  const dataDirs = [
    path.join(home, '.local/share'),
    '/usr/local/share',
    '/usr/share',
    '/var/lib/flatpak/exports/share',
    path.join(home, '.local/share/flatpak/exports/share'),
    '/var/lib/snapd/desktop',
  ];
  let desktop = null;
  let desktopAt = 0;
  const cache = new Map();

  const exists = async (file) => {
    try { return (await stat(file)).isFile(); } catch { return false; }
  };

  const loadDesktop = async () => {
    if (desktop && now() - desktopAt < DESKTOP_TTL_MS) return desktop;
    const map = new Map();
    for (const dir of dataDirs) {
      const apps = path.join(dir, 'applications');
      let names = [];
      try { names = await readdir(apps); } catch { continue; }
      for (const name of names) {
        if (!name.endsWith('.desktop')) continue;
        try {
          const entry = parseDesktopEntry(await readFile(path.join(apps, name), 'utf8'));
          const program = entry && execProgram(entry.exec);
          if (program && entry.icon && !map.has(program)) map.set(program, entry.icon);
        } catch { /* unreadable entries are skipped */ }
      }
    }
    desktop = map;
    desktopAt = now();
    return map;
  };

  const themeIcon = async (name) => {
    if (path.isAbsolute(name)) return /\.(png|svg)$/i.test(name) && await exists(name) ? name : null;
    // A real raster at a useful size beats a vector; the vector is the fallback.
    for (const dir of dataDirs) {
      for (const size of SIZES) {
        const file = path.join(dir, 'icons/hicolor', size, 'apps', `${name}.png`);
        if (await exists(file)) return file;
      }
    }
    for (const dir of dataDirs) {
      const file = path.join(dir, 'icons/hicolor/scalable/apps', `${name}.svg`);
      if (await exists(file)) return file;
    }
    for (const dir of ['/usr/share/pixmaps', path.join(home, '.local/share/pixmaps')]) {
      for (const ext of ['png', 'svg']) {
        const file = path.join(dir, `${name}.${ext}`);
        if (await exists(file)) return file;
      }
    }
    return null;
  };

  const linuxIcon = async (executable) => {
    const name = (await loadDesktop()).get(exeKey(executable));
    if (!name) return null;
    const file = await themeIcon(name);
    if (!file) return null;
    const info = await stat(file);
    const svg = file.toLowerCase().endsWith('.svg');
    if (info.size <= 0 || info.size > (svg ? MAX_SVG_BYTES : MAX_ICON_BYTES)) return null;
    return { bytes: await readFile(file), mime: svg ? 'image/svg+xml' : 'image/png' };
  };

  const nativeIcon = async (filePath) => {
    if (typeof getFileIcon !== 'function' || !path.isAbsolute(filePath)) return null;
    // A Windows path seen from Linux (a Proton game) is not a file here.
    if (platform === 'linux') return null;
    const bytes = await getFileIcon(filePath);
    return bytes?.length ? { bytes, mime: 'image/png' } : null;
  };

  async function lookup(executable, filePath, size) {
    const found = platform === 'linux' ? await linuxIcon(executable) : await nativeIcon(String(filePath || ''));
    if (!found || !found.bytes.length) return null;
    if (found.mime === 'image/svg+xml') return found;
    const bytes = toPng(found.bytes, size);
    return bytes ? { bytes, mime: 'image/png' } : null;
  }

  return Object.freeze({
    /// `{ bytes, mime }` for the program (a PNG resized to `size`, or an SVG as it is), or null. Cached per executable and size, failures included.
    iconFor(executable, filePath, size = 128) {
      const key = `${exeKey(executable)}@${size}`;
      if (!cache.has(key)) {
        cache.set(key, lookup(executable, filePath, size).catch(() => null));
        if (cache.size > 256) cache.delete(cache.keys().next().value);
      }
      return cache.get(key);
    },
  });
}

module.exports = { createProgramIcons, parseDesktopEntry, execProgram, exeKey };
