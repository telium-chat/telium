import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CallStage } from '../views/CallStage.jsx';
import { StoreProvider } from '../hooks/useStore.jsx';
import { ModalProvider } from '../hooks/useModal.jsx';
import { WatchProvider } from '../hooks/useWatch.jsx';

const ME = '@alice:home.example';
const THEM = '@bob:home.example';

const store = {
  me: { user_id: ME },
  channels: new Map([['voice-1', { guild_id: 'guild-1' }]]),
  guilds: new Map([['guild-1', { domain: 'guild.example' }]]),
  members: new Map(),
  voice: new Map(),
  can: () => true,
  apiForGuild: () => ({ base: 'https://guild.example' }),
  apiForChannel: () => ({}),
  on: () => () => {},
};

const Around = ({ children }) => (
  <StoreProvider store={store}>
    <ModalProvider>
      <WatchProvider>{children}</WatchProvider>
    </ModalProvider>
  </StoreProvider>
);

function voiceIn(mode) {
  return {
    channelId: 'voice-1',
    server: { mode },
    local: { self_video: false, streaming: false, self_mute: false, self_deaf: false },
    speaking: new Set(),
    connected: new Set([ME, THEM]),
    cameras: new Map(),
    screens: new Map(),
    micDenied: false,
    audioBlocked: false,
    cameraFacing: 'user',
    join: vi.fn(),
    leave: vi.fn(),
    toggle: vi.fn(),
    toggleStream: vi.fn(),
  };
}

vi.mock('../hooks/useVoice.jsx', () => ({ useVoice: () => current }));
let current = voiceIn('sfu');

const people = [
  { user_id: ME, self_mute: false },
  { user_id: THEM, self_mute: false, streaming: true },
];

function mount({ mode, onWatch, onWatchQuality, watchers = [] }) {
  current = voiceIn(mode);
  return render(
    <Around>
      <CallStage
        roomId="voice-1"
        participants={people}
        watchers={watchers}
        onWatch={onWatch}
        onWatchQuality={onWatchQuality}
      />
    </Around>,
  );
}

describe('the stream quality picker', () => {
  it('shows the recorded choice while watching and reports a new one', async () => {
    const user = userEvent.setup();
    const onWatchQuality = vi.fn();
    mount({
      mode: 'sfu',
      onWatch: vi.fn(),
      onWatchQuality,
      watchers: [{ viewer: ME, streamer: THEM, quality: 'medium' }],
    });

    const picker = screen.getByRole('combobox', { name: 'Stream quality' });
    expect(picker.value).toBe('medium');
    expect([...picker.options].map((o) => o.value)).toEqual(['auto', 'low', 'medium', 'high']);

    await user.selectOptions(picker, 'low');
    expect(onWatchQuality).toHaveBeenCalledWith(THEM, 'low');
  });

  it('defaults to auto when the watch row carries no quality', () => {
    mount({
      mode: 'sfu',
      onWatch: vi.fn(),
      onWatchQuality: vi.fn(),
      watchers: [{ viewer: ME, streamer: THEM }],
    });
    expect(screen.getByRole('combobox', { name: 'Stream quality' }).value).toBe('auto');
  });

  it('has nothing to pick before the forward is bought, or without a listener', () => {
    mount({ mode: 'sfu', onWatch: vi.fn(), onWatchQuality: vi.fn() });
    expect(screen.queryByRole('combobox', { name: 'Stream quality' })).toBeNull();

    mount({
      mode: 'sfu',
      onWatch: vi.fn(),
      watchers: [{ viewer: ME, streamer: THEM, quality: 'high' }],
    });
    expect(screen.queryByRole('combobox', { name: 'Stream quality' })).toBeNull();
  });
});

describe('the screen-share watch gate', () => {
  it('asks before it forwards, in an SFU room', async () => {
    const user = userEvent.setup();
    const onWatch = vi.fn();
    mount({ mode: 'sfu', onWatch });

    await user.click(screen.getByRole('button', { name: 'Watch' }));
    expect(onWatch).toHaveBeenCalledWith(THEM, true);
  });

  it('offers to stop once the forward has been bought', async () => {
    const user = userEvent.setup();
    const onWatch = vi.fn();
    mount({ mode: 'sfu', onWatch, watchers: [{ viewer: ME, streamer: THEM }] });

    await user.click(screen.getByRole('button', { name: 'Stop watching' }));
    expect(onWatch).toHaveBeenCalledWith(THEM, false);
  });

  it('does not ask in a mesh, where the picture is already on the wire', () => {
    mount({ mode: 'mesh', onWatch: vi.fn() });

    expect(screen.queryByRole('button', { name: 'Watch' })).toBeNull();
  });

  it('never offers to watch your own screen', () => {
    current = voiceIn('sfu');
    render(
      <Around>
        <CallStage
          roomId="voice-1"
          participants={[{ user_id: ME, self_mute: false, streaming: true }]}
          watchers={[]}
          onWatch={vi.fn()}
        />
      </Around>,
    );

    expect(screen.queryByRole('button', { name: 'Watch' })).toBeNull();
  });
});
