import { describe, expect, it } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import { createFakeServer, GUILD } from './fake-server.js';
import { signedInApp } from './harness.jsx';

const ME = '@alice:home.example';

const TAGS = [
  { id: 'tag-bug', name: 'Bug', emoji: null, moderated: false },
  { id: 'tag-idea', name: 'Idea', emoji: null, moderated: false },
  { id: 'tag-solved', name: 'Solved', emoji: null, moderated: true },
];

async function boot(overrides = {}) {
  const server = createFakeServer(overrides);
  server.state.guild.channels.push({
    id: 'f1',
    name: 'help',
    type: 'forum',
    permission_overwrites: [],
    available_tags: TAGS,
    default_sort: 'activity',
    default_layout: 'list',
  });
  const { store, user } = await signedInApp(server);
  await act(async () => { await store.addServer('guilds.example'); });
  await user.click(await screen.findByTitle('Telium on guilds.example'));
  return { server, store, user };
}

async function openBoard(store, user) {
  store.navigate({ view: 'chat', channelId: 'c1' });
  await user.click(await screen.findByText('help'));
}

function seedPost(server, over = {}) {
  const id = over.id || `t${(server.state.threads.get('f1') || []).length + 1}`;
  const now = over.created_at || Date.now();
  const post = {
    id,
    parent_id: 'f1',
    guild_id: 'g1',
    owner: ME,
    title: 'A post',
    tags: [],
    archived: false,
    locked: false,
    pinned: false,
    message_count: 3,
    last_active: now,
    created_at: now,
    opening: {
      id: `m${id}`,
      channel_id: id,
      guild_id: 'g1',
      author: ME,
      content: 'The body of it',
      attachments: [],
      created_at: now,
    },
    ...over,
  };
  const list = server.state.threads.get('f1') || [];
  server.state.threads.set('f1', [...list, post]);
  server.state.messages.push(post.opening);
  return post;
}

