import { describe, expect, it, vi } from 'vitest';
import { answerAndroidCallNotification } from '../lib/android-call-notification.js';

const ME = '@alice:home.example';
const CALLER = '@carol:other.example';

function callStore(states) {
  return {
    signedIn: true,
    me: { user_id: ME },
    voiceApi: vi.fn(() => ({
      voiceStates: vi.fn(async () => ({ voice_states: states })),
    })),
    hydrateVoice: vi.fn(),
    stopRing: vi.fn(),
  };
}

describe('Android notification call answer', () => {
  it('joins only after the authenticated roster still contains another participant', async () => {
    const states = [{ user_id: CALLER, conversation_id: 'dm1', channel_id: 'dm1' }];
    const store = callStore(states);
    const join = vi.fn(async () => {});

    await expect(answerAndroidCallNotification(store, join, 'dm1')).resolves.toBe(true);

    expect(store.hydrateVoice).toHaveBeenCalledWith('dm1', states);
    expect(store.stopRing).toHaveBeenCalledWith('dm1', 'answered');
    expect(join).toHaveBeenCalledWith('dm1');
  });

  it('does not turn a stale Answer action into a new outgoing call', async () => {
    const store = callStore([]);
    const join = vi.fn(async () => {});

    await expect(answerAndroidCallNotification(store, join, 'dm1')).resolves.toBe(false);

    expect(store.hydrateVoice).toHaveBeenCalledWith('dm1', []);
    expect(store.stopRing).not.toHaveBeenCalled();
    expect(join).not.toHaveBeenCalled();
  });
});
