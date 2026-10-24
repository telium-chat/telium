import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MESH_DISCONNECTED_MS,
  MESH_RECOVERIES_BEFORE_REPORT,
  MESH_STALL_MS,
  MeshCall,
  preferScreenCodec,
  preferredScreenCodec,
} from '../lib/voice.js';
import { FakePC, fakeTrack, stubCall, settle } from './fake-webrtc.js';

describe('Windows screen codec', () => {
  it('leaves Linux and browser codec order alone', () => {
    expect(preferredScreenCodec({ teliumDesktop: { platform: 'linux' } })).toBeNull();
    expect(preferredScreenCodec({})).toBeNull();
  });

  it('puts H264 first for Windows desktop screen transceivers', () => {
    const setCodecPreferences = vi.fn();
    const scope = {
      teliumDesktop: { platform: 'win32' },
      RTCRtpSender: {
        getCapabilities: () => ({
          codecs: [
            { mimeType: 'video/VP8' },
            { mimeType: 'video/H264', sdpFmtpLine: 'profile-level-id=42e01f' },
            { mimeType: 'video/rtx' },
          ],
        }),
      },
    };
    expect(preferScreenCodec({ setCodecPreferences }, scope)).toBe(true);
    expect(setCodecPreferences).toHaveBeenCalledWith([
      { mimeType: 'video/H264', sdpFmtpLine: 'profile-level-id=42e01f' },
      { mimeType: 'video/VP8' },
      { mimeType: 'video/rtx' },
    ]);
  });
});

