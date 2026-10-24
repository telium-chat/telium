import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { VoiceActivityCard } from '../components/RichActivityCard.jsx';
import { StatusLine } from '../components/StatusText.jsx';
import { dispatchMethods } from '../lib/store/dispatch.js';
import { permissionMethods } from '../lib/store/permissions.js';
import { profileActivitiesFor, voiceActivityFor } from '../lib/voice-activity.js';

function voiceStore({ allowed = true } = {}) {
  return {
    guilds: new Map([['guild-a', { id: 'guild-a', name: 'Linux Community' }]]),
    channels: new Map([
      ['voice-a', { id: 'voice-a', guild_id: 'guild-a', name: 'General', type: 'voice' }],
    ]),
    voice: new Map([
      ['voice-a', [{
        guild_id: 'guild-a',
        channel_id: 'voice-a',
        user_id: '@alice:home.example',
        joined_at: 1_700_000_000_000,
      }]],
    ]),
    can: vi.fn(() => allowed),
  };
}

describe('privacy-scoped voice profile activity', () => {
  it('derives voice activity only from a guild channel the viewer may see', () => {
    const visible = voiceStore();
    expect(voiceActivityFor(visible, '@alice:home.example')).toMatchObject({
      guild_id: 'guild-a',
      guild_name: 'Linux Community',
      channel_id: 'voice-a',
      channel_name: 'General',
    });
    expect(visible.can).toHaveBeenCalledWith('voice-a', 'VIEW_CHANNEL');

    const hidden = voiceStore({ allowed: false });
    expect(voiceActivityFor(hidden, '@alice:home.example')).toBeNull();
  });

  it('never treats a DM call room as profile activity', () => {
    const store = voiceStore();
    store.voice.set('dm-room', [{
      conversation_id: 'dm-room',
      channel_id: 'dm-room',
      user_id: '@alice:home.example',
    }]);
    store.voice.delete('voice-a');
    expect(voiceActivityFor(store, '@alice:home.example')).toBeNull();
  });

  it('can scope the member rail to its own guild while profiles use mutual guilds', () => {
    const store = voiceStore();
    expect(voiceActivityFor(store, '@alice:home.example', { guildId: 'guild-a' })).not.toBeNull();
    expect(voiceActivityFor(store, '@alice:home.example', { guildId: 'guild-b' })).toBeNull();
  });

  it('composes voice with game, music and video without choosing one winner', () => {
    const store = voiceStore();
    const presence = {
      rich_activities: [
        { name: 'Minecraft', type: 0 },
        { name: 'Pink Floyd', type: 2 },
        { name: 'YouTube', type: 3 },
      ],
    };
    const activities = profileActivitiesFor(store, '@alice:home.example', presence);
    expect(activities.voice?.channel_name).toBe('General');
    expect(activities.rich.map((activity) => activity.name)).toEqual([
      'Minecraft', 'Pink Floyd', 'YouTube',
    ]);
  });

  it('purges voice state when a complete visibility snapshot removes its channel', () => {
    const emitted = [];
    const store = {
      permWrites: new Map(),
      reapplyPending: permissionMethods.reapplyPending,
      channels: new Map([
        ['voice-a', { id: 'voice-a', guild_id: 'guild-a', name: 'Secret Voice' }],
        ['text-a', { id: 'text-a', guild_id: 'guild-a', name: 'general' }],
        ['thread-a', {
          id: 'thread-a', guild_id: 'guild-a', name: 'topic', type: 'thread', parent_id: 'text-a',
        }],
      ]),
      voice: new Map([['voice-a', [{ user_id: '@alice:home.example', channel_id: 'voice-a' }]]]),
      watchers: new Map([['voice-a', [{ viewer: '@me:home.example' }]]]),
      emit: vi.fn((event, value) => emitted.push([event, value])),
      loadReadState: vi.fn(async () => {}),
    };

    dispatchMethods.onDispatch.call(store, {
      domain: 'guild.example',
      t: 'CHANNEL_VISIBILITY',
      d: {
        guild_id: 'guild-a',
        channels: [{ id: 'text-a', name: 'general' }],
      },
    });

    expect(store.channels.has('voice-a')).toBe(false);
    expect(store.channels.has('thread-a')).toBe(true);
    expect(store.voice.has('voice-a')).toBe(false);
    expect(store.watchers.has('voice-a')).toBe(false);
    expect(emitted).toContainEqual(['voice', 'voice-a']);
  });

  it('does not delete an opened thread from a base-channel visibility snapshot', () => {
    const store = {
      permWrites: new Map(),
      reapplyPending: permissionMethods.reapplyPending,
      channels: new Map([
        ['thread-a', {
          id: 'thread-a',
          guild_id: 'guild-a',
          type: 'thread',
          parent_id: 'text-a',
          name: 'opened thread',
        }],
        ['text-a', { id: 'text-a', guild_id: 'guild-a', type: 'text', name: 'general' }],
      ]),
      voice: new Map(),
      watchers: new Map(),
      emit: vi.fn(),
      loadReadState: vi.fn(async () => {}),
    };

    dispatchMethods.onDispatch.call(store, {
      domain: 'guild.example',
      t: 'CHANNEL_VISIBILITY',
      d: {
        guild_id: 'guild-a',
        channels: [{ id: 'text-a', type: 'text', name: 'general' }],
        voice_states: [],
      },
    });

    expect(store.channels.has('thread-a')).toBe(true);
  });

  it('hydrates an already-running call when channel visibility is newly granted', () => {
    const store = {
      permWrites: new Map(),
      reapplyPending: permissionMethods.reapplyPending,
      channels: new Map(),
      voice: new Map(),
      watchers: new Map(),
      emit: vi.fn(),
      loadReadState: vi.fn(async () => {}),
    };

    dispatchMethods.onDispatch.call(store, {
      domain: 'guild.example',
      t: 'CHANNEL_VISIBILITY',
      d: {
        guild_id: 'guild-a',
        channels: [{ id: 'voice-a', name: 'Staff', type: 'voice' }],
        voice_states: [{
          guild_id: 'guild-a',
          channel_id: 'voice-a',
          user_id: '@alice:home.example',
        }],
      },
    });

    expect(store.channels.get('voice-a')).toMatchObject({
      guild_id: 'guild-a',
      name: 'Staff',
    });
    expect(store.voice.get('voice-a')).toEqual([
      expect.objectContaining({ user_id: '@alice:home.example' }),
    ]);
    expect(store.emit).toHaveBeenCalledWith('voice', 'voice-a');
  });

  it('lets voice outrank the custom/activity line in compact member UI', () => {
    const html = renderToStaticMarkup(createElement(StatusLine, {
      presence: {
        custom_status: 'busy building',
        rich_activity: { name: 'Minecraft', type: 0 },
      },
      store: {},
      priorityActivity: { kind: 'voice', verb: 'In', name: 'General' },
    }));
    expect(html).toContain('General');
    expect(html).toContain('In');
    expect(html).not.toContain('busy building');
    expect(html).not.toContain('Minecraft');
  });

  it('renders the authorized guild and channel without needing Rich Presence', () => {
    const html = renderToStaticMarkup(createElement(VoiceActivityCard, {
      activity: voiceActivityFor(voiceStore(), '@alice:home.example'),
    }));
    expect(html).toContain('In Voice');
    expect(html).toContain('General');
    expect(html).toContain('Linux Community');
  });
});
