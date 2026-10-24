import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ProfileBody } from '../views/profile/ProfileBody.jsx';

const ME = '@alice:home.example';
const THEM = '@bob:home.example';

const { store } = vi.hoisted(() => ({
  store: {
    me: { user_id: '@alice:home.example', profile: { display_name: 'Alice' } },
    home: { base: 'https://home.example', domain: 'home.example' },
    prefs: { presence: 'online', status: {}, muted: {}, collapsed: {} },
    guilds: new Map([['guild-1', { id: 'guild-1', name: 'Example', domain: 'guild.example' }]]),
    members: new Map([['guild-1', new Map()]]),
    channels: new Map(),
    conversations: [],
    friends: new Map(),
    presence: new Map(),
    voice: new Map(),
    identityOf: (id) => (id === THEM
      ? { user_id: id, display_name: 'Bob', bio: 'Grows tomatoes.' }
      : { user_id: id, display_name: 'Alice', bio: 'Writes it all down.' }),
    peerProfile: () => null,
    apiForGuild: () => ({ base: 'https://guild.example', domain: 'guild.example' }),
    ensureProfile: vi.fn(),
    ensureFullProfile: vi.fn(),
    loadRoles: vi.fn(() => Promise.resolve()),
    guildPermissions: () => 0,
    myMember: () => null,
    roles: new Map(),
    roleName: (_guildId, id) => id,
    dmWith: () => null,
    statusOf: () => null,
    navigate: vi.fn(),
    channelsOf: () => [],
    ensureMutuals: vi.fn(() => Promise.resolve(null)),
    mutualsFor: () => null,
    on: () => () => {},
  },
}));

vi.mock('../hooks/useStore.jsx', () => ({
  useStore: () => store,
  useOptionalStore: () => store,
  useStoreEvent: () => {},
  useStoreEventFor: () => {},
}));
vi.mock('../hooks/useVoice.jsx', () => ({
  useVoice: () => ({ channelId: null, join: vi.fn(), leave: vi.fn() }),
}));
vi.mock('../hooks/useModal.jsx', () => ({ useModal: () => ({ open: vi.fn(), close: vi.fn() }) }));
vi.mock('../hooks/useProfileCard.js', () => ({ useProfileCard: () => ({ open: vi.fn() }) }));

const open = (userId, props = {}) => render(
  <ProfileBody guildId="guild-1" userId={userId} close={() => {}} surface="full" {...props} />,
);

describe('the opened-out profile', () => {
  it('prints the bio in the identity column rather than behind a tab', () => {
    open(THEM);

    expect(screen.queryByRole('tab', { name: 'About' })).toBeNull();
    const bio = screen.getByText('Grows tomatoes.');
    expect(bio.closest('.pc__left')).toBeTruthy();
    expect(bio.closest('.pc__right')).toBeNull();
  });

  it('opens on Activity and says what would appear there when nothing is shared', () => {
    open(THEM);

    expect(screen.getByRole('tab', { name: 'Activity' }).getAttribute('aria-selected'))
      .toBe('true');
    expect(screen.getByText(/not sharing an activity you can see right now/)).toBeTruthy();
  });

  it('offers both mutual tabs on somebody else', () => {
    open(THEM);

    expect(screen.getByRole('tab', { name: /mutual friend/i })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /mutual server/i })).toBeTruthy();
  });

  it('offers neither mutual tab on your own card, and does not go looking', () => {
    store.ensureMutuals.mockClear();
    open(ME);

    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((tab) => tab.textContent)).toEqual(['Activity']);
    expect(store.ensureMutuals).not.toHaveBeenCalled();
  });

  it('falls back to a tab that exists when your own card is opened on a mutual one', () => {
    open(ME, { initialTab: 'friends' });

    const tab = screen.getByRole('tab', { name: 'Activity' });
    expect(tab.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText(/appear while they are active/)).toBeTruthy();
  });
});
