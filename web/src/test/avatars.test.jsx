import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { createFakeServer, freshStore, HOME } from './fake-server.js';
import { signedInApp } from './harness.jsx';
import { dmPeer } from '../lib/conversations.js';
import { faceOf } from '../lib/faces.js';

const ME = '@alice:home.example';
const CAROL = '@carol:other.example';
const MY_FACE = 'alice-face?cap=cap-a';
const HER_FACE = 'carol-face?cap=cap-c';

const remoteFriend = (userId, extra = {}) => ({
  user_id: userId,
  domain: userId.split(':')[1],
  state: 'accepted',
  presence: { user_id: userId, status: 'online' },
  display_name: null,
  avatar_ref: null,
  ...extra,
});

const convo = (id, kind, memberIds) => ({
  id,
  kind,
  sequencer: 'home.example',
  epoch: 1,
  last_seq: 0,
  members: memberIds.map((user_id) => ({ user_id, state: 'joined' })),
});

async function boot({ friends = [], conversations = [], profiles = {} } = {}) {
  const server = createFakeServer({ friends, conversations, profiles });
  const { store, user } = await signedInApp(server);
  await user.click(await screen.findByTitle('Direct messages'));
  await waitFor(() => expect(store.friends.size).toBe(friends.length));
  return { server, store, user };
}

const rail = () => within(screen.getByText('Conversations').parentElement);

const myProfile = {
  user_id: ME,
  display_name: 'Alice',
  avatar_ref: MY_FACE,
  banner_ref: null,
  accent_color: null,
  bio: null,
  pronouns: null,
  profile_version: 1,
  updated_at: 1_700_000_000_000,
};

describe('resolving a face', () => {
  it('resolves your own avatar in a DM context', async () => {
    const { store } = await boot({ profiles: { [ME]: myProfile } });

    const face = faceOf(store, ME);
    expect(face.avatarRef).toBe(MY_FACE);
    expect(face.base).toBe(HOME);
    expect(face.mediaOrigin).toBeNull();

    expect(dmPeer(store, ME).avatarRef).toBe(MY_FACE);

    await waitFor(() => {
      const img = [...document.querySelectorAll('img')]
        .find((el) => el.getAttribute('src')?.includes('alice-face'));
      expect(img?.getAttribute('src')).toBe(`${HOME}/_telium/v1/media/${MY_FACE}`);
    });
  });

  it('asks for a friend the list could not describe, and draws what comes back', async () => {
    const { server, store } = await boot({
      friends: [remoteFriend(CAROL)],
      conversations: [convo('dm1', 'dm', [ME, CAROL])],
      profiles: {
        [CAROL]: { user_id: CAROL, display_name: 'Carol', avatar_ref: HER_FACE },
      },
    });

    await waitFor(() => expect(server.state.profileHits).toEqual([CAROL]));
    await waitFor(() => expect(rail().queryByText('Carol')).toBeTruthy());

    const face = faceOf(store, CAROL);
    expect(face.avatarRef).toBe(HER_FACE);
    expect(face.base).toBe(HOME);
    expect(face.mediaOrigin).toBe('other.example');

    const row = rail().getByText('Carol').closest('button');
    expect(row.querySelector('img').getAttribute('src')).toBe(
      `${HOME}/_telium/v1/media/remote/other.example/carol-face?cap=cap-c`,
    );
  });

  it('still asks nothing for a friend the list did describe', async () => {
    const { server } = await boot({
      friends: [remoteFriend(CAROL, { display_name: 'Carol', avatar_ref: HER_FACE })],
      conversations: [convo('dm1', 'dm', [ME, CAROL])],
    });

    await waitFor(() => expect(rail().queryByText('Carol')).toBeTruthy());
    expect(server.state.profileHits).toEqual([]);
  });

  it('draws the same face at the head of the conversation as in the rail', async () => {
    const { user } = await boot({
      friends: [remoteFriend(CAROL, { display_name: 'Carol', avatar_ref: HER_FACE })],
      conversations: [convo('dm1', 'dm', [ME, CAROL])],
    });

    await user.click(rail().getByText('Carol'));

    const head = (await screen.findByText(/The start of your messages with Carol/))
      .closest('div');
    const face = head.querySelector('img');
    expect(face?.getAttribute('src')).toBe(
      `${HOME}/_telium/v1/media/remote/other.example/carol-face?cap=cap-c`,
    );
    expect(rail().getByText('Carol').closest('button').querySelector('img')
      .getAttribute('src')).toBe(face.getAttribute('src'));
  });

  it('opens the head with the name they chose rather than their localpart', async () => {
    const { user } = await boot({
      friends: [remoteFriend(CAROL, { display_name: 'Carol', avatar_ref: HER_FACE })],
      conversations: [convo('dm1', 'dm', [ME, CAROL])],
    });

    await user.click(rail().getByText('Carol'));

    const headings = await screen.findAllByRole('heading', { name: 'Carol' });
    expect(headings.map((h) => h.tagName)).toEqual(['H1', 'H2']);
  });
});

function bareStore({ friends = [], profile = null, fail = false } = {}) {
  const store = freshStore();
  store.me = { user_id: ME, profile: myProfile };
  const asked = [];
  store.home = {
    base: HOME,
    domain: 'home.example',
    friends: async () => ({ friends }),
    userProfile: async (userId) => {
      asked.push(userId);
      if (fail) throw new Error('unreachable');
      return profile || { user_id: userId, display_name: 'Nadia', avatar_ref: 'n?cap=1' };
    },
  };
  return { store, asked };
}

describe('asking for a profile', () => {
  it('asks for a peer drawn before the friends list landed', async () => {
    const { store, asked } = bareStore();

    store.ensureProfile('@nadia:elsewhere.example');
    expect(asked).toEqual([]);

    await store.refreshFriends();
    expect(asked).toEqual(['@nadia:elsewhere.example']);
    await waitFor(() => {
      expect(store.peerProfile('@nadia:elsewhere.example')?.avatar_ref).toBe('n?cap=1');
    });
  });

  it('never asks the home server about you', async () => {
    const { store, asked } = bareStore();
    await store.refreshFriends();
    store.ensureProfile(ME);
    expect(asked).toEqual([]);
    expect(faceOf(store, ME).avatarRef).toBe(MY_FACE);
  });

  it('lets a reconnect retry a refusal instead of wearing it for the session', async () => {
    const { store } = bareStore({ fail: true });
    await store.refreshFriends();

    store.ensureProfile('@nadia:elsewhere.example');
    await waitFor(() => expect(store.identityOf('@nadia:elsewhere.example')).toBe(false));

    const before = [...store.peerProfileTried.entries()];
    store.ensureProfile('@nadia:elsewhere.example');
    expect([...store.peerProfileTried.entries()]).toEqual(before);

    store.home.userProfile = async (userId) => ({
      user_id: userId, display_name: 'Nadia', avatar_ref: 'n?cap=2',
    });
    await store.refreshFriends();
    store.ensureProfile('@nadia:elsewhere.example');
    await waitFor(() => {
      expect(store.peerProfile('@nadia:elsewhere.example')?.avatar_ref).toBe('n?cap=2');
    });
  });
});
