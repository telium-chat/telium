import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { ModalProvider } from '../hooks/useModal.jsx';
import { StoreProvider } from '../hooks/useStore.jsx';
import { GifEmbed } from '../views/chat/GifEmbed.jsx';

const originalGetContext = HTMLCanvasElement.prototype.getContext;

afterEach(() => {
  HTMLCanvasElement.prototype.getContext = originalGetContext;
  vi.restoreAllMocks();
});

describe('GIF focus behavior', () => {
  it('freezes an extensionless provider GIF while Telium is unfocused and resumes on focus', async () => {
    let focused = true;
    vi.spyOn(document, 'hasFocus').mockImplementation(() => focused);
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ({ drawImage: vi.fn() }));

    const store = {
      sync: { get: () => [] },
      on: () => () => {},
      emit: () => {},
    };
    const url = 'https://media.example/provider/content/abc123';

    render(
      <StoreProvider store={store}>
        <ModalProvider>
          <GifEmbed url={url} />
        </ModalProvider>
      </StoreProvider>,
    );

    const image = screen.getByAltText('GIF');
    Object.defineProperty(image, 'naturalWidth', { configurable: true, value: 320 });
    Object.defineProperty(image, 'naturalHeight', { configurable: true, value: 180 });
    expect(image.src).toBe(url);

    focused = false;
    window.dispatchEvent(new Event('blur'));
    await waitFor(() => {
      const canvas = document.querySelector('canvas[aria-label="GIF"]');
      expect(canvas).toBeTruthy();
      expect(canvas.style.display).not.toBe('none');
    });
    expect(image.getAttribute('src')).toBeNull();

    focused = true;
    window.dispatchEvent(new Event('focus'));
    await waitFor(() => expect(image.src).toBe(url));
  });

  it('uses native desktop focus even when the webview still claims it is focused', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ({ drawImage: vi.fn() }));

    const store = {
      sync: { get: () => [] },
      on: () => () => {},
      emit: () => {},
    };
    const url = 'https://media.example/provider/content/native-focus';

    render(
      <StoreProvider store={store}>
        <ModalProvider>
          <GifEmbed url={url} />
        </ModalProvider>
      </StoreProvider>,
    );

    const image = screen.getByAltText('GIF');
    Object.defineProperty(image, 'naturalWidth', { configurable: true, value: 320 });
    Object.defineProperty(image, 'naturalHeight', { configurable: true, value: 180 });

    window.dispatchEvent(new CustomEvent('telium:native-window-focus', { detail: false }));
    await waitFor(() => {
      const canvas = document.querySelector('canvas[aria-label="GIF"]');
      expect(canvas).toBeTruthy();
      expect(canvas.style.display).not.toBe('none');
    });
    expect(image.getAttribute('src')).toBeNull();

    window.dispatchEvent(new CustomEvent('telium:native-window-focus', { detail: true }));
    await waitFor(() => expect(image.src).toBe(url));
  });

  it('does not need to export or refetch a cross-origin frame to freeze it', async () => {
    let focused = true;
    vi.spyOn(document, 'hasFocus').mockImplementation(() => focused);
    const drawImage = vi.fn();
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ({ drawImage }));
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const store = {
      sync: { get: () => [] },
      on: () => () => {},
      emit: () => {},
    };
    const url = 'https://gifs.20plays.com/uploads/no-cors.gif';

    render(
      <StoreProvider store={store}>
        <ModalProvider>
          <GifEmbed url={url} />
        </ModalProvider>
      </StoreProvider>,
    );

    const image = screen.getByAltText('GIF');
    Object.defineProperty(image, 'naturalWidth', { configurable: true, value: 320 });
    Object.defineProperty(image, 'naturalHeight', { configurable: true, value: 180 });

    focused = false;
    window.dispatchEvent(new Event('blur'));
    await waitFor(() => expect(drawImage).toHaveBeenCalledWith(image, 0, 0));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(image.getAttribute('src')).toBeNull();
  });
});

describe('GIF focus behavior on the desktop shell', () => {
  it('still freezes a GIF the desktop player cannot decode', async () => {
    let focused = true;
    vi.spyOn(document, 'hasFocus').mockImplementation(() => focused);
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ({ drawImage: vi.fn() }));
    window.teliumDesktop = {
      runtime: 'electron',
      onWindowFocusChanged: () => () => {},
      windowFocus: () => Promise.resolve(true),
      fetchGifBytes: () => Promise.reject(new Error('too large')),
    };

    try {
      const { AnimatedImage } = await import('../components/AnimatedImage.jsx');
      const url = 'https://media.example/provider/content/too-big.gif';
      render(<AnimatedImage src={url} alt="big" animated gif />);

      // Decode fails, so the plain image takes over and must still obey focus.
      await waitFor(() => expect(document.querySelectorAll('img').length).toBe(1));
      const image = screen.getByAltText('big');
      Object.defineProperty(image, 'naturalWidth', { configurable: true, value: 320 });
      Object.defineProperty(image, 'naturalHeight', { configurable: true, value: 180 });

      focused = false;
      window.dispatchEvent(new CustomEvent('telium:native-window-focus', { detail: false }));
      await waitFor(() => expect(image.getAttribute('src')).toBeNull());
      const canvas = document.querySelector('canvas[aria-label="big"]');
      expect(canvas).toBeTruthy();
    } finally {
      delete window.teliumDesktop;
    }
  });
});

describe('GIF focus behavior while the desktop player is still decoding', () => {
  it('hides the self-animating fallback image while the window is unfocused', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    window.teliumDesktop = {
      runtime: 'electron',
      onWindowFocusChanged: () => () => {},
      windowFocus: () => Promise.resolve(false),
      fetchGifBytes: () => new Promise(() => {}),
    };
    try {
      const { AnimatedImage } = await import('../components/AnimatedImage.jsx');
      render(<AnimatedImage src="https://media.example/x/loading.gif" alt="slow" animated gif />);
      const image = screen.getByAltText('slow');
      window.dispatchEvent(new CustomEvent('telium:native-window-focus', { detail: false }));
      await waitFor(() => expect(image.style.visibility).toBe('hidden'));
      window.dispatchEvent(new CustomEvent('telium:native-window-focus', { detail: true }));
      await waitFor(() => expect(image.style.visibility).not.toBe('hidden'));
    } finally {
      delete window.teliumDesktop;
    }
  });
});
