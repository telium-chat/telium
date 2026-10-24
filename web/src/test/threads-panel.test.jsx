import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { ME, GUILD_DOMAIN, mount, signedInStore } from './harness.jsx';
import { ThreadsButton } from '../views/dialogs/ThreadsDialog.jsx';

const OWNER = '18446744073709551615';
const BOB = '@bob:home.example';
const HOUR = 60 * 60 * 1000;

const thread = (id, title, over = {}) => ({
  id, title, parent_id: 'c-general', guild_id: 'g1', owner: BOB,
  archived: false, locked: false, pinned: false, message_count: 2,
  last_active: Date.now() - HOUR, created_at: Date.now() - 2 * HOUR, ...over,
});

const ACTIVE = [thread('t1', 'Release planning'), thread('t2', 'Bug triage', { owner: ME })];
const ARCHIVED = [thread('t3', 'Old launch notes', { archived: true })];

function storeWith({ permissions = OWNER, cached = null, pending = false } = {}) {
  const store = signedInStore({
    guilds: [{
      id: 'g1',
      name: 'Telium',
      domain: GUILD_DOMAIN,
      channels: [{ id: 'c-general', name: 'general', type: 'text', position: 0, parent_id: null }],
      roles: [{ id: 'g1', name: '@everyone', permissions: '0' }],
      me: { user_id: ME, roles: [], permissions },
    }],
    members: { g1: [{ user_id: BOB, display_name: 'Bob', roles: [] }] },
    threads: cached ? { 'c-general': cached } : {},
    route: { guildId: 'g1', channelId: 'c-general' },
  });
  const api = {
    threads: vi.fn((_, archived) => (pending
      ? new Promise(() => {})
      : Promise.resolve({ threads: archived ? ARCHIVED : ACTIVE }))),
    createThread: vi.fn(async (_, body) => thread('t9', body.title, { owner: ME })),
  };
  store.apiForChannel = () => api;
  store.navigate = vi.fn();
  return { store, api };
}

async function open(store) {
  const view = mount(<ThreadsButton channelId="c-general" />, store);
  const button = screen.getByRole('button', { name: 'Threads' });
  await view.user.click(button);
  const panel = await screen.findByRole('dialog', { name: 'Threads' });
  return { ...view, button, panel };
}

describe('the threads panel', () => {
  it('hangs from the button, lists active then archived, and gives the caret back', async () => {
    const { store } = storeWith();
    const { user, button, panel } = await open(store);

    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(within(panel).getByRole('searchbox', { name: 'Search threads' }));

    const active = await within(panel).findByRole('region', { name: 'Active' });
    const archived = within(panel).getByRole('region', { name: 'Archived' });
    expect(within(active).getByText('Release planning')).toBeTruthy();
    expect(within(active).getByText('Bug triage')).toBeTruthy();
    expect(within(archived).getByText('Old launch notes')).toBeTruthy();
    expect(within(active).getAllByText('Bob').length).toBeGreaterThan(0);
    expect(within(active).getAllByText(/^Last active /).length).toBe(2);

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Threads' })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(button));
  });

  it('filters by name as you type, with one line when nothing matches', async () => {
    const { store } = storeWith();
    const { user, panel } = await open(store);
    await within(panel).findByText('Release planning');

    await user.keyboard('triage');
    expect(within(panel).queryByText('Release planning')).toBeNull();
    expect(within(panel).getByText('Bug triage')).toBeTruthy();
    expect(within(panel).queryByRole('region', { name: 'Archived' })).toBeNull();

    await user.keyboard('zzz');
    expect(within(panel).getByText('No threads match.')).toBeTruthy();
  });

  it('draws the threads it already holds without waiting for the server', async () => {
    const { store } = storeWith({ cached: [ACTIVE[0]], pending: true });
    const { panel } = await open(store);
    expect(within(panel).getByText('Release planning')).toBeTruthy();
    expect(within(panel).queryByRole('status', { name: 'Loading threads' })).toBeNull();
  });

  it('opens a thread from its card, by pointer or by arrow and Enter', async () => {
    const { store } = storeWith();
    const { user, panel } = await open(store);
    await within(panel).findByText('Release planning');

    await user.keyboard('{ArrowDown}');
    expect(document.activeElement.textContent).toContain('Release planning');
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement.textContent).toContain('Bug triage');
    await user.keyboard('{Enter}');

    expect(store.navigate).toHaveBeenCalledWith({ channelId: 't2' });
    expect(store.channels.get('t2')).toMatchObject({ type: 'thread', parent_id: 'c-general', name: 'Bug triage' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Threads' })).toBeNull());
  });

  it('starts a thread through the same prompt a message uses', async () => {
    const { store, api } = storeWith();
    const { user, panel } = await open(store);
    await user.click(within(panel).getByRole('button', { name: 'Create' }));

    const prompt = await screen.findByRole('dialog', { name: 'Start a thread' });
    await user.type(within(prompt).getByLabelText('Thread title'), 'Roadmap');
    await user.click(within(prompt).getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(api.createThread).toHaveBeenCalledWith('c-general', { title: 'Roadmap' }));
    await waitFor(() => expect(store.navigate).toHaveBeenCalledWith({ channelId: 't9' }));
  });

  it('offers no Create to a member who cannot start one', async () => {
    const { store } = storeWith({ permissions: '0' });
    const { panel } = await open(store);
    await within(panel).findByText('Release planning');
    expect(within(panel).queryByRole('button', { name: 'Create' })).toBeNull();
  });
});
