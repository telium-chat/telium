import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { mount, signedInStore } from './harness.jsx';
import { GifPickerPanel, GifPopover } from '../views/chat/GifPicker.jsx';
import { gifSizeOf, noteGifSize, toggleGifFavorite } from '../lib/gifs.js';
import { KEYS } from '../lib/sync.js';
import { expectNoViolations } from './a11y.js';
import { EN } from '../lib/i18n/catalog/index.js';

const noop = () => {};
const FAVORITES = EN['chat.gif.favorites'];
const field = () => screen.getByPlaceholderText(EN['chat.gif.search']);
const doorOf = (scope) => within(scope).getByRole('option', { name: FAVORITES });
const QUIET_RESIZE_OBSERVER = globalThis.ResizeObserver;
let resizeObservers = [];

function watchingResizeObserver() {
  globalThis.ResizeObserver = class {
    constructor(callback) { this.callback = callback; }

    observe(target) { this.target = target; resizeObservers.push(this); }

    unobserve() {}

    disconnect() {}
  };
}

const panelObserver = (panel) => resizeObservers.find((entry) => entry.target === panel);

function at(panel, { left = 80, top = 40, width = 400, height = 480 } = {}) {
  panel.getBoundingClientRect = () => {
    const w = parseFloat(panel.style.width) || width;
    const h = parseFloat(panel.style.height) || height;
    return { left, top, width: w, height: h, right: left + w, bottom: top + h };
  };
}

let anchor = null;
const popoverAnchor = () => {
  anchor = document.createElement('button');
  anchor.setAttribute('aria-label', EN['chat.gif.picker']);
  document.body.append(anchor);
  return anchor;
};

beforeEach(() => {
  globalThis.IntersectionObserver = class {
    constructor(callback) { this.callback = callback; }

    observe(target) { this.callback([{ isIntersecting: true, target }], this); }

    unobserve() {}

    disconnect() {}
  };
});

afterEach(() => {
  delete globalThis.IntersectionObserver;
  globalThis.ResizeObserver = QUIET_RESIZE_OBSERVER;
  resizeObservers = [];
  anchor?.remove();
  anchor = null;
  vi.restoreAllMocks();
});

describe('the free corner', () => {
  it('drags the box from the corner the anchor does not hold, and remembers where it got to', () => {
    const store = signedInStore();
    const { container, unmount } = mount(
      <GifPickerPanel onPick={noop} onClose={noop} resizable />,
      store,
    );
    const grip = within(container).getByRole('separator', { name: EN['chat.gif.resize'] });
    const panel = grip.parentElement;
    at(panel);
    expect(panel.style.width).toBe('');

    fireEvent.pointerDown(grip, { pointerId: 1, button: 0, clientX: 80, clientY: 40 });
    fireEvent.pointerMove(grip, { pointerId: 1, clientX: 40, clientY: 60 });
    expect(panel.style.width).toBe('440px');
    expect(panel.style.height).toBe('460px');
    expect(grip.getAttribute('aria-valuenow')).toBe('440');
    fireEvent.pointerUp(grip, { pointerId: 1 });

    expect(store.prefs.gifSize).toEqual({ width: 440, height: 460 });
    expect(store.sync.get(KEYS.prefs)).toEqual(expect.objectContaining({
      gifSize: { width: 440, height: 460 },
    }));

    unmount();
    const again = mount(<GifPickerPanel onPick={noop} onClose={noop} resizable />, store);
    const restored = within(again.container).getByRole('separator')
      .parentElement;
    expect(restored.style.width).toBe('440px');
    expect(restored.style.height).toBe('460px');
  });

  it('walks the box on arrow keys without walking the grid at the same time', () => {
    const store = signedInStore();
    const { container } = mount(
      <GifPickerPanel onPick={noop} onClose={noop} resizable />,
      store,
    );
    const grip = within(container).getByRole('separator', { name: EN['chat.gif.resize'] });
    const panel = grip.parentElement;
    at(panel);

    fireEvent.keyDown(grip, { key: 'ArrowLeft' });
    fireEvent.keyDown(grip, { key: 'ArrowDown' });
    expect(panel.style.width).toBe('416px');
    expect(panel.style.height).toBe('464px');
    expect(store.prefs.gifSize).toEqual({ width: 416, height: 464 });

    expect(container.querySelector('[data-cursor="true"]')).toBeNull();
  });

  it('keeps the box under the hand while the grid counts columns underneath it', async () => {
    watchingResizeObserver();
    const store = signedInStore();
    const { container } = mount(
      <GifPickerPanel onPick={noop} onClose={noop} resizable />,
      store,
    );
    const grip = within(container).getByRole('separator', { name: EN['chat.gif.resize'] });
    const panel = grip.parentElement;
    at(panel, { left: 120 });

    fireEvent.pointerDown(grip, { pointerId: 1, button: 0, clientX: 80, clientY: 40 });
    fireEvent.pointerMove(grip, { pointerId: 1, clientX: -20, clientY: 40 });
    expect(panel.style.width).toBe('500px');
    expect(grip.getAttribute('aria-valuenow')).toBe('500');

    const observer = panelObserver(panel);
    expect(observer).toBeTruthy();
    act(() => observer.callback([]));
    expect(container.querySelectorAll('.gif-col')).toHaveLength(3);
    expect(panel.style.width).toBe('500px');
    expect(grip.getAttribute('aria-valuenow')).toBe('500');

    fireEvent.pointerUp(grip, { pointerId: 1 });
    expect(store.prefs.gifSize).toEqual({ width: 500, height: 480 });
    await act(async () => {});
  });

  it('gives up the grip while it is filling the window', async () => {
    const store = signedInStore({ prefs: { gifSize: { width: 520, height: 600 } } });
    const onOpenChange = vi.fn();
    const { user } = mount(
      <GifPopover open onOpenChange={onOpenChange} anchor={popoverAnchor()} onPick={noop} />,
      store,
    );
    const popup = await screen.findByRole('dialog', { name: EN['chat.gif.picker'] });
    const panel = popup.querySelector('.gif-popover');
    expect(panel.style.width).toBe('520px');
    expect(within(popup).getByRole('separator')).toBeTruthy();
    expect(panel.querySelector('[data-resize]')).toBeTruthy();

    await user.click(within(popup).getByRole('button', { name: EN['chat.gif.fullscreen'] }));
    expect(within(popup).queryByRole('separator')).toBeNull();
    expect(panel.querySelector('[data-resize]')).toBeNull();
    expect(panel.style.width).toBe('');
  });
});

