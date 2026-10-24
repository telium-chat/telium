import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../App.jsx';
import { recentEmoji } from '../lib/emoji.js';
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
  server.state.dmFrames = [{
    id: 'f1', conversation_id: 'dm1', seq: 1, epoch: 1,
    kind: 'application', sender: CAROL, sender_device: 'd-carol',
    ciphertext: 'AAAA', created_at: Date.now(),
  }, {
    id: 'f2', conversation_id: 'dm1', seq: 2, epoch: 1,
    kind: 'application', sender: ME, sender_device: 'd-alice',
    ciphertext: 'BBBB', created_at: Date.now(),
  }];
  const store = freshStore();
  const user = userEvent.setup();
  render(<App store={store} />);
  await signIn(user, { home: HOME });
  await waitFor(() => expect(store.signedIn).toBe(true));
  await waitFor(() => expect(store.mls).toBeTruthy());
  store.mls.plaintext.set('f1', { text: 'hello', attachments: [], reply: null });
  store.mls.plaintext.set('f2', { text: 'draft one', attachments: [], reply: null });
  await user.click(await screen.findByTitle('Direct messages'));
  await user.click(await screen.findByText('carol'));
  return { server, store, user };
}

function stubReactions(store) {
  const apply = (op) => async (conversationId, frameId, emoji) => {
    store.mls.applyReaction(conversationId, ME, { target: frameId, emoji, op });
    act(() => { store.emit('dm', { conversation_id: conversationId }); });
  };
  return vi.spyOn(store, 'reactDm').mockImplementation(apply('add'))
    && vi.spyOn(store, 'unreactDm').mockImplementation(apply('remove'));
}

