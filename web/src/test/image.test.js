import { beforeEach, describe, expect, it, vi } from 'vitest';
import { decompressFrames, parseGIF } from 'gifuct-js';
import { encodeAnimation } from 'wasm-webp';
import {
  PRESETS, clampCrop, cropRect, isAnimated, isAnimatedGif, reencode, reencodeAnimatedGif,
} from '../lib/image.js';

vi.mock('gifuct-js', () => ({
  decompressFrames: vi.fn(),
  parseGIF: vi.fn(),
}));

vi.mock('wasm-webp', () => ({ encodeAnimation: vi.fn() }));

function stubCanvas({ encodings = ['image/webp', 'image/jpeg', 'image/png'], bytes = 1000, alpha = false } = {}) {
  const drawn = [];
  const asked = [];
  const pixels = new Uint8ClampedArray(4).fill(255);
  if (alpha) pixels[3] = 0;
  vi.stubGlobal('OffscreenCanvas', undefined);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({
    clearRect() {},
    drawImage(...args) { drawn.push(args); },
    getImageData: () => ({ data: pixels }),
  }));
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function toBlob(cb, type, quality) {
    asked.push({ type, quality, width: this.width });
    const actual = encodings.includes(type) ? type : 'image/png';
    const size = typeof bytes === 'function' ? bytes(actual, quality, this.width) : bytes;
    cb(new Blob([new Uint8Array(size)], { type: actual }));
  });
  return { drawn, asked };
}

const png = (name = 'me.png') => new File([new Uint8Array([1, 2, 3])], name, { type: 'image/png' });

beforeEach(() => {
  vi.restoreAllMocks();
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 1200, height: 800, close() {} })));
});

describe('cropRect', () => {
  it('defaults to the largest centred square', () => {
    expect(cropRect(1200, 800, {})).toEqual({ sx: 200, sy: 0, side: 800 });
  });

  it('zooms about the chosen centre', () => {
    expect(cropRect(1000, 1000, { zoom: 2, cx: 0.5, cy: 0.5 }))
      .toEqual({ sx: 250, sy: 250, side: 500 });
  });

  it('never selects pixels the picture does not have', () => {
    const rect = cropRect(1200, 800, { zoom: 2, cx: -3, cy: 9 });
    expect(rect).toEqual({ sx: 0, sy: 400, side: 400 });
  });

  it('supports a wide banner crop without changing the square contract', () => {
    expect(cropRect(1200, 800, {}, 3)).toEqual({
      sx: 0, sy: 200, width: 1200, height: 400, aspect: 3,
    });
  });

  it('clamps the zoom itself', () => {
    expect(clampCrop(1000, 1000, { zoom: 99 }).zoom).toBe(4);
    expect(clampCrop(1000, 1000, { zoom: 0.1 }).zoom).toBe(1);
  });
});

describe('isAnimated', () => {
  it('sees a still GIF as one frame even when it has a transparency block', () => {
    expect(isAnimated(gif(1))).toBe(false);
  });

  it('sees a multi-frame GIF', () => {
    expect(isAnimated(gif(3))).toBe(true);
    expect(isAnimatedGif(gif(3))).toBe(true);
  });

  it('sees an animated WebP by its VP8X flags, and a still one as still', () => {
    expect(isAnimated(webp(true))).toBe(true);
    expect(isAnimated(webp(false))).toBe(false);
  });

  it('sees an APNG by the control chunk ahead of the image data', () => {
    expect(isAnimated(apng(true))).toBe(true);
    expect(isAnimated(apng(false))).toBe(false);
  });
});

