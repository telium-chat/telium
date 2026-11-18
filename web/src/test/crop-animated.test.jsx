import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useImageCrop } from '../views/dialogs/CropImageDialog.jsx';
import { StoreProvider } from '../hooks/useStore.jsx';
import { ModalHost, ModalProvider } from '../hooks/useModal.jsx';
import { freshStore } from './fake-server.js';

function webp(animated) {
  const b = new Uint8Array(30);
  b.set([...'RIFF'].map((c) => c.charCodeAt(0)), 0);
  b.set([...'WEBP'].map((c) => c.charCodeAt(0)), 8);
  b.set([...'VP8X'].map((c) => c.charCodeAt(0)), 12);
  b[20] = animated ? 0x02 : 0x00;
  return new File([b], 'me.webp', { type: 'image/webp' });
}

async function open(file) {
  URL.createObjectURL = vi.fn(() => 'blob:x');
  URL.revokeObjectURL = vi.fn();
  const onDone = vi.fn();
  function Opener() {
    const crop = useImageCrop();
    return <button type="button" onClick={() => crop(file, 'avatar').then(onDone)}>Open crop</button>;
  }
  render(
    <StoreProvider store={freshStore()}>
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
  it('has one button, and an animated image goes up still animated', async () => {
    const file = webp(true);
    const { onDone } = await open(file);
    expect(screen.queryByRole('button', { name: /keep animation/i })).toBeNull();
    const use = await screen.findByRole('button', { name: 'Use image' });
    await waitFor(() => expect(use.disabled).toBe(false));
    await userEvent.click(use);
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(file));
  });

  it('says plainly that the crop is skipped for an animated WebP', async () => {
    await open(webp(true));
    expect(await screen.findByText(/crop is not applied/)).toBeTruthy();
  });
});
