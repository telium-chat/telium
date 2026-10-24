import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../App.jsx';
import { createFakeServer, freshStore, GUILD, HOME } from './fake-server.js';
import { signedInApp } from './harness.jsx';
import { signIn } from './sign-in.js';

const CAROL = '@carol:other.example';

const CONVO = {
  id: 'dm1',
  kind: 'dm',
  sequencer: 'home.example',
  epoch: 1,
  last_seq: 0,
  members: [
    { user_id: '@alice:home.example', state: 'joined' },
    { user_id: CAROL, state: 'joined' },
  ],
};

async function boot(prepare) {
  const server = createFakeServer({ conversations: [CONVO] });
  prepare?.(server.state);
  const { store, user } = await signedInApp(server);
  await act(async () => { await store.addServer('guilds.example'); });
  await user.click(await screen.findByTitle('Telium on guilds.example'));
  await user.click(await screen.findByRole('button', { name: 'general' }));
  await screen.findByText('second');
  return { server, store, user };
}

async function openForward(user, fromText) {
  fireEvent.contextMenu(screen.getByText(fromText));
  await user.click(await screen.findByRole('menuitem', { name: 'Forward' }));
  return screen.findByRole('dialog');
}

describe('message forwarding', () => {
  it('lists channels and conversations as destinations', async () => {
    const { user } = await boot();
    const dialog = await openForward(user, 'second');

    expect(within(dialog).getByText('#general')).toBeTruthy();
    expect(within(dialog).getByText('carol')).toBeTruthy();

    await user.type(within(dialog).getByPlaceholderText(/Search channels/), 'carol');
    expect(within(dialog).queryByText('#general')).toBeNull();
    expect(within(dialog).getByText('carol')).toBeTruthy();
  });

  it('sends a copy to the picked channel and leaves the original alone', async () => {
    const { server, user } = await boot();
    const dialog = await openForward(user, 'second');

    const row = within(dialog).getByText('#general').closest('div');
    await user.click(within(row).getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(server.state.messages.length).toBe(3));
    expect(server.state.messages[2].content).toBe('telium://forward/g1/c1/m2\nsecond');
    expect(server.state.messages[0].content).toBe('first');
  });

  it('shows the copy as forwarded rather than as the forwarder\'s words', async () => {
    const { server, user } = await boot();
    const dialog = await openForward(user, 'second');

    const row = within(dialog).getByText('#general').closest('div');
    await user.click(within(row).getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(server.state.messages.length).toBe(3));
    await act(async () => {
      server.dispatch(GUILD, 'MESSAGE_CREATE', server.state.messages[2]);
    });

    expect(await screen.findByText('Forwarded from Telium')).toBeTruthy();
    expect(screen.queryByText(/telium:\/\//)).toBeNull();
    expect(screen.getByText('first')).toBeTruthy();
  });

  it('forwards into a DM through the conversation, not the wire', async () => {
    const { server, store, user } = await boot();
    vi.spyOn(store, 'sendDm').mockResolvedValue({ id: 'f9' });
    const dialog = await openForward(user, 'second');

    const row = within(dialog).getByText('carol').closest('div');
    await user.click(within(row).getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(store.sendDm)
      .toHaveBeenCalledWith('dm1', 'telium://forward/g1/c1/m2\nsecond', []));
    expect(server.state.sent.length).toBe(0);
  });

  it('carries a conversation origin as the bare marker and chips it on arrival', async () => {
    const server = createFakeServer({ conversations: [CONVO] });
    server.install();
    server.state.dmFrames = [{
      id: 'f1', conversation_id: 'dm1', seq: 1, epoch: 1,
      kind: 'application', sender: CAROL, sender_device: 'd-carol',
      ciphertext: 'AAAA', created_at: Date.now(),
    }];
    const store = freshStore();
    const user = userEvent.setup();
    render(<App store={store} />);
    await signIn(user, { home: HOME });
    await waitFor(() => expect(store.signedIn).toBe(true));
    await waitFor(() => expect(store.mls).toBeTruthy());
    store.mls.plaintext.set('f1', { text: 'hello', attachments: [], reply: null });
    vi.spyOn(store, 'sendDm').mockResolvedValue({ id: 'f2' });
    await act(async () => { await store.addServer('guilds.example'); });

    await user.click(await screen.findByTitle('Direct messages'));
    await user.click(await screen.findByText('carol'));
    const dmRow = (await screen.findByText('hello')).closest('div.msg-row');
    await user.click(within(dmRow).getByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Forward' }));

    const dialog = await screen.findByRole('dialog');
    const dest = within(dialog).getByText('#general').closest('div');
    await user.click(within(dest).getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(server.state.sent.map((m) => m.content))
      .toEqual(['telium://forward/convo/dm1/f1\nhello']));

    await user.click(await screen.findByTitle('Telium on guilds.example'));
    await user.click(await screen.findByRole('button', { name: 'general' }));
    const chip = await screen.findByText((content) => content.includes('Forwarded from'));
    expect(chip).toBeTruthy();
    expect(screen.getByText('hello')).toBeTruthy();
    expect(screen.queryByTitle(/Jump to message/)).toBeNull();
    expect(screen.queryByText(/telium:\/\//)).toBeNull();
  });

  it('a chip in a DM jumps back to the source guild channel and flashes it', async () => {
    const server = createFakeServer({ conversations: [CONVO] });
    server.install();
    server.state.dmFrames = [{
      id: 'f1', conversation_id: 'dm1', seq: 1, epoch: 1,
      kind: 'application', sender: CAROL, sender_device: 'd-carol',
      ciphertext: 'AAAA', created_at: Date.now(),
    }];
    const store = freshStore();
    const user = userEvent.setup();
    render(<App store={store} />);
    await signIn(user, { home: HOME });
    await waitFor(() => expect(store.signedIn).toBe(true));
    await waitFor(() => expect(store.mls).toBeTruthy());
    store.mls.plaintext.set('f1', {
      text: 'telium://forward/g1/c1/m1\nlook at this',
      attachments: [], reply: null,
    });
    vi.spyOn(store, 'sendDm').mockResolvedValue({ id: 'f2' });
    await act(async () => { await store.addServer('guilds.example'); });

    await user.click(await screen.findByTitle('Telium on guilds.example'));
    await user.click(await screen.findByRole('button', { name: 'general' }));
    await user.click(await screen.findByTitle('Direct messages'));
    await user.click(await screen.findByText('carol'));
    expect(await screen.findByText('look at this')).toBeTruthy();

    const chip = await screen.findByTitle('Jump to message in #general');
    expect(chip.textContent).toMatch(/Telium/);
    expect(chip.textContent).toMatch(/#general/);

    await user.click(chip);
    await waitFor(() => expect(store.route.channelId).toBe('c1'));
    await waitFor(() => expect(document.querySelector('[data-id="m1"]').className)
      .toMatch(/msg-flash/));
  });

  it('a DM chip jump snaps the original message into view (not just flashes)', async () => {
    const server = createFakeServer({ conversations: [CONVO] });
    server.install();
    server.state.dmFrames = [{
      id: 'f1', conversation_id: 'dm1', seq: 1, epoch: 1,
      kind: 'application', sender: CAROL, sender_device: 'd-carol',
      ciphertext: 'AAAA', created_at: Date.now(),
    }];
    const store = freshStore();
    const user = userEvent.setup();
    render(<App store={store} />);
    await signIn(user, { home: HOME });
    await waitFor(() => expect(store.signedIn).toBe(true));
    await waitFor(() => expect(store.mls).toBeTruthy());
    store.mls.plaintext.set('f1', {
      text: 'telium://forward/g1/c1/m1\nlook at this',
      attachments: [], reply: null,
    });
    vi.spyOn(store, 'sendDm').mockResolvedValue({ id: 'f2' });
    await act(async () => { await store.addServer('guilds.example'); });

    await user.click(await screen.findByTitle('Telium on guilds.example'));
    await user.click(await screen.findByRole('button', { name: 'general' }));
    await user.click(await screen.findByTitle('Direct messages'));
    await user.click(await screen.findByText('carol'));
    expect(await screen.findByText('look at this')).toBeTruthy();

    const chip = await screen.findByTitle('Jump to message in #general');

    const scrollSpy = vi.spyOn(Element.prototype, 'scrollTop', 'set');

    await user.click(chip);
    await waitFor(() => expect(store.route.channelId).toBe('c1'));

    const row = await waitFor(() => {
      const el = document.querySelector('[data-id="m1"]');
      expect(el).toBeTruthy();
      expect(el.className).toMatch(/msg-flash/);
      return el;
    });

    await waitFor(() => expect(scrollSpy).toHaveBeenCalled());
  });

  it('a resolvable chip jumps to the original message', async () => {
    const { user } = await boot((state) => {
      state.guild.channels.push({
        id: 'c4', name: 'annex', type: 'text', permission_overwrites: [],
      });
      state.messages.push({
        id: 'm4', channel_id: 'c4', author: '@bob:home.example',
        content: 'telium://forward/g1/c1/m1\nlook at this',
        created_at: Date.now(),
      });
    });

    await user.click(await screen.findByRole('button', { name: 'annex' }));
    await screen.findByText('look at this');

    await user.click(screen.getByTitle('Jump to message in #general'));
    await waitFor(() => expect(document.querySelector('[data-id="m1"]').className)
      .toMatch(/msg-flash/));
  });

  it('a chip for a guild this account is not in stays a label', async () => {
    const { user } = await boot((state) => {
      state.guild.channels.push({
        id: 'c4', name: 'annex', type: 'text', permission_overwrites: [],
      });
      state.messages.push({
        id: 'm5', channel_id: 'c4', author: '@bob:home.example',
        content: 'telium://forward/gx/cx/mx\nfrom somewhere else',
        created_at: Date.now(),
      });
    });

    await user.click(await screen.findByRole('button', { name: 'annex' }));
    await screen.findByText('from somewhere else');

    expect(screen.getByText('Forwarded from unknown server')).toBeTruthy();
    expect(screen.queryByTitle(/Jump to message/)).toBeNull();
  });
});