describe('reencode', () => {
  it('matches the profile asset limit for unchanged animated avatars and icons', () => {
    expect(PRESETS.avatar.maxBytes).toBe(256 * 1024);
    expect(PRESETS.icon.maxBytes).toBe(256 * 1024);
  });

  it('draws the crop square into a canvas of the preset size', async () => {
    const { drawn } = stubCanvas();
    const out = await reencode(png(), { zoom: 2, cx: 0.5, cy: 0.5 }, PRESETS.avatar);

    expect(drawn).toHaveLength(1);
    expect(drawn[0].slice(1)).toEqual([400, 200, 400, 400, 0, 0, 256, 256]);
    expect(out.type).toBe('image/webp');
    expect(out.name).toBe('me.webp');
  });

  it('draws a banner crop into its wide output dimensions', async () => {
    const { drawn } = stubCanvas();
    await reencode(png(), {}, PRESETS.banner);

    expect(drawn[0].slice(1)).toEqual([0, 200, 1200, 400, 0, 0, 600, 200]);
  });

  it('falls back when the browser answers a WebP request with a PNG', async () => {
    stubCanvas({ encodings: ['image/png'] });
    const out = await reencode(png(), {}, PRESETS.emoji);
    expect(out.type).toBe('image/png');
    expect(out.name).toBe('me.png');
  });

  it('never offers JPEG for a crop with a transparent pixel in it', async () => {
    const { asked } = stubCanvas({ encodings: ['image/png'], alpha: true });
    await reencode(png(), {}, PRESETS.emoji);
    expect(asked.map((a) => a.type)).toEqual([
      'image/webp', 'image/webp', 'image/webp', 'image/png',
    ]);
  });

  it('takes the JPEG when the picture is opaque and WebP is unavailable', async () => {
    stubCanvas({ encodings: ['image/jpeg', 'image/png'] });
    const out = await reencode(png(), {}, PRESETS.avatar);
    expect(out.type).toBe('image/jpeg');
    expect(out.name).toBe('me.jpg');
  });

  it('walks the quality ladder until the result fits the ceiling', async () => {
    const { asked } = stubCanvas({
      bytes: (type, quality) => (quality > 0.6 ? 400 * 1024 : 20 * 1024),
    });
    const out = await reencode(png(), {}, PRESETS.avatar);
    expect(asked.map((a) => a.quality)).toEqual([0.9, 0.75, 0.55]);
    expect(out.size).toBe(20 * 1024);
  });

  it('halves the output before giving up on a picture that will not compress', async () => {
    const { asked } = stubCanvas({ bytes: (type, quality, width) => (width > 128 ? 999999 : 5000) });
    const out = await reencode(png(), {}, PRESETS.avatar);
    expect([...new Set(asked.map((a) => a.width))]).toEqual([256, 128]);
    expect(out.size).toBe(5000);
  });

  it('says so rather than uploading something over the ceiling', async () => {
    stubCanvas({ bytes: 9_000_000 });
    await expect(reencode(png(), {}, PRESETS.avatar)).rejects.toThrow(/could not compress/);
  });

  it('turns an animated GIF into a bounded animated WebP', async () => {
    class AnimationCanvas {
      constructor(width, height) {
        this.width = width;
        this.height = height;
        this.context = {
          clearRect() {},
          createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
          drawImage() {},
          getImageData: (_x, _y, w, h) => ({
            data: new Uint8ClampedArray(w * h * 4).fill(255),
          }),
          putImageData() {},
        };
      }

      getContext() { return this.context; }
    }

    vi.stubGlobal('OffscreenCanvas', AnimationCanvas);
    parseGIF.mockReturnValue({ lsd: { width: 2, height: 2 } });
    decompressFrames.mockReturnValue([0, 1].map((i) => ({
      delay: 40,
      dims: { top: 0, left: 0, width: 2, height: 2 },
      disposalType: 1,
      pixels: [0, 0, 0, 0],
      colorTable: [[i * 255, 0, 0]],
    })));
    encodeAnimation.mockResolvedValue(new Uint8Array(100));

    const out = await reencodeAnimatedGif(
      new File([gif(2)], 'me.gif', { type: 'image/gif' }),
      {},
      PRESETS.avatar,
    );

    expect(out.type).toBe('image/webp');
    expect(out.name).toBe('me.webp');
    expect(encodeAnimation).toHaveBeenCalledWith(
      256,
      256,
      false,
      expect.arrayContaining([
        expect.objectContaining({
          data: expect.any(Uint8Array),
          duration: 40,
          config: { lossless: 0, quality: 82 },
        }),
      ]),
    );
    expect(encodeAnimation.mock.calls[0][3][0].data).toHaveLength(256 * 256 * 3);
  });
});

function gif(frames) {
  const out = [...'GIF89a'].map((c) => c.charCodeAt(0));
  out.push(4, 0, 4, 0, 0x80, 0, 0);
  out.push(0, 0, 0, 255, 255, 255);
  for (let i = 0; i < frames; i += 1) {
    out.push(0x21, 0xf9, 0x04, 0x01, 0x0a, 0x00, 0x00, 0x00);
    out.push(0x2c, 0, 0, 0, 0, 4, 0, 4, 0, 0);
    out.push(0x02, 0x02, 0x44, 0x01, 0x00);
  }
  out.push(0x3b);
  return new Uint8Array(out);
}

function webp(animated) {
  const b = new Uint8Array(30);
  b.set([...'RIFF'].map((c) => c.charCodeAt(0)), 0);
  b.set([...'WEBP'].map((c) => c.charCodeAt(0)), 8);
  b.set([...'VP8X'].map((c) => c.charCodeAt(0)), 12);
  b[20] = animated ? 0x02 : 0x00;
  return b;
}

function apng(animated) {
  const out = [0x89, ...[...'PNG\r\n\x1a\n'].map((c) => c.charCodeAt(0))];
  const chunk = (type, len = 0) => {
    out.push(0, 0, 0, len, ...[...type].map((c) => c.charCodeAt(0)));
    for (let i = 0; i < len + 4; i += 1) out.push(0);
  };
  chunk('IHDR', 13);
  if (animated) chunk('acTL', 8);
  chunk('IDAT', 4);
  return new Uint8Array(out);
}
