import { describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
import { createFakeServer, GUILD } from './fake-server.js';
import { signedInApp } from './harness.jsx';
import { FakePC, stubMedia } from './fake-webrtc.js';

const ME = '@alice:home.example';
const CARA = '@cara:home.example';

const callLog = () => globalThis.fetch.mock.calls
  .map(([url, init]) => ({ url: String(url), method: init?.method || 'GET' }));

const joins = () => callLog().filter((c) => c.url.endsWith('/channels/c2/voice/join')).length;

async function inLounge() {
  stubMedia();
  const server = createFakeServer();
  const { store, user } = await signedInApp(server);
  await act(async () => { await store.addServer('guilds.example'); });
  await screen.findByTitle('Telium on guilds.example');

  server.state.voiceStates.push({ user_id: CARA, channel_id: 'c2' });
  await user.click(await screen.findByTitle('Telium on guilds.example'));
  await user.click(await screen.findByText('lounge'));
  await waitFor(() => expect(joins()).toBeGreaterThan(0));
  await waitFor(() => expect(FakePC.all.length).toBeGreaterThan(0));

  // Watch the HTTP traffic from here on: the fake server's own fetch stub is
  // the inner layer, so a wrapper sees every request the app makes.
  const inner = globalThis.fetch;
  vi.stubGlobal('fetch', vi.fn(async (url, init) => inner(url, init)));
  return { server, store, user };
}

describe('a seat the server ended', () => {
  it('checks the server and hangs up when the seat is really gone', async () => {
    const { server } = await inLounge();

    server.state.voiceStates = server.state.voiceStates.filter((v) => v.user_id !== ME);
    await act(async () => {
      server.dispatch(GUILD, 'VOICE_STATE_UPDATE', {
        guild_id: 'g1', channel_id: null, user_id: ME,
      });
    });

    await waitFor(() => expect(callLog().some((c) => c.url.endsWith('/channels/c2/voice/leave'))).toBe(true));
    await waitFor(() => expect(
      screen.queryByRole('toolbar', { name: 'Call controls' }),
    ).toBeNull());
  });

  it('stays in the call when the server still holds the seat', async () => {
    const { server } = await inLounge();

    // The roster frame says gone; the server's own answer contradicts it.
    await act(async () => {
      server.dispatch(GUILD, 'VOICE_STATE_UPDATE', {
        guild_id: 'g1', channel_id: null, user_id: ME,
      });
    });
    await waitFor(() => expect(
      callLog().some((c) => c.url.endsWith('/channels/c2/voice') && c.method === 'GET'),
    ).toBe(true));
    await act(async () => {});
    expect(callLog().some((c) => c.url.endsWith('/channels/c2/voice/leave'))).toBe(false);
  });
});

describe('a voice server that asks to reconnect', () => {
  it('joins again and keeps the call up', async () => {
    const { server } = await inLounge();
    const before = joins();

    await act(async () => {
      server.dispatch(GUILD, 'VOICE_SERVER_UPDATE', {
        guild_id: 'g1', channel_id: 'c2', reconnect: true,
      });
    });

    await waitFor(() => expect(joins()).toBeGreaterThan(before));
    expect(screen.getByRole('toolbar', { name: 'Call controls' })).toBeTruthy();
  });
});
