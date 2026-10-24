import { describe, expect, it } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../App.jsx';
import { createFakeServer, freshStore, HOME } from './fake-server.js';
import { signIn } from './sign-in.js';

const ME = '@alice:home.example';
const CAROL = '@carol:other.example';

async function boot() {
  const server = createFakeServer({
    conversations: [{
      id: 'dm1', kind: 'dm', sequencer: 'home.example', epoch: 1, last_seq: 0,
      members: [
        { user_id: ME, state: 'joined' },
        { user_id: CAROL, state: 'joined' },
      ],
    }],
  });
  server.install();
  const at = Date.now();
  server.state.dmFrames = [
    { id: 'w1', conversation_id: 'dm1', seq: 1, epoch: 1, kind: 'welcome', sender: CAROL, sender_device: 'd-carol', ciphertext: 'AAAA', created_at: at },
    { id: 'f1', conversation_id: 'dm1', seq: 2, epoch: 1, kind: 'application', sender: CAROL, sender_device: 'd-carol', ciphertext: 'BBBB', created_at: at },
    { id: 'g1', conversation_id: 'dm1', seq: 3, epoch: 1, kind: 'groupinfo', sender: CAROL, sender_device: 'd-carol', ciphertext: 'CCCC', created_at: at },
    { id: 'c1', conversation_id: 'dm1', seq: 4, epoch: 1, kind: 'commit', sender: ME, sender_device: 'd-alice', ciphertext: 'DDDD', created_at: at },
  ];
  const store = freshStore();
  const user = userEvent.setup();
  render(<App store={store} />);
  await signIn(user, { home: HOME });
  await waitFor(() => expect(store.signedIn).toBe(true));
  await waitFor(() => expect(store.mls).toBeTruthy());
  store.mls.plaintext.set('f1', { text: 'hello', attachments: [], reply: null });
  await user.click(await screen.findByTitle('Direct messages'));
  await user.click(await screen.findByText('carol'));
  return { store, user };
}

describe('a quiet dm', () => {
  it('draws the conversation and not the key schedule', async () => {
    await boot();
    expect(await screen.findByText('hello')).toBeTruthy();

    expect(screen.queryByText('the group state was republished')).toBeNull();
    expect(screen.queryByText('someone was welcomed into the conversation')).toBeNull();
    expect(screen.queryByText('group membership changed')).toBeNull();
  });

  it('opens with who it is with rather than with an essay', async () => {
    await boot();

    expect(await screen.findByText(/The start of your messages with carol/))
      .toBeTruthy();
    expect(screen.queryByText(/always sees who is talking to whom/)).toBeNull();
    expect(screen.queryByText(/sequenced by/)).toBeNull();
  });

  it('opens a profile when the sender avatar is clicked', async () => {
    const { user } = await boot();

    await user.click(await screen.findByRole('button', { name: 'Open profile for carol' }));
    const card = await screen.findByRole('dialog');
    expect(card.textContent).toMatch(/carol/);
  });

  it('keeps the whole claim one press away, on the lock', async () => {
    const { user } = await boot();
    const lock = await screen.findByRole('button', { name: 'Encryption details' });

    await user.click(lock);
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toMatch(/always sees who is talking to whom/);
    expect(dialog.textContent).toMatch(/home\.example/);
  });

  it('opens a profile from inside the details dialog', async () => {
    const { user } = await boot();
    await user.click(await screen.findByRole('button', { name: 'Encryption details' }));
    const dialog = await screen.findByRole('dialog');

    await user.click(within(dialog).getByRole('button', { name: CAROL }));
    await waitFor(() => expect(document.querySelector('.popover [role="dialog"]')).toBeTruthy());
    const card = document.querySelector('.popover [role="dialog"]');
    expect(card.textContent).toMatch(/carol/);

    const backdrop = document.querySelector('.modal__backdrop');
    expect(Number(card.closest('.popover').style.zIndex))
      .toBeGreaterThan(Number(backdrop.style.zIndex));
  });

  it('does not mark a conversation unread for a receipt, only for a message', async () => {
    const { store } = await boot();
    await act(async () => {
      store.navigate({ view: 'chat', guildId: null, channelId: null, conversationId: null });
    });

    const engine = store.mls;
    const walked = [];
    engine.sync = async (id, frames) => {
      walked.push(id);
      for (const frame of frames) if (frame.id === 'r1') engine.signals.add(frame.id);
      return [];
    };

    const notified = [];
    store.on('dm-notify', (frame) => notified.push(frame));
    const arriving = (id, seq) => ({
      id,
      conversation_id: 'dm1',
      seq,
      epoch: 1,
      kind: 'application',
      sender: CAROL,
      sender_device: 'd-carol',
      ciphertext: 'EEEE',
      created_at: Date.now(),
    });

    await act(async () => { store.onDmFrame(arriving('r1', 5)); });
    await waitFor(() => expect(walked).toHaveLength(1));
    expect(store.dmUnreadFor('dm1')).toBe(0);
    expect(store.conversations.find((c) => c.id === 'dm1').unread).toBeFalsy();
    expect(notified).toEqual([]);

    await act(async () => { store.onDmFrame(arriving('m1', 6)); });
    await waitFor(() => expect(store.dmUnreadFor('dm1')).toBe(1));
    expect(store.conversations.find((c) => c.id === 'dm1').unread).toBe(true);
    expect(notified).toHaveLength(1);
  });
});
