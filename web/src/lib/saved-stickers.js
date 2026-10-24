// Saved stickers: a reference list kept in the sealed sync store.

import { KEYS, MAX_SAVED_STICKERS } from './sync.js';

export { MAX_SAVED_STICKERS };

function tag(sticker) {
  return `${sticker?.origin || ''}\n${sticker?.id || ''}`;
}

export function savedStickers(sync) {
  const values = sync?.get?.(KEYS.savedStickers);
  return Array.isArray(values) ? values : [];
}

export function isSavedSticker(sync, sticker) {
  const wanted = tag(sticker);
  return savedStickers(sync).some((saved) => tag(saved) === wanted);
}

export function toggleSavedSticker(store, sticker) {
  if (!sticker?.id) return false;
  const wanted = tag(sticker);
  const current = savedStickers(store.sync);
  const saved = current.some((entry) => tag(entry) === wanted);
  const next = saved
    ? current.filter((entry) => tag(entry) !== wanted)
    : [{ id: sticker.id, origin: sticker.origin || '', name: sticker.name || '' }, ...current]
      .slice(0, MAX_SAVED_STICKERS);
  store.sync.set(KEYS.savedStickers, next);
  store.emit?.('saved-stickers');
  return !saved;
}
