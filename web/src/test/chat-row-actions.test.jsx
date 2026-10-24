import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../App.jsx';
import { Mls } from '../lib/mls.js';
import { StoreProvider } from '../hooks/useStore.jsx';
import { Timeline } from '../views/chat/Timeline.jsx';
import { createFakeServer, freshStore, HOME } from './fake-server.js';
import { signIn } from './sign-in.js';

const ME = '@alice:home.example';
const BOB = '@bob:home.example';

function inFlight() {
  let settle;
  const promise = new Promise((resolve, reject) => { settle = { resolve, reject }; });
  return { promise, ...settle };
}

function channelStore(reactions = []) {
  const store = freshStore();
  store.me = { user_id: ME };
  store.messages.set('c1', [{ id: 'm1', channel_id: 'c1', author: BOB, content: 'hi', reactions }]);
  const api = { react: vi.fn(), unreact: vi.fn() };
  vi.spyOn(store, 'apiForChannel').mockReturnValue(api);
  const groups = () => store.messages.get('c1')[0].reactions;
  return { store, api, groups };
}

describe('optimistic reactions in a channel', () => {
  it('draws an add before the server answers, and the echo does not count it twice', async () => {
    const { store, api, groups } = channelStore();
    const call = inFlight();
    api.react.mockReturnValue(call.promise);

    const done = store.setOwnReaction('c1', 'm1', '👍', true);
    expect(groups()).toEqual([{ emoji: '👍', count: 1, me: true, users: [ME] }]);

    store.onReaction({ channel_id: 'c1', message_id: 'm1', emoji: '👍', user_id: ME }, 'add');
    call.resolve({});
    await done;
    expect(groups()).toEqual([{ emoji: '👍', count: 1, me: true, users: [ME] }]);
  });

  it('draws a remove at once, and the echo of it takes nothing more away', async () => {
    const { store, api, groups } = channelStore([
      { emoji: '👍', count: 2, me: true, users: [ME, BOB] },
    ]);
    const call = inFlight();
    api.unreact.mockReturnValue(call.promise);

    const done = store.setOwnReaction('c1', 'm1', '👍', false);
    expect(groups()).toEqual([{ emoji: '👍', count: 1, me: false, users: [BOB] }]);

    store.onReaction({ channel_id: 'c1', message_id: 'm1', emoji: '👍', user_id: ME }, 'remove');
    call.resolve({});
    await done;
    expect(groups()).toEqual([{ emoji: '👍', count: 1, me: false, users: [BOB] }]);
  });

  it('takes the mark back when the server refuses, and says so to the caller', async () => {
    const { store, api, groups } = channelStore([
      { emoji: '🔥', count: 1, me: false, users: [BOB] },
    ]);
    api.react.mockRejectedValue(Object.assign(new Error('nope'), { status: 403 }));
    await expect(store.setOwnReaction('c1', 'm1', '🔥', true)).rejects.toThrow('nope');
    expect(groups()).toEqual([{ emoji: '🔥', count: 1, me: false, users: [BOB] }]);

    const { store: other, api: otherApi, groups: otherGroups } = channelStore([
      { emoji: '🔥', count: 1, me: true, users: [ME] },
    ]);
    otherApi.unreact.mockRejectedValue(new Error('offline'));
    await expect(other.setOwnReaction('c1', 'm1', '🔥', false)).rejects.toThrow('offline');
    expect(otherGroups()).toEqual([{ emoji: '🔥', count: 1, me: true, users: [ME] }]);
  });

  it('counts somebody else once however many times their add is delivered', () => {
    const { store, groups } = channelStore();
    const bob = { channel_id: 'c1', message_id: 'm1', emoji: '👍', user_id: BOB };
    store.onReaction(bob, 'add');
    store.onReaction(bob, 'add');
    expect(groups()).toEqual([{ emoji: '👍', count: 1, me: false, users: [BOB] }]);
    store.onReaction(bob, 'remove');
    expect(groups()).toEqual([]);
  });
});

