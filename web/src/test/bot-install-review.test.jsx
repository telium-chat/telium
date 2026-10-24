import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BotsPane } from '../views/guild-settings/BotsPane.jsx';

describe('bot installation review', () => {
  it('resolves a pasted application reference, prechecks requested capabilities, and lets the guild narrow them', async () => {
    const applicationId = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
    const api = {
      get: vi.fn().mockResolvedValue({ bots: [] }),
      post: vi.fn(async (path, body) => {
        if (path.endsWith('/bots/preview')) {
          return {
            application_id: body.application_id,
            application_origin: body.application_origin,
            name: 'Ping Bot',
            description: 'Replies to ping.',
            bot_user_id: '@ping:bots.example',
            install_enabled: true,
            allowed_intent_names: ['GUILD_MESSAGES', 'MESSAGE_CONTENT'],
            default_permission_names: ['VIEW_CHANNEL', 'SEND_MESSAGES'],
          };
        }
        if (path.endsWith('/bots')) return { ok: true };
        throw new Error(`unexpected POST ${path}`);
      }),
      patch: vi.fn(),
      del: vi.fn(),
    };

    render(<BotsPane guildId="guild-1" api={api} />);

    fireEvent.change(screen.getByLabelText('Application reference'), {
      target: { value: `bots.example/${applicationId}` },
    });

    await waitFor(() => expect(api.post).toHaveBeenCalledWith(
      '/_telium/v1/guilds/guild-1/bots/preview',
      {
        application_id: applicationId,
        application_origin: 'bots.example',
      },
    ));

    const messages = await screen.findByRole('checkbox', { name: 'Messages' });
    const content = screen.getByRole('checkbox', { name: 'Message content' });
    const view = screen.getByRole('checkbox', { name: 'View Channels' });
    const send = screen.getByRole('checkbox', { name: 'Send Messages' });

    expect(messages.getAttribute('aria-checked')).toBe('true');
    expect(content.getAttribute('aria-checked')).toBe('true');
    expect(view.getAttribute('aria-checked')).toBe('true');
    expect(send.getAttribute('aria-checked')).toBe('true');

    fireEvent.click(content);
    expect(content.getAttribute('aria-checked')).toBe('false');

    fireEvent.click(screen.getByRole('button', { name: 'Install Ping Bot' }));

    await waitFor(() => expect(api.post).toHaveBeenCalledWith(
      '/_telium/v1/guilds/guild-1/bots',
      {
        application_id: applicationId,
        application_origin: 'bots.example',
        intents: ['GUILD_MESSAGES'],
        permissions: ['VIEW_CHANNEL', 'SEND_MESSAGES'],
      },
    ));
  });
});
