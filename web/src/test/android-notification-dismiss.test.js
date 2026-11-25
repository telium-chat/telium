import { describe, expect, it, vi } from 'vitest';

vi.mock('../lib/platform.js', () => ({ isMobileTauri: true }));

import {
  installAndroidNotificationNavigation,
  onScreenDestination,
} from '../lib/android-notification-navigation.js';

function recordingBridge() {
  const listeners = new Set();
  const sent = [];
  return {
    sent,
    addEventListener: (_event, fn) => listeners.add(fn),
    removeEventListener: (_event, fn) => listeners.delete(fn),
    postMessage: vi.fn((raw) => {
      const request = JSON.parse(raw);
      sent.push(request);
      queueMicrotask(() => {
        const reply = request.op === 'take_destination'
          ? { ok: true, has_destination: false, request_id: request.request_id }
          : { ok: true, cancelled: 1, request_id: request.request_id };
        for (const fn of [...listeners]) fn({ data: JSON.stringify(reply) });
      });
    }),
  };
}

function store(route) {
  const handlers = new Map();
  return {
    signedIn: true,
    me: { user_id: '@bob:home.example' },
    session: { home: { user_id: '@bob:home.example', base: 'https://home.example', device_id: 'phone-1' } },
    guilds: new Map([['guild-1', { domain: 'guild.example' }]]),
    route,
    jumpTo: vi.fn(),
    navigate: vi.fn(),
    on: (event, fn) => {
      const set = handlers.get(event) || new Set();
      set.add(fn);
      handlers.set(event, set);
      return () => set.delete(fn);
    },
    emit(event) { for (const fn of [...(handlers.get(event) || [])]) fn(); },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('clearing Android alerts for what is on screen', () => {
  it('names the open conversation or channel the way Android indexes alerts', () => {
    expect(onScreenDestination(store({ view: 'dms', conversationId: 'dm-1' })))
      .toEqual({ type: 'conversation', conversation_id: 'dm-1' });
    expect(onScreenDestination(store({ view: 'chat', guildId: 'guild-1', channelId: 'general' })))
      .toEqual({ type: 'guild_channel', guild_origin: 'guild.example', guild_id: 'guild-1', channel_id: 'general' });
    expect(onScreenDestination(store({ view: 'dms', conversationId: null }))).toBeNull();
    expect(onScreenDestination(store({ view: 'chat', guildId: 'unknown', channelId: 'x' }))).toBeNull();
  });

  it('clears a place once when it is opened, and again only after leaving it', async () => {
    const bridge = recordingBridge();
    window.teliumAndroidNotificationBridge = bridge;
    const s = store({ view: 'chat', guildId: null, channelId: null });
    const dispose = installAndroidNotificationNavigation(s);
    await settle();
    const dismissals = () => bridge.sent.filter((m) => m.op === 'dismiss_place');

    s.route = { view: 'dms', conversationId: 'dm-1' };
    s.emit('route');
    s.emit('route');
    await settle();
    expect(dismissals()).toHaveLength(1);
    expect(dismissals()[0]).toMatchObject({
      destination: { type: 'conversation', conversation_id: 'dm-1' },
      device_id: 'phone-1',
    });

    s.route = { view: 'dms', conversationId: null };
    s.emit('route');
    s.route = { view: 'dms', conversationId: 'dm-1' };
    s.emit('route');
    await settle();
    expect(dismissals()).toHaveLength(2);
    dispose();
    delete window.teliumAndroidNotificationBridge;
  });
});
