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

const streams = (...ids) => new Map(ids.map((id) => [id, { id }]));

const onWatch = vi.fn();

function voiceWith({ screens = new Map(), cameras = new Map() } = {}) {
  return {
    channelId: 'voice-1',
    server: { mode: 'sfu' },
    local: { self_video: false, streaming: false, self_mute: false, self_deaf: false },
    speaking: new Set(),
    connected: new Set([ME, BOB, CARA, DAN]),
    cameras,
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
let current = voiceWith();

const looking = [
  { user_id: ME, self_mute: false, self_video: true },
  { user_id: BOB, self_mute: false, self_video: true },
  { user_id: CARA, self_mute: false, self_video: true },
  { user_id: DAN, self_mute: false },
];

const stage = (participants) => (
  <Around>
    <CallStage
      roomId="voice-1"
      participants={participants}
      watchers={[]}
      onWatch={onWatch}
      onWatchQuality={vi.fn()}
    />
  </Around>
);

function mount({ participants = looking, ...rest } = {}) {
  onWatch.mockClear();
  current = voiceWith(rest);
  const view = render(stage(participants));
  return {
    ...view,
    update: ({ participants: next = participants, ...voice } = {}) => {
      current = voiceWith(voice);
      view.rerender(stage(next));
    },
  };
}

const pictures = (name) => screen.queryAllByLabelText(`${name}'s camera`).length;
const expand = (name) => screen.getByRole('button', { name: `Expand ${name}'s video` });
const collapse = (name) => screen.getByRole('button', { name: `Return ${name} to the grid` });

describe('expanding a person into the stage', () => {
  it('goes both ways', async () => {
    const user = userEvent.setup();
    mount({ cameras: streams(ME, BOB, CARA) });
    expect(pictures('cara')).toBe(1);

    await user.click(expand('cara'));
    expect(pictures('cara')).toBe(2);
    expect(collapse('cara').getAttribute('aria-pressed')).toBe('true');

    await user.click(collapse('cara'));
    expect(pictures('cara')).toBe(1);
    expect(expand('cara').getAttribute('aria-pressed')).toBe('false');
  });

  it('is operable from the keyboard and names what it does', async () => {
    const user = userEvent.setup();
    mount({ cameras: streams(ME, BOB, CARA) });

    expand('cara').focus();
    await user.keyboard('{Enter}');
    expect(pictures('cara')).toBe(2);

    collapse('cara').focus();
    await user.keyboard(' ');
    expect(pictures('cara')).toBe(1);
  });

  it('offers nothing on a face that is only an avatar', () => {
    mount({ cameras: streams(ME, BOB, CARA) });
    expect(screen.queryByRole('button', { name: /dan/i })).toBeNull();
  });

  it('tells nobody else', async () => {
    const user = userEvent.setup();
    mount({ cameras: streams(ME, BOB, CARA) });

    await user.click(expand('bob'));
    expect(onWatch).not.toHaveBeenCalled();
    expect(current.join).not.toHaveBeenCalled();
    expect(current.toggle).not.toHaveBeenCalled();
  });
});

describe('what a person on the stage yields to', () => {
  it('gives the slot to a share and keeps the choice', async () => {
    const user = userEvent.setup();
    const view = mount({ cameras: streams(ME, BOB, CARA) });
    await user.click(expand('cara'));
    expect(pictures('cara')).toBe(2);

    view.update({ cameras: streams(ME, BOB, CARA), screens: streams(BOB) });
    expect(screen.getByLabelText("bob's screen")).toBeTruthy();
    expect(pictures('cara')).toBe(1);
    expect(collapse('cara').getAttribute('aria-pressed')).toBe('true');
  });

  it('takes the slot back when the last share stops', async () => {
    const user = userEvent.setup();
    const view = mount({ cameras: streams(ME, BOB, CARA) });
    await user.click(expand('cara'));
    view.update({ cameras: streams(ME, BOB, CARA), screens: streams(BOB) });
    view.update({ cameras: streams(ME, BOB, CARA) });

    expect(screen.queryByLabelText("bob's screen")).toBeNull();
    expect(pictures('cara')).toBe(2);
  });
});

describe('a stage that cannot be left empty', () => {
  it('falls back to the grid when the camera goes off, and returns when it comes back', async () => {
    const user = userEvent.setup();
    const view = mount({ cameras: streams(ME, BOB, CARA) });
    await user.click(expand('cara'));

    view.update({ cameras: streams(ME, BOB) });
    expect(pictures('cara')).toBe(0);
    expect(pictures('bob')).toBe(1);

    view.update({ cameras: streams(ME, BOB, CARA) });
    expect(pictures('cara')).toBe(2);
  });

  it('forgets somebody who leaves the room', async () => {
    const user = userEvent.setup();
    const view = mount({ cameras: streams(ME, BOB, CARA) });
    await user.click(expand('cara'));

    view.update({
      participants: looking.filter((v) => v.user_id !== CARA),
      cameras: streams(ME, BOB),
    });
    expect(pictures('cara')).toBe(0);

    view.update({ cameras: streams(ME, BOB, CARA) });
    expect(pictures('cara')).toBe(1);
    expect(expand('cara').getAttribute('aria-pressed')).toBe('false');
  });
});
