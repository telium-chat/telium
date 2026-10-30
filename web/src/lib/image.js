/// Client-side re-encoding of avatars, banners and emoji. The ceilings are a courtesy; the origin enforces them again.

export const PRESETS = {
  // Animated avatars upload unchanged, so this must match the origin's profile-asset ceiling.
  avatar: { size: 256, maxBytes: 256 * 1024 },
  // Banners share the profile-asset 256 KB ceiling.
  banner: { width: 600, height: 200, aspect: 3, maxBytes: 256 * 1024 },
  // Guild icons share the profile-asset ceiling.
  icon: { size: 256, maxBytes: 256 * 1024 },
  emoji: { size: 128, maxBytes: 96 * 1024 },
  // The guild server caps a sticker's pack entry at 256 KB.
  sticker: { size: 320, maxBytes: 224 * 1024 },
};

export const ZOOM = { min: 1, max: 4, step: 0.05 };

// Best quality first; the loop takes the first encoding that fits.
const QUALITY = [0.9, 0.75, 0.55];
const ANIMATION_QUALITY = [82, 68, 54, 42];
const ANIMATION_CANDIDATES = [
  { size: 256, maxFrames: 60 },
  { size: 192, maxFrames: 45 },
  { size: 128, maxFrames: 30 },
  { size: 96, maxFrames: 20 },
  { size: 64, maxFrames: 12 },
];

/// A crop is `{ zoom, cx, cy }`: magnification and centre as fractions of the source, so it is size-independent. Clamped here to stay inside the picture.
export function clampCrop(width, height, { zoom = 1, cx = 0.5, cy = 0.5 } = {}, aspect = 1) {
  const z = clamp(zoom, ZOOM.min, ZOOM.max);
  const ratio = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  const cropWidth = Math.min(width, height * ratio) / z;
  const cropHeight = cropWidth / ratio;
  const halfX = cropWidth / 2 / width;
  const halfY = cropHeight / 2 / height;
  return { zoom: z, cx: clamp(cx, halfX, 1 - halfX), cy: clamp(cy, halfY, 1 - halfY) };
}

/// Default (zoom 1, centred) is the largest centred rectangle for the aspect ratio.
export function cropRect(width, height, crop, aspect = 1) {
  const ratio = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  const { zoom, cx, cy } = clampCrop(width, height, crop, ratio);
  const cropWidth = Math.min(width, height * ratio) / zoom;
  const cropHeight = cropWidth / ratio;
  const sx = cx * width - cropWidth / 2;
  const sy = cy * height - cropHeight / 2;
  // Compact square shape kept for the original avatar/emoji callers and tests.
  return ratio === 1
    ? { sx, sy, side: cropWidth }
    : { sx, sy, width: cropWidth, height: cropHeight, aspect: ratio };
}

/// A canvas keeps only the first frame, so callers use this to warn about animation.
export function isAnimated(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (isGifBytes(b)) return gifFrames(b) > 1;
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') {
    // An animation is always extended-format; the VP8X ANIM bit is the answer.
    return ascii(b, 12, 4) === 'VP8X' && (b[20] & 0x02) !== 0;
  }
  if (b[0] === 0x89 && ascii(b, 1, 3) === 'PNG') return hasApngControl(b);
  return false;
}

/// Animated WebP and APNG are left untouched, not mistaken for GIF.
export function isAnimatedGif(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return isGifBytes(b) && gifFrames(b) > 1;
}

/// WebP first, with a fallback; a browser that can't encode WebP returns a PNG, so the returned type is the signal. JPEG only when no pixel is transparent.
export async function reencode(file, crop, preset) {
  if (typeof createImageBitmap !== 'function') {
    throw new Error('this browser cannot decode images off the main thread');
  }
  const bitmap = await createImageBitmap(file);
  try {
    // Halving is the backstop for a flat-colour PNG whose alpha rules out JPEG.
    const outputWidth = preset.width || preset.size;
    const outputHeight = preset.height || preset.size;
    const aspect = preset.aspect || 1;
    for (const scale of [1, 0.5]) {
      const width = Math.max(1, Math.round(outputWidth * scale));
      const height = Math.max(1, Math.round(outputHeight * scale));
      const blob = await bestFit(bitmap, crop, width, height, preset.maxBytes, aspect);
      if (blob) return named(file, blob);
    }
  } finally {
    bitmap.close?.();
  }
  throw new Error(`could not compress this image under ${Math.round(preset.maxBytes / 1024)} KB`);
}

