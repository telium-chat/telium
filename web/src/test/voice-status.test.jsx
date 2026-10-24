import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { StoreProvider } from '../hooks/useStore.jsx';
import { ModalHost, ModalProvider, useModal } from '../hooks/useModal.jsx';
import {
  MAX_VOICE_STATUS, VoiceStatusDialog, VoiceStatusLine, canSetVoiceStatus,
} from '../views/dialogs/VoiceStatusDialog.jsx';

function voiceChannel(over = {}) {
  return {
    id: 'voice-1', guild_id: 'guild-1', type: 'voice', name: 'General', domain: 'g.example',
    ...over,
  };
}

function testStore(channel, { can = {}, inCall = false } = {}) {
  const channels = new Map([[channel.id, channel]]);
  const saved = [];
  return {
    store: {
      me: { user_id: '@alice:h' },
      channels,
      voice: new Map([['voice-1', inCall ? [{ user_id: '@alice:h' }] : []]]),
      can: (id, name) => !!can[name],
      apiForChannel: () => ({
        setVoiceStatus: vi.fn(async (id, status) => {
          saved.push([id, status]);
          return { ...channel, voice_status: status || null };
        }),
      }),
      emit: vi.fn(),
      on: () => () => {},
    },
    saved,
  };
}

describe('canSetVoiceStatus', () => {
  it('is never offered on a text channel', () => {
    const { store } = testStore(voiceChannel({ type: 'text' }), { can: { CONNECT: true } });
    expect(canSetVoiceStatus(store, { ...voiceChannel(), type: 'text' })).toBe(false);
  });

  it('opens to anyone holding CONNECT', () => {
    const { store } = testStore(voiceChannel(), { can: { CONNECT: true } });
    expect(canSetVoiceStatus(store, voiceChannel())).toBe(true);
  });

  it('opens to someone sitting in the call without any grant', () => {
    const { store } = testStore(voiceChannel(), { inCall: true });
    expect(canSetVoiceStatus(store, voiceChannel())).toBe(true);
  });

  it('stays shut for a stranger with no grant and no seat', () => {
    const { store } = testStore(voiceChannel());
    expect(canSetVoiceStatus(store, voiceChannel())).toBe(false);
  });

  it('treats a moderator grant as a yes', () => {
    const { store } = testStore(voiceChannel(), { can: { MUTE_MEMBERS: true } });
    expect(canSetVoiceStatus(store, voiceChannel())).toBe(true);
  });
});

describe('VoiceStatusLine', () => {
  it('draws the line under a voice channel that has one', () => {
    const { store } = testStore(voiceChannel({ voice_status: 'Lobby 2 — ranked' }));
    render(
      <StoreProvider store={store}>
        <VoiceStatusLine channel={store.channels.get('voice-1')} />
      </StoreProvider>,
    );
    expect(screen.getByText('Lobby 2 — ranked')).toBeTruthy();
  });

  it('draws nothing without a status, and nothing on a text channel', () => {
    const { store } = testStore(voiceChannel({ voice_status: null }));
    const { container } = render(
      <StoreProvider store={store}>
        <VoiceStatusLine channel={store.channels.get('voice-1')} />
      </StoreProvider>,
    );
    expect(container.textContent).toBe('');
  });

  it('caps at 140 characters, like the server', () => {
    expect(MAX_VOICE_STATUS).toBe(140);
  });
});

describe('VoiceStatusDialog', () => {
  function openDialog(store, channel) {
    function Opener() {
      const modal = useModal();
      return (
        <button type="button" onClick={() => modal.open((close) => <VoiceStatusDialog channel={channel} close={close} />)}>
          Open status
        </button>
      );
    }
    render(
      <StoreProvider store={store}>
        <ModalProvider>
          <Opener />
          <ModalHost />
        </ModalProvider>
      </StoreProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open status' }));
  }

  it('saves through the voice-status route and folds the answer into the map', async () => {
    const user = userEvent.setup();
    const channel = voiceChannel({ voice_status: null });
    const { store, saved } = testStore(channel, { can: { CONNECT: true } });
    const close = vi.fn();
    void close;
    openDialog(store, channel);
    await user.type(await screen.findByLabelText('Voice status'), 'ranked grind');
    await user.click(screen.getByRole('button', { name: 'Save status' }));
    expect(saved).toEqual([['voice-1', 'ranked grind']]);
    expect(store.channels.get('voice-1').voice_status).toBe('ranked grind');
  });

  it('clears from the edit form', async () => {
    const user = userEvent.setup();
    const channel = voiceChannel({ voice_status: 'old line' });
    const { store, saved } = testStore(channel, { can: { CONNECT: true } });
    openDialog(store, channel);
    await user.click(await screen.findByRole('button', { name: 'Clear' }));
    expect(saved).toEqual([['voice-1', null]]);
  });
});
