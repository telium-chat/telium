import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../lib/store.js';
import { faceOf } from '../lib/faces.js';
import { isClassified, mayInterrupt } from '../lib/interrupts.js';

const ME = '@alice:home.example';
const BOB = '@bob:home.example';
const CAROL = '@carol:other.example';

const profile = (userId, over = {}) => ({
  user_id: userId,
  display_name: 'Bob',
  avatar_ref: 'bob-face?cap=cap-b',
  banner_ref: 'bob-banner?cap=cap-b',
  accent_color: null,
  bio: 'Grows tomatoes.',
  pronouns: 'he/him',
  profile_version: 3,
  updated_at: 1000,
  created_at: 500,
  ...over,
});

const friendRow = (userId, over = {}) => ({
  user_id: userId,
  domain: 'home.example',
  state: 'accepted',
  presence: { user_id: userId, status: 'online' },
  display_name: 'Bob',
  avatar_ref: 'bob-face?cap=cap-b',
  created_at: 900,
  updated_at: 900,
  ...over,
});

let store;
let asked;

beforeEach(() => {
  store = new Store();
  asked = [];
  store.me = {
    user_id: ME,
    profile: { user_id: ME, display_name: 'Alice', avatar_ref: null, bio: null },
  };
  store.home = {
    base: 'https://home.example',
    domain: 'home.example',
    userProfile: async (userId) => { asked.push(userId); return profile(userId); },
  };
});

const deliver = (d, t = 'PROFILE_UPDATE') =>
  store.onDispatch({ domain: 'home.example', t, d });

describe('a profile edit announced by its home server', () => {
  it('is an event this build has an opinion about, and a quiet one', () => {
    expect(isClassified('PROFILE_UPDATE')).toBe(true);
    expect(mayInterrupt('PROFILE_UPDATE')).toBe(false);
  });

  it('reaches the card of somebody this client already asked about', async () => {
    store.fetchIdentity(BOB);
    await vi.waitFor(() => expect(store.identityOf(BOB).bio).toBe('Grows tomatoes.'));

    deliver(profile(BOB, { bio: 'Grows chillies now.', pronouns: 'they/them', profile_version: 4 }));

    expect(store.identityOf(BOB).bio).toBe('Grows chillies now.');
    expect(store.identityOf(BOB).pronouns).toBe('they/them');
    expect(store.identityOf(BOB).profile_version).toBe(4);
  });

  it('redraws the rail row of a DM peer who is no friend at all', async () => {
    store.home.userProfile = async () =>
      profile(CAROL, { display_name: 'Carol', avatar_ref: 'old' });
    store.fetchIdentity(CAROL);
    await vi.waitFor(() => expect(faceOf(store, CAROL).name).toBe('Carol'));

    deliver(profile(CAROL, { display_name: 'Caroline', avatar_ref: 'new' }));

    expect(faceOf(store, CAROL).name).toBe('Caroline');
    expect(store.peerProfile(CAROL).avatar_ref).toBe('new');
  });

  it('renames a friend in the list their name is drawn from', () => {
    store.friends.set(BOB, friendRow(BOB));
    expect(faceOf(store, BOB).name).toBe('Bob');

    deliver(profile(BOB, { display_name: 'Robert' }));

    expect(faceOf(store, BOB).name).toBe('Robert');
    expect(store.friends.get(BOB).display_name).toBe('Robert');
    expect(store.friends.get(BOB).state).toBe('accepted');
    expect(store.friends.get(BOB).presence.status).toBe('online');
  });

  it('takes down a face somebody took down', () => {
    store.friends.set(BOB, friendRow(BOB));

    deliver(profile(BOB, { avatar_ref: null }));

    expect(store.friends.get(BOB).avatar_ref).toBe(null);
    expect(faceOf(store, BOB).avatarRef).toBe(null);
  });

  it('reaches your own other devices', () => {
    const seen = [];
    store.on('me', (me) => seen.push(me.profile.display_name));

    deliver({ ...profile(ME), display_name: 'Alice Liddell', bio: 'Still here.' });

    expect(store.me.profile.display_name).toBe('Alice Liddell');
    expect(store.me.profile.bio).toBe('Still here.');
    expect(store.identityOf(ME).display_name).toBe('Alice Liddell');
    expect(seen).toEqual(['Alice Liddell']);
    expect(store.identities.has(ME)).toBe(false);
  });

  it('spends no request on a profile it was handed', async () => {
    deliver(profile(BOB));
    store.ensureFullProfile(BOB);
    store.ensureProfile(BOB);
    await Promise.resolve();

    expect(asked).toEqual([]);
    expect(store.identityOf(BOB).bio).toBe('Grows tomatoes.');
  });

  it('heals a peer whose server was unreachable when we asked', async () => {
    store.home.userProfile = async () => { throw new Error('unreachable'); };
    store.fetchIdentity(BOB);
    await vi.waitFor(() => expect(store.identityOf(BOB)).toBe(false));

    deliver(profile(BOB));

    expect(store.identityOf(BOB).display_name).toBe('Bob');
    expect(store.peerProfileTried.get(BOB)).toBe(true);
  });

  it('ignores a frame with nobody in it', () => {
    expect(() => deliver({})).not.toThrow();
    expect(() => deliver(null)).not.toThrow();
    expect(store.identities.size).toBe(0);
  });
});

describe('the one landing a profile has', () => {
  it('is the same whether the client asked or was told', async () => {
    const fetched = new Store();
    fetched.me = store.me;
    fetched.home = { domain: 'home.example', userProfile: async () => profile(BOB) };
    fetched.fetchIdentity(BOB);
    await vi.waitFor(() => expect(fetched.identityOf(BOB)).toBeTruthy());

    deliver(profile(BOB));

    expect(store.identityOf(BOB)).toEqual(fetched.identityOf(BOB));
    expect(store.peerProfile(BOB)).toEqual(fetched.peerProfile(BOB));
    expect(store.peerProfileTried.get(BOB)).toBe(fetched.peerProfileTried.get(BOB));
  });

  it('announces itself once, to whoever is drawing them', () => {
    const identities = [];
    const peers = [];
    store.on('identity', (e) => identities.push(e.user_id));
    store.on('peers', (e) => peers.push(e.user_id));

    deliver(profile(BOB));

    expect(identities).toEqual([BOB]);
    expect(peers).toEqual([BOB]);
  });
});
