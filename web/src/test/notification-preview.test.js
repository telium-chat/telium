import { describe, expect, it } from 'vitest';
import {
  NOTIFICATION_PREVIEW,
  genericNotificationBody,
  normalizeNotificationPreview,
  notificationPreview,
} from '../lib/notification-preview.js';

describe('notification preview privacy', () => {
  const input = {
    title: '#general',
    body: 'Alice: secret message text',
    senderTitle: 'Alice',
    genericBody: 'New mention',
  };

  it('keeps the full preview only in full mode', () => {
    expect(notificationPreview(NOTIFICATION_PREVIEW.FULL, input)).toEqual({
      title: '#general',
      body: 'Alice: secret message text',
    });
  });

  it('sender mode keeps identity but drops message text', () => {
    expect(notificationPreview(NOTIFICATION_PREVIEW.SENDER, input)).toEqual({
      title: 'Alice',
      body: 'New mention',
    });
  });

  it('hidden mode drops both sender and message text', () => {
    expect(notificationPreview(NOTIFICATION_PREVIEW.HIDDEN, input)).toEqual({
      title: 'Telium',
      body: 'New mention',
    });
  });

  it('unknown persisted values use the backwards-compatible full mode', () => {
    expect(normalizeNotificationPreview('future-mode')).toBe('full');
    expect(notificationPreview('future-mode', input).body).toBe('Alice: secret message text');
  });
});

describe('generic notification bodies', () => {
  it('says only that an encrypted message arrived', () => {
    expect(genericNotificationBody('encrypted_message')).toBe('Encrypted message');
  });

  it('keeps the vocabulary its Android twin uses for guild and account events', () => {
    expect(genericNotificationBody('mention')).toBe('New mention');
    expect(genericNotificationBody('reply')).toBe('New reply');
    expect(genericNotificationBody('call')).toBe('Incoming call');
    expect(genericNotificationBody('incoming_call')).toBe('Incoming call');
    expect(genericNotificationBody('migration')).toBe('Account alert');
    expect(genericNotificationBody('security')).toBe('Account alert');
  });

  it('falls back to a neutral label for a kind this build does not author', () => {
    expect(genericNotificationBody('future_kind')).toBe('New notification');
    expect(genericNotificationBody(undefined)).toBe('New notification');
  });

  it('is what a redacted preview shows in place of the message', () => {
    expect(notificationPreview(NOTIFICATION_PREVIEW.HIDDEN, {
      title: 'Alice',
      body: 'Encrypted message',
      genericBody: genericNotificationBody('encrypted_message'),
    })).toEqual({ title: 'Telium', body: 'Encrypted message' });
  });
});
