import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';

const { store, voice } = vi.hoisted(() => ({
  store: {
    me: { user_id: '@alice:home.example' },
    route: { view: 'chat', guildId: 'guild-2', channelId: 'text-1', conversationId: null },
    channels: new Map([['voice-1', { id: 'voice-1', guild_id: 'guild-1', name: 'Lounge' }]]),
    conversations: [{ id: 'dm-1' }],
    voice: new Map(),
    navigate: vi.fn(),
    on: () => () => {},
  },
  voice: {
    channelId: 'voice-1',
    active: true,
    local: { self_video: false, streaming: true },
    cameras: new Map(),
    screens: new Map([['@alice:home.example', {}]]),
  },
}));

vi.mock('../hooks/useVoice.jsx', () => ({ useVoice: () => voice }));

import { StoreProvider } from '../hooks/useStore.jsx';
import { WatchProvider } from '../hooks/useWatch.jsx';
import { PersistentMediaMiniView } from '../views/PersistentMediaMiniView.jsx';

const Around = ({ children }) => (
  <StoreProvider store={store}>
    <WatchProvider>{children}</WatchProvider>
  </StoreProvider>
);

function frame() {
  return render(
    <Around>
      <PersistentMediaMiniView />
    </Around>,
  ).container.querySelector('aside[aria-label="Call mini view"]');
}

describe('the media mini view', () => {
  it('opens in chat on double-click, and only double-click', () => {
    store.navigate.mockClear();
    const view = frame();

    fireEvent.click(view.querySelector('video'));
    expect(store.navigate).not.toHaveBeenCalled();

    fireEvent.doubleClick(view.querySelector('video'));
    expect(store.navigate).toHaveBeenCalledWith({
      view: 'voice',
      guildId: 'guild-1',
      channelId: 'voice-1',
      conversationId: null,
    });
  });

  it('opens the DM conversation when the call is not in a guild', () => {
    store.navigate.mockClear();
    voice.channelId = 'dm-1';
    try {
      const view = frame();
      fireEvent.doubleClick(view.querySelector('video'));
      expect(store.navigate).toHaveBeenCalledWith({
        view: 'dms',
        guildId: null,
        channelId: null,
        conversationId: 'dm-1',
      });
    } finally {
      voice.channelId = 'voice-1';
    }
  });

  it('leaves the buttons and the resize corner to their own meanings', () => {
    store.navigate.mockClear();
    const view = frame();

    fireEvent.doubleClick(view.querySelector('button[title="Hide"]'));
    expect(store.navigate).not.toHaveBeenCalled();

    fireEvent.doubleClick(view.querySelector('[data-mini-resize-handle]'));
    expect(store.navigate).not.toHaveBeenCalled();
  });
});
