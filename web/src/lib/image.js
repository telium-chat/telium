/// Client-side shrink for profile assets the origin would refuse. The server
/// answers an oversized avatar with "crop or downscale it first"; this does
/// the downscaling so the sentence never has to be read.

const SHRINKABLE = new Set(['image/png', 'image/jpeg', 'image/webp']);
const STEP = 0.8;
const MIN_SIDE = 64;

function asFile(blob, name) {
  return new File([blob], name, { type: blob.type || 'application/octet-stream' });
}

function encode(bitmap, width, height, mime, quality) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) return Promise.resolve(null);
  context.drawImage(bitmap, 0, 0, width, height);
  return new Promise((resolve) => {
    canvas.toBlob(
      (blob) => resolve(blob),
      mime,
      mime === 'image/png' ? undefined : quality,
    );
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
    const blob = await encode(bitmap, width, height, file.type, 0.85);
    if (blob && blob.size <= cap) {
      return asFile(blob, file.name);
    }
    if (blob) last = blob;
    const nextWidth = Math.max(MIN_SIDE, Math.floor(width * STEP));
    const nextHeight = Math.max(MIN_SIDE, Math.floor(height * STEP));
    if (nextWidth === width && nextHeight === height) {
      return last ? asFile(last, file.name) : file;
    }
    width = nextWidth;
    height = nextHeight;
  }
}
