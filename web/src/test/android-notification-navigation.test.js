import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/platform.js', () => ({ isMobileTauri: true }));

import { installAndroidNotificationNavigation } from '../lib/android-notification-navigation.js';

function bridgeWith(tap) {
  const listeners = new Set();
  return {
    addEventListener: (_event, fn) => listeners.add(fn),
    removeEventListener: (_event, fn) => listeners.delete(fn),
    postMessage: vi.fn((raw) => {
      const request = JSON.parse(raw);
      queueMicrotask(() => {
        const payload = tap
          ? {
            ok: true,
            has_destination: true,
            request_id: request.request_id,
            tap,
          }
          : {
            ok: true,
            has_destination: false,
            request_id: request.request_id,
          };
        for (const listener of [...listeners]) {
          listener({ data: JSON.stringify(payload) });
        }
      });
    }),
  };
}

function storeFor(userId = '@bob:bob.example') {
  const handlers = new Map();
  return {
    signedIn: true,
    me: { user_id: userId },
    session: { home: { user_id: userId } },
    jumpTo: vi.fn(() => true),
    navigate: vi.fn(),
    on: vi.fn((event, fn) => {
      const set = handlers.get(event) || new Set();
      set.add(fn);
      handlers.set(event, set);
      return () => set.delete(fn);
    }),
    emit(event, ...args) {
      for (const fn of [...(handlers.get(event) || [])]) fn(...args);
    },
  };
}

const destination = {
  type: 'guild_message',
  guild_origin: 'guild.example',
  guild_id: 'guild-1',
  channel_id: 'general',
  message_id: 'message-1',
};

const conversation = {
  type: 'conversation',
  conversation_id: 'conv-1',
};

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}

describe('Android notification navigation', () => {
  beforeEach(() => {
    delete window.teliumAndroidNotificationBridge;
  });

  afterEach(() => {
    delete window.teliumAndroidNotificationBridge;
    vi.restoreAllMocks();
  });

  it('jumps to the exact message for the signed-in account', async () => {
    window.teliumAndroidNotificationBridge = bridgeWith({
      user_id: '@bob:bob.example',
      destination,
    });
    const store = storeFor();

    const dispose = installAndroidNotificationNavigation(store);
    await settle();

    expect(store.jumpTo).toHaveBeenCalledWith('general', 'message-1');
    expect(store.navigate).not.toHaveBeenCalled();
    dispose();
  });

  it('falls back to the authenticated guild/channel when exact jump is unavailable', async () => {
    window.teliumAndroidNotificationBridge = bridgeWith({
      user_id: '@bob:bob.example',
      destination,
    });
    const store = storeFor();
    store.jumpTo.mockReturnValue(false);

    const dispose = installAndroidNotificationNavigation(store);
    await settle();

    expect(store.navigate).toHaveBeenCalledWith({
      view: 'chat',
      guildId: 'guild-1',
      channelId: 'general',
    });
    dispose();
  });

  it('opens the conversation a direct-message wake names', async () => {
    window.teliumAndroidNotificationBridge = bridgeWith({
      user_id: '@bob:bob.example',
      destination: conversation,
    });
    const store = storeFor();

    const dispose = installAndroidNotificationNavigation(store);
    await settle();

    expect(store.navigate).toHaveBeenCalledWith({
      view: 'dms',
      guildId: null,
      channelId: null,
      conversationId: 'conv-1',
    });
    expect(store.jumpTo).not.toHaveBeenCalled();
    dispose();
  });

  it('hands an explicit incoming-call Answer action to the live voice UI', async () => {
    window.teliumAndroidNotificationBridge = bridgeWith({
      user_id: '@bob:bob.example',
      action: 'answer_call',
      destination: conversation,
    });
    const store = storeFor();
    const answer = vi.fn();
    store.on('android-call-answer', answer);

    const dispose = installAndroidNotificationNavigation(store);
    await settle();

    expect(answer).toHaveBeenCalledWith('conv-1');
    expect(store.navigate).toHaveBeenCalledWith({
      view: 'dms',
      guildId: null,
      channelId: null,
      conversationId: 'conv-1',
    });
    dispose();
  });

  it('rejects native call actions on non-conversation destinations', async () => {
    window.teliumAndroidNotificationBridge = bridgeWith({
      user_id: '@bob:bob.example',
      action: 'answer_call',
      destination,
    });
    const store = storeFor();

    const dispose = installAndroidNotificationNavigation(store);
    await settle();

    expect(store.jumpTo).not.toHaveBeenCalled();
    expect(store.navigate).not.toHaveBeenCalled();
    dispose();
  });

  it('routes nothing when a conversation destination names no conversation', async () => {
    window.teliumAndroidNotificationBridge = bridgeWith({
      user_id: '@bob:bob.example',
      destination: { type: 'conversation' },
    });
    const store = storeFor();

    const dispose = installAndroidNotificationNavigation(store);
    await settle();

    expect(store.navigate).not.toHaveBeenCalled();
    expect(store.jumpTo).not.toHaveBeenCalled();
    dispose();
  });

  it('consumes but never routes a conversation wake from a previous account', async () => {
    const nativeBridge = bridgeWith({
      user_id: '@alice:alice.example',
      destination: conversation,
    });
    window.teliumAndroidNotificationBridge = nativeBridge;
    const store = storeFor('@bob:bob.example');

    const dispose = installAndroidNotificationNavigation(store);
    await settle();

    expect(nativeBridge.postMessage).toHaveBeenCalledTimes(1);
    expect(store.navigate).not.toHaveBeenCalled();
    expect(store.jumpTo).not.toHaveBeenCalled();
    dispose();
  });

  it('consumes but never routes a notification from a previous account', async () => {
    const nativeBridge = bridgeWith({
      user_id: '@alice:alice.example',
      destination,
    });
    window.teliumAndroidNotificationBridge = nativeBridge;
    const store = storeFor('@bob:bob.example');

    const dispose = installAndroidNotificationNavigation(store);
    await settle();

    expect(nativeBridge.postMessage).toHaveBeenCalledTimes(1);
    expect(store.jumpTo).not.toHaveBeenCalled();
    expect(store.navigate).not.toHaveBeenCalled();
    dispose();
  });
});
