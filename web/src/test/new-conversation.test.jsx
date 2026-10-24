import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { createFakeServer } from './fake-server.js';
import { signedInApp } from './harness.jsx';

const row = (userId, state, displayName = null) => ({
  user_id: userId,
  domain: userId.split(':')[1],
  state,
  presence: state === 'accepted' ? { user_id: userId, status: 'online' } : null,
  display_name: displayName,
  avatar_ref: null,
});

const BOB = '@bob:home.example';
const CAROL = '@carol:other.example';

async function boot(friends = []) {
  const server = createFakeServer({ friends });
  const { store, user } = await signedInApp(server);
  await user.click(await screen.findByTitle('Direct messages'));
  await user.click(await screen.findByTitle('New conversation'));
  await screen.findByRole('dialog');
  return { server, store, user };
}

describe('the new conversation dialog', () => {
  it('says the conversation is encrypted in one short line, not the essay', async () => {
    await boot();

    expect(await screen.findByText('End-to-end encrypted')).toBeTruthy();
    expect(screen.queryByText('End-to-end encrypted with MLS.')).toBeNull();
    expect(screen.queryByText(/sequences these frames/)).toBeNull();
  });

  it('lists accepted friends and starts with whoever was picked', async () => {
    const { store, user } = await boot([
      row(BOB, 'accepted'),
      row(CAROL, 'accepted', 'Carol'),
      row('@erin:home.example', 'pending_in'),
    ]);

    expect(await screen.findByRole('option', { name: /bob/ })).toBeTruthy();
    expect(screen.getByRole('option', { name: /Carol/ })).toBeTruthy();
    expect(screen.queryByRole('option', { name: /erin/ })).toBeNull();

    const start = vi.spyOn(store, 'startConversation')
      .mockResolvedValue({ id: 'dm1', kind: 'dm' });

    await user.click(screen.getByRole('option', { name: /bob/ }));
    expect(screen.queryByRole('option', { name: /bob/ })).toBeNull();
    expect(screen.getByRole('button', { name: /^Remove bob/ })).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(start).toHaveBeenCalledWith([BOB], 'dm'));
  });

  it('pools a typed id and a picked friend into one member list', async () => {
    const { store, user } = await boot([row(BOB, 'accepted'), row(CAROL, 'accepted')]);
    const start = vi.spyOn(store, 'startConversation')
      .mockResolvedValue({ id: 'gc1', kind: 'gc' });

    const who = await screen.findByLabelText('Who');
    await user.type(who, `${CAROL}{Enter}`);
    await user.click(screen.getByRole('option', { name: /bob/ }));

    await user.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(start).toHaveBeenCalledWith([CAROL, BOB], 'gc'));
  });

  it('completes a bare name against your own home server', async () => {
    const { store, user } = await boot();
    const start = vi.spyOn(store, 'startConversation')
      .mockResolvedValue({ id: 'dm1', kind: 'dm' });

    await user.type(await screen.findByLabelText('Who'), 'bob{Enter}');
    expect(screen.getByRole('button', { name: /^Remove bob/ })).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(start).toHaveBeenCalledWith([BOB], 'dm'));
  });

  it('leaves an id that already names its server alone', async () => {
    const { store, user } = await boot();
    const start = vi.spyOn(store, 'startConversation')
      .mockResolvedValue({ id: 'dm1', kind: 'dm' });

    await user.type(await screen.findByLabelText('Who'), `${CAROL}{Enter}`);
    await user.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(start).toHaveBeenCalledWith([CAROL], 'dm'));
  });

  it('filters the list as you type and commits a row from the keyboard', async () => {
    const { store, user } = await boot([
      row(BOB, 'accepted'),
      row(CAROL, 'accepted', 'Carol'),
    ]);
    const start = vi.spyOn(store, 'startConversation')
      .mockResolvedValue({ id: 'dm1', kind: 'dm' });
    const who = await screen.findByLabelText('Who');

    await user.type(who, 'Car');
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(1));
    await user.keyboard('{Enter}');
    expect(who.value).toBe('');
    expect(screen.getByRole('button', { name: /^Remove Carol/ })).toBeTruthy();

    await user.keyboard('{Backspace}');
    expect(screen.queryByRole('button', { name: /^Remove Carol/ })).toBeNull();
    await user.type(who, 'o');
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(2));
    expect(screen.getAllByRole('option').some((o) => o.getAttribute('aria-selected') === 'true')).toBe(false);
    const first = screen.getAllByRole('option')[0].textContent;
    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}');
    expect(screen.getAllByRole('option')[0].getAttribute('aria-selected')).toBe('true');
    await user.keyboard('{Enter}');
    expect(screen.getByRole('button', { name: new RegExp(`^Remove ${first.includes('Carol') ? 'Carol' : 'bob'}`) })).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1));
  });

  it('drops the last chip on backspace in an empty field', async () => {
    const { user } = await boot([row(BOB, 'accepted')]);

    await user.type(await screen.findByLabelText('Who'), 'bob{Enter}');
    expect(screen.getByRole('button', { name: /^Remove bob/ })).toBeTruthy();

    await user.keyboard('{Backspace}');
    expect(screen.queryByRole('button', { name: /^Remove bob/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Start' }).hasAttribute('disabled')).toBe(true);
  });

  it('does not ask who will run the group', async () => {
    const { user } = await boot([row(BOB, 'accepted'), row(CAROL, 'accepted')]);

    await user.click(await screen.findByRole('option', { name: /bob/ }));
    await user.click(screen.getByRole('option', { name: /carol/ }));

    expect(screen.queryByText('Who can add and remove people')).toBeNull();
    expect(screen.queryByText('Anyone in the group')).toBeNull();
  });
});
