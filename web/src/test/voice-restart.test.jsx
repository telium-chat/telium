import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { createFakeServer, HOME } from './fake-server.js';
import { signedInApp } from './harness.jsx';
import { stubMedia } from './fake-webrtc.js';

vi.mock('../lib/platform.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    subscribeAndroidCallControls: (listener) => {
      const onControl = (event) => listener(String(event?.detail || ''));
      window.addEventListener('telium:android-call-control', onControl);
      return () => window.removeEventListener('telium:android-call-control', onControl);
    },
  };
});

const ME = '@alice:home.example';
const CAROL = '@carol:other.example';
const HOME_HOST = new URL(HOME).host;

const dock = (name) => within(screen.getByRole('toolbar', { name: 'Call controls' }))
  .getByRole('button', { name });

async function inACall() {
  stubMedia();
  const server = createFakeServer({
    conversations: [{
      id: 'dm1', kind: 'dm', sequencer: 'home.example', epoch: 1, last_seq: 0,
      members: [
        { user_id: ME, state: 'joined' },
        { user_id: CAROL, state: 'joined' },
      ],
    }],
  });
  const { store, user } = await signedInApp(server);
  await waitFor(() => expect(store.mls).toBeTruthy());
  await user.click(await screen.findByTitle('Direct messages'));
  await user.click(await screen.findByText('carol'));
  await user.click(await screen.findByTitle('Start a call'));
  await waitFor(() => expect(server.state.calls.get('dm1')).toHaveLength(1));
  expect(dock('Disconnect')).toBeTruthy();
  return { server, store, user };
}

const identifies = (server) => server.framesFor(HOME).filter((f) => f.op === 'IDENTIFY');

function restart(server, { honoured }) {
  server.state.reclaimsVoice = honoured;
  if (!honoured) server.state.calls.set('dm1', []);
  const open = server.state.sockets.filter((s) => (
    s.readyState === 1 && new URL(s.url.replace(/^ws/, 'http')).host === HOME_HOST
  ));
  expect(open.length).toBeGreaterThan(0);
  for (const socket of open) {
    socket.readyState = 3;
    socket.onclose?.({ code: 1006, reason: 'the server was replaced' });
  }
}

describe('a call across a homeserver restart', () => {
  it('tells the server which call it is still in, by the session it was given', async () => {
    const { server } = await inACall();
    const before = identifies(server).length;

    restart(server, { honoured: true });
    await waitFor(
      () => expect(identifies(server).length).toBe(before + 1),
      { timeout: 4000 },
    );

    const claim = identifies(server).at(-1).d.voice;
    expect(claim).toEqual([{ room_id: 'dm1', session_id: 'cs1' }]);
  });

  it('does nothing at all when the seat was still there', async () => {
    const { server } = await inACall();

    restart(server, { honoured: true });
    await waitFor(() => expect(identifies(server).length).toBeGreaterThan(1), { timeout: 4000 });

    await new Promise((r) => { setTimeout(r, 200); });
    expect(server.state.callJoins).toHaveLength(1);
    expect(screen.getByRole('toolbar', { name: 'Call controls' })).toBeTruthy();
    expect(document.querySelector(`[data-user="${ME}"]`)).toBeTruthy();
  });

  it('reads the roster again when the seat held, and dials whoever joined meanwhile', async () => {
    const { server } = await inACall();
    expect(document.querySelector(`[data-user="${CAROL}"]`)).toBeNull();

    server.state.calls.get('dm1').push({ user_id: CAROL, conversation_id: 'dm1', channel_id: 'dm1' });
    restart(server, { honoured: true });

    await waitFor(
      () => expect(document.querySelector(`[data-user="${CAROL}"]`)).toBeTruthy(),
      { timeout: 4000 },
    );
    expect(server.state.callJoins).toHaveLength(1);
  });

  it('joins again when it cannot follow the call to where it moved', async () => {
    const { server } = await inACall();
    const fetchImpl = globalThis.fetch;
    let refused = 0;
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      if (String(url).endsWith('/conversations/dm1/voice/server') && refused === 0) {
        refused += 1;
        return new Response(JSON.stringify({ error: 'unavailable' }), { status: 503 });
      }
      return fetchImpl(url, init);
    }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    server.dispatch(HOME, 'VOICE_SERVER_UPDATE', {
      channel_id: 'dm1', conversation_id: 'dm1', generation: 1, mode: 'mesh',
    });

    await waitFor(() => expect(refused).toBe(1));
    await waitFor(() => expect(server.state.callJoins).toHaveLength(2), { timeout: 4000 });
    expect(screen.getByRole('toolbar', { name: 'Call controls' })).toBeTruthy();
    warn.mockRestore();
    vi.unstubAllGlobals();
  });

  it('takes its seat back when the restart outran the grace window', async () => {
    const { server } = await inACall();

    restart(server, { honoured: false });

    await waitFor(() => expect(server.state.callJoins).toHaveLength(2), { timeout: 4000 });
    await waitFor(() => expect(server.state.calls.get('dm1')).toEqual([
      expect.objectContaining({ user_id: ME, conversation_id: 'dm1' }),
    ]));
    expect(screen.getByRole('toolbar', { name: 'Call controls' })).toBeTruthy();
    expect(document.querySelector(`[data-user="${ME}"]`)).toBeTruthy();
  });

  it('stops claiming a call once it has been left', async () => {
    const { server, user } = await inACall();
    await user.click(dock('Disconnect'));
    await waitFor(() => expect(server.state.calls.get('dm1')).toEqual([]));
    const before = identifies(server).length;

    restart(server, { honoured: true });
    await waitFor(
      () => expect(identifies(server).length).toBe(before + 1),
      { timeout: 4000 },
    );
    expect(identifies(server).at(-1).d.voice).toEqual([]);
  });

  it('leaves the Telium voice session when Android Telecom disconnects it', async () => {
    const { server } = await inACall();

    window.dispatchEvent(new CustomEvent('telium:android-call-control', {
      detail: 'disconnect',
    }));

    await waitFor(() => expect(server.state.calls.get('dm1')).toEqual([]));
    expect(screen.queryByRole('toolbar', { name: 'Call controls' })).toBeNull();
  });

  it('applies mute and deafen controls from the Android ongoing-call notification', async () => {
    await inACall();

    window.dispatchEvent(new CustomEvent('telium:android-call-control', {
      detail: 'toggle_mute',
    }));
    await waitFor(() => expect(dock('Unmute')).toBeTruthy());

    window.dispatchEvent(new CustomEvent('telium:android-call-control', {
      detail: 'toggle_deafen',
    }));
    await waitFor(() => expect(dock('Undeafen')).toBeTruthy());
  });
});
