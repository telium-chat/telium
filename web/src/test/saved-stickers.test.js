import { describe, expect, it } from 'vitest';
import {
  MAX_SAVED_STICKERS, isSavedSticker, savedStickers, toggleSavedSticker,
} from '../lib/saved-stickers.js';
import { KEYS } from '../lib/sync.js';

function fakeStore(initial) {
  const doc = new Map();
  if (initial !== undefined) doc.set(KEYS.savedStickers, initial);
  const events = [];
  return {
    events,
    sync: {
      get: (key) => doc.get(key),
      set: (key, value) => { doc.set(key, value); },
    },
    emit: (name) => { events.push(name); },
  };
}

const sticker = (id, origin = 'guild.example', name = id) => ({ id, origin, name });

describe('savedStickers', () => {
  it('reads the list out of the sync document', () => {
    const store = fakeStore([sticker('a')]);
    expect(savedStickers(store.sync)).toEqual([sticker('a')]);
  });

  it('answers with an empty list rather than whatever the store had', () => {
    expect(savedStickers(undefined)).toEqual([]);
    expect(savedStickers({})).toEqual([]);
    expect(savedStickers(fakeStore().sync)).toEqual([]);
    expect(savedStickers(fakeStore('not a list').sync)).toEqual([]);
    expect(savedStickers(fakeStore(null).sync)).toEqual([]);
  });
});

describe('isSavedSticker', () => {
  it('tells two guilds\u2019 stickers apart even when the ids match', () => {
    const store = fakeStore([sticker('shared', 'one.example')]);
    expect(isSavedSticker(store.sync, sticker('shared', 'one.example'))).toBe(true);
    expect(isSavedSticker(store.sync, sticker('shared', 'two.example'))).toBe(false);
  });

  it('matches on the reference, not on the name it was saved under', () => {
    const store = fakeStore([sticker('a', 'guild.example', 'old name')]);
    expect(isSavedSticker(store.sync, sticker('a', 'guild.example', 'new name'))).toBe(true);
  });

  it('treats a missing origin as the empty one, both ways round', () => {
    const store = fakeStore([{ id: 'a' }]);
    expect(isSavedSticker(store.sync, { id: 'a', origin: '' })).toBe(true);
  });

  it('says no about nothing', () => {
    const store = fakeStore([sticker('a')]);
    expect(isSavedSticker(store.sync, null)).toBe(false);
    expect(isSavedSticker(store.sync, {})).toBe(false);
  });
});

describe('toggleSavedSticker', () => {
  it('saves a sticker, newest first, and says it is saved now', () => {
    const store = fakeStore([sticker('old')]);

    expect(toggleSavedSticker(store, sticker('new'))).toBe(true);
    expect(savedStickers(store.sync).map((s) => s.id)).toEqual(['new', 'old']);
  });

  it('stores the reference and the name, and nothing else the caller passed', () => {
    const store = fakeStore([]);
    toggleSavedSticker(store, { id: 'a', origin: 'guild.example', name: 'wave', url: 'https://x' });
    expect(savedStickers(store.sync)).toEqual([{ id: 'a', origin: 'guild.example', name: 'wave' }]);
  });

  it('unsaves on the second press and says it is not saved now', () => {
    const store = fakeStore([sticker('a'), sticker('b')]);

    expect(toggleSavedSticker(store, sticker('a'))).toBe(false);
    expect(savedStickers(store.sync).map((s) => s.id)).toEqual(['b']);
  });

  it('unsaves only the one from that server', () => {
    const store = fakeStore([sticker('shared', 'one.example'), sticker('shared', 'two.example')]);

    toggleSavedSticker(store, sticker('shared', 'two.example'));

    expect(savedStickers(store.sync)).toEqual([sticker('shared', 'one.example')]);
  });

  it('drops the oldest past the cap rather than growing the sealed document', () => {
    const full = Array.from({ length: MAX_SAVED_STICKERS }, (_, i) => sticker(`s${i}`));
    const store = fakeStore(full);

    toggleSavedSticker(store, sticker('newest'));
    const after = savedStickers(store.sync);

    expect(after).toHaveLength(MAX_SAVED_STICKERS);
    expect(after[0].id).toBe('newest');
    expect(after[after.length - 1].id).toBe(`s${MAX_SAVED_STICKERS - 2}`);
    expect(isSavedSticker(store.sync, sticker(`s${MAX_SAVED_STICKERS - 1}`))).toBe(false);
  });

  it('tells the app the list moved, so an open picker redraws', () => {
    const store = fakeStore([]);
    toggleSavedSticker(store, sticker('a'));
    expect(store.events).toEqual(['saved-stickers']);
  });

  it('refuses a sticker with no id, and writes nothing', () => {
    const store = fakeStore([sticker('a')]);

    expect(toggleSavedSticker(store, {})).toBe(false);
    expect(toggleSavedSticker(store, null)).toBe(false);

    expect(savedStickers(store.sync)).toEqual([sticker('a')]);
    expect(store.events).toEqual([]);
  });
});
