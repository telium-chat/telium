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

async function inLounge({ channels = [] } = {}) {
  stubMedia();
  const server = createFakeServer();
  server.state.guild.channels.push(...channels);
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

describe('the caller escaping a bridged outage', () => {
  it('stands the retake ladder down when they join another channel', async () => {
    const { store, user } = await inLounge({
      channels: [{ id: 'c4', name: 'stage', type: 'voice', permission_overwrites: [] }],
    });

    // The lounge's join now answers 503 — an SFU mid-restart, the case the
    // ladder bridges for. The next drop sends the seat into the ladder, whose
    // first rung is three seconds out.
    const inner = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      if (String(url).endsWith('/channels/c2/voice/join')) {
        return new Response(null, { status: 503 });
      }
      return inner(url, init);
    }));
    await act(async () => {
      store.emit('voice-reclaim', { domain: store.voiceDomain('c2'), rooms: new Set() });
    });
    await waitFor(() => expect(joins(), 'the ladder’s first attempt failed').toBe(2), { timeout: 5000 });

    // The caller gives up on the lounge and joins the stage instead. A
    // successful join sets `channelRef` without touching the ladder's abort
    // flag, so the rung that wakes must stand down — not tear this call down
    // and re-dial the channel that is down. The count is captured at once:
    // the next rung is still ~3s out (the first attempt only just failed),
    // so any join logged after this point belongs to a wake.
    await user.click(await screen.findByText('stage'));
    await waitFor(() => expect(
      callLog().some((c) => c.url.endsWith('/channels/c4/voice/join')),
    ).toBe(true), { timeout: 5000 });
    await waitFor(() => expect(screen.getByRole('toolbar', { name: 'Call controls' })).toBeTruthy(), { timeout: 5000 });
    // Baseline only once the stage call is fully up: a wake before this point
    // finds no other channel to protect and may attempt the lounge once more,
    // which is harmless. Any attempt after this point re-dials a channel the
    // caller walked away from.
    const loungeJoins = joins();

    // Long enough to contain a wake plus the harness's own join latency; the
    // next rung after that is six seconds out, so exactly one wake lands here.
    await act(async () => { await new Promise((r) => setTimeout(r, 7000)); });
    expect(joins()).toBe(loungeJoins, 'no further attempts on the channel that is down');
    expect(screen.getByRole('toolbar', { name: 'Call controls' })).toBeTruthy();
  }, 25_000);
});
