import { describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../App.jsx';
import { Store } from '../lib/store.js';
import { createFakeServer, HOME } from './fake-server.js';
import { signIn } from './sign-in.js';

describe('emoji picker', () => {
  it('opens with custom emoji, a default guild icon, and custom recents', async () => {
    const logged = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...a) => logged.push(a.join(' ')));
    const server = createFakeServer();
    server.state.expressionLatency = 3000;
    server.state.emojis = [
      { kind: 'emoji', id: 'e1', guild_id: 'g1', name: 'party', animated: false },
    ];
    server.install();
    const store = new Store();
    const user = userEvent.setup();
    render(<App store={store} />);
    await signIn(user, { home: HOME });
    await waitFor(() => expect(store.signedIn).toBe(true));
    await act(async () => { await store.addServer('guilds.example'); });
    await user.click(await screen.findByTitle('Telium on guilds.example'));
    await user.click(await screen.findByRole('button', { name: 'general' }));

    await user.click(await screen.findByTitle('Emoji'));
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(within(dialog).getByText('Telium emoji')).toBeTruthy(), { timeout: 8000 });
    expect(server.state.expressionRequests).toHaveLength(1);
    expect(within(dialog).getByRole('button', { name: 'Telium emoji' }).querySelector('[title="g1"]'))
      .toBeTruthy();
    expect(within(dialog).getByAltText(':party:')).toBeTruthy();

    await user.click(within(dialog).getByAltText(':party:'));
    await user.click(screen.getByTitle('Emoji'));
    const reopened = await screen.findByRole('dialog');
    await waitFor(() => expect(within(reopened).getAllByAltText(':party:').length).toBeGreaterThan(1));
    expect(server.state.expressionRequests).toHaveLength(1);

    expect(logged.filter((e) => !/not wrapped in act|no route for/.test(e))).toEqual([]);
    spy.mockRestore();
  });
});
