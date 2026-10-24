import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

import {
  DEFAULT_LOOKUPS, LOOKUP_MODES, lookupAllowed, normalizeLookups,
} from '../lib/mutual-lookups.js';
import { friendMethods } from '../lib/store/friends.js';
import { prefsMethods } from '../lib/store/prefs.js';

const ME = '@alice:home.example';
const THEM = '@bob:elsewhere.example';

function makeStore({ lookups } = {}) {
  const calls = { friends: 0, guilds: 0, saved: 0 };
  const store = {
    ...prefsMethods,
    ...friendMethods,
    me: { user_id: ME },
    prefs: lookups === undefined ? {} : { lookups },
    mutuals: new Map(),
    mutualsAsked: new Map(),
    mutualsRetries: new Map(),
    guilds: new Map(),
    sync: { set: () => { calls.saved += 1; } },
    emit: () => {},
    mutualFriendsWith: async () => { calls.friends += 1; return { friends: [], complete: true }; },
    mutualGuildsWith: async () => { calls.guilds += 1; return { guilds: [], complete: true }; },
  };
  return { store, calls };
}

describe('the lookup policy', () => {
  it.each([
    ['hover', 'open', true], ['open', 'open', true], ['never', 'open', false],
    ['hover', 'hover', true], ['open', 'hover', false], ['never', 'hover', false],
  ])('mode %s, trigger %s -> %s', (mode, trigger, allowed) => {
    expect(lookupAllowed(mode, trigger)).toBe(allowed);
  });

  it('defaults to open and resolves anything unreadable to the default', () => {
    expect(DEFAULT_LOOKUPS).toBe('open');
    expect(LOOKUP_MODES).toEqual(['hover', 'open', 'never']);
    for (const v of [undefined, 'always', null, true]) expect(normalizeLookups(v)).toBe(DEFAULT_LOOKUPS);
  });
});

describe('the store refuses lookups it has not been given', () => {
  it('asks nobody and leaves no trace when the setting is never', async () => {
    const { store, calls } = makeStore({ lookups: 'never' });
    expect(await store.ensureMutuals(THEM)).toBe(null);
    expect(await store.ensureMutuals(THEM, { trigger: 'hover' })).toBe(null);
    expect(calls).toEqual({ friends: 0, guilds: 0, saved: 0 });
    expect(store.mutualsFor(THEM)).toBe(null);
    expect(store.mutualsAsked.size).toBe(0);
  });

  it('refuses a hover under the default and still answers an open', async () => {
    const { store, calls } = makeStore();
    expect(await store.ensureMutuals(THEM, { trigger: 'hover' })).toBe(null);
    expect(calls.friends + calls.guilds).toBe(0);
    await store.ensureMutuals(THEM);
    expect(calls).toMatchObject({ friends: 1, guilds: 1 });
  });

  it('reads the setting on every ask and never asks about the account holder', async () => {
    const { store, calls } = makeStore({ lookups: 'hover' });
    expect(await store.ensureMutuals(ME, { trigger: 'hover' })).toBe(null);
    expect(calls.friends).toBe(0);
    await store.ensureMutuals('@carol:elsewhere.example', { trigger: 'hover' });
    expect(calls).toMatchObject({ friends: 1, guilds: 1 });
    store.prefs.lookups = 'never';
    expect(await store.ensureMutuals(THEM, { trigger: 'hover' })).toBe(null);
    expect(calls.friends).toBe(1);
  });

  it('syncs the setting, rejects unknown modes, and keeps answers already bought', async () => {
    const { store, calls } = makeStore({ lookups: 'hover' });
    await store.ensureMutuals(THEM, { trigger: 'hover' });
    expect(store.setMutualLookups('never')).toBe('never');
    expect(calls.saved).toBe(1);
    expect(store.mutualLookups()).toBe('never');
    expect(store.mutualsFor(THEM)).not.toBe(null);
    expect(store.setMutualLookups('sometimes')).toBe(DEFAULT_LOOKUPS);
    expect(store.prefs.lookups).toBe(DEFAULT_LOOKUPS);
  });
});

const { holder, modalDouble } = vi.hoisted(() => ({
  holder: { store: null },
  modalDouble: { depth: 0 },
}));

