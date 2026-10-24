import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { StoreProvider, useStoreEvent } from '../hooks/useStore.jsx';
import { PersistentAudioProvider, PersistentAudioTopbar } from '../hooks/usePersistentAudio.jsx';
import { PlayableAttachment } from '../views/chat/PlayableAttachment.jsx';

function makeStore(route) {
  const listeners = new Map();
  return {
    route,
    on(event, listener) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(listener);
      return () => listeners.get(event)?.delete(listener);
    },
    emit(event, payload) {
      for (const listener of listeners.get(event) || []) listener(payload);
    },
  };
}

function ChannelHarness({ store }) {
  useStoreEvent('route');
  if (store.route.channelId !== 'channel-a') return <div data-testid="other-channel" />;
  return (
    <PlayableAttachment
      att={{ name: 'recording.mp3', mime: 'audio/mpeg', size: 1024 }}
      url="https://media.example/recording.mp3"
      host="media.example"
    />
  );
}

describe('persistent channel audio', () => {
  it('keeps one audio element alive across channel navigation and exposes topbar controls', () => {
    const store = makeStore({
      view: 'chat',
      guildId: 'guild-1',
      channelId: 'channel-a',
      conversationId: null,
    });

    const { container } = render(
      <StoreProvider store={store}>
        <PersistentAudioProvider>
          <PersistentAudioTopbar />
          <ChannelHarness store={store} />
        </PersistentAudioProvider>
      </StoreProvider>,
    );

    const audio = container.querySelector('audio');
    expect(audio).toBeTruthy();
    expect(screen.queryByLabelText('Audio player')).toBeNull();

    let paused = true;
    Object.defineProperties(audio, {
      paused: { configurable: true, get: () => paused },
      ended: { configurable: true, get: () => false },
      duration: { configurable: true, value: 120 },
      currentTime: { configurable: true, writable: true, value: 0 },
    });

    const play = vi.spyOn(audio, 'play').mockImplementation(() => {
      paused = false;
      fireEvent.play(audio);
      return Promise.resolve();
    });
    const pause = vi.spyOn(audio, 'pause').mockImplementation(() => {
      paused = true;
      fireEvent.pause(audio);
    });

    fireEvent.click(screen.getByRole('button', { name: 'Play recording.mp3 audio' }));
    expect(play).toHaveBeenCalledTimes(1);
    expect(audio.getAttribute('src')).toBe('https://media.example/recording.mp3');

    audio.currentTime = 30;
    fireEvent.durationChange(audio);
    fireEvent.timeUpdate(audio);

    act(() => {
      store.route = {
        view: 'chat',
        guildId: 'guild-1',
        channelId: 'channel-b',
        conversationId: null,
      };
      store.emit('route');
    });

    expect(screen.getByTestId('other-channel')).toBeTruthy();
    const floating = screen.getByLabelText('Audio player');
    expect(floating).toBeTruthy();
    expect(floating.textContent).toContain('recording.mp3');
    expect(audio.getAttribute('src')).toBe('https://media.example/recording.mp3');

    const scrubber = screen.getByRole('slider', { name: 'Seek recording.mp3' });
    expect(scrubber.value).toBe('25');
    fireEvent.change(scrubber, { target: { value: '50' } });
    expect(audio.currentTime).toBe(60);

    fireEvent.click(screen.getByRole('button', { name: 'Pause recording.mp3' }));
    expect(pause).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Play recording.mp3' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Stop recording.mp3' }));
    expect(screen.queryByLabelText('Audio player')).toBeNull();
    expect(audio.getAttribute('src')).toBeNull();
    expect(audio.currentTime).toBe(0);

    play.mockRestore();
    pause.mockRestore();
  });
});
