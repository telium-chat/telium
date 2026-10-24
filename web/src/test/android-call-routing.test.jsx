import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { store, voice, getRoutes, setRoute } = vi.hoisted(() => ({
  store: {
    me: { user_id: '@alice:home.example' },
    channels: new Map([['voice-1', { guild_id: 'guild-1' }]]),
    guilds: new Map([['guild-1', { domain: 'guild.example' }]]),
    members: new Map(),
    voice: new Map(),
    can: () => true,
    apiForGuild: () => ({ base: 'https://guild.example' }),
    apiForChannel: () => ({}),
    on: () => () => {},
  },
  voice: {
    channelId: 'voice-1',
    server: { mode: 'mesh' },
    local: { self_video: false, streaming: false, self_mute: false, self_deaf: false },
    speaking: new Set(),
    connected: new Set(),
    cameras: new Map(),
    screens: new Map(),
    micDenied: false,
    audioBlocked: false,
    cameraFacing: 'user',
    join: vi.fn(),
    leave: vi.fn(),
    toggle: vi.fn(),
    toggleStream: vi.fn(),
    flipCamera: vi.fn(),
    resumeAudio: vi.fn(),
  },
  getRoutes: vi.fn(async () => ({
    supported: true,
    selected: 'auto',
    automatic_label: 'Automatic · Speaker',
    routes: [
      { id: '17', label: 'Bluetooth', kind: 'bluetooth' },
      { id: '23', label: 'Earpiece', kind: 'earpiece' },
    ],
  })),
  setRoute: vi.fn(async (id) => String(id)),
}));

vi.mock('../hooks/useVoice.jsx', () => ({ useVoice: () => voice }));
vi.mock('../lib/platform.js', () => ({
  isAndroid: true,
  isTauriRuntime: () => false,
  getAndroidAudioRoutes: getRoutes,
  setAndroidAudioRoute: setRoute,
}));

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

describe('Android call audio routing', () => {
  it('offers Android communication routes and switches to the chosen output', async () => {
    const user = userEvent.setup();
    render(
      <Around>
        <CallStage
          roomId="voice-1"
          participants={[{ user_id: '@alice:home.example', self_mute: false }]}
          mobile
          joinHint="Join"
        />
      </Around>,
    );

    expect(screen.queryByRole('button', { name: 'Share screen' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Audio output' }));

    expect(getRoutes).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole('button', { name: /Automatic · Speaker/ })).toBeTruthy();
    const bluetooth = screen.getByRole('button', { name: 'Bluetooth' });
    expect(bluetooth).toBeTruthy();

    await user.click(bluetooth);
    await waitFor(() => expect(setRoute).toHaveBeenCalledWith('17'));
  });
});