vi.mock('../hooks/useStore.jsx', () => ({
  useStore: () => holder.store,
  useOptionalStore: () => holder.store,
  useStoreEvent: () => {},
  useStoreEventFor: () => {},
}));
vi.mock('../hooks/useModal.jsx', () => ({
  useModal: () => modalDouble,
  LAYER: (depth) => 100 + depth,
}));

const { ProfileCardProvider } = await import('../views/profile/ProfileCardProvider.jsx');
const { useProfileCard } = await import('../hooks/useProfileCard.js');
const { useMutuals } = await import('../views/profile/useMutuals.js');

function Row({ userId }) {
  const profiles = useProfileCard();
  return (
    <button type="button" onPointerEnter={() => profiles.prefetch(userId)} onPointerLeave={profiles.cancel}>
      {userId}
    </button>
  );
}

describe('hover dwell before the fan-out', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    holder.store = { ensureFullProfile: vi.fn(), ensureMutuals: vi.fn() };
  });
  afterEach(() => {
    vi.useRealTimers();
    holder.store = null;
  });

  const enter = (el) => act(() => { fireEvent.pointerOver(el, { relatedTarget: document.body }); });
  const leave = (el) => act(() => { fireEvent.pointerOut(el, { relatedTarget: document.body }); });
  const wait = (ms) => act(() => { vi.advanceTimersByTime(ms); });
  const one = () => {
    const view = render(<ProfileCardProvider><Row userId={THEM} /></ProfileCardProvider>);
    return { view, row: screen.getByRole('button', { name: THEM }) };
  };

  it('warms the profile first, then the fan-out tagged as a hover, without restarting', () => {
    const { row } = one();
    enter(row);
    wait(200);
    expect(holder.store.ensureFullProfile).toHaveBeenCalledWith(THEM);
    expect(holder.store.ensureMutuals).not.toHaveBeenCalled();
    enter(row);
    wait(300);
    expect(holder.store.ensureMutuals).toHaveBeenCalledTimes(1);
    expect(holder.store.ensureMutuals).toHaveBeenCalledWith(THEM, { trigger: 'hover' });
  });

  it('takes the fan-out back when the pointer leaves or the provider unmounts', () => {
    const { view, row } = one();
    enter(row);
    wait(200);
    leave(row);
    wait(1000);
    enter(row);
    view.unmount();
    wait(1000);
    expect(holder.store.ensureMutuals).not.toHaveBeenCalled();
  });

  it('spends nothing on a pointer crossing a list', () => {
    const names = ['@one:a.example', '@two:b.example', '@three:c.example'];
    render(<ProfileCardProvider>{names.map((id) => <Row key={id} userId={id} />)}</ProfileCardProvider>);
    for (const id of names) {
      const row = screen.getByRole('button', { name: id });
      enter(row);
      wait(60);
      leave(row);
    }
    wait(1000);
    expect(holder.store.ensureMutuals).not.toHaveBeenCalled();
    expect(holder.store.ensureFullProfile).not.toHaveBeenCalled();
  });
});

function MutualsProbe({ store, userId }) {
  const { mutualFriends, mutualGuilds, reserveMutuals } = useMutuals(store, userId, false);
  return (
    <div
      data-testid="probe"
      data-off={String(mutualFriends?.off === true && mutualGuilds?.off === true)}
      data-reserve={String(reserveMutuals)}
    />
  );
}

describe('a card that was told not to ask says so', () => {
  afterEach(() => { holder.store = null; });

  it.each([
    ['never', 'true', 'false', false],
    [undefined, 'false', undefined, true],
  ])('lookups=%s', (lookups, off, reserve, asked) => {
    const { store } = makeStore({ lookups });
    store.ensureMutuals = vi.fn(store.ensureMutuals.bind(store));
    holder.store = store;
    render(<MutualsProbe store={store} userId={THEM} />);
    const probe = screen.getByTestId('probe');
    expect(probe.dataset.off).toBe(off);
    if (reserve) expect(probe.dataset.reserve).toBe(reserve);
    if (asked) expect(store.ensureMutuals).toHaveBeenCalledWith(THEM);
    else expect(store.ensureMutuals).not.toHaveBeenCalled();
  });
});
