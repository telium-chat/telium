import { describe, expect, it } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
import { createFakeServer } from './fake-server.js';
import { signedInApp } from './harness.jsx';

describe('The mini profile card', () => {
  it('closes when the control that opened it is clicked again', async () => {
    const server = createFakeServer();
    const { store, user } = await signedInApp(server);
    await act(async () => { await store.addServer('guilds.example'); });
    await user.click(await screen.findByTitle('Telium on guilds.example'));
    await screen.findByText('first');

    const [opener] = await screen.findAllByRole('button', { name: /^Open profile/ });
    await user.click(opener);
    await screen.findByLabelText('Profile');

    await user.click(opener);
    await waitFor(() => expect(screen.queryByLabelText('Profile')).toBeNull());
  });
});