/// Decoder and encoder load lazily so the still path stays small.
export async function reencodeAnimatedGif(file, crop, preset) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!isAnimatedGif(bytes)) throw new Error('this image does not contain an animated GIF');

  const [{ parseGIF, decompressFrames }, { encodeAnimation }] = await Promise.all([
    import('gifuct-js'),
    import('wasm-webp'),
  ]);
  const parsed = parseGIF(bytes.buffer);
  const width = parsed?.lsd?.width;
  const height = parsed?.lsd?.height;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error('the GIF has invalid dimensions');
  }
  // Avoid a huge source canvas; the output is small anyway.
  if (width * height > 4096 * 4096) {
    throw new Error('this GIF is too large to process in the browser');
  }

  const sourceFrames = decompressFrames(parsed, false).filter((frame) => frame?.dims);
  if (sourceFrames.length < 2) throw new Error('the GIF has no usable animation frames');

  for (const candidate of animationCandidates(preset)) {
    const rendered = renderGifFrames(
      sourceFrames, width, height, crop, candidate.width, candidate.height,
      candidate.maxFrames, preset.aspect || 1,
    );
    for (const quality of ANIMATION_QUALITY) {
      const encoded = await encodeAnimation(
        candidate.width,
        candidate.height,
        rendered.hasAlpha,
        rendered.frames.map((frame) => ({
          // libwebp expects 3 bytes per pixel when hasAlpha is false; passing RGBA as RGB striped the output.
          data: rendered.hasAlpha ? frame.data : rgbaToRgb(frame.data),
          duration: frame.duration,
          config: { lossless: 0, quality },
        })),
      );
      if (!encoded) continue;
      const blob = new Blob([encoded], { type: 'image/webp' });
      if (blob.size <= preset.maxBytes) return named(file, blob);
    }
  }
  throw new Error(`could not compress this animated GIF under ${Math.round(preset.maxBytes / 1024)} KB`);
}

function animationCandidates(preset) {
  if (preset.width && preset.height) {
    return [1, 0.75, 0.5, 0.375, 0.25].map((scale, i) => ({
      width: Math.max(1, Math.round(preset.width * scale)),
      height: Math.max(1, Math.round(preset.height * scale)),
      maxFrames: [60, 45, 30, 20, 12][i],
    }));
  }
  return ANIMATION_CANDIDATES.map(({ size, maxFrames }) => ({
    width: size, height: size, maxFrames,
  }));
}

function renderGifFrames(sourceFrames, width, height, crop, outputWidth, outputHeight, maxFrames, aspect) {
  const indexes = sampleFrameIndexes(sourceFrames.length, maxFrames);
  const selected = new Map(indexes.map((index, i) => [index, i]));
  const durations = indexes.map((start, i) => {
    const end = indexes[i + 1] ?? sourceFrames.length;
    return Math.max(10, sourceFrames.slice(start, end)
      .reduce((total, frame) => total + Math.max(10, frame.delay || 100), 0));
  });
  const pixels = new Uint8ClampedArray(width * height * 4);
  const source = makeCanvas(width, height);
  const output = makeCanvas(outputWidth, outputHeight);
  const rect = cropRect(width, height, crop, aspect);
  const frames = [];
  let previous = null;
  let hasAlpha = false;

  sourceFrames.forEach((frame, index) => {
    applyDisposal(pixels, width, previous);
    const restore = frame.disposalType === 3 ? pixels.slice() : null;
    drawGifFrame(pixels, width, frame);
    const outputIndex = selected.get(index);
    if (outputIndex !== undefined) {
      const sourceCtx = source.context;
      sourceCtx.putImageData(makeImageData(sourceCtx, pixels, width, height), 0, 0);
      output.context.clearRect(0, 0, outputWidth, outputHeight);
      output.context.drawImage(
        source.canvas,
        rect.sx,
        rect.sy,
        rect.width || rect.side,
        rect.height || rect.side,
        0,
        0,
        outputWidth,
        outputHeight,
      );
      const data = new Uint8Array(output.context.getImageData(0, 0, outputWidth, outputHeight).data);
      if (!hasAlpha) {
        for (let i = 3; i < data.length; i += 4) {
          if (data[i] !== 255) { hasAlpha = true; break; }
        }
      }
      frames[outputIndex] = { data, duration: durations[outputIndex] };
    }
    previous = { ...frame, restore };
  });

  return { frames: frames.filter(Boolean), hasAlpha };
}