describe('MeshCall', () => {
  beforeEach(() => { FakePC.all = []; vi.unstubAllGlobals(); });

  it('holds one connection per other participant and closes the ones that leave', async () => {
    stubCall();
    const call = new MeshCall({ me: '@a:h', signal: vi.fn(async () => {}) });
    await call.start([]);

    call.sync(['@a:h', '@b:h', '@c:h']);
    expect([...call.peers.keys()].sort()).toEqual(['@b:h', '@c:h']);

    const dropped = call.peers.get('@c:h').pc;
    call.sync(['@a:h', '@b:h']);
    expect([...call.peers.keys()]).toEqual(['@b:h']);
    expect(dropped.closed).toBe(true);

    call.stop();
    expect(call.peers.size).toBe(0);
  });

  it('passes the ICE configuration the host issued to every peer', async () => {
    stubCall();
    const ice = [{ urls: ['stun:stun.example'] }];
    const call = new MeshCall({ me: '@a:h', signal: vi.fn(async () => {}) });
    await call.start(ice);
    call.sync(['@b:h']);
    expect(call.peers.get('@b:h').pc.config.iceServers).toEqual(ice);
  });

  it('settles a simultaneous offer instead of deadlocking on it', async () => {
    stubCall();
    const calls = {};
    const relay = (from) => async (target, payload) => {
      await Promise.resolve();
      calls[target].accept({ from, payload });
    };
    calls['@a:h'] = new MeshCall({ me: '@a:h', signal: relay('@a:h') });
    calls['@b:h'] = new MeshCall({ me: '@b:h', signal: relay('@b:h') });
    await calls['@a:h'].start([]);
    await calls['@b:h'].start([]);

    calls['@a:h'].sync(['@b:h']);
    calls['@b:h'].sync(['@a:h']);
    for (let i = 0; i < 12; i += 1) await settle();

    const a = calls['@a:h'].peers.get('@b:h');
    const b = calls['@b:h'].peers.get('@a:h');
    expect([a.polite, b.polite].sort()).toEqual([false, true]);
    expect(b.polite).toBe(true);
    expect(a.pc.signalingState).toBe('stable');
    expect(b.pc.signalingState).toBe('stable');
    expect(b.pc.remoteDescription.type).toBe('offer');
    expect(a.pc.remoteDescription.type).toBe('answer');
  });

  it('sends one peer its signals in order, however slow the relay is', async () => {
    stubCall();
    const arrived = [];
    const call = new MeshCall({
      me: '@a:h',
      signal: async (target, payload) => {
        const wait = arrived.length === 0 ? 20 : 0;
        await new Promise((r) => setTimeout(r, wait));
        arrived.push(payload.description ? payload.description.type : 'candidate');
      },
    });
    await call.start([]);
    call.sync(['@b:h']);
    await settle();

    const { pc } = call.peers.get('@b:h');
    pc.onicecandidate({ candidate: { candidate: 'one' } });
    pc.onicecandidate({ candidate: { candidate: 'two' } });
    await new Promise((r) => setTimeout(r, 60));

    expect(arrived).toEqual(['offer', 'candidate', 'candidate']);
  });

  it('holds a candidate that arrives before the description it belongs to', async () => {
    stubCall();
    const errors = [];
    const call = new MeshCall({
      me: '@a:h', signal: vi.fn(async () => {}), onError: (e) => errors.push(e),
    });
    await call.start([]);

    await call.accept({ from: '@z:h', payload: { candidate: { candidate: 'early' } } });
    const { pc } = call.peers.get('@z:h');
    expect(pc.candidates).toEqual([]);
    expect(errors).toEqual([]);

    await call.accept({ from: '@z:h', payload: { description: { type: 'offer', sdp: 'x' } } });
    expect(pc.candidates).toEqual([{ candidate: 'early' }]);
  });

  it('answers a peer whose offer arrives before their voice state does', async () => {
    stubCall();
    const sent = [];
    const call = new MeshCall({ me: '@a:h', signal: async (t, p) => sent.push([t, p]) });
    await call.start([]);

    await call.accept({ from: '@z:h', payload: { description: { type: 'offer', sdp: 'x' } } });
    expect(call.peers.has('@z:h')).toBe(true);
    expect(sent.at(-1)[0]).toBe('@z:h');
    expect(sent.at(-1)[1].description.type).toBe('answer');
  });

  it('ignores a signal that claims to come from us', async () => {
    stubCall();
    const call = new MeshCall({ me: '@a:h', signal: vi.fn(async () => {}) });
    await call.start([]);
    await call.accept({ from: '@a:h', payload: { description: { type: 'offer' } } });
    expect(call.peers.size).toBe(0);
  });

  it('deafening stops the outgoing track as well as the incoming ones', async () => {
    const { tracks } = stubCall();
    const call = new MeshCall({ me: '@a:h', signal: vi.fn(async () => {}) });
    await call.start([]);
    call.sync(['@b:h']);
    const peer = call.peers.get('@b:h');
    peer.pc.receive();

    call.setDeafened(true);
    expect(peer.audio.muted).toBe(true);
    expect(tracks[0].enabled).toBe(false);

    call.setDeafened(false);
    expect(peer.audio.muted).toBe(false);
    expect(tracks[0].enabled).toBe(true);

    call.setDeafened(true);
    call.setMuted(false);
    expect(tracks[0].enabled).toBe(false);
    call.stop();
  });

  it('leaves somebody who deafened while muted muted when they undeafen', async () => {
    const { tracks } = stubCall();
    const call = new MeshCall({ me: '@a:h', signal: vi.fn(async () => {}) });
    await call.start([]);

    call.setMuted(true);
    call.setDeafened(true);
    call.setDeafened(false);
    expect(tracks[0].enabled).toBe(false);

    call.setMuted(false);
    expect(tracks[0].enabled).toBe(true);
    call.stop();
  });

  it('plays a remote track through an element in the document and takes it away again', async () => {
    stubCall();
    const call = new MeshCall({ me: '@a:h', signal: vi.fn(async () => {}) });
    await call.start([]);
    call.sync(['@b:h']);

    call.peers.get('@b:h').pc.receive({ kind: 'audio' }, []);
    const element = document.querySelector('audio');
    expect(element).toBeTruthy();
    expect(element.srcObject).toBeTruthy();
    expect(element.play).toHaveBeenCalled();

    call.stop();
    expect(document.querySelector('audio')).toBeNull();
  });

  it('joins without a microphone rather than failing the call', async () => {
    stubCall();
    navigator.mediaDevices.getUserMedia = vi.fn(async () => { throw new Error('denied'); });
    const call = new MeshCall({ me: '@a:h', signal: vi.fn(async () => {}) });
    expect(await call.start([])).toBe(false);
    expect(call.micError).toBeTruthy();
    call.sync(['@b:h']);
    const peer = call.peers.get('@b:h');
    expect(peer.transceiver.direction).toBe('recvonly');
    expect(peer.transceiver.sender.track).toBeNull();
  });

  it('sends the microphone to a peer that connected while it was still being asked for', async () => {
    const { tracks } = stubCall();
    let grant;
    navigator.mediaDevices.getUserMedia = vi.fn(
      () => new Promise((resolve) => { grant = resolve; }),
    );
    const call = new MeshCall({ me: '@a:h', signal: vi.fn(async () => {}) });
    const opening = call.start([]);

    await call.accept({ from: '@b:h', payload: { description: { type: 'offer', sdp: 'x' } } });
    const peer = call.peers.get('@b:h');
    expect(peer.transceiver.direction).toBe('recvonly');

    grant({ getTracks: () => tracks, getAudioTracks: () => tracks });
    expect(await opening).toBe(true);
    expect(peer.transceiver.sender.track).toBe(tracks[0]);
    expect(peer.transceiver.direction).toBe('sendrecv');
    await settle();
    expect(peer.pc.needed || peer.pc.localDescription?.type === 'offer').toBeTruthy();
  });

  it('reports only the peers whose media is up, and says so when one never comes up', async () => {
    vi.useFakeTimers();
    try {
      stubCall();
      const peers = [];
      const errors = [];
      const call = new MeshCall({
        me: '@a:h',
        signal: vi.fn(async () => {}),
        onPeers: (set) => peers.push(set),
        onError: (e) => errors.push(e.message),
      });
      await call.start([]);
      call.sync(['@b:h']);
      expect(peers.at(-1).size).toBe(0);

      const { pc } = call.peers.get('@b:h');
      pc.settle('connected');
      expect([...peers.at(-1)]).toEqual(['@b:h']);

      pc.settle('failed');
      expect(peers.at(-1).size).toBe(0);
      await vi.advanceTimersByTimeAsync(600);
      expect(pc.restarts).toBe(1);
      expect(errors).toEqual([]);
      await vi.advanceTimersByTimeAsync(MESH_STALL_MS * 8);
      expect(pc.restarts).toBeGreaterThan(MESH_RECOVERIES_BEFORE_REPORT);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('@b:h');

      pc.settle('connected');
      const before = pc.restarts;
      pc.settle('failed');
      await vi.advanceTimersByTimeAsync(600);
      expect(pc.restarts).toBe(before + 1);
      expect(errors).toHaveLength(1);
      call.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives a disconnected peer a moment to come back before renegotiating', async () => {
    vi.useFakeTimers();
    try {
      stubCall();
      const call = new MeshCall({ me: '@a:h', signal: vi.fn(async () => {}) });
      await call.start([]);
      call.sync(['@b:h']);
      const { pc } = call.peers.get('@b:h');
      pc.settle('connected');
      pc.settle('disconnected');
      await vi.advanceTimersByTimeAsync(MESH_DISCONNECTED_MS - 100);
      expect(pc.restarts).toBe(0);
      await vi.advanceTimersByTimeAsync(700);
      expect(pc.restarts).toBe(1);
      pc.settle('connected');
      pc.settle('disconnected');
      pc.settle('connected');
      await vi.advanceTimersByTimeAsync(MESH_STALL_MS * 4);
      expect(pc.restarts).toBe(1);
      call.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('renegotiates a pair whose offer was lost on the way', async () => {
    vi.useFakeTimers();
    try {
      stubCall();
      const calls = {};
      let lose = 1;
      const relay = (from) => async (target, payload) => {
        await Promise.resolve();
        if (from === '@a:h' && payload.description?.type === 'offer' && lose > 0) {
          lose -= 1;
          return;
        }
        calls[target].accept({ from, payload });
      };
      calls['@a:h'] = new MeshCall({ me: '@a:h', signal: relay('@a:h') });
      calls['@b:h'] = new MeshCall({ me: '@b:h', signal: relay('@b:h') });
      await calls['@a:h'].start([]);
      await calls['@b:h'].start([]);
      calls['@a:h'].sync(['@b:h']);
      calls['@b:h'].sync(['@a:h']);
      await vi.advanceTimersByTimeAsync(50);

      const a = calls['@a:h'].peers.get('@b:h');
      const b = calls['@b:h'].peers.get('@a:h');
      expect(a.pc.signalingState).toBe('have-local-offer');
      expect(a.pc.remoteDescription).toBe(null);

      await vi.advanceTimersByTimeAsync(MESH_STALL_MS + 1000);
      expect(a.pc.signalingState).toBe('stable');
      expect(b.pc.signalingState).toBe('stable');
      expect(a.pc.remoteDescription).not.toBe(null);
      expect(b.pc.remoteDescription).not.toBe(null);
      calls['@a:h'].stop();
      calls['@b:h'].stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('lays every m-line down before anyone turns anything on', async () => {
    stubCall();
    const call = new MeshCall({ me: '@a:h', signal: vi.fn(async () => {}) });
    await call.start([]);
    call.sync(['@b:h']);

    const peer = call.peers.get('@b:h');
    expect(peer.pc.transceivers).toHaveLength(4);
    expect(peer.pc.transceivers[0]).toBe(peer.transceiver);
    expect(peer.pc.transceivers[1]).toBe(peer.camera);
    expect(peer.pc.transceivers[2]).toBe(peer.screen);
    expect(peer.pc.transceivers[3]).toBe(peer.screenAudio);
    for (const t of [peer.camera, peer.screen, peer.screenAudio]) {
      expect(t.direction).toBe('recvonly');
      expect(t.sender.track).toBeNull();
    }
  });

  it('puts a shared screen on every peer and takes it back off again', async () => {
    const { screen, screenTracks } = stubCall();
    const onScreen = vi.fn();
    const call = new MeshCall({ me: '@a:h', signal: vi.fn(async () => {}), onScreen });
    await call.start([]);
    call.sync(['@b:h', '@c:h']);

    expect(await call.setScreenShareEnabled(true)).toBe(true);
    for (const peer of call.peers.values()) {
      expect(peer.screen.sender.track).toBe(screenTracks[0]);
      expect(peer.screen.direction).toBe('sendrecv');
    }
    expect(onScreen).toHaveBeenCalledWith('@a:h', screen);

    await call.setScreenShareEnabled(false);
    for (const peer of call.peers.values()) {
      expect(peer.screen.sender.track).toBeNull();
      expect(peer.screen.direction).toBe('recvonly');
    }
    expect(screenTracks[0].stop).toHaveBeenCalled();
    expect(onScreen).toHaveBeenLastCalledWith('@a:h', null);
  });

  it('gives a peer who arrives mid-share the screen they missed', async () => {
    const { screenTracks } = stubCall();
    const call = new MeshCall({ me: '@a:h', signal: vi.fn(async () => {}) });
    await call.start([]);
    await call.setScreenShareEnabled(true);

    call.sync(['@b:h']);
    const peer = call.peers.get('@b:h');
    expect(peer.screen.sender.track).toBe(screenTracks[0]);
    expect(peer.screen.direction).toBe('sendrecv');
  });

  it("follows the browser's own stop-sharing button", async () => {
    const { screenTracks } = stubCall();
    const onScreen = vi.fn();
    const onScreenEnd = vi.fn();
    const call = new MeshCall({
      me: '@a:h', signal: vi.fn(async () => {}), onScreen, onScreenEnd,
    });
    await call.start([]);
    call.sync(['@b:h']);
    await call.setScreenShareEnabled(true);

    screenTracks[0].emit('ended');
    expect(call.screen).toBeNull();
    expect(call.peers.get('@b:h').screen.direction).toBe('recvonly');
    expect(onScreen).toHaveBeenLastCalledWith('@a:h', null);
    expect(onScreenEnd).toHaveBeenCalled();
  });

  it('lets a dismissed picker through to the caller untouched', async () => {
    stubCall();
    const onScreen = vi.fn();
    const call = new MeshCall({ me: '@a:h', signal: vi.fn(async () => {}), onScreen });
    await call.start([]);
    call.sync(['@b:h']);

    const refused = Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' });
    navigator.mediaDevices.getDisplayMedia = vi.fn(async () => { throw refused; });

    await expect(call.setScreenShareEnabled(true)).rejects.toBe(refused);
    expect(call.screen).toBeNull();
    expect(onScreen).not.toHaveBeenCalled();
    expect(call.peers.get('@b:h').screen.direction).toBe('recvonly');
  });

  it('puts the camera on its own m-line and takes it back off again', async () => {
    const { camera, cameraTracks } = stubCall();
    const onCamera = vi.fn();
    const call = new MeshCall({ me: '@a:h', signal: vi.fn(async () => {}), onCamera });
    await call.start([]);
    call.sync(['@b:h', '@c:h']);

    expect(await call.setVideoEnabled(true)).toBe(true);
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenLastCalledWith(
      expect.objectContaining({ video: expect.anything(), audio: false }),
    );
    for (const peer of call.peers.values()) {
      expect(peer.camera.sender.track).toBe(cameraTracks[0]);
      expect(peer.camera.direction).toBe('sendrecv');
      expect(peer.screen.direction).toBe('recvonly');
    }
    expect(onCamera).toHaveBeenCalledWith('@a:h', camera);

    await call.setVideoEnabled(false);
    for (const peer of call.peers.values()) {
      expect(peer.camera.sender.track).toBeNull();
      expect(peer.camera.direction).toBe('recvonly');
    }
    expect(cameraTracks[0].stop).toHaveBeenCalled();
    expect(onCamera).toHaveBeenLastCalledWith('@a:h', null);
  });

  it('carries a camera and a screen at the same time', async () => {
    const { camera, screen, cameraTracks, screenTracks } = stubCall();
    const onCamera = vi.fn();
    const onScreen = vi.fn();
    const call = new MeshCall({
      me: '@a:h', signal: vi.fn(async () => {}), onCamera, onScreen,
    });
    await call.start([]);
    call.sync(['@b:h']);

    await call.setVideoEnabled(true);
    await call.setScreenShareEnabled(true);
    const peer = call.peers.get('@b:h');
    expect(peer.camera.sender.track).toBe(cameraTracks[0]);
    expect(peer.screen.sender.track).toBe(screenTracks[0]);
    expect(onCamera).toHaveBeenLastCalledWith('@a:h', camera);
    expect(onScreen).toHaveBeenLastCalledWith('@a:h', screen);

    await call.setScreenShareEnabled(false);
    expect(peer.screen.sender.track).toBeNull();
    expect(peer.camera.sender.track).toBe(cameraTracks[0]);
    expect(onCamera).toHaveBeenLastCalledWith('@a:h', camera);
  });

  it('tells an inbound face from an inbound screen by the m-line it came in on', async () => {
    stubCall();
    const onCamera = vi.fn();
    const onScreen = vi.fn();
    const call = new MeshCall({
      me: '@a:h', signal: vi.fn(async () => {}), onCamera, onScreen,
    });
    await call.start([]);
    call.sync(['@b:h']);
    const peer = call.peers.get('@b:h');

    const face = fakeTrack('video');
    peer.pc.receive(face, [{ id: 'face' }], peer.camera);
    const display = fakeTrack('video');
    peer.pc.receive(display, [{ id: 'display' }], peer.screen);

    expect(onCamera).toHaveBeenCalledWith('@b:h', { id: 'face' });
    expect(onScreen).toHaveBeenCalledWith('@b:h', { id: 'display' });

    face.emit('mute');
    expect(onCamera).toHaveBeenLastCalledWith('@b:h', null);
    expect(onScreen).toHaveBeenLastCalledWith('@b:h', { id: 'display' });
  });

  it('reports a camera taken away rather than turned off', async () => {
    const { cameraTracks } = stubCall();
    const onCamera = vi.fn();
    const onCameraEnd = vi.fn();
    const call = new MeshCall({
      me: '@a:h', signal: vi.fn(async () => {}), onCamera, onCameraEnd,
    });
    await call.start([]);
    call.sync(['@b:h']);
    await call.setVideoEnabled(true);

    cameraTracks[0].emit('ended');
    expect(call.camera).toBeNull();
    expect(call.peers.get('@b:h').camera.direction).toBe('recvonly');
    expect(onCamera).toHaveBeenLastCalledWith('@a:h', null);
    expect(onCameraEnd).toHaveBeenCalled();
  });

  it('says why there is no picker on an insecure page', async () => {
    stubCall();
    const call = new MeshCall({ me: '@a:h', signal: vi.fn(async () => {}) });
    await call.start([]);

    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: undefined });
    vi.stubGlobal('isSecureContext', false);

    await expect(call.setScreenShareEnabled(true)).rejects.toThrow(/secure page/);
    expect(call.screen).toBeNull();
  });

  it('hands an inbound screen up as a picture rather than an element', async () => {
    stubCall();
    const onScreen = vi.fn();
    const call = new MeshCall({ me: '@a:h', signal: vi.fn(async () => {}), onScreen });
    await call.start([]);
    call.sync(['@b:h']);
    const peer = call.peers.get('@b:h');

    const track = fakeTrack('video');
    const stream = { id: 'theirs' };
    peer.pc.receive(track, [stream], peer.screen);

    expect(onScreen).toHaveBeenCalledWith('@b:h', stream);
    expect(document.querySelector('video')).toBeNull();

    track.emit('mute');
    expect(onScreen).toHaveBeenLastCalledWith('@b:h', null);
    track.emit('unmute');
    expect(onScreen).toHaveBeenLastCalledWith('@b:h', stream);

    call.sync([]);
    expect(onScreen).toHaveBeenLastCalledWith('@b:h', null);
  });

  it('lets the capture go when the call ends', async () => {
    const { screenTracks } = stubCall();
    const call = new MeshCall({ me: '@a:h', signal: vi.fn(async () => {}) });
    await call.start([]);
    await call.setScreenShareEnabled(true);

    call.stop();
    expect(screenTracks[0].stop).toHaveBeenCalled();
    expect(call.screen).toBeNull();
  });
});


describe('mobile camera switching', () => {
  it('replaces the live camera track with the requested side without rebuilding the call', async () => {
    const media = stubCall();
    const frontTrack = fakeTrack('video');
    const rearTrack = fakeTrack('video');
    const front = {
      getTracks: () => [frontTrack],
      getVideoTracks: () => [frontTrack],
      getAudioTracks: () => [],
    };
    const rear = {
      getTracks: () => [rearTrack],
      getVideoTracks: () => [rearTrack],
      getAudioTracks: () => [],
    };

    navigator.mediaDevices.getUserMedia = vi.fn(async (constraints) => {
      if (!constraints?.video) return media.stream;
      return constraints.video.facingMode?.ideal === 'environment' ? rear : front;
    });

    const onCamera = vi.fn();
    const call = new MeshCall({
      me: '@a:h',
      signal: vi.fn(async () => {}),
      onCamera,
    });
    await call.start([]);
    call.sync(['@b:h']);

    await call.setVideoEnabled(true, { facingMode: 'user' });
    const peer = call.peers.get('@b:h');
    expect(peer.camera.sender.track).toBe(frontTrack);

    await call.switchCamera('environment');
    expect(navigator.mediaDevices.getUserMedia.mock.calls.at(-1)[0].video.facingMode.ideal)
      .toBe('environment');
    expect(peer.camera.sender.track).toBe(rearTrack);
    expect(frontTrack.stop).toHaveBeenCalledOnce();
    expect(rearTrack.stop).not.toHaveBeenCalled();
    expect(onCamera.mock.calls.at(-1)[1]).toBe(rear);

    call.stop();
    expect(rearTrack.stop).toHaveBeenCalledOnce();
  });
});
