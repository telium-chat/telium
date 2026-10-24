import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CallStage } from '../views/CallStage.jsx';
import { StoreProvider } from '../hooks/useStore.jsx';
import { ModalProvider } from '../hooks/useModal.jsx';
import { WatchProvider } from '../hooks/useWatch.jsx';

const ME = '@alice:home.example';
const BOB = '@bob:home.example';
const CARA = '@cara:home.example';
const DAN = '@dan:home.example';

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

const share = (...ids) => new Map(ids.map((id) => [id, {}]));

function voiceWith(screens) {
  return {
    channelId: 'voice-1',
    server: { mode: 'sfu' },
    local: { self_video: false, streaming: false, self_mute: false, self_deaf: false },
    speaking: new Set(),
    connected: new Set([ME, BOB, CARA, DAN]),
    cameras: new Map(),
    screens,
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
let current = voiceWith(new Map());

const people = [
  { user_id: ME, self_mute: false },
  { user_id: BOB, self_mute: false, streaming: true },
  { user_id: CARA, self_mute: false, streaming: true },
  { user_id: DAN, self_mute: false, streaming: true },
];

function mount({ screens, watchers = [] }) {
  current = voiceWith(screens);
  return render(
    <Around>
      <CallStage
        roomId="voice-1"
        participants={people}
        watchers={watchers}
        onWatch={vi.fn()}
        onWatchQuality={vi.fn()}
      />
    </Around>,
  );
}

const onStage = (name) => screen.queryByLabelText(`${name}'s screen`);

describe('which shares stay visible on the stage', () => {
  it('takes a stage nobody is using', () => {
    mount({ screens: share(BOB) });
    expect(onStage('bob')).toBeTruthy();
  });

  it('keeps a second share visible beside the first', async () => {
    const view = mount({ screens: share(BOB) });
    expect(onStage('bob')).toBeTruthy();

    current = voiceWith(share(BOB, CARA));
    view.rerender(
      <Around>
        <CallStage
          roomId="voice-1"
          participants={people}
          watchers={[]}
          onWatch={vi.fn()}
          onWatchQuality={vi.fn()}
        />
      </Around>,
    );

    expect(onStage('bob')).toBeTruthy();
    expect(onStage('cara')).toBeTruthy();
    expect(screen.getByRole('slider', { name: "cara's screen audio volume" })).toBeTruthy();
  });

  it('provides an independent audio slider for every remote share', async () => {
    const view = mount({ screens: share(BOB) });
    current = voiceWith(share(BOB, CARA));
    view.rerender(
      <Around>
        <CallStage
          roomId="voice-1"
          participants={people}
          watchers={[]}
          onWatch={vi.fn()}
          onWatchQuality={vi.fn()}
        />
      </Around>,
    );

    expect(screen.getByRole('slider', { name: "bob's screen audio volume" })).toBeTruthy();
    expect(screen.getByRole('slider', { name: "cara's screen audio volume" })).toBeTruthy();
  });

  it('hides the share volume slider until hovered, the way the fullscreen button hides', () => {
    mount({ screens: share(BOB) });
    const slider = screen.getByRole('slider', { name: "bob's screen audio volume" });
    const label = slider.closest('label');
    expect(label.className).toContain('opacity-0');
    expect(label.className).toContain('group-hover:opacity-100');
    expect(label.className).toContain('focus-within:opacity-100');
  });

  it('keeps the share volume slider drawn on a phone', () => {
    const view = mount({ screens: share(BOB) });
    view.rerender(
      <Around>
        <CallStage
          roomId="voice-1"
          participants={people}
          watchers={[]}
          onWatch={vi.fn()}
          onWatchQuality={vi.fn()}
          mobile
        />
      </Around>,
    );
    const slider = screen.getByRole('slider', { name: "bob's screen audio volume" });
    expect(slider.closest('label').className).toContain('opacity-100');
  });

  it('keeps all active shares visible when another participant starts sharing', async () => {
    const watchers = [{ viewer: ME, streamer: BOB }];
    const view = mount({ screens: share(BOB, CARA), watchers });
    expect(onStage('bob')).toBeTruthy();

    current = voiceWith(share(BOB, CARA, DAN));
    view.rerender(
      <Around>
        <CallStage
          roomId="voice-1"
          participants={people}
          watchers={watchers}
          onWatch={vi.fn()}
          onWatchQuality={vi.fn()}
        />
      </Around>,
    );

    expect(onStage('bob')).toBeTruthy();
    expect(onStage('cara')).toBeTruthy();
    expect(onStage('dan')).toBeTruthy();
  });

  it('shows every share even when one is already subscribed', () => {
    mount({ screens: share(BOB, CARA), watchers: [{ viewer: ME, streamer: CARA }] });
    expect(onStage('cara')).toBeTruthy();
    expect(onStage('bob')).toBeTruthy();
  });
});

describe('the watch gate on a filmstrip thumbnail', () => {
  it('drops the layer picker and shortens its own label', () => {
    mount({ screens: share(BOB), watchers: [{ viewer: ME, streamer: CARA }] });

    expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Stop watching' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'Stream quality' })).toBeNull();
  });
});