function sampleFrameIndexes(count, maxFrames) {
  const take = Math.min(count, maxFrames);
  if (take <= 1) return [0];
  return Array.from({ length: take }, (_, i) => Math.round((i * (count - 1)) / (take - 1)));
}

function drawGifFrame(target, width, frame) {
  const { top, left, width: frameWidth, height: frameHeight } = frame.dims;
  const table = frame.colorTable || [];
  for (let y = 0; y < frameHeight; y += 1) {
    for (let x = 0; x < frameWidth; x += 1) {
      const colorIndex = frame.pixels[(y * frameWidth) + x];
      if (colorIndex === frame.transparentIndex) continue;
      const color = table[colorIndex];
      if (!color) continue;
      const at = (((top + y) * width) + left + x) * 4;
      target[at] = color[0];
      target[at + 1] = color[1];
      target[at + 2] = color[2];
      target[at + 3] = 255;
    }
  }
}

function applyDisposal(target, width, previous) {
  if (!previous) return;
  if (previous.disposalType === 3 && previous.restore) {
    target.set(previous.restore);
    return;
  }
  if (previous.disposalType !== 2) return;
  const { top, left, width: frameWidth, height: frameHeight } = previous.dims;
  for (let y = 0; y < frameHeight; y += 1) {
    const start = (((top + y) * width) + left) * 4;
    target.fill(0, start, start + frameWidth * 4);
  }
}

function makeCanvas(width, height) {
  const canvas = typeof OffscreenCanvas === 'function'
    ? new OffscreenCanvas(width, height)
    : Object.assign(document.createElement('canvas'), { width, height });
  const context = canvas.getContext('2d', { alpha: true });
  if (!context) throw new Error('this browser has no 2D canvas');
  return { canvas, context };
}

function makeImageData(context, pixels, width, height) {
  if (typeof ImageData === 'function') return new ImageData(pixels, width, height);
  const image = context.createImageData(width, height);
  image.data.set(pixels);
  return image;
}

function rgbaToRgb(rgba) {
  const rgb = new Uint8Array((rgba.length / 4) * 3);
  for (let source = 0, target = 0; source < rgba.length; source += 4, target += 3) {
    rgb[target] = rgba[source];
    rgb[target + 1] = rgba[source + 1];
    rgb[target + 2] = rgba[source + 2];
  }
  return rgb;
}

async function bestFit(bitmap, crop, width, height, maxBytes, aspect) {
  const { canvas, opaque } = draw(bitmap, crop, width, height, aspect);
  const types = opaque
    ? [...QUALITY.map((q) => ['image/webp', q]), ...QUALITY.map((q) => ['image/jpeg', q]), ['image/png']]
    : [...QUALITY.map((q) => ['image/webp', q]), ['image/png']];
  for (const [type, quality] of types) {
    const blob = await encode(canvas, type, quality);
    // A refusal is a PNG under the requested type's name, or a rejection, depending on the canvas.
    if (!blob || blob.type !== type) continue;
    if (blob.size <= maxBytes) return blob;
  }
  return null;
}

