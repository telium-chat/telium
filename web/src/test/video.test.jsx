import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { createFakeServer, GUILD } from './fake-server.js';
import { signedInApp } from './harness.jsx';
import { FakePC, fakeTrack, stubMedia } from './fake-webrtc.js';

async function boot(overrides) {
  const server = createFakeServer(overrides);
  const { store, user } = await signedInApp(server);
  await act(async () => { await store.addServer('guilds.example'); });
  await screen.findByTitle('Telium on guilds.example');
  return { server, store, user };
}

async function joinLounge(overrides) {
  const media = stubMedia();
  const booted = await boot(overrides);
  booted.server.state.voiceStates.push({ user_id: '@bob:home.example', channel_id: 'c2' });
  await booted.user.click(await screen.findByTitle('Telium on guilds.example'));
  await booted.user.click(await screen.findByText('lounge'));
  await waitFor(() => expect(FakePC.all).toHaveLength(1));
  return { ...booted, ...media };
}

const dock = (name) => within(screen.getByRole('toolbar', { name: 'Call controls' }))
  .getByRole('button', { name });

async function startScreenShare(user) {
  await user.click(dock('Share screen'));
  await user.click(await screen.findByRole('button', { name: 'Choose what to share' }));
}

describe('screen sharing', () => {
  it('opens the picker, puts the capture on the wire, and draws it back', async () => {
    const {
      server, store, user, screen: capture, screenVideoTracks, screenAudioTracks,
    } = await joinLounge();

    await startScreenShare(user);

    await waitFor(() => expect(navigator.mediaDevices.getDisplayMedia).toHaveBeenCalled());
    const displayOptions = navigator.mediaDevices.getDisplayMedia.mock.calls[0][0];
    expect(displayOptions.audio).toEqual({ suppressLocalAudioPlayback: false });
    expect(displayOptions.systemAudio).toBe('include');
    expect(displayOptions.windowAudio).toBe('system');

    await waitFor(() => expect(server.state.streams).toEqual([
      { enabled: true, preset: 'detail 1080p@15' },
    ]));

    const [pc] = FakePC.all;
    expect(pc.transceivers[2].sender.track).toBe(screenVideoTracks[0]);
    expect(pc.transceivers[2].direction).toBe('sendrecv');
    expect(pc.transceivers[3].sender.track).toBe(screenAudioTracks[0]);
    expect(pc.transceivers[3].direction).toBe('sendrecv');

    const mine = await screen.findByLabelText('Your screen');
    expect(mine.srcObject).toBe(capture);
    expect(mine.muted).toBe(true);

    act(() => {
      store.navigate({ view: 'chat', guildId: 'g1', channelId: 'c1' });
    });
    const mini = await screen.findByLabelText('Call mini view');
    expect(within(mini).getByLabelText('Your screen').srcObject).toBe(capture);
    expect(navigator.mediaDevices.getDisplayMedia).toHaveBeenCalledTimes(1);

    const resizeHandle = mini.querySelector('[data-mini-resize-handle]');
    expect(resizeHandle).not.toBeNull();
    Object.defineProperty(mini, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        left: 420,
        right: 700,
        top: 330,
        bottom: 487.5,
        width: 280,
        height: 157.5,
      }),
    });
    fireEvent.pointerDown(resizeHandle, {
      button: 0, pointerId: 41, clientX: 420, clientY: 330,
    });
    fireEvent.pointerMove(resizeHandle, {
      pointerId: 41, clientX: 340, clientY: 330,
    });
    expect(mini.style.width).toBe('360px');
    fireEvent.pointerUp(resizeHandle, {
      pointerId: 41, clientX: 340, clientY: 330,
    });

    await user.click(within(mini).getByRole('button', { name: 'Expand call' }));
    await waitFor(() => expect(store.route.channelId).toBe('c2'));
    await waitFor(() => expect(screen.queryByLabelText('Call mini view')).toBeNull());

    await user.click(dock('Stop sharing'));
    await waitFor(() => expect(server.state.streams).toHaveLength(2));
    expect(server.state.streams[1].enabled).toBe(false);
    expect(screenVideoTracks[0].stop).toHaveBeenCalled();
    expect(screenAudioTracks[0].stop).toHaveBeenCalled();
    expect(pc.transceivers[2].direction).toBe('recvonly');
    expect(pc.transceivers[3].direction).toBe('recvonly');
    await waitFor(() => expect(screen.queryByLabelText('Your screen')).toBeNull());
  });

  it('claims nothing when the picker is dismissed', async () => {
    const { server, user } = await joinLounge();
    const refused = Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' });
    navigator.mediaDevices.getDisplayMedia = vi.fn(async () => { throw refused; });

    await startScreenShare(user);
    await waitFor(() => expect(navigator.mediaDevices.getDisplayMedia).toHaveBeenCalled());

    expect(server.state.streams).toEqual([]);
    expect(dock('Share screen')).toBeTruthy();
    expect(screen.queryByLabelText('Your screen')).toBeNull();
    expect(document.body.textContent).not.toContain('Could not share');
  });

  it('puts the capture back down if the server refuses the flag', async () => {
    const { server, user, screenTracks } = await joinLounge();
    server.state.streamDenied = true;

    await startScreenShare(user);

    await waitFor(() => expect(screenTracks[0].stop).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByLabelText('Your screen')).toBeNull());
    expect(dock('Share screen')).toBeTruthy();
    expect(FakePC.all[0].transceivers[2].direction).toBe('recvonly');
  });

  it("draws somebody else's screen without asking to subscribe to it", async () => {
    const { user } = await joinLounge();
    const [pc] = FakePC.all;

    const track = fakeTrack('video');
    const theirs = { id: 'bob-screen' };
    await act(async () => {
      pc.receive(track, [theirs], pc.transceivers[2]);
      pc.settle('connected');
    });

    const tile = await screen.findByLabelText("bob's screen");
    expect(tile.srcObject).toBe(theirs);
    expect(screen.queryByRole('button', { name: 'Watch' })).toBeNull();
    expect(document.body.textContent).not.toMatch(/mesh/i);

    await act(async () => { track.emit('mute'); });
    await waitFor(() => expect(screen.queryByLabelText("bob's screen")).toBeNull());

    expect(within(screen.getByRole('toolbar', { name: 'Call controls' }))
      .queryByRole('button', { name: 'Stop sharing' })).toBeNull();
    await user.click(dock('Disconnect'));
  });

  it('sets the encoder up for a game when that is what was chosen', async () => {
    const { server, user, screenVideoTracks } = await joinLounge();

    await user.click(dock('Share screen'));
    await user.click(await screen.findByText('A game or video'));
    await user.click(screen.getByRole('button', { name: 'Choose what to share' }));

    await waitFor(() => expect(screenVideoTracks[0].contentHint).toBe('motion'));
    await waitFor(() => expect(
      FakePC.all[0].transceivers[2].sender.getParameters().degradationPreference,
    ).toBe('maintain-framerate'));
    await waitFor(() => expect(server.state.streams).toEqual([
      { enabled: true, preset: 'motion 1080p@60' },
    ]));
  });

  it('keeps a document sharp instead of smooth, which is the other half of the choice', async () => {
    const { user, screenVideoTracks } = await joinLounge();

    await startScreenShare(user);

    await waitFor(() => expect(screenVideoTracks[0].contentHint).toBe('text'));
    await waitFor(() => expect(
      FakePC.all[0].transceivers[2].sender.getParameters().degradationPreference,
    ).toBe('maintain-resolution'));
  });

  it('leaves the share silent when the sharer said not to send the sound', async () => {
    const { user } = await joinLounge();

    await user.click(dock('Share screen'));
    await user.click(await screen.findByLabelText(/Share the sound too/));
    await user.click(screen.getByRole('button', { name: 'Choose what to share' }));

    await waitFor(() => expect(navigator.mediaDevices.getDisplayMedia).toHaveBeenCalled());
    const options = navigator.mediaDevices.getDisplayMedia.mock.calls[0][0];
    expect(options.audio).toBe(false);
    expect(options.systemAudio).toBeUndefined();
  });

  it('says so when the browser gave the share no sound to send', async () => {
    const { user } = await joinLounge();
    const silent = {
      getTracks: () => [fakeTrack('video')],
      getVideoTracks() { return this.getTracks(); },
      getAudioTracks: () => [],
    };
    navigator.mediaDevices.getDisplayMedia = vi.fn(async () => silent);

    await startScreenShare(user);

    await screen.findByLabelText('Your screen');
    await waitFor(() => expect(document.body.textContent).toMatch(/no sound/i));
  });
});

