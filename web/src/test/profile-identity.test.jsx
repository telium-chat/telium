import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { Store } from '../lib/store.js';
import { ProfileBody } from '../views/profile/ProfileBody.jsx';
import { dayOf } from '../lib/util.js';

const { holder } = vi.hoisted(() => ({ holder: { store: null } }));

vi.mock('../hooks/useStore.jsx', () => ({
  useStore: () => holder.store,
  useOptionalStore: () => holder.store,
  useStoreEvent: () => {},
  useStoreEventFor: () => {},
}));
vi.mock('../hooks/useVoice.jsx', () => ({
  useVoice: () => ({ channelId: null, join: vi.fn(), leave: vi.fn() }),
}));
vi.mock('../hooks/useModal.jsx', () => ({ useModal: () => ({ open: vi.fn(), close: vi.fn() }) }));
vi.mock('../hooks/useProfileCard.js', () => ({ useProfileCard: () => ({ open: vi.fn() }) }));

const ME = '@alice:home.example';
const BOB = '@bob:home.example';
const HOME = 'https://home.example';

const CREATED = Date.parse('2019-03-04T00:00:00Z');
const JOINED = Date.parse('2023-08-09T00:00:00Z');

const localFriend = (userId) => ({
  user_id: userId,
  domain: 'home.example',
  state: 'accepted',
  presence: { user_id: userId, status: 'online' },
  display_name: 'Bob',
  avatar_ref: 'bob-face?cap=cap-b',
  created_at: Date.parse('2024-01-02T00:00:00Z'),
  updated_at: Date.parse('2024-01-02T00:00:00Z'),
});

const fullProfile = (userId) => ({
  user_id: userId,
  display_name: 'Bob',
  avatar_ref: 'bob-face?cap=cap-b',
  banner_ref: 'bob-banner?cap=cap-b',
  accent_color: null,
  bio: 'Grows tomatoes.',
  pronouns: 'he/him',
  profile_version: 3,
  updated_at: CREATED,
  created_at: CREATED,
});

function cardStore({ friends = [], profile = fullProfile(BOB), fail = false } = {}) {
  const store = new Store();
  const asked = [];
  store.me = { user_id: ME, profile: { user_id: ME, display_name: 'Alice' } };
  store.home = {
    base: HOME,
    domain: 'home.example',
    friends: async () => ({ friends }),
    userProfile: async (userId) => {
      asked.push(userId);
      if (fail) throw new Error('unreachable');
      return profile;
    },
  };
  store.guilds = new Map([['guild-1', { id: 'guild-1', name: 'Example', domain: 'guild.example' }]]);
  store.members = new Map([['guild-1', new Map([[BOB, {
    user_id: BOB, guild_id: 'guild-1', roles: [], joined_at: JOINED,
  }]])]]);
  store.apiForGuild = () => ({ base: 'https://guild.example', domain: 'guild.example' });
  store.loadRoles = vi.fn(() => Promise.resolve());
  store.guildPermissions = () => 0;
  store.myMember = () => null;
  store.roleName = (_g, id) => id;
  store.dmWith = () => null;
  store.navigate = vi.fn();
  store.channelsOf = () => [];
  store.mutualFriendsWith = vi.fn(() => Promise.resolve({ friends: [], complete: true }));
  store.mutualGuildsWith = vi.fn(() => Promise.resolve({ guilds: [], complete: true }));
  store.trust = {
    peers: new Map(),
    signed: new Map(),
    refresh: async () => ({ identityKey: null, devices: new Map() }),
    statusFor: () => 'unverified',
    requestFor: () => null,
  };
  return { store, asked };
}

const openCard = (store, userId = BOB) => {
  holder.store = store;
  return render(
    <ProfileBody guildId="guild-1" userId={userId} close={() => {}} surface="full" />,
  );
};

describe("a friend's profile card", () => {
  it('still says how long they have been on Telium', async () => {
    const { store, asked } = cardStore({ friends: [localFriend(BOB)] });
    await store.refreshFriends();
    expect(store.friends.get(BOB).display_name).toBe('Bob');

    openCard(store);

    expect(await screen.findByText(dayOf(CREATED))).toBeTruthy();
    expect(screen.getByText('Member since')).toBeTruthy();
    expect(screen.getByText(dayOf(JOINED))).toBeTruthy();
    expect(asked).toEqual([BOB]);
  });

  it('gets the rest of what only a profile carries, not just the date', async () => {
    const { store } = cardStore({ friends: [localFriend(BOB)] });
    await store.refreshFriends();

    openCard(store);

    await waitFor(() => expect(store.identityOf(BOB)?.bio).toBe('Grows tomatoes.'));
    expect(store.identityOf(BOB).pronouns).toBe('he/him');
    expect(store.identityOf(BOB).banner_ref).toBe('bob-banner?cap=cap-b');
    expect(await screen.findByText('Grows tomatoes.')).toBeTruthy();
  });

  it('draws their theme as the card border and ground', async () => {
    const { store } = cardStore({ profile: { ...fullProfile(BOB), theme_colors: [0xf0e0c0, 0] } });
    const { container } = openCard(store);
    await waitFor(() => expect(container.querySelector('.pc')?.dataset.themed).toBe('true'));
    const card = container.querySelector('.pc');
    expect(card.style.getPropertyValue('--pc-theme-top')).toBe('#f0e0c0');
    expect(card.style.getPropertyValue('--pc-theme-bottom')).toBe('#000000');
  });
});

describe('the two doors into the one ask', () => {
  it('leaves the rail asking nothing for a friend the list described', async () => {
    const { store, asked } = cardStore({ friends: [localFriend(BOB)] });
    await store.refreshFriends();

    store.ensureProfile(BOB);
    expect(asked).toEqual([]);
  });

  it('asks once however many surfaces want it', async () => {
    const { store, asked } = cardStore({ friends: [localFriend(BOB)] });
    await store.refreshFriends();

    store.ensureFullProfile(BOB);
    store.ensureFullProfile(BOB);
    store.ensureProfile(BOB);
    await waitFor(() => expect(store.identityOf(BOB)?.created_at).toBe(CREATED));
    expect(asked).toEqual([BOB]);
  });

  it('never asks the home server about your own account', async () => {
    const { store, asked } = cardStore();
    await store.refreshFriends();

    store.ensureFullProfile(ME);
    expect(asked).toEqual([]);
  });

  it('does not turn a refusal into a loop', async () => {
    const { store, asked } = cardStore({ friends: [localFriend(BOB)], fail: true });
    await store.refreshFriends();

    store.ensureFullProfile(BOB);
    await waitFor(() => expect(store.identityOf(BOB)).toBe(false));

    store.ensureFullProfile(BOB);
    store.ensureFullProfile(BOB);
    expect(asked).toEqual([BOB]);
  });
});
