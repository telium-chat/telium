'use strict';

const { createHash } = require('node:crypto');
const { readFile, stat } = require('node:fs/promises');
const path = require('node:path');
const { fileURLToPath } = require('node:url');

const MAX_LOCAL_ART_BYTES = 4 * 1024 * 1024;
const MAX_HANDLES = 128;

function localFileUrl(raw) {
  if (typeof raw !== 'string' || raw.length > 4096) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'file:' || (url.hostname && url.hostname !== 'localhost')) return null;
    // Rejects malformed or remote file URLs before a handle reaches the renderer.
    fileURLToPath(url);
    return url.href;
  } catch {
    return null;
  }
}

function imageMime(bytes) {
  if (!bytes || bytes.length < 12) return null;
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return 'image/gif';
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF'
    && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (bytes.subarray(4, 12).toString('ascii').includes('ftypavif')) return 'image/avif';
  // SVG is not accepted: images from other apps must be passive rasters.
  return null;
}

function createLocalArtworkRegistry() {
  const entries = new Map();

  const touch = (handle, item) => {
    entries.delete(handle);
    entries.set(handle, item);
    while (entries.size > MAX_HANDLES) entries.delete(entries.keys().next().value);
  };

  return Object.freeze({
    register(raw, trackKey = '') {
      const url = localFileUrl(raw);
      if (!url) return null;
      // Some players reuse one cache path; key by track so a new song gets a new handle.
      const semantic = typeof trackKey === 'string' ? trackKey.slice(0, 512) : '';
      const handle = `mpris-art:${createHash('sha256')
        .update(url)
        .update('\0')
        .update(semantic)
        .digest('hex').slice(0, 32)}`;
      touch(handle, { url });
      return handle;
    },

    async read(handle) {
      const item = entries.get(handle);
      if (!item) return null;
      touch(handle, item);
      const filename = fileURLToPath(item.url);
      const info = await stat(filename);
      if (!info.isFile() || info.size <= 0 || info.size > MAX_LOCAL_ART_BYTES) return null;
      const bytes = await readFile(filename);
      const mime = imageMime(bytes);
      if (!mime) return null;
      // ArrayBuffer clones over IPC without leaking Node's Buffer prototype.
      const array = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      return {
        bytes: array,
        mime,
        name: `album-art${path.extname(filename).toLowerCase() || '.img'}`,
      };
    },

    clear() { entries.clear(); },
  });
}

module.exports = { createLocalArtworkRegistry, localFileUrl, imageMime };
