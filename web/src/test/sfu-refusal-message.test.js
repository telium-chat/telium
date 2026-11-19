import { describe, it, expect } from 'vitest';
import { errorMessage } from '../lib/i18n/errors.js';
import { t } from '../lib/i18n/index.js';

describe('a voice relay refusal', () => {
  it('names an unverifiable signer instead of a permission problem', () => {
    const failed = Object.assign(new Error('SFU /session returned 403'), {
      status: 403,
      body: { error: 'could not verify the server that signed this request', code: 'sfu_origin_unverified' },
    });
    const message = errorMessage(failed);
    expect(message).toBe(t('errors.sfu_origin_unverified'));
    expect(message).not.toBe(t('errors.status.403'));
  });

  it('falls back to the status sentence for a relay that sends no code', () => {
    const failed = Object.assign(new Error('SFU /session returned 403'), { status: 403, body: { error: 'bad signature' } });
    expect(errorMessage(failed)).toBe(t('errors.status.403'));
  });
});
