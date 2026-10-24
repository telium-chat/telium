import { StrictMode } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ImagePreview } from '../views/chat/ImagePreview.jsx';

const box = (width, height, left, top) => ({
  x: left,
  y: top,
  width,
  height,
  left,
  top,
  right: left + width,
  bottom: top + height,
  toJSON() {
    return {
      x: left, y: top, width, height, left, top,
      right: left + width, bottom: top + height,
    };
  },
});

const twoFrames = () => new Promise((resolve) => {
  requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
});

describe('image lightbox entrance', () => {
  beforeEach(() => {
    vi.spyOn(Element.prototype, 'getBoundingClientRect')
      .mockImplementation(() => box(400, 300, 12, 48));
    vi.spyOn(window, 'matchMedia').mockImplementation((media) => ({
      matches: false,
      media,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent: () => false,
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('opens after StrictMode replays the mount effect', async () => {
    render(
      <StrictMode>
        <ImagePreview src="/media/pic.png" alt="pic.png" />
      </StrictMode>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'View pic.png larger' }));
    expect(screen.getByRole('dialog').getAttribute('data-phase')).toBe('enter');

    await act(twoFrames);

    expect(screen.getByRole('dialog').getAttribute('data-phase')).toBe('open');
  });

  it('opens when the picture reports its size before the entrance lands', async () => {
    render(
      <StrictMode>
        <ImagePreview src="/media/pic.png" alt="pic.png" />
      </StrictMode>,
    );

    const trigger = screen.getByRole('button', { name: 'View pic.png larger' });
    const thumbCanvas = trigger.querySelector('canvas');
    thumbCanvas.width = 0;
    thumbCanvas.height = 0;
    fireEvent.click(trigger);

    const picture = document.querySelector('img.lightbox__image');
    Object.defineProperty(picture, 'naturalWidth', { value: 1600, configurable: true });
    Object.defineProperty(picture, 'naturalHeight', { value: 900, configurable: true });
    fireEvent.load(picture);
    expect(screen.getByRole('dialog').getAttribute('data-phase')).toBe('enter');

    await act(twoFrames);

    expect(screen.getByRole('dialog').getAttribute('data-phase')).toBe('open');
  });
});
