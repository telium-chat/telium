import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { ControlledGifCanvas } from '../components/ControlledGifCanvas.jsx';

const originalGetContext = HTMLCanvasElement.prototype.getContext;

afterEach(() => {
  HTMLCanvasElement.prototype.getContext = originalGetContext;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('ControlledGifCanvas', () => {
  it('pauses on the current frame and resumes with the remaining frame delay', async () => {
    vi.useFakeTimers();

    const drawImage = vi.fn();
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
      clearRect: vi.fn(),
      createImageData: (width, height) => ({
        data: new Uint8ClampedArray(width * height * 4),
      }),
      putImageData: vi.fn(),
      getImageData: () => ({ data: new Uint8ClampedArray(16) }),
      drawImage,
    }));

    const patch = new Uint8ClampedArray(2 * 2 * 4);
    const loader = vi.fn(async () => ({
      width: 2,
      height: 2,
      frames: [
        { dims: { left: 0, top: 0, width: 2, height: 2 }, delay: 100, disposalType: 1, patch },
        { dims: { left: 0, top: 0, width: 2, height: 2 }, delay: 100, disposalType: 1, patch },
      ],
    }));

    const { rerender } = render(
      <ControlledGifCanvas src="https://gifs.example/test.gif" active loader={loader} />,
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(drawImage).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(40);
    });
    rerender(
      <ControlledGifCanvas src="https://gifs.example/test.gif" active={false} loader={loader} />,
    );

    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(drawImage).toHaveBeenCalledTimes(1);

    rerender(
      <ControlledGifCanvas src="https://gifs.example/test.gif" active loader={loader} />,
    );
    await act(async () => {
      vi.advanceTimersByTime(59);
    });
    expect(drawImage).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(drawImage).toHaveBeenCalledTimes(2);
  });
});
