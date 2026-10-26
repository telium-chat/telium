import { describe, expect, it } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../App.jsx';
import { createFakeServer, freshStore, GUILD, HOME } from './fake-server.js';
import { signedInApp } from './harness.jsx';
import { signIn } from './sign-in.js';
import { isInviteUrl } from '../views/chat/InviteCard.jsx';

const CONVERSATION = {
  id: 'dm1',
  kind: 'dm',
  sequencer: 'home.example',
  epoch: 1,
  last_seq: 0,
  members: [
    { user_id: '@alice:home.example', state: 'joined' },
    { user_id: '@bob:home.example', state: 'joined' },
  ],
};

async function bootDm() {
  const server = createFakeServer({ conversations: [CONVERSATION] });
  const { store, user } = await signedInApp(server);
  await waitFor(() => expect(store.mls).toBeTruthy());
  return { server, store, user };
}

async function openDm(server, store, user, text) {
  server.state.dmFrames = [{
    id: 'f1', conversation_id: 'dm1', seq: 1, epoch: 1,
    kind: 'application', sender: '@bob:home.example', sender_device: 'd-bob',
    ciphertext: 'AAAA', created_at: Date.now(),
  }];
  store.mls.plaintext.set('f1', { text, attachments: [] });

  await user.click(screen.getByTitle('Direct messages'));
  await user.click(await screen.findByText('bob'));
}

describe('links and invites in messages', () => {
  it('recognizes generated tilde-prefixed invite URLs as invite links', () => {
    expect(isInviteUrl('https://guilds.example/invite/~m3a2yuvn')).toBe(true);
    expect(isInviteUrl('https://guilds.example/invite/rc5sejf3')).toBe(true);
    expect(isInviteUrl('https://telium.chat/invite/~m3a2yuvn@guilds.example')).toBe(true);
  });

  it('renders a URL in a DM as a clickable link, like a guild channel does', async () => {
    const { server, store, user } = await bootDm();
    await openDm(server, store, user, 'see https://example.com/notes for context');

    const link = await screen.findByRole('link', { name: 'https://example.com/notes' });
    expect(link.href).toBe('https://example.com/notes');
    expect(link.closest('.md')).not.toBeNull();
    expect(screen.getByText('see')).toBeTruthy();
  });

  it('renders an invite link in a DM as a card, and Join runs the join flow', async () => {
    const { server, store, user } = await bootDm();
    await openDm(server, store, user, 'come hang out https://guilds.example/invite/INVITE1');

    const join = await screen.findByRole('button', { name: 'Join Telium' });
    const card = join.closest('.invite-card');
    expect(card.textContent).toContain('Telium');
    expect(card.textContent).toContain('2 members');

    await user.click(join);
    await waitFor(() => expect(server.state.joins).toEqual(['INVITE1']));
    expect(await screen.findByText('Joined.')).toBeTruthy();
    expect(store.session.servers['guilds.example']).toBeTruthy();
  });

  it('renders a portal invite link as a card for the server the link names', async () => {
    const { server, store, user } = await bootDm();
    await openDm(server, store, user, 'come hang out https://telium.chat/invite/INVITE1@guilds.example');

    const join = await screen.findByRole('button', { name: 'Join Telium' });
    const card = join.closest('.invite-card');
    expect(card.textContent).toContain('2 members');

    await user.click(join);
    await waitFor(() => expect(server.state.joins).toEqual(['INVITE1']));
    expect(store.session.servers['guilds.example']).toBeTruthy();
  });

  it('shows the invite card for an invite posted in a guild channel', async () => {
    const server = createFakeServer();
    server.install();
    const store = freshStore();
    const user = userEvent.setup();
    render(<App store={store} />);
    await signIn(user, { home: HOME });
    await waitFor(() => expect(store.signedIn).toBe(true));
    await act(async () => { await store.addServer('guilds.example'); });
    await user.click(await screen.findByTitle('Telium on guilds.example'));
    await screen.findByText('first');

    act(() => {
      server.dispatch(GUILD, 'MESSAGE_CREATE', {
        id: 'm99',
        channel_id: 'c1',
        author: '@carol:home.example',
        content: 'bring the others https://guilds.example/invite/INVITE1',
        created_at: Date.now(),
      });
    });

    const join = await screen.findByRole('button', { name: 'Join Telium' });
    const card = join.closest('.invite-card');
    expect(card.textContent).toContain('2 members');

    expect(document.querySelector('.link-embed')).toBeNull();

    await user.click(join);
    await waitFor(() => expect(server.state.joins).toEqual(['INVITE1']));
  });
});