describe('optimistic reactions in a conversation', () => {
  function dmStore() {
    const store = freshStore();
    const mls = { userId: ME, reactions: new Map(), saveReactions: () => {} };
    mls.applyReaction = Mls.prototype.applyReaction.bind(mls);
    mls.reactionsTo = Mls.prototype.reactionsTo.bind(mls);
    store.mls = mls;
    const emitted = vi.spyOn(store, 'emit');
    const mine = () => mls.reactionsTo('dm1', 'f1');
    return { store, mls, emitted, mine };
  }

  it('folds the mark in and redraws before the frame goes out', async () => {
    const { store, mls, emitted, mine } = dmStore();
    const call = inFlight();
    mls.react = vi.fn(() => call.promise);

    const done = store.reactDm('dm1', 'f1', '👍');
    expect(mine()).toEqual([{ emoji: '👍', count: 1, users: [ME] }]);
    expect(emitted).toHaveBeenCalledWith('dm', { conversation_id: 'dm1' });

    mls.applyReaction('dm1', ME, { target: 'f1', emoji: '👍', op: 'add' });
    call.resolve({ id: 'x' });
    await done;
    expect(mine()).toEqual([{ emoji: '👍', count: 1, users: [ME] }]);
  });

  it('takes a removal back when the frame could not be sent', async () => {
    const { store, mls, mine } = dmStore();
    mls.applyReaction('dm1', ME, { target: 'f1', emoji: '👍', op: 'add' });
    const call = inFlight();
    mls.unreact = vi.fn(() => call.promise);

    const done = store.unreactDm('dm1', 'f1', '👍');
    expect(mine()).toEqual([]);
    call.reject(new Error('offline'));
    await expect(done).rejects.toThrow('offline');
    expect(mine()).toEqual([{ emoji: '👍', count: 1, users: [ME] }]);
  });
});

function messageStore() {
  const store = freshStore();
  store.me = { user_id: ME };
  store.messages.set('c1', [
    { id: 'm1', channel_id: 'c1', author: BOB, content: 'one', edited_at: null },
    { id: 'm2', channel_id: 'c1', author: ME, content: 'two', edited_at: null },
    { id: 'm3', channel_id: 'c1', author: BOB, content: 'three', edited_at: null },
  ]);
  const api = { deleteMessage: vi.fn(), editMessage: vi.fn() };
  vi.spyOn(store, 'apiForChannel').mockReturnValue(api);
  const ids = () => store.messages.get('c1').map((m) => m.id);
  const get = (id) => store.messages.get('c1').find((m) => m.id === id);
  return { store, api, ids, get };
}

describe('optimistic deletes and edits in a channel', () => {
  it('takes a deleted message out before the server answers, and the echo removes nothing more', async () => {
    const { store, api, ids } = messageStore();
    const call = inFlight();
    api.deleteMessage.mockReturnValue(call.promise);
    const done = store.deleteMessageNow('c1', 'm2');
    expect(ids()).toEqual(['m1', 'm3']);
    store.removeMessage({ channel_id: 'c1', id: 'm2' });
    call.resolve({});
    await done;
    expect(ids()).toEqual(['m1', 'm3']);
    expect(api.deleteMessage).toHaveBeenCalledWith('c1', 'm2');
  });

  it('puts a refused delete back where it was, and says so to the caller', async () => {
    const { store, api, ids, get } = messageStore();
    const call = inFlight();
    api.deleteMessage.mockReturnValue(call.promise);
    const done = store.deleteMessageNow('c1', 'm2');
    store.messages.get('c1').unshift({ id: 'm0', channel_id: 'c1', author: BOB, content: 'zero' });
    call.reject(Object.assign(new Error('nope'), { status: 403 }));
    await expect(done).rejects.toThrow('nope');
    expect(ids()).toEqual(['m0', 'm1', 'm2', 'm3']);
    expect(get('m2').content).toBe('two');
  });

  it('draws an edit at once, marked edited and saving, and settles it on success', async () => {
    const { store, api, get } = messageStore();
    const call = inFlight();
    api.editMessage.mockReturnValue(call.promise);
    const done = store.editMessageNow('c1', 'm2', 'two, better');
    expect(get('m2')).toMatchObject({ content: 'two, better', saving: true });
    expect(get('m2').edited_at).toBeTruthy();
    store.patchMessage({ channel_id: 'c1', id: 'm2', content: 'two, better', edited_at: 'server' });
    call.resolve({});
    await done;
    expect(get('m2')).toMatchObject({ content: 'two, better', edited_at: 'server', saving: false });
  });

  it('puts the old words back when an edit is refused', async () => {
    const { store, api, get } = messageStore();
    api.editMessage.mockRejectedValue(new Error('offline'));
    await expect(store.editMessageNow('c1', 'm2', 'nope')).rejects.toThrow('offline');
    expect(get('m2')).toMatchObject({ content: 'two', edited_at: null, saving: false });
  });
});