function draw(bitmap, crop, width, height, aspect) {
  const rect = cropRect(bitmap.width, bitmap.height, crop, aspect);
  const { canvas, context: ctx } = makeCanvas(width, height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(
    bitmap,
    rect.sx,
    rect.sy,
    rect.width || rect.side,
    rect.height || rect.side,
    0,
    0,
    width,
    height,
  );
  return { canvas, opaque: isOpaque(ctx, width, height) };
}

/// Reads drawn pixels rather than trusting the format; a refused read (tainted canvas) assumes transparency.
function isOpaque(ctx, width, height) {
  try {
    const { data } = ctx.getImageData(0, 0, width, height);
    for (let i = 3; i < data.length; i += 4) if (data[i] !== 255) return false;
    return true;
  } catch {
    return false;
  }
}

function encode(canvas, type, quality) {
  if (canvas.convertToBlob) return canvas.convertToBlob({ type, quality }).catch(() => null);
  return new Promise((resolve) => { canvas.toBlob(resolve, type, quality); });
}

function named(file, blob) {
  const stem = (file.name || 'image').replace(/\.[^.]+$/, '');
  const ext = { 'image/webp': 'webp', 'image/jpeg': 'jpg' }[blob.type] || 'png';
  return new File([blob], `${stem}.${ext}`, { type: blob.type });
}

function clamp(value, low, high) {
  // A square wider than the picture: the midpoint is the only unbiased answer.
  if (low > high) return (low + high) / 2;
  return Math.min(high, Math.max(low, value));
}

function ascii(b, at, len) {
  let out = '';
  for (let i = 0; i < len; i += 1) out += String.fromCharCode(b[at + i] || 0);
  return out;
}

function isGifBytes(b) {
  return ascii(b, 0, 3) === 'GIF';
}

/// Finds a second image descriptor; counting `21 F9` extensions would call a transparent still animated.
function gifFrames(b) {
  const screen = b[10];
  let p = 13 + (screen & 0x80 ? 3 * 2 ** ((screen & 7) + 1) : 0);
  let frames = 0;
  while (p < b.length) {
    const block = b[p];
    p += 1;
    if (block === 0x2c) {
      frames += 1;
      if (frames > 1) return frames;
      const local = b[p + 8];
      p += 9 + (local & 0x80 ? 3 * 2 ** ((local & 7) + 1) : 0);
      p += 1;
      p = skipSubBlocks(b, p);
    } else if (block === 0x21) {
      p += 1;
      p = skipSubBlocks(b, p);
    } else {
      break;
    }
  }
  return frames;
}

function skipSubBlocks(b, at) {
  let p = at;
  while (p < b.length && b[p] !== 0) p += b[p] + 1;
  return p + 1;
}

/// APNG has an `acTL` chunk ahead of the image data.
function hasApngControl(b) {
  let p = 8;
  while (p + 8 <= b.length) {
    const len = (b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3];
    const type = ascii(b, p + 4, 4);
    if (type === 'acTL') return true;
    if (type === 'IDAT') return false;
    p += 12 + len;
  }
  return false;
}

const SHRINKABLE = new Set(['image/png', 'image/jpeg', 'image/webp']);
const SHRINK_STEP = 0.8;
const SHRINK_MIN_SIDE = 64;

function shrinkTo(blob, name) {
  return new File([blob], name, { type: blob.type || 'application/octet-stream' });
}

function encodeShrunk(bitmap, width, height, mime) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) return Promise.resolve(null);
  context.drawImage(bitmap, 0, 0, width, height);
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), mime, mime === 'image/png' ? undefined : 0.85);
  });
}

/// Returns a file within `cap` when the browser can produce one — same name,
/// same type, re-encoded smaller in steps. Anything it cannot help with comes
/// back unchanged: an undersized file, a non-image, a GIF (animation does not
/// survive re-encoding), a picture that will not decode, or a browser without
/// the pieces. The server stays the authority either way.
export async function downscaleToFit(file, cap) {
  if (!cap || file.size <= cap || !SHRINKABLE.has(file.type)) return file;
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return file;
  }
  let width = bitmap.width;
  let height = bitmap.height;
  let last = null;
  for (;;) {
    const blob = await encodeShrunk(bitmap, width, height, file.type);
    if (blob && blob.size <= cap) {
      return shrinkTo(blob, file.name);
    }
    if (blob) last = blob;
    const nextWidth = Math.max(SHRINK_MIN_SIDE, Math.floor(width * SHRINK_STEP));
    const nextHeight = Math.max(SHRINK_MIN_SIDE, Math.floor(height * SHRINK_STEP));
    if (nextWidth === width && nextHeight === height) {
      return last ? shrinkTo(last, file.name) : file;
    }
    width = nextWidth;
    height = nextHeight;
  }
}