describe('camera', () => {
  it('opens the camera, puts it on its own m-line, and draws it in your tile', async () => {
    const { server, store, user, cameraTracks } = await joinLounge();

    await user.click(dock('Turn on camera'));

    await waitFor(() => expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(2));
    const asked = navigator.mediaDevices.getUserMedia.mock.calls[1][0];
    expect(asked.video).toBeTruthy();
    expect(asked.video.facingMode?.ideal).toBe('user');
    expect(asked.audio).toBe(false);

    await waitFor(() => expect(server.state.voiceStates.find((v) => v.user_id === '@alice:home.example')?.self_video).toBe(true));

    const pc = FakePC.all[0];
    expect(pc.transceivers[1].sender.track).toBe(cameraTracks[0]);
    expect(pc.transceivers[1].direction).toBe('sendrecv');
    expect(pc.transceivers[2].direction).toBe('recvonly');

    const mine = await screen.findByLabelText('Your camera');
    expect(mine.srcObject).toBeTruthy();
    expect(mine.muted).toBe(true);
    expect(mine.className).toContain('-scale-x-100');
    const cameraStream = mine.srcObject;

    act(() => {
      store.navigate({ view: 'chat', guildId: 'g1', channelId: 'c1' });
    });
    const mini = await screen.findByLabelText('Call mini view');
    const miniCamera = within(mini).getByLabelText('Your camera');
    expect(miniCamera.srcObject).toBe(cameraStream);
    expect(miniCamera.className).toContain('-scale-x-100');
    await user.click(within(mini).getByRole('button', { name: 'Expand call' }));
    await waitFor(() => expect(store.route.channelId).toBe('c2'));
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(2);

    await user.click(dock('Turn off camera'));
    await waitFor(() => expect(screen.queryByLabelText('Your camera')).toBeNull());
    expect(cameraTracks[0].stop).toHaveBeenCalled();
  });

  it('says so when the camera is refused, and claims nothing', async () => {
    const { server, user } = await joinLounge();
    navigator.mediaDevices.getUserMedia = vi.fn(async () => {
      throw Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' });
    });

    await user.click(dock('Turn on camera'));
    await waitFor(() => expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalled());

    await waitFor(() => expect(document.body.textContent).toContain('Camera permission was refused'));
    expect(server.state.voiceStates.find((v) => v.user_id === '@alice:home.example')?.self_video)
      .toBeFalsy();
    expect(dock('Turn on camera')).toBeTruthy();
    expect(screen.queryByLabelText('Your camera')).toBeNull();
  });

  it("clears somebody else's face when voice state says their camera is off", async () => {
    const { server, store } = await joinLounge();
    const pc = FakePC.all[0];
    const bob = '@bob:home.example';

    await act(async () => {
      server.dispatch(GUILD, 'VOICE_STATE_UPDATE', {
        guild_id: 'g1', channel_id: 'c2', user_id: bob, self_video: true,
      });
    });

    const face = fakeTrack('video');
    await act(async () => { pc.receive(face, [{ id: 'bob-face' }], pc.transceivers[1]); });
    expect(await screen.findByLabelText("bob's camera")).toBeTruthy();

    act(() => {
      store.navigate({ view: 'chat', guildId: 'g1', channelId: 'c1' });
    });
    expect(await screen.findByLabelText("bob's camera")).toBeTruthy();
    expect(await screen.findByLabelText('Call mini view')).toBeTruthy();

    await act(async () => {
      server.dispatch(GUILD, 'VOICE_STATE_UPDATE', {
        guild_id: 'g1', channel_id: 'c2', user_id: bob, self_video: false,
      });
    });
    await waitFor(() => expect(screen.queryByLabelText("bob's camera")).toBeNull());
    await waitFor(() => expect(screen.queryByLabelText('Call mini view')).toBeNull());
  });

  it("draws somebody else's face in their tile, not on the stage", async () => {
    const { server, user } = await joinLounge();
    const pc = FakePC.all[0];

    await act(async () => {
      server.dispatch(GUILD, 'VOICE_STATE_UPDATE', {
        guild_id: 'g1', channel_id: 'c2', user_id: '@bob:home.example', self_video: true,
      });
    });

    const face = fakeTrack('video');
    await act(async () => { pc.receive(face, [{ id: 'bob-face' }], pc.transceivers[1]); });

    const tile = await screen.findByLabelText("bob's camera");
    expect(tile.srcObject).toEqual({ id: 'bob-face' });
    expect(tile.className).not.toContain('-scale-x-100');
    expect(tile.closest('[data-user="@bob:home.example"]')).toBeTruthy();

    await act(async () => { face.emit('mute'); });
    await waitFor(() => expect(screen.queryByLabelText("bob's camera")).toBeNull());
    await user.click(dock('Disconnect'));
  });
});