describe('optimistic deletes and edits in a conversation', () => {
  function dmStore() {
    const store = freshStore();
    const mls = Object.assign(Object.create(Mls.prototype), {
      userId: ME,
      edits: new Map(),
      tombstones: new Map(),
      outgoing: new Map(),
      plaintext: new Map([['f1', { text: 'hello' }]]),
    });
    store.mls = mls;
    const emitted = vi.spyOn(store, 'emit');
    return { store, mls, emitted };
  }

  it('shows an edit, saving, before the frame goes out, and drops the overlay once sent', async () => {
    const { store, mls, emitted } = dmStore();
    const call = inFlight();
    mls.post = vi.fn(() => call.promise);
    const done = store.editDm('dm1', 'f1', 'hello there');
    expect(mls.currentText('dm1', 'f1')).toBe('hello there');
    expect(mls.isEdited('dm1', 'f1')).toBe(true);
    expect(mls.isSaving('dm1', 'f1')).toBe(true);
    expect(emitted).toHaveBeenCalledWith('dm', { conversation_id: 'dm1' });
    mls.edits.set('dm1', new Map([['f1', { text: 'hello there', by: ME }]]));
    call.resolve({ id: 'x' });
    await done;
    expect(mls.currentText('dm1', 'f1')).toBe('hello there');
    expect(mls.isSaving('dm1', 'f1')).toBe(false);
  });

  it('takes a refused edit back', async () => {
    const { store, mls } = dmStore();
    mls.post = vi.fn(async () => { throw new Error('offline'); });
    await expect(store.editDm('dm1', 'f1', 'nope')).rejects.toThrow('offline');
    expect(mls.currentText('dm1', 'f1')).toBe('hello');
    expect(mls.isEdited('dm1', 'f1')).toBe(false);
    expect(mls.isSaving('dm1', 'f1')).toBe(false);
  });

  it('tombstones a delete at once and gives it back, words and all, if it could not be sent', async () => {
    const { store, mls, emitted } = dmStore();
    const call = inFlight();
    mls.post = vi.fn(() => call.promise);
    const done = store.deleteDm('dm1', 'f1');
    expect(mls.isDeleted('dm1', 'f1')).toBe(true);
    expect(emitted).toHaveBeenCalledWith('dm', { conversation_id: 'dm1' });
    call.reject(new Error('offline'));
    await expect(done).rejects.toThrow('offline');
    expect(mls.isDeleted('dm1', 'f1')).toBe(false);
    expect(mls.currentText('dm1', 'f1')).toBe('hello');
  });
});

