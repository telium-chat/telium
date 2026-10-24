// Dependency-free QR encoder: the TOTP secret must not go to a third-party service.

const VERSION = 20;
const SIZE = VERSION * 4 + 17;
const DATA_CODEWORDS = 669;
const ECC_CODEWORDS_PER_BLOCK = 26;
const BLOCK_DATA_LENGTHS = [41, 41, 41, 42, 42, 42, 42, 42, 42, 42, 42, 42, 42, 42, 42, 42];
const ALIGNMENT_CENTERS = [6, 34, 62, 90];

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255];
}

function mul(a, b) {
  if (!a || !b) return 0;
  return EXP[LOG[a] + LOG[b]];
}

function generator(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i += 1) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= poly[j];
      next[j + 1] ^= mul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}
const GEN = generator(ECC_CODEWORDS_PER_BLOCK);

function remainder(data) {
  const out = new Array(ECC_CODEWORDS_PER_BLOCK).fill(0);
  for (const byte of data) {
    const factor = byte ^ out[0];
    out.shift();
    out.push(0);
    for (let i = 0; i < ECC_CODEWORDS_PER_BLOCK; i += 1) {
      out[i] ^= mul(GEN[i + 1], factor);
    }
  }
  return out;
}

function appendBits(bits, value, length) {
  for (let i = length - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1);
}

function dataCodewords(text) {
  const bytes = [...new TextEncoder().encode(text)];
  if (bytes.length > 666) throw new Error('QR payload is too long');

  const bits = [];
  appendBits(bits, 0b0100, 4);
  appendBits(bits, bytes.length, 16);
  for (const byte of bytes) appendBits(bits, byte, 8);

  const capacity = DATA_CODEWORDS * 8;
  for (let i = 0; i < Math.min(4, capacity - bits.length); i += 1) bits.push(0);
  while (bits.length % 8) bits.push(0);

  const data = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j += 1) byte = (byte << 1) | bits[i + j];
    data.push(byte);
  }
  let pad = 0;
  while (data.length < DATA_CODEWORDS) data.push(pad++ % 2 === 0 ? 0xec : 0x11);
  return data;
}

function codewords(text) {
  const data = dataCodewords(text);
  const blocks = [];
  let offset = 0;
  for (const len of BLOCK_DATA_LENGTHS) {
    const chunk = data.slice(offset, offset + len);
    offset += len;
    blocks.push({ data: chunk, ecc: remainder(chunk) });
  }

  const out = [];
  const maxData = Math.max(...BLOCK_DATA_LENGTHS);
  for (let i = 0; i < maxData; i += 1) {
    for (const block of blocks) if (i < block.data.length) out.push(block.data[i]);
  }
  for (let i = 0; i < ECC_CODEWORDS_PER_BLOCK; i += 1) {
    for (const block of blocks) out.push(block.ecc[i]);
  }
  return out;
}

function formatBits(mask) {
  const data = mask;
  let rem = data << 10;
  for (let i = 14; i >= 10; i -= 1) {
    if ((rem >>> i) & 1) rem ^= 0x537 << (i - 10);
  }
  return (((data << 10) | rem) ^ 0x5412) & 0x7fff;
}

function versionBits() {
  let rem = VERSION << 12;
  for (let i = 17; i >= 12; i -= 1) {
    if ((rem >>> i) & 1) rem ^= 0x1f25 << (i - 12);
  }
  return (VERSION << 12) | rem;
}

const mask0 = (row, col) => (row + col) % 2 === 0;

export function qrMatrix(text) {
  const modules = Array.from({ length: SIZE }, () => Array(SIZE).fill(false));
  const reserved = Array.from({ length: SIZE }, () => Array(SIZE).fill(false));
  const set = (row, col, dark) => {
    if (row < 0 || col < 0 || row >= SIZE || col >= SIZE) return;
    modules[row][col] = Boolean(dark);
    reserved[row][col] = true;
  };

  const finder = (top, left) => {
    for (let dr = -1; dr <= 7; dr += 1) {
      for (let dc = -1; dc <= 7; dc += 1) {
        const row = top + dr;
        const col = left + dc;
        if (row < 0 || col < 0 || row >= SIZE || col >= SIZE) continue;
        const inCore = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
        const dark = inCore && (
          dr === 0 || dr === 6 || dc === 0 || dc === 6
          || (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4)
        );
        set(row, col, dark);
      }
    }
  };
  finder(0, 0);
  finder(0, SIZE - 7);
  finder(SIZE - 7, 0);

  // Alignment before timing so the timing line stops at an alignment marker.
  for (const row of ALIGNMENT_CENTERS) {
    for (const col of ALIGNMENT_CENTERS) {
      if (reserved[row][col]) continue;
      for (let dr = -2; dr <= 2; dr += 1) {
        for (let dc = -2; dc <= 2; dc += 1) {
          set(row + dr, col + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
        }
      }
    }
  }

  for (let i = 8; i < SIZE - 8; i += 1) {
    if (!reserved[6][i]) set(6, i, i % 2 === 0);
    if (!reserved[i][6]) set(i, 6, i % 2 === 0);
  }

  const bit = (value, i) => ((value >>> i) & 1) !== 0;
  const fmt = formatBits(0);
  for (let i = 0; i <= 5; i += 1) set(i, 8, bit(fmt, i));
  set(7, 8, bit(fmt, 6));
  set(8, 8, bit(fmt, 7));
  set(8, 7, bit(fmt, 8));
  for (let i = 9; i < 15; i += 1) set(8, 14 - i, bit(fmt, i));
  for (let i = 0; i < 8; i += 1) set(8, SIZE - 1 - i, bit(fmt, i));
  for (let i = 8; i < 15; i += 1) set(SIZE - 15 + i, 8, bit(fmt, i));
  set(SIZE - 8, 8, true);

  const ver = versionBits();
  for (let i = 0; i < 18; i += 1) {
    const dark = bit(ver, i);
    const a = SIZE - 11 + (i % 3);
    const b = Math.floor(i / 3);
    set(b, a, dark);
    set(a, b, dark);
  }

  const bytes = codewords(text);
  let dataBit = 0;
  for (let right = SIZE - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    const upward = ((right + 1) & 2) === 0;
    for (let vert = 0; vert < SIZE; vert += 1) {
      const row = upward ? SIZE - 1 - vert : vert;
      for (let j = 0; j < 2; j += 1) {
        const col = right - j;
        if (reserved[row][col]) continue;
        let dark = false;
        if (dataBit < bytes.length * 8) {
          dark = ((bytes[dataBit >>> 3] >>> (7 - (dataBit & 7))) & 1) !== 0;
          dataBit += 1;
        }
        modules[row][col] = dark !== mask0(row, col);
      }
    }
  }
  return modules;
}
