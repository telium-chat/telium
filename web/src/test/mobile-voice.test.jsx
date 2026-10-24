import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

const { store, voice } = vi.hoisted(() => ({
  store: {
    me: { user_id: '@alice:home.example' },
    channels: new Map([['voice-1', { guild_id: 'guild-1' }]]),
    members: new Map(),
    voice: new Map(),
    can: () => true,
    apiForGuild: () => ({ base: 'https://guild.example' }),
    apiForChannel: () => ({}),
    on: () => () => {},
  },
  voice: {
    channelId: null,
    server: null,
    local: { self_video: false, streaming: false, self_mute: false, self_deaf: false },
    speaking: new Set(),
    connected: new Set(),
    cameras: new Map(),
    screens: new Map(),
    micDenied: false,
    join: vi.fn(),
    leave: vi.fn(),
    toggle: vi.fn(),
    toggleStream: vi.fn(),
  },
}));

vi.mock('../hooks/useVoice.jsx', () => ({ useVoice: () => voice }));

import { CallStage } from '../views/CallStage.jsx';
import { StoreProvider } from '../hooks/useStore.jsx';
import { ModalProvider } from '../hooks/useModal.jsx';
import { WatchProvider } from '../hooks/useWatch.jsx';

const Around = ({ children }) => (
  <StoreProvider store={store}>
    <ModalProvider>
      <WatchProvider>{children}</WatchProvider>
    </ModalProvider>
  </StoreProvider>
);

const people = [
  { user_id: '@alice:home.example', self_mute: false },
  { user_id: '@bob:remote.example', self_mute: false },
  { user_id: '@cara:remote.example', self_mute: false },
];

describe('mobile call stage', () => {
  it('uses a two-column camera grid and retains a touch-sized join action', () => {
    store.me = { user_id: '@viewer:home.example' };
    const { container } = render(
      <Around>
        <CallStage roomId="voice-1" participants={people} mobile joinHint="Join" />
      </Around>,
    );

    expect(container.querySelector('.mobile-call-stage.is-mobile')).toBeTruthy();
    expect(container.querySelector('.grid-cols-2')).toBeTruthy();
    expect(container.querySelectorAll('[data-user]')).toHaveLength(3);
    expect(screen.getByRole('button', { name: 'Join voice' }).className).toContain('py-3');
  });

  it('gives a mobile screenshare the primary stage and keeps call controls wired', () => {
    store.me = { user_id: '@alice:home.example' };
    voice.channelId = 'voice-1';
    voice.server = { mode: 'mesh' };
    voice.screens = new Map([['@alice:home.example', {}]]);

    render(
      <Around>
        <CallStage
          roomId="voice-1"
          participants={[people[0]]}
          mobile
          joinHint="Join"
        />
      </Around>,
    );

    expect(screen.getByLabelText('Your screen')).toBeTruthy();
    const toolbar = screen.getByRole('toolbar', { name: 'Call controls' });
    expect(toolbar).toBeTruthy();
    expect(toolbar.className).toContain('overflow-x-auto');
    expect(toolbar.className).toContain('flex-nowrap');
    expect(screen.getByRole('button', { name: 'Share screen' })).toBeTruthy();
  });
});