describe('a forum channel', () => {
  it('draws a board of posts with their bodies, and opens one into its thread', async () => {
    const { server, store, user } = await boot();
    seedPost(server, {
      id: 't1', title: 'Cannot join a call', tags: ['tag-bug'], message_count: 4,
    });
    seedPost(server, { id: 't2', title: 'Threads in the sidebar', tags: ['tag-idea'] });
    await openBoard(store, user);

    const card = await screen.findByRole('button', { name: 'Cannot join a call' });
    expect(within(card).getByText('The body of it')).toBeTruthy();
    expect(within(card).getByText('Bug')).toBeTruthy();
    expect(within(card).getByText('4 messages')).toBeTruthy();

    await user.click(card);
    await waitFor(() => expect(store.route.channelId).toBe('t1'));
    expect(await screen.findByTitle('Back to help')).toBeTruthy();
    expect(await screen.findByText('The body of it')).toBeTruthy();
  });

  it('filters by tag and re-sorts without asking the server for a body twice', async () => {
    const { server, store, user } = await boot();
    seedPost(server, {
      id: 't1', title: 'Old but busy', tags: ['tag-bug'], created_at: 1_000, last_active: 9_000,
    });
    seedPost(server, {
      id: 't2', title: 'New and quiet', tags: ['tag-idea'], created_at: 8_000, last_active: 2_000,
    });
    await openBoard(store, user);

    const titles = () => [...document.querySelectorAll('[data-post]')]
      .map((n) => n.getAttribute('aria-label'));

    await screen.findByRole('button', { name: 'Old but busy' });
    expect(titles()).toEqual(['Old but busy', 'New and quiet']);

    await user.click(screen.getByLabelText('Sort posts'));
    await user.click(within(await screen.findByRole('listbox')).getByRole('option', { name: 'Date posted' }));
    await waitFor(() => expect(titles()).toEqual(['New and quiet', 'Old but busy']));

    await user.click(screen.getByRole('button', { name: 'Bug' }));
    await waitFor(() => expect(titles()).toEqual(['Old but busy']));
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    await waitFor(() => expect(titles()).toHaveLength(2));
  });

  it('writes a new post as a title, tags and a first message in one request', async () => {
    const { server, store, user } = await boot();
    await openBoard(store, user);

    await user.click(await screen.findByRole('button', { name: 'New Post' }));
    await user.type(await screen.findByLabelText('Title'), 'How do I federate?');
    await user.type(screen.getByLabelText('Message'), 'Two servers, one guild.');
    await user.click(screen.getByRole('button', { name: /Idea/ }));
    await user.click(screen.getByRole('button', { name: 'Post' }));

    await waitFor(() => expect(server.state.threads.get('f1')?.length).toBe(1));
    const post = server.state.threads.get('f1')[0];
    expect(post.title).toBe('How do I federate?');
    expect(post.tags).toEqual(['tag-idea']);
    expect(post.opening.content).toBe('Two servers, one guild.');
    expect(post.opening.channel_id).toBe(post.id);
    await waitFor(() => expect(store.route.channelId).toBe(post.id));
  });

  it('pins a post above the sort order and deletes it back off the board', async () => {
    const { server, store, user } = await boot();
    seedPost(server, { id: 't1', title: 'Read me first', last_active: 1_000 });
    seedPost(server, { id: 't2', title: 'Something newer', last_active: 9_000 });
    await openBoard(store, user);
    await screen.findByText('Read me first');

    await store.apiForChannel('f1').patchThread('t1', { pinned: true });
    const list = store.threads.get('f1');
    store.threads.set('f1', list.map((t) => (t.id === 't1' ? { ...t, pinned: true } : t)));
    store.emit('threads', 'f1');
    await waitFor(() => expect(server.state.threads.get('f1')
      .find((t) => t.id === 't1').pinned).toBe(true));

    await store.apiForChannel('f1').deleteThread('t2');
    store.dropThread('f1', 't2');
    await waitFor(() => expect(
      screen.queryByRole('button', { name: 'Something newer' }),
    ).toBeNull());
    expect(server.state.threads.get('f1').some((t) => t.id === 't2')).toBe(false);
  });
  it('draws the emoji in a body rather than the token standing for one', async () => {
    const { server, store, user } = await boot();
    seedPost(server, {
      id: 't1',
      title: 'Ship it',
      opening: {
        id: 'mt1',
        channel_id: 't1',
        guild_id: 'g1',
        author: ME,
        content: '**Shipping** <fatdog:01M2RD1VD19N3BAJ53KX0BQ1XR> \u{1F389}',
        attachments: [],
        created_at: Date.now(),
      },
    });
    await openBoard(store, user);

    const card = await screen.findByRole('button', { name: 'Ship it' });
    expect(within(card).getByAltText(':fatdog:')).toBeTruthy();
    expect(within(card).getByAltText('\u{1F389}')).toBeTruthy();
    expect(card.textContent).not.toContain('01M2RD');
    expect(card.textContent).not.toContain('**');
    expect(within(card).getByText('Shipping').closest('strong')).toBeTruthy();
  });

  it('takes a post off the board when the server says it has archived', async () => {
    const { server, store, user } = await boot();
    seedPost(server, { id: 't1', title: 'Still going' });
    seedPost(server, { id: 't2', title: 'Gone quiet' });
    await openBoard(store, user);
    await screen.findByRole('button', { name: 'Gone quiet' });

    const row = server.state.threads.get('f1').find((t) => t.id === 't2');
    await act(async () => {
      server.dispatch(GUILD, 'THREAD_UPDATE', { ...row, archived: true });
    });

    await waitFor(() => expect(
      screen.queryByRole('button', { name: 'Gone quiet' }),
    ).toBeNull());
    expect(screen.getByRole('button', { name: 'Still going' })).toBeTruthy();
    expect(store.threads.get('f1').find((t) => t.id === 't2')?.archived).toBe(true);
  });
});
