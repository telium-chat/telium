import { describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../App.jsx';
import { createFakeServer, freshStore, HOME } from './fake-server.js';
import { signedInApp } from './harness.jsx';
import { signIn } from './sign-in.js';
import { FakePC, stubMedia } from './fake-webrtc.js';

const ME = '@alice:home.example';
const CAROL = '@carol:other.example';

async function boot(overrides) {
  stubMedia();
  const server = createFakeServer({
    conversations: [{
      id: 'dm1', kind: 'dm', sequencer: 'home.example', epoch: 1, last_seq: 0,
      members: [
        { user_id: ME, state: 'joined' },
        { user_id: CAROL, state: 'joined' },
      ],
    }],
    ...overrides,
  });
  const { store, user } = await signedInApp(server);
  await waitFor(() => expect(store.mls).toBeTruthy());
  await user.click(await screen.findByTitle('Direct messages'));
  await user.click(await screen.findByText('carol'));
  return { server, store, user };
}

const dock = (name) => within(screen.getByRole('toolbar', { name: 'Call controls' }))
  .getByRole('button', { name });

const tileFor = (userId) => document.querySelector(`[data-user="${userId}"]`);

describe('calls in a conversation', () => {
  it('starts one from the header and puts the stage over the conversation', async () => {
    const { server, user } = await boot();

    await user.click(await screen.findByTitle('Start a call'));

    await waitFor(() => expect(server.state.calls.get('dm1')).toEqual([
      expect.objectContaining({ user_id: ME, conversation_id: 'dm1' }),
    ]));
    expect(server.state.calls.get('dm1')[0].guild_id).toBeUndefined();

    expect(tileFor(ME)).toBeTruthy();
    expect(dock('Mute')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/mesh/i);
    expect(screen.getByPlaceholderText(/Message/i)).toBeTruthy();

    expect(screen.getByTitle('Leave call')).toBeTruthy();

    await user.click(dock('Disconnect'));
    await waitFor(() => expect(server.state.calls.get('dm1')).toEqual([]));
    await waitFor(() => expect(screen.queryByRole('toolbar', { name: 'Call controls' })).toBeNull());
    expect(tileFor(ME)).toBeNull();
    expect(await screen.findByTitle('Start a call')).toBeTruthy();
  });

  it('shows the caller that they are ringing someone until somebody joins', async () => {
    const { server, store, user } = await boot();

    await user.click(await screen.findByTitle('Start a call'));
    await waitFor(() => expect(server.state.calls.get('dm1')).toHaveLength(1));

    expect(await screen.findByText('Ringing…')).toBeTruthy();
    expect(store.outgoingCalls.has('dm1')).toBe(true);

    act(() => store.onVoice({ user_id: CAROL, conversation_id: 'dm1', channel_id: 'dm1' }));
    await waitFor(() => expect(screen.queryByText('Ringing…')).toBeNull());
    expect(store.outgoingCalls.has('dm1')).toBe(false);
    expect(tileFor(CAROL)).toBeTruthy();
  });

  it('shows a call that is already running before joining it', async () => {
    const { user } = await boot({
      calls: new Map([['dm1', [{ user_id: CAROL, conversation_id: 'dm1', channel_id: 'dm1' }]]]),
    });

    await waitFor(() => expect(tileFor(CAROL)).toBeTruthy());
    expect(screen.queryByRole('toolbar', { name: 'Call controls' })).toBeNull();
    expect(screen.getByTitle('Join call')).toBeTruthy();

    await user.click(screen.getByText('Join call'));
    await waitFor(() => expect(FakePC.all).toHaveLength(1));
    expect(dock('Disconnect')).toBeTruthy();
    expect(tileFor(ME)).toBeTruthy();
    expect(FakePC.all[0].config.iceTransportPolicy).toBe('all');
  });

  it('asks for an SFU when its call privacy says so, and will not settle for a mesh', async () => {
    const { server, store, user } = await boot();
    store.setCallPrivacy('sfu', 'dm1');

    await user.click(await screen.findByTitle('Start a call'));
    await waitFor(() => expect(server.state.callJoins).toHaveLength(1));
    expect(server.state.callJoins[0]).toMatchObject({ wants_sfu: true, custom_sfu: false });
    expect(Object.values(server.state.callJoins[0])).not.toContain('sfu');

    expect(await screen.findByText(/asks for an SFU/)).toBeTruthy();
    await waitFor(() => expect(server.state.calls.get('dm1')).toEqual([]));
    expect(FakePC.all).toHaveLength(0);
    expect(screen.queryByRole('toolbar', { name: 'Call controls' })).toBeNull();
  });

  it('pins its connections to the relay when its call privacy asks for one', async () => {
    const turn = { urls: ['turn:turn.home.example:3478'], username: 'u', credential: 'c' };
    const { server, store, user } = await boot({
      callCaps: { relay: true, sfu: false, mesh_max_participants: 4, e2ee: 'mls-exporter' },
      callServer: (id) => ({
        mode: 'mesh',
        channel_id: id,
        conversation_id: id,
        max_participants: 4,
        generation: 0,
        host: null,
        relay: true,
        ice_servers: [turn],
      }),
      calls: new Map([['dm1', [{ user_id: CAROL, conversation_id: 'dm1', channel_id: 'dm1' }]]]),
    });
    await waitFor(() => expect(store.callCaps().relay).toBe(true));
    store.setCallPrivacy('relay', 'dm1');

    await waitFor(() => expect(tileFor(CAROL)).toBeTruthy());
    await user.click(screen.getByText('Join call'));
    await waitFor(() => expect(FakePC.all).toHaveLength(1));

    expect(server.state.callJoins[0]).toMatchObject({ wants_sfu: false });
    expect(FakePC.all[0].config.iceTransportPolicy).toBe('relay');
    expect(FakePC.all[0].config.iceServers).toEqual([turn]);
    expect(document.body.textContent).not.toMatch(/mesh/i);
  });

  it('answers the offers that arrive while its own join is still on the way', async () => {
    const AARON = '@aaron:home.example';
    const ZED = '@zed:home.example';
    stubMedia();
    const server = createFakeServer({
      conversations: [{
        id: 'g1', kind: 'group', name: 'the trio', sequencer: 'home.example', epoch: 1, last_seq: 0,
        members: [
          { user_id: ME, state: 'joined' },
          { user_id: AARON, state: 'joined' },
          { user_id: ZED, state: 'joined' },
        ],
      }],
      calls: new Map([['g1', [
        { user_id: AARON, conversation_id: 'g1', channel_id: 'g1' },
        { user_id: ZED, conversation_id: 'g1', channel_id: 'g1' },
      ]]]),
    });
    server.install();
    const store = freshStore();
    const user = userEvent.setup();
    render(<App store={store} />);
    await signIn(user, { home: HOME });
    await waitFor(() => expect(store.mls).toBeTruthy());
    await user.click(await screen.findByTitle('Direct messages'));
    await user.click(await screen.findByText('the trio'));
    await waitFor(() => expect(tileFor(AARON)).toBeTruthy());

    let answer;
    const held = new Promise((resolve) => { answer = resolve; });
    const fetchImpl = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      const response = await fetchImpl(url, init);
      if (String(url).endsWith('/conversations/g1/voice/join')) await held;
      return response;
    }));
    await user.click(screen.getByText('Join call'));
    await waitFor(() => expect(server.state.callJoins).toHaveLength(1));

    await act(async () => {
      for (const from of [AARON, ZED]) {
        server.dispatch(HOME, 'VOICE_SIGNAL', {
          channel_id: 'g1', conversation_id: 'g1', from,
          payload: { description: { type: 'offer', sdp: `offer-from-${from}` } },
        });
      }
    });
    await act(async () => { answer(); });

    const answered = (target) => server.state.signals.some((s) => s.target === target
      && s.payload?.description?.type === 'answer');
    await waitFor(() => expect(answered(AARON)).toBe(true));
    await waitFor(() => expect(answered(ZED)).toBe(true));
    const peers = FakePC.all.filter((pc) => !pc.closed);
    expect(peers).toHaveLength(2);
    for (const pc of peers) {
      await waitFor(() => expect(pc.signalingState).toBe('stable'));
      expect(pc.remoteDescription.type).toBe('offer');
    }
  });
});
