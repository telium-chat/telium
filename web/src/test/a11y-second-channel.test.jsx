import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Dots } from '../components/Flow.jsx';
import { CallStage, DockButton } from '../views/CallStage.jsx';
import { IncomingCallHost } from '../views/IncomingCall.jsx';
import { StoreProvider } from '../hooks/useStore.jsx';
import { ModalProvider } from '../hooks/useModal.jsx';
import { WatchProvider } from '../hooks/useWatch.jsx';

const ME = '@alice:home.example';
const BOB = '@bob:home.example';

const store = {
  me: { user_id: ME },
  channels: new Map([['voice-1', { guild_id: 'guild-1' }]]),
  guilds: new Map([['guild-1', { domain: 'guild.example' }]]),
  members: new Map(),
  voice: new Map(),
  ringing: new Map(),
  can: () => true,
  apiForGuild: () => ({ base: 'https://guild.example' }),
  apiForChannel: () => ({}),
  on: () => () => {},
};

const Around = ({ children }) => (
  <StoreProvider store={store}>
    <ModalProvider><WatchProvider>{children}</WatchProvider></ModalProvider>
  </StoreProvider>
);

let voice = null;
vi.mock('../hooks/useVoice.jsx', () => ({ useVoice: () => voice }));

const stage = () => (
  <Around>
    <CallStage roomId="voice-1" participants={[{ user_id: ME }, { user_id: BOB }]} watchers={[]} onWatch={vi.fn()} onWatchQuality={vi.fn()} />
  </Around>
);

describe('state that is painted is also written down', () => {
  it('says how far through a flow you are', () => {
    const { container } = render(<Dots steps={['a', 'b', 'c', 'd']} at="c" />);
    expect(container.textContent).toContain('Step 3 of 4');
  });

  it('call toggles carry aria-pressed; plain actions do not', () => {
    const { rerender } = render(<DockButton title="Mute" off={false}>x</DockButton>);
    expect(screen.getByRole('button', { name: 'Mute' }).getAttribute('aria-pressed')).toBe('false');
    rerender(<DockButton title="Unmute" off>x</DockButton>);
    expect(screen.getByRole('button', { name: 'Unmute' }).getAttribute('aria-pressed')).toBe('true');
    rerender(<DockButton title="Leave call">x</DockButton>);
    expect(screen.getByRole('button', { name: 'Leave call' }).hasAttribute('aria-pressed')).toBe(false);
  });

  it('says who is speaking, not only rings them', () => {
    voice = {
      channelId: 'voice-1',
      server: { mode: 'sfu' },
      local: { self_video: false, streaming: false, self_mute: false, self_deaf: false },
      speaking: new Set([BOB]),
      connected: new Set([ME, BOB]),
      cameras: new Map(),
      screens: new Map(),
      micDenied: false,
      audioBlocked: false,
      cameraFacing: 'user',
      join: vi.fn(), leave: vi.fn(), toggle: vi.fn(), toggleStream: vi.fn(),
    };
    const { rerender, container } = render(stage());
    expect(container.textContent).toContain('speaking');
    voice.speaking = new Set();
    rerender(stage());
    expect(container.textContent).not.toContain('speaking');
  });

  it('has an empty assertive live region before a call rings', () => {
    const { container } = render(<Around><IncomingCallHost /></Around>);
    const live = container.querySelector('[aria-live]');
    expect(live?.getAttribute('aria-live')).toBe('assertive');
    expect(live.textContent).toBe('');
  });
});
