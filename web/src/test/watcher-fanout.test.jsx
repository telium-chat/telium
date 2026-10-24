import { describe, expect, it } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
import { createFakeServer, GUILD } from './fake-server.js';
import { signedInApp } from './harness.jsx';
import { FakePC, stubMedia } from './fake-webrtc.js';

const ME = '@alice:home.example';
const BOB = '@bob:home.example';
const CARA = '@cara:home.example';

async function inLounge() {
  stubMedia();
  const server = createFakeServer();
  const { store, user } = await signedInApp(server);
  await act(async () => { await store.addServer('guilds.example'); });
  await screen.findByTitle('Telium on guilds.example');

  server.state.voiceStates.push({ user_id: BOB, channel_id: 'c2', streaming: true });
  server.state.voiceStates.push({ user_id: CARA, channel_id: 'c2' });
  await user.click(await screen.findByTitle('Telium on guilds.example'));
  await user.click(await screen.findByText('lounge'));
  await waitFor(() => expect(FakePC.all.length).toBeGreaterThan(0));
  return { server, store, user };
}

const pile = () => screen.queryByRole('img', { name: /watching$/ })?.getAttribute('aria-label') ?? null;

const watchers = (server, rows) => act(async () => {
  server.dispatch(GUILD, 'VOICE_WATCHERS_UPDATE', {
    guild_id: 'g1', channel_id: 'c2', watchers: rows,
  });
});

describe('the watcher list', () => {
  it('shows a second watcher to the first one, with no refetch', async () => {
    const { server } = await inLounge();

    await watchers(server, [{ viewer: ME, streamer: BOB, quality: 'auto' }]);
    await waitFor(() => expect(pile()).toBe('1 person watching'));

    await watchers(server, [
      { viewer: ME, streamer: BOB, quality: 'auto' },
      { viewer: CARA, streamer: BOB, quality: 'auto' },
    ]);
    await waitFor(() => expect(pile()).toBe('2 people watching'));
  });

  it('takes a watcher off the list when they stop', async () => {
    const { server } = await inLounge();
    await watchers(server, [
      { viewer: ME, streamer: BOB, quality: 'auto' },
      { viewer: CARA, streamer: BOB, quality: 'auto' },
    ]);
    await waitFor(() => expect(pile()).toBe('2 people watching'));

    await watchers(server, [{ viewer: ME, streamer: BOB, quality: 'auto' }]);
    await waitFor(() => expect(pile()).toBe('1 person watching'));
  });

  it('takes a watcher off the list when they disconnect', async () => {
    const { server } = await inLounge();
    await watchers(server, [
      { viewer: ME, streamer: BOB, quality: 'auto' },
      { viewer: CARA, streamer: BOB, quality: 'auto' },
    ]);
    await waitFor(() => expect(pile()).toBe('2 people watching'));

    await act(async () => {
      server.dispatch(GUILD, 'VOICE_STATE_UPDATE', {
        guild_id: 'g1', channel_id: null, user_id: CARA,
      });
    });
    await watchers(server, [{ viewer: ME, streamer: BOB, quality: 'auto' }]);
    await waitFor(() => expect(pile()).toBe('1 person watching'));
  });

  it('does not read a quality change as somebody new', async () => {
    const { server } = await inLounge();
    await watchers(server, [{ viewer: CARA, streamer: BOB, quality: 'auto' }]);
    await waitFor(() => expect(pile()).toBe('1 person watching'));

    await watchers(server, [{ viewer: CARA, streamer: BOB, quality: 'high' }]);
    await waitFor(() => expect(pile()).toBe('1 person watching'));

    await watchers(server, [{ viewer: CARA, streamer: BOB, quality: 'high' }]);
    await waitFor(() => expect(pile()).toBe('1 person watching'));
  });

  it('counts people rather than subscriptions', async () => {
    const { server } = await inLounge();

    await watchers(server, [
      { viewer: CARA, streamer: BOB, quality: 'auto' },
      { viewer: CARA, streamer: ME, quality: 'auto' },
    ]);
    await waitFor(() => expect(pile()).toBe('1 person watching'));
  });

  it('says nothing at all when the last watcher goes', async () => {
    const { server } = await inLounge();
    await watchers(server, [{ viewer: CARA, streamer: BOB, quality: 'auto' }]);
    await waitFor(() => expect(pile()).toBe('1 person watching'));

    await watchers(server, []);
    await waitFor(() => expect(pile()).toBeNull());
  });
});
