import { describe, expect, it } from 'vitest';
import { qrMatrix } from '../lib/qr.js';

describe('QR encoder', () => {
  it('encodes authenticator URIs into a stable Version 20 QR matrix', () => {
    const uri = 'otpauth://totp/Telium:%40alice%3Ahome.example'
      + '?secret=JBSWY3DPEHPK3PXP&issuer=Telium&digits=6&period=30';
    const matrix = qrMatrix(uri);

    expect(matrix).toHaveLength(97);
    expect(matrix.every((row) => row.length === 97)).toBe(true);
    expect(matrix.flat().filter(Boolean)).toHaveLength(4774);

    expect(matrix[0][0]).toBe(true);
    expect(matrix[1][1]).toBe(false);
    expect(matrix[3][3]).toBe(true);
    expect(matrix[0][96]).toBe(true);
    expect(matrix[96][0]).toBe(true);
  });

  it('refuses payloads that cannot fit instead of silently truncating a secret', () => {
    expect(() => qrMatrix('x'.repeat(667))).toThrow(/too long/i);
  });
});