describe('the free edges', () => {
  it('moves one edge at a time, whichever strip the hand started on', async () => {
    const store = signedInStore();
    const { container } = mount(
      <GifPickerPanel onPick={noop} onClose={noop} resizable />,
      store,
    );
    const grip = within(container).getByRole('separator', { name: EN['chat.gif.resize'] });
    const panel = grip.parentElement;
    at(panel);
    const side = panel.querySelector('[data-resize="x"]');
    const top = panel.querySelector('[data-resize="y"]');
    expect(side).toBeTruthy();
    expect(top).toBeTruthy();
    expect(container.querySelectorAll('[role="separator"]')).toHaveLength(1);
    expect(side.hasAttribute('tabindex')).toBe(false);
    expect(top.hasAttribute('tabindex')).toBe(false);

    fireEvent.pointerDown(top, { pointerId: 1, button: 0, clientX: 200, clientY: 40 });
    fireEvent.pointerMove(top, { pointerId: 1, clientX: 340, clientY: 90 });
    expect(panel.style.height).toBe('430px');
    expect(panel.style.width).toBe('400px');
    fireEvent.pointerUp(top, { pointerId: 1 });

    fireEvent.pointerDown(side, { pointerId: 2, button: 0, clientX: 80, clientY: 200 });
    fireEvent.pointerMove(side, { pointerId: 2, clientX: 116, clientY: 400 });
    expect(panel.style.width).toBe('364px');
    expect(panel.style.height).toBe('430px');
    fireEvent.pointerUp(side, { pointerId: 2 });

    expect(store.prefs.gifSize).toEqual({ width: 364, height: 430 });
    await act(async () => {});
  });
});

describe('how wide it draws', () => {
  it('gains columns as the panel gains width, rather than bigger GIFs', async () => {
    watchingResizeObserver();
    const { container } = mount(
      <GifPickerPanel onPick={noop} onClose={noop} resizable />,
      signedInStore(),
    );
    const panel = within(container).getByRole('separator').parentElement;

    expect(container.querySelectorAll('.gif-col')).toHaveLength(2);

    at(panel, { width: 1000 });
    const observer = panelObserver(panel);
    expect(observer).toBeTruthy();
    act(() => observer.callback([]));

    expect(container.querySelectorAll('.gif-col')).toHaveLength(5);
    await act(async () => {});
  });
});

