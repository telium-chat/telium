import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BotsPane } from '../views/guild-settings/BotsPane.jsx';

const PING = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const PONG = '01BX5ZZKBKACTAV9WEVGEMMVRZ';

const descriptor = (id, over) => ({
  application_id: id,
  application_origin: 'bots.example',
  name: id === PING ? 'Ping Bot' : 'Pong Bot',
  description: 'Replies.',
  bot_user_id: `@${id === PING ? 'ping' : 'pong'}:bots.example`,
  install_enabled: true,
  allowed_intent_names: ['GUILD_MESSAGES'],
  default_permission_names: ['VIEW_CHANNEL', 'SEND_MESSAGES'],
  ...over,
});

describe('the install card never shows the application it is not about to install', () => {
  it('clears the previous review the moment the reference changes, not only when it stops parsing', async () => {
    let releasePong;
    const api = {
      get: vi.fn().mockResolvedValue({ bots: [] }),
      post: vi.fn(async (path, body) => {
        if (!path.endsWith('/bots/preview')) throw new Error(`unexpected POST ${path}`);
        if (body.application_id === PING) return descriptor(PING);
        return new Promise((resolve) => { releasePong = () => resolve(descriptor(PONG)); });
      }),
      patch: vi.fn(),
      del: vi.fn(),
    };

    render(<BotsPane guildId="guild-1" api={api} />);
    const field = screen.getByLabelText('Application reference');

    fireEvent.change(field, { target: { value: `bots.example/${PING}` } });
    await screen.findByRole('button', { name: 'Install Ping Bot' });
    expect(screen.getByText('@ping:bots.example')).toBeTruthy();

    fireEvent.change(field, { target: { value: `bots.example/${PONG}` } });

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Install Ping Bot' })).toBeNull();
    });
    expect(screen.queryByText('@ping:bots.example')).toBeNull();
    expect(screen.queryByRole('checkbox', { name: 'Send Messages' })).toBeNull();

    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
    await act(async () => { releasePong(); });
    await screen.findByRole('button', { name: 'Install Pong Bot' });
  });
});

describe('the edit list distinguishes what is held from what may be granted', () => {
  const installed = {
    bot_user_id: '@ping:bots.example',
    application_id: PING,
    application_origin: 'bots.example',
    display_name: 'Ping Bot',
    allowed_intent_names: ['GUILD_MESSAGES'],
    permission_names: ['SEND_MESSAGES', 'MANAGE_MESSAGES'],
  };

  const paneWith = (over) => {
    const api = {
      get: vi.fn().mockResolvedValue({ bots: [{ ...installed, ...over?.bot }] }),
      post: vi.fn(async (path) => {
        if (!path.endsWith('/bots/preview')) throw new Error(`unexpected POST ${path}`);
        return descriptor(PING, over?.descriptor);
      }),
      patch: vi.fn().mockResolvedValue({ ok: true }),
      del: vi.fn(),
    };
    render(<BotsPane guildId="guild-1" api={api} />);
    return api;
  };

  it('shows a withdrawn permission, lets it be surrendered, and will not offer it back', async () => {
    const api = paneWith({ descriptor: { default_permission_names: ['SEND_MESSAGES'] } });

    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    const managed = await screen.findByRole('checkbox', { name: 'Manage Messages' });

    await waitFor(() => expect(screen.getByText('no longer offered')).toBeTruthy());
    expect(managed.getAttribute('aria-checked')).toBe('true');
    expect(managed.getAttribute('aria-disabled')).not.toBe('true');

    fireEvent.click(managed);
    expect(managed.getAttribute('aria-checked')).toBe('false');

    await waitFor(() => expect(managed.getAttribute('aria-disabled')).toBe('true'));

    fireEvent.click(screen.getByRole('button', { name: 'Save grants' }));
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith(
      '/_telium/v1/guilds/guild-1/bots/%40ping%3Abots.example',
      { intents: ['GUILD_MESSAGES'], permissions: ['SEND_MESSAGES'] },
    ));
  });

  it('carries a capability this build has never heard of through an unrelated edit', async () => {
    const api = paneWith({
      bot: { permission_names: ['SEND_MESSAGES', 'SUMMON_MEMBERS'] },
      descriptor: { default_permission_names: ['SEND_MESSAGES', 'SUMMON_MEMBERS'] },
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    const unknown = await screen.findByRole('checkbox', { name: 'SUMMON_MEMBERS' });
    expect(unknown.getAttribute('aria-checked')).toBe('true');

    fireEvent.click(screen.getByRole('checkbox', { name: 'Send Messages' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save grants' }));

    await waitFor(() => expect(api.patch).toHaveBeenCalledWith(
      '/_telium/v1/guilds/guild-1/bots/%40ping%3Abots.example',
      { intents: ['GUILD_MESSAGES'], permissions: ['SUMMON_MEMBERS'] },
    ));
  });
});
