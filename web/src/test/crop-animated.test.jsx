import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useImageCrop } from '../views/dialogs/CropImageDialog.jsx';
import { StoreProvider } from '../hooks/useStore.jsx';
import { ModalHost, ModalProvider } from '../hooks/useModal.jsx';
import { freshStore } from './fake-server.js';
import { reencode, reencodeAnimation } from '../lib/image.js';

vi.mock('../lib/image.js', async (importOriginal) => ({
  ...(await importOriginal()),
  reencodeAnimation: vi.fn(),
  reencode: vi.fn(),
}));

function apng() {
  const out = [0x89, ...[...'PNG\r\n\x1a\n'].map((c) => c.charCodeAt(0))];
  const chunk = (type, len = 0) => {
    out.push(0, 0, 0, len, ...[...type].map((c) => c.charCodeAt(0)));
    for (let i = 0; i < len + 4; i += 1) out.push(0);
  };
  chunk('IHDR', 13);
  chunk('acTL', 8);
  chunk('IDAT', 4);
  return new File([new Uint8Array(out)], 'me.png', { type: 'image/png' });
}

function webp(animated, size = 30) {
  const b = new Uint8Array(size);
  b.set([...'RIFF'].map((c) => c.charCodeAt(0)), 0);
  b.set([...'WEBP'].map((c) => c.charCodeAt(0)), 8);
  b.set([...'VP8X'].map((c) => c.charCodeAt(0)), 12);
  b[20] = animated ? 0x02 : 0x00;
  return new File([b], 'me.webp', { type: 'image/webp' });
}

async function open(file, originCap) {
  URL.createObjectURL = vi.fn(() => 'blob:x');
  URL.revokeObjectURL = vi.fn();
  const onDone = vi.fn();
  function Opener() {
    const crop = useImageCrop();
    return <button type="button" onClick={() => crop(file, 'avatar').then(onDone)}>Open crop</button>;
  }
  const store = freshStore();
  store.session = { home: { domain: 'home.example' } };
  if (originCap) store.caps.set('home.example', { media: { max_profile_asset_bytes: originCap } });
  render(
    <StoreProvider store={store}>
      <ModalProvider>
        <Opener />
        <ModalHost />
      </ModalProvider>
    </StoreProvider>,
  );
  await userEvent.click(screen.getByRole('button', { name: 'Open crop' }));
  const img = await waitFor(() => {
    const el = document.querySelector('img.crop-image');
    if (!el) throw new Error('no image yet');
    return el;
  });
  Object.defineProperty(img, 'naturalWidth', { value: 100 });
  Object.defineProperty(img, 'naturalHeight', { value: 100 });
  fireEvent.load(img);
  return { onDone };
}

describe('cropping an animated avatar', () => {
  it('has one button, and an animated WebP goes up re-encoded, cropped and still animated', async () => {
    const file = webp(true);
    const made = new File([new Uint8Array(10)], 'me.webp', { type: 'image/webp' });
    reencodeAnimation.mockResolvedValue(made);
    const { onDone } = await open(file);
    expect(screen.queryByRole('button', { name: /keep animation/i })).toBeNull();
    const use = await screen.findByRole('button', { name: 'Use image' });
    await waitFor(() => expect(use.disabled).toBe(false));
    await userEvent.click(use);
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(onDone.mock.calls[0][0]).toBe(made);
    expect(reencodeAnimation.mock.calls[0][0]).toBe(file);
    expect(reencodeAnimation.mock.calls[0][2]).toEqual(expect.objectContaining({ size: 256 }));
    expect(screen.queryByText(/first frame/)).toBeNull();
  });

  it('uses the first frame, and says so, when this browser cannot read an APNG\'s frames', async () => {
    vi.stubGlobal('ImageDecoder', undefined);
    reencodeAnimation.mockClear();
    const still = new File([new Uint8Array(10)], 'me.webp', { type: 'image/webp' });
    reencode.mockResolvedValue(still);
    const { onDone } = await open(apng());
    expect(await screen.findByText(/only its first frame is used/)).toBeTruthy();
    const use = await screen.findByRole('button', { name: 'Use image' });
    await userEvent.click(use);
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(onDone.mock.calls[0][0]).toBe(still);
    expect(reencodeAnimation).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('gives an animated avatar up to 512 KB when the origin allows it', async () => {
    const made = new File([new Uint8Array(300 * 1024)], 'me.webp', { type: 'image/webp' });
    reencodeAnimation.mockReset().mockResolvedValue(made);
    const { onDone } = await open(webp(true), 512 * 1024);
    const use = await screen.findByRole('button', { name: 'Use image' });
    await waitFor(() => expect(use.disabled).toBe(false));
    await userEvent.click(use);
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(onDone.mock.calls[0][0]).toBe(made);
    expect(reencodeAnimation.mock.calls[0][2].maxBytes).toBe(512 * 1024);
  });

  it('holds it to 256 KB when the origin has not said it allows more', async () => {
    const made = new File([new Uint8Array(300 * 1024)], 'me.webp', { type: 'image/webp' });
    reencodeAnimation.mockReset().mockResolvedValue(made);
    const { onDone } = await open(webp(true), undefined);
    const use = await screen.findByRole('button', { name: 'Use image' });
    await waitFor(() => expect(use.disabled).toBe(false));
    await userEvent.click(use);
    await waitFor(() => expect(reencodeAnimation).toHaveBeenCalled());
    expect(reencodeAnimation.mock.calls[0][2].maxBytes).toBe(256 * 1024);
    await waitFor(() => expect(use.disabled).toBe(false));
    expect(onDone).not.toHaveBeenCalled();
  });
});