describe('fullscreen', () => {
  it('fills the window, and Escape gives the window back before it gives the picker back', async () => {
    const store = signedInStore({ prefs: { gifSize: { width: 520, height: 600 } } });
    const onOpenChange = vi.fn();
    const { user } = mount(
      <GifPopover open onOpenChange={onOpenChange} anchor={popoverAnchor()} onPick={noop} />,
      store,
    );
    const popup = await screen.findByRole('dialog', { name: EN['chat.gif.picker'] });
    const panel = popup.querySelector('.gif-popover');

    await user.click(within(popup).getByRole('button', { name: EN['chat.gif.fullscreen'] }));
    expect(document.querySelector('.gif-positioner--fill')).toBeTruthy();
    expect(document.querySelector('.gif-popup--fill')).toBeTruthy();
    expect(panel.classList.contains('gif-popover--fill')).toBe(true);
    expect(within(popup).getByRole('button', { name: EN['chat.gif.exitFullscreen'] })).toBeTruthy();

    const closing = () => onOpenChange.mock.calls.some(([next]) => next === false);
    await user.keyboard('{Escape}');
    expect(closing()).toBe(false);
    expect(document.querySelector('.gif-popup--fill')).toBeNull();
    expect(within(popup).getByRole('button', { name: EN['chat.gif.fullscreen'] })).toBeTruthy();
    expect(panel.style.width).toBe('520px');

    await user.keyboard('{Escape}');
    expect(closing()).toBe(true);
    expect(onOpenChange.mock.calls.at(-1)[1]?.reason).toBe('escape-key');
  });
});

describe('the door', () => {
  it('opens the reader own list, empties the box, and Escape puts the query back', async () => {
    const store = signedInStore();
    const { user, container } = mount(<GifPickerPanel onPick={noop} onClose={noop} />, store);
    await user.type(field(), 'cats');
    expect(doorOf(container)).toBeTruthy();

    await user.click(doorOf(container));
    expect(field().value).toBe('');
    expect(document.activeElement).toBe(field());
    expect(within(container).queryByRole('option', { name: FAVORITES })).toBeNull();
    expect(await within(container).findByText(EN['chat.gif.favoritesEmpty'])).toBeTruthy();
    expect(within(container).getByRole('button', { name: EN['chat.gif.trending'] })
      .getAttribute('aria-pressed')).toBe('false');

    await user.keyboard('{Escape}');
    expect(field().value).toBe('cats');
    expect(doorOf(container)).toBeTruthy();
  });

  it('drops the question it was holding as soon as a new one is asked', async () => {
    const store = signedInStore();
    const { user, container } = mount(<GifPickerPanel onPick={noop} onClose={noop} />, store);
    await user.type(field(), 'cats');
    await user.click(doorOf(container));

    await user.type(field(), 'dogs');
    expect(doorOf(container)).toBeTruthy();
    expect(field().value).toBe('dogs');

    await user.click(doorOf(container));
    await user.keyboard('{Escape}');
    expect(field().value).toBe('dogs');
  });
});

describe("a favourite's shape", () => {
  it('is the size it is known to be, and square until something is known', async () => {
    const wide = 'https://media.example.test/wide.gif';
    const unknown = 'https://media.example.test/unknown.gif';
    noteGifSize(wide, 800, 400);
    const store = signedInStore();
    toggleGifFavorite(store, wide);
    toggleGifFavorite(store, unknown);
    const { user, container } = mount(<GifPickerPanel onPick={noop} onClose={noop} />, store);

    await user.click(doorOf(container));
    await waitFor(() => expect(within(container).getAllByRole('option')).toHaveLength(2));

    expect(within(container).getByRole('listbox').getAttribute('aria-label')).toBe(FAVORITES);
    const shapes = [...container.querySelectorAll('.gif-tile')]
      .map((tile) => tile.style.aspectRatio);
    expect(shapes).toEqual(['1 / 1', '800 / 400']);
  });

  it('learns the shape from the GIF own bytes the first time it is drawn', async () => {
    const url = 'https://media.example.test/tall.gif';
    expect(gifSizeOf(url)).toBeNull();
    const store = signedInStore();
    toggleGifFavorite(store, url);
    const { user, container } = mount(<GifPickerPanel onPick={noop} onClose={noop} />, store);

    await user.click(doorOf(container));
    const image = await screen.findByAltText(EN['chat.gif.favorite']);
    const tile = image.closest('.gif-tile');
    expect(tile.style.aspectRatio).toBe('1 / 1');

    Object.defineProperties(image, {
      naturalWidth: { value: 640, configurable: true },
      naturalHeight: { value: 480, configurable: true },
    });
    fireEvent.load(image);
    await waitFor(() => expect(tile.style.aspectRatio).toBe('640 / 480'));
    expect(gifSizeOf(url)).toEqual({ width: 640, height: 480 });
    expect(within(container).getAllByRole('option')).toHaveLength(1);
  });
});

describe('the popover as drawn', () => {
  it('is clean, with its grip, its fullscreen control and its door', async () => {
    const store = signedInStore();
    mount(<GifPopover open onOpenChange={noop} anchor={popoverAnchor()} onPick={noop} />, store);
    await screen.findByRole('dialog', { name: EN['chat.gif.picker'] });
    await expectNoViolations({ baseElement: document.body }, 'the GIF popover');
  });
});
