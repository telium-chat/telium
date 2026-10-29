import { afterEach, describe, expect, it, vi } from 'vitest';
import { downscaleToFit } from '../lib/image.js';

function stubPipeline(sizesByCall) {
  // createImageBitmap hands back a fixed-size picture; every canvas encode
  // consumes the next blob size from the script.
  const createImageBitmap = vi.fn(async () => ({ width: 1000, height: 800 }));
  let call = 0;
  const toBlob = (cb, mime) => {
    const size = sizesByCall[Math.min(call, sizesByCall.length - 1)];
    call += 1;
    cb(new Blob([new Uint8Array(size)], { type: mime }));
  };
  const createElement = vi.fn(() => ({
    width: 0,
    height: 0,
    getContext: () => ({ drawImage() {} }),
    toBlob,
  }));
  vi.stubGlobal('createImageBitmap', createImageBitmap);
  vi.stubGlobal('document', { ...globalThis.document, createElement });
  return { createImageBitmap, createElement };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('downscaleToFit', () => {
  it('leaves a file that already fits exactly as it is', async () => {
    const file = new File([new Uint8Array(10)], 'me.png', { type: 'image/png' });
    const out = await downscaleToFit(file, 1024);
    expect(out).toBe(file);
  });

  it('leaves a file the browser cannot help, and says nothing', async () => {
    const file = new File([new Uint8Array(4096)], 'huge.png', { type: 'image/png' });
    vi.stubGlobal('createImageBitmap', vi.fn(async () => { throw new Error('no decoder'); }));
    const out = await downscaleToFit(file, 1024);
    expect(out).toBe(file);
  });

  it('shrinks an oversized picture until it fits, keeping name and type', async () => {
    stubPipeline([4096, 512]);
    const file = new File([new Uint8Array(4096)], 'me.png', { type: 'image/png' });
    const out = await downscaleToFit(file, 1024);
    expect(out).not.toBe(file);
    expect(out.name).toBe('me.png');
    expect(out.type).toBe('image/png');
    expect(out.size).toBeLessThanOrEqual(1024);
  });

  it('gives up at the floor rather than vanishing to nothing', async () => {
    stubPipeline([4096, 4096, 4096, 4096, 4096, 4096, 4096, 4096, 4096, 4096, 4096, 4096, 4096, 4096]);
    const file = new File([new Uint8Array(4096)], 'me.jpeg', { type: 'image/jpeg' });
    const out = await downscaleToFit(file, 1024);
    expect(out).not.toBe(file);
    expect(out.size).toBe(4096);
    expect(out.name).toBe('me.jpeg');
  });

  it('does not touch a gif, whose animation would not survive', async () => {
    const file = new File([new Uint8Array(4096)], 'me.gif', { type: 'image/gif' });
    const out = await downscaleToFit(file, 1024);
    expect(out).toBe(file);
  });
});