describe('the head of the timeline', () => {
  const surface = {
    id: 'c1', kind: 'channel', guildId: 'g1',
    ack: () => {}, memberOf: () => null, colourFor: () => null,
  };
  const store = {
    me: { user_id: ME },
    threads: new Map(),
    myMember: () => null,
    takeJump: () => null,
    on: () => () => {},
  };
  const draw = (props) => render(
    <StoreProvider store={store}>
      <Timeline
        surface={surface}
        items={[]}
        pending={[]}
        loading={false}
        intro={<div>Welcome to #general</div>}
        onEdit={() => {}}
        onReply={() => {}}
        {...props}
      />
    </StoreProvider>,
  );

  afterEach(() => { delete globalThis.IntersectionObserver; });

  it('shows where the channel began when there is nothing above', () => {
    draw({ hasMore: false });
    expect(screen.getByText('Welcome to #general')).toBeTruthy();
    expect(screen.queryByText(/scroll up/i)).toBeNull();
  });

  it('never asks the reader to scroll, and only speaks while a page is coming', () => {
    const { rerender } = draw({ hasMore: true, fetchingOlder: false });
    expect(screen.queryByText(/scroll up/i)).toBeNull();
    expect(screen.queryByText('Welcome to #general')).toBeNull();
    expect(screen.queryByText('Loading older messages…')).toBeNull();
    rerender(
      <StoreProvider store={store}>
        <Timeline surface={surface} items={[]} pending={[]} loading={false} hasMore fetchingOlder onEdit={() => {}} onReply={() => {}} />
      </StoreProvider>,
    );
    expect(screen.getByText('Loading older messages…')).toBeTruthy();
  });

  it('fetches the page above as soon as the head comes into reach', async () => {
    let seen;
    globalThis.IntersectionObserver = class {
      constructor(callback) { seen = callback; }

      observe() {}

      disconnect() {}
    };
    const onLoadOlder = vi.fn(async () => {});
    draw({ hasMore: true, onLoadOlder });
    await act(async () => { seen([{ isIntersecting: true }]); });
    expect(onLoadOlder).toHaveBeenCalled();
  });
});

describe('the hover bar', () => {
  async function boot(mutate) {
    const server = createFakeServer();
    mutate?.(server.state);
    server.install();
    const store = freshStore();
    const user = userEvent.setup();
    render(<App store={store} />);
    await signIn(user, { home: HOME });
    await waitFor(() => expect(store.signedIn).toBe(true));
    await act(async () => { await store.addServer('guilds.example'); });
    await user.click(await screen.findByTitle('Telium on guilds.example'));
    await screen.findByText('first');
    return { server, store, user };
  }

  const barOf = (text) => screen.getByText(text).closest('.msg-row').querySelector('.msg-actions');

  afterEach(() => { document.documentElement.classList.remove('shift-held'); });

  it('offers three quick reactions that land in one press', async () => {
    const { server, user } = await boot();
    const bar = barOf('first');
    const quick = within(bar).getAllByTitle(/^React with /);
    expect(quick.length).toBe(3);
    await user.click(within(bar).getByTitle('React with \u{1F44D}'));
    const row = screen.getByText('first').closest('.msg-row');
    await waitFor(() => expect(row.querySelector('.reaction-pill')).toBeTruthy());
    await waitFor(() => expect(server.state.reactions).toEqual([
      { message_id: 'm1', emoji: '\u{1F44D}', method: 'PUT' },
    ]));
  });

  it('tracks Shift for the whole window and lets it go on blur', async () => {
    await boot();
    const root = document.documentElement;
    fireEvent.keyDown(window, { key: 'Shift', shiftKey: true });
    expect(root.classList.contains('shift-held')).toBe(true);
    fireEvent.keyUp(window, { key: 'Shift', shiftKey: false });
    expect(root.classList.contains('shift-held')).toBe(false);
    fireEvent.keyDown(window, { key: 'Shift', shiftKey: true });
    fireEvent.blur(window);
    expect(root.classList.contains('shift-held')).toBe(false);
  });

  it('deletes at once with Shift held, without asking', async () => {
    const { store, user } = await boot();
    const api = store.apiForChannel('c1');
    const remove = vi.spyOn(api, 'deleteMessage').mockResolvedValue({});
    fireEvent.keyDown(window, { key: 'Shift', shiftKey: true });
    const bar = barOf('first');
    const del = within(bar).getByTitle('Delete');
    expect(del.dataset.tone).toBe('danger');
    expect(del.classList.contains('shift-only')).toBe(true);
    await user.click(del);
    expect(remove).toHaveBeenCalledWith('c1', 'm1');
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('pins at once with Shift held', async () => {
    const { store, user } = await boot();
    const api = store.apiForChannel('c1');
    const pin = vi.spyOn(api, 'pin').mockResolvedValue({});
    await user.click(within(barOf('first')).getByTitle('Pin'));
    expect(pin).toHaveBeenCalledWith('c1', 'm1');
    expect(await screen.findByText('Pinned.')).toBeTruthy();
  });

  it('marks the messages history came back with pinned, head row and gutter row alike', async () => {
    await boot((state) => {
      state.messages.push({
        id: 'm3', channel_id: 'c1', guild_id: state.guild.id,
        author: ME, content: 'third', created_at: 1_700_000_120_000,
      });
      state.pins = [
        { channel_id: 'c1', message_id: 'm1' },
        { channel_id: 'c1', message_id: 'm3' },
      ];
    });
    const head = (await screen.findByText('first')).closest('.msg-row');
    const gutter = (await screen.findByText('third')).closest('.msg-row');
    const plain = screen.getByText('second').closest('.msg-row');

    await waitFor(() => expect(within(head).getByTitle('Pinned')).toBeTruthy());
    expect(within(gutter).getByTitle('Pinned')).toBeTruthy();
    expect(within(plain).queryByTitle('Pinned')).toBeNull();
    expect(within(head).getByTitle('Pinned').textContent).toBe('Pinned');
    expect(within(gutter).getByTitle('Pinned').textContent).toBe('Pinned');
    expect(within(gutter).getByTitle('Pinned').closest('.w-10')).not.toBeNull();
    expect(within(head).getByTitle('Pinned').closest('.w-10')).toBeNull();
  });

  it('puts the mark on when a pin lands and takes it straight back off', async () => {
    const { store, user } = await boot();
    const row = screen.getByText('first').closest('.msg-row');
    expect(within(row).queryByTitle('Pinned')).toBeNull();

    const api = store.apiForChannel('c1');
    vi.spyOn(api, 'pin').mockResolvedValue({});
    await user.click(within(row).getByTitle('Pin'));
    expect(await screen.findByText('Pinned.')).toBeTruthy();
    act(() => store.onDispatch({
      domain: 'guilds.example',
      t: 'CHANNEL_PINS_UPDATE',
      d: { channel_id: 'c1', message_id: 'm1', pinned: true },
    }));
    await waitFor(() => expect(within(row).getByTitle('Pinned')).toBeTruthy());
    expect(within(row).getByTitle('Unpin')).toBeTruthy();

    vi.spyOn(api, 'pin').mockRejectedValue(Object.assign(new Error('conflict'), { status: 409 }));
    vi.spyOn(api, 'unpin').mockResolvedValue({});
    await user.click(within(row).getByTitle('Unpin'));
    expect(await screen.findByText('Unpinned.')).toBeTruthy();
    act(() => store.onDispatch({
      domain: 'guilds.example',
      t: 'CHANNEL_PINS_UPDATE',
      d: { channel_id: 'c1', message_id: 'm1', pinned: false },
    }));
    await waitFor(() => expect(within(row).queryByTitle('Pinned')).toBeNull());
    expect(within(row).getByTitle('Pin')).toBeTruthy();
  });

  it('says out loud that a pin was made while the room is open, and opens the list from it', async () => {
    const { store, user } = await boot();

    act(() => store.onDispatch({
      domain: 'guilds.example',
      t: 'CHANNEL_PINS_UPDATE',
      d: { channel_id: 'c2', message_id: 'm9', pinned: true },
    }));
    expect(screen.queryByText('A message was pinned')).toBeNull();

    act(() => store.onDispatch({
      domain: 'guilds.example',
      t: 'CHANNEL_PINS_UPDATE',
      d: { channel_id: 'c1', message_id: 'm1', pinned: true },
    }));

    const notice = await screen.findByText('A message was pinned');
    expect(notice.closest('[data-pin-notice]')).toBeTruthy();
    expect(screen.queryByText(/pinned a message/)).toBeNull();

    const headerPin = await screen.findByTitle('Pinned messages');
    await user.click(screen.getByRole('button', { name: 'See all pins' }));
    expect(await screen.findByRole('dialog', { name: 'Pinned messages' })).toBeTruthy();
    expect(headerPin.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getAllByRole('dialog', { name: 'Pinned messages' })).toHaveLength(1);
  });

  it('offers only what the permission holds', async () => {
    await boot((state) => {
      state.guild.owner = BOB;
      state.guild.me = {
        ...state.guild.me, is_owner: false, permissions: '3151875',
      };
    });
    expect(within(barOf('first')).queryByTitle('Delete')).toBeNull();
    expect(within(barOf('first')).queryByTitle('Pin')).toBeNull();
    expect(within(barOf('second')).getByTitle('Delete')).toBeTruthy();
    expect(within(barOf('second')).queryByTitle('Pin')).toBeNull();
  });

  it('removes a row the moment it is deleted, and brings it back with a toast if refused', async () => {
    const { store, user } = await boot();
    const api = store.apiForChannel('c1');
    const call = inFlight();
    vi.spyOn(api, 'deleteMessage').mockReturnValue(call.promise);
    fireEvent.keyDown(window, { key: 'Shift', shiftKey: true });
    await user.click(within(barOf('second')).getByTitle('Delete'));
    await waitFor(() => expect(screen.queryByText('second')).toBeNull());
    await act(async () => { call.reject(new Error('nope')); });
    expect(await screen.findByText('second')).toBeTruthy();
    expect(await screen.findByText(/Delete failed/)).toBeTruthy();
  });

  it('dims a saving edit exactly as a send, with its (edited) mark and its time', async () => {
    const { store } = await boot();
    const api = store.apiForChannel('c1');
    const call = inFlight();
    vi.spyOn(api, 'editMessage').mockReturnValue(call.promise);
    let done;
    act(() => { done = store.editMessageNow('c1', 'm2', 'second, fixed'); });
    const row = (await screen.findByText('second, fixed')).closest('.msg-row');
    expect(row.classList.contains('msg-pending')).toBe(true);
    expect(within(row).getByText(/\(edited\)/)).toBeTruthy();
    expect(within(row).queryByText('Sending…')).toBeNull();
    await act(async () => { call.resolve({}); await done; });
    await waitFor(() => expect(row.classList.contains('msg-pending')).toBe(false));
    expect(within(row).getByText(/\(edited\)/)).toBeTruthy();
  });
});