describe('dm message actions', () => {
  it('drops a picked emoji at the caret and files it under recents', async () => {
    const { store, user } = await boot();
    const composer = await screen.findByPlaceholderText('Message');

    await user.type(composer, 'ab');
    composer.setSelectionRange(1, 1);

    await user.click(screen.getByTitle('Emoji'));
    const dialog = await screen.findByRole('dialog');
    await user.click(await within(dialog).findByTitle(':fire:'));

    await waitFor(() => expect(composer.value).toBe('a\u{1F525}b'));
    expect(recentEmoji(store.sync)).toContain('\u{1F525}');
  });

  it('sends a picked GIF as encrypted message text without replacing the draft', async () => {
    const { store, user } = await boot();
    const send = vi.spyOn(store, 'sendDm').mockResolvedValue({ id: 'f-gif' });
    const composer = await screen.findByPlaceholderText('Message');
    await user.type(composer, 'keep this draft');
    await user.click(screen.getByTitle('GIF'));
    const dialog = await screen.findByRole('dialog');
    await user.click(await within(dialog).findByTitle('Send Celebration'));

    await waitFor(() => expect(send).toHaveBeenCalledWith(
      'dm1', 'https://media.klipy.com/test/celebrate.gif', [], null, expect.any(String),
    ));
    expect(composer.value).toBe('keep this draft');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('renders a decrypted DM GIF directly instead of asking the embed proxy', async () => {
    const { server, store } = await boot();
    store.mls.plaintext.set('f1', {
      text: 'https://media.klipy.com/test/celebrate.gif', attachments: [], reply: null,
    });
    act(() => { store.emit('dm', { conversation_id: 'dm1' }); });
    const image = await screen.findByAltText('GIF');
    expect(image.getAttribute('src')).toBe('https://media.klipy.com/test/celebrate.gif');
    expect(server.state.embedRequests).toEqual([]);
  });

  it('reacts through the picker and takes the reaction back off the pill', async () => {
    const { store, user } = await boot();
    stubReactions(store);

    const row = screen.getByText('hello').closest('div.msg-row');
    await user.click(within(row).getByTitle('React'));
    const picker = await screen.findByLabelText('Emoji picker');
    await user.click(await within(picker).findByTitle(':+1:'));

    const thumb = '\u{1F44D}\uFE0F';
    const pill = await within(row).findByRole('button', {
      name: `${thumb}, 1 reaction, reacted by you`,
    });
    await user.click(pill);
    await waitFor(() => expect(
      within(row).queryByRole('button', { name: /1 reaction/ }),
    ).toBeNull());
  });

  it('stages a reply, sends the quote inside the message, and cancels on Escape', async () => {
    const { store, user } = await boot();
    const send = vi.spyOn(store, 'sendDm').mockResolvedValue({ id: 'f2' });

    const row = screen.getByText('hello').closest('div.msg-row');
    await user.click(within(row).getByTitle('Reply'));
    expect(screen.getByText(/Replying to carol/)).toBeTruthy();

    const composer = await screen.findByPlaceholderText('Message');
    await user.type(composer, 'and my answer');
    await user.keyboard('{Escape}');
    expect(screen.queryByText(/Replying to carol/)).toBeNull();

    await user.click(within(row).getByTitle('Reply'));
    expect(screen.getByText(/Replying to carol/)).toBeTruthy();
    await user.type(composer, '{Enter}');
    await waitFor(() => expect(send).toHaveBeenCalledWith('dm1', 'and my answer', [], {
      id: 'f1', author: CAROL, text: 'hello',
    }, expect.any(String)));
  });

  it('puts the caret in the composer when a reply starts, and leaves it alone on cancel', async () => {
    const { user } = await boot();
    const composer = await screen.findByPlaceholderText('Message');

    const theirs = screen.getByText('hello').closest('div.msg-row');
    await user.click(within(theirs).getByTitle('Reply'));
    expect(document.activeElement).toBe(composer);

    await user.type(composer, 'and my answer');
    composer.setSelectionRange(0, 0);
    composer.blur();

    const mine = screen.getByText('draft one').closest('div.msg-row');
    await user.click(within(mine).getByTitle('Reply'));
    expect(document.activeElement).toBe(composer);
    expect(composer.selectionStart).toBe('and my answer'.length);
    expect(composer.selectionEnd).toBe('and my answer'.length);

    await user.click(screen.getByTitle('Cancel reply'));
    expect(screen.queryByText(/Replying to/)).toBeNull();
    expect(document.activeElement).not.toBe(composer);
    expect(composer.value).toBe('and my answer');
  });

  it('files the emoji a sent message carried under recents', async () => {
    const { store, user } = await boot();
    vi.spyOn(store, 'sendDm').mockResolvedValue({ id: 'f3' });
    const composer = await screen.findByPlaceholderText('Message');

    const party = '<party:01M2RD1VD19N3BAJ53KX0BQ1XR@other.example>';
    fireEvent.change(composer, { target: { value: `nice \u{1F525} ${party}` } });
    await user.type(composer, '{Enter}');

    await waitFor(() => expect(recentEmoji(store.sync)).toEqual(['\u{1F525}', party]));
  });

  it('draws a quoted custom emoji as a picture in both places a quote appears', async () => {
    const { store, user } = await boot();
    const party = '<party:01M2RD1VD19N3BAJ53KX0BQ1XR@other.example>';
    store.mls.plaintext.set('f1', { text: `cheers ${party}`, attachments: [], reply: null });
    store.mls.plaintext.set('f2', {
      text: 'draft one', attachments: [],
      reply: { id: 'f1', author: CAROL, text: `cheers ${party}` },
    });
    act(() => { store.emit('dm', { conversation_id: 'dm1' }); });

    const quote = await waitFor(() => {
      const el = document.querySelector('[data-id="f2"] .msg-preview');
      expect(el).toBeTruthy();
      return el;
    });
    expect(within(quote).getByAltText(':party:')).toBeTruthy();
    expect(quote.textContent).not.toContain('01M2RD');

    await user.click(within(document.querySelector('[data-id="f1"]')).getByTitle('Reply'));
    const strip = screen.getByText(/Replying to carol/);
    expect(within(strip).getByAltText(':party:')).toBeTruthy();
    expect(strip.textContent).not.toContain('01M2RD');
  });

  it('puts the caret in the composer when a conversation is opened', async () => {
    const { user } = await boot();
    const composer = await screen.findByPlaceholderText('Message');

    await waitFor(() => expect(document.activeElement).toBe(composer));

    await user.type(composer, 'half a sentence');
    composer.setSelectionRange(0, 0);
    composer.blur();

    await user.click(screen.getByText('Friends'));
    await user.click(await screen.findByText('carol'));
    const reopened = await screen.findByPlaceholderText('Message');
    await waitFor(() => expect(document.activeElement).toBe(reopened));
    expect(reopened.value).toBe('half a sentence');
    expect(reopened.selectionStart).toBe('half a sentence'.length);
    expect(reopened.selectionEnd).toBe('half a sentence'.length);
  });

  it('does not take the focus off whatever is already holding it', async () => {
    const { user } = await boot();
    const composer = await screen.findByPlaceholderText('Message');
    await waitFor(() => expect(document.activeElement).toBe(composer));
    composer.blur();
    await user.click(screen.getByText('Friends'));

    const elsewhere = document.createElement('input');
    document.body.appendChild(elsewhere);
    elsewhere.focus();

    fireEvent.click(screen.getByText('carol'));
    const reopened = await screen.findByPlaceholderText('Message');
    await act(async () => {});
    expect(document.activeElement).toBe(elsewhere);
    expect(reopened.value).toBe('');
    elsewhere.remove();
  });

  it('edits your own message in place and marks it edited', async () => {
    const { store, user } = await boot();
    vi.spyOn(store, 'editDm').mockImplementation(async (cid, fid, newText) => {
      store.mls.applyEdit(cid, ME, { target: fid, text: newText });
      act(() => { store.emit('dm', { conversation_id: cid }); });
    });

    const row = screen.getByText('draft one').closest('div.msg-row');
    await user.click(within(row).getByTitle('Edit'));

    const box = within(row).getByRole('textbox');
    expect(box.value).toBe('draft one');
    await user.clear(box);
    await user.type(box, 'draft two{Enter}');

    await waitFor(() => expect(within(row).getByText('draft two')).toBeTruthy());
    expect(within(row).getByText('(edited)')).toBeTruthy();
    expect(screen.getByPlaceholderText('Message').value).toBe('');
  });

  it('does not draw its own message as unreadable while the send is in flight', async () => {
    const { store } = await boot();
    const echo = {
      id: 'f9', conversation_id: 'dm1', seq: 9, epoch: 1, kind: 'application',
      sender: ME, sender_device: store.mls.deviceId, ciphertext: 'EEEE', created_at: Date.now(),
    };

    store.sending.add('dm1');
    await act(async () => { store.onDmFrame(echo); });
    expect(store.dmFrames.get('dm1').some((f) => f.id === 'f9')).toBe(false);

    store.sending.delete('dm1');
    await act(async () => { store.onDmFrame(echo); });
    expect(store.dmFrames.get('dm1').some((f) => f.id === 'f9')).toBe(true);
  });

  it('offers the same menu to a right-click as to the ... button', async () => {
    await boot();
    const row = screen.getByText('draft one').closest('div.msg-row');

    fireEvent.contextMenu(row);
    const items = (await screen.findAllByRole('menuitem')).map((el) => el.textContent);
    expect(items).toEqual(expect.arrayContaining([
      'Reply', 'Forward', 'Edit message', 'Pin message', 'Copy text', 'Delete message',
    ]));
  });

  it('deletes for everyone only after asking, and shows the tombstone', async () => {
    const { store, user } = await boot();
    vi.spyOn(store, 'deleteDm').mockImplementation(async (cid, fid) => {
      store.mls.applyDelete(cid, ME, { target: fid });
      act(() => { store.emit('dm', { conversation_id: cid }); });
    });

    const row = screen.getByText('draft one').closest('div.msg-row');
    await user.click(within(row).getByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete message' }));

    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await screen.findByText('Message deleted');
    expect(screen.queryByText('draft one')).toBeNull();
  });

  it('pins any readable message into the header list, jumps to it, and unpins', async () => {
    const { store, user } = await boot();
    vi.spyOn(store, 'setPinDm').mockImplementation(async (cid, fid, pin) => {
      const payload = pin
        ? { target: fid, op: 'add', author: fid === 'f1' ? CAROL : ME,
            snippet: store.mls.textOf(fid) || '' }
        : { target: fid, op: 'remove' };
      store.mls.applyPin(cid, ME, payload);
      act(() => { store.emit('dm', { conversation_id: cid }); });
    });
    vi.spyOn(store.mls, 'joined').mockReturnValue(true);

    const pinsButton = await screen.findByTitle('Pinned messages');
    const detailsButton = screen.getByTitle(/conversation details/i);
    expect(pinsButton.compareDocumentPosition(detailsButton)
      & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(pinsButton).queryByText('1')).toBeNull();

    const row = screen.getByText('hello').closest('div.msg-row');
    await user.click(within(row).getByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Pin message' }));

    expect(await within(pinsButton).findByText('1')).toBeTruthy();
    expect(within(row).getByTitle('Pinned')).toBeTruthy();

    await user.click(pinsButton);
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('carol')).toBeTruthy();
    expect(within(dialog).getByText('hello')).toBeTruthy();

    await user.click(within(dialog).getByRole('button', { name: /^Jump to the message/ }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(
      document.querySelector('[data-id="f1"]').className,
    ).toContain('msg-flash'));

    await user.click(screen.getByTitle('Pinned messages'));
    const reopened = await screen.findByRole('dialog');
    await user.click(within(reopened).getByRole('button', { name: 'Unpin' }));
    await waitFor(() => expect(within(reopened).getByText('Nothing pinned yet')).toBeTruthy());
    expect(within(reopened).queryByText('hello')).toBeNull();
    const still = screen.getByText('hello').closest('div.msg-row');
    await waitFor(() => expect(within(still).queryByTitle('Pinned')).toBeNull());
  });

  it('counts the pins nobody has listed, and listing them is what clears it', async () => {
    const { store, user } = await boot();
    vi.spyOn(store, 'setPinDm').mockImplementation(async (cid, fid, pin) => {
      const payload = pin
        ? { target: fid, op: 'add', author: fid === 'f1' ? CAROL : ME,
            snippet: store.mls.textOf(fid) || '' }
        : { target: fid, op: 'remove' };
      store.mls.applyPin(cid, ME, payload);
      act(() => { store.emit('dm', { conversation_id: cid }); });
    });
    vi.spyOn(store.mls, 'joined').mockReturnValue(true);

    const pin = async (text) => {
      const row = screen.getByText(text).closest('div.msg-row');
      await user.click(within(row).getByRole('button', { name: 'More actions' }));
      await user.click(await screen.findByRole('menuitem', { name: 'Pin message' }));
    };

    const pinsButton = await screen.findByTitle('Pinned messages');
    expect(within(pinsButton).queryByText('1')).toBeNull();

    await pin('hello');
    await within(pinsButton).findByText('1');

    await user.click(pinsButton);
    await screen.findByRole('dialog');
    await waitFor(() => expect(within(pinsButton).queryByText('1')).toBeNull());

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await pin('draft one');
    await within(pinsButton).findByText('1');
  });

  it('says out loud that a pin was made in this conversation, and opens the list from it', async () => {
    const { store, user } = await boot();
    vi.spyOn(store.mls, 'setPin').mockImplementation(async (cid, fid, pin) => {
      const payload = pin
        ? { target: fid, op: 'add', author: CAROL, snippet: store.mls.textOf(fid) || '' }
        : { target: fid, op: 'remove' };
      store.mls.applyPin(cid, CAROL, payload);
      return { id: 'f-pin' };
    });

    const row = screen.getByText('hello').closest('div.msg-row');
    await user.click(within(row).getByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Pin message' }));

    const notice = await screen.findByText(/pinned a message/);
    expect(notice.closest('[data-pin-notice]')).toBeTruthy();
    expect(screen.queryByText('A message was pinned')).toBeNull();

    const pinsButton = await screen.findByTitle('Pinned messages');
    expect(await within(pinsButton).findByText('1')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'See all pins' }));
    expect(await screen.findByRole('dialog', { name: 'Pinned messages' })).toBeTruthy();
    expect(pinsButton.getAttribute('aria-expanded')).toBe('true');
    await waitFor(() => expect(within(pinsButton).queryByText('1')).toBeNull());
  });
});
