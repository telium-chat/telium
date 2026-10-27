import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DisconnectReason, RoomEvent, Track, VideoPreset, VideoQuality } from 'livekit-client';
import {
  MAX_BITRATE_ATTRIBUTE,
  MeshCall,
  SfuCall,
  WATCH_TOPIC,
} from '../lib/voice.js';
import { fakeTrack, stubCall } from './fake-webrtc.js';

describe('SfuCall media that will not open', () => {
  const sfu = () => {
    const errors = [];
    const call = new SfuCall({
      me: '@a:h', endpoint: 'https://sfu.example', joinToken: 'token', iceServers: [],
      onError: (e) => errors.push(e.message),
    });
    return { call, errors };
  };
  const bob = { identity: '@b:h' };
  const missing = () => new Error('MissingKey: missing key at index 3 for participant @b:h');

  it('does not raise the alarm for a frame under a key that is still on its way', () => {
    vi.useFakeTimers();
    try {
      const { call, errors } = sfu();
      vi.setSystemTime(0);
      call.encryptionError(missing(), bob);
      vi.setSystemTime(1500);
      call.encryptionError(missing(), bob);
      call.keyArrived();
      vi.setSystemTime(2500);
      call.encryptionError(missing(), bob);
      expect(errors).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('says so in words when it lasts, and passes a broken worker straight through', () => {
    vi.useFakeTimers();
    try {
      const { call, errors } = sfu();
      for (let t = 0; t <= 6000; t += 1000) {
        vi.setSystemTime(t);
        call.encryptionError(missing(), bob);
      }
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('will not open under any key this device holds');
      expect(errors[0]).not.toContain('MissingKey');

      call.encryptionError(new Error('InternalError: worker died'), bob);
      call.encryptionError(new Error('InternalError: worker died'), bob);
      expect(errors).toHaveLength(2);
      expect(errors[1]).toContain('worker died');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('SfuCall callbacks', () => {
  it('defaults the audio-blocked callback to a no-op', () => {
    const call = new SfuCall({
      me: '@a:h',
      endpoint: 'https://sfu.example',
      joinToken: 'token',
      iceServers: [],
    });
    expect(() => call.stop()).not.toThrow();
  });

  it('subscribes ordinary call media but gates screen video and audio on Watch', () => {
    const call = new SfuCall({
      me: '@a:h',
      endpoint: 'https://sfu.example',
      joinToken: 'token',
      iceServers: [],
    });
    const microphone = { kind: Track.Kind.Audio, source: Track.Source.Microphone, setSubscribed: vi.fn() };
    const camera = { kind: Track.Kind.Video, source: Track.Source.Camera, setSubscribed: vi.fn() };
    const screen = { kind: Track.Kind.Video, source: Track.Source.ScreenShare, setSubscribed: vi.fn() };
    const screenAudio = {
      kind: Track.Kind.Audio, source: Track.Source.ScreenShareAudio, setSubscribed: vi.fn(),
    };
    const publications = new Map([
      ['mic', microphone], ['camera', camera], ['screen', screen], ['screen-audio', screenAudio],
    ]);
    const participant = { identity: '@b:h', trackPublications: publications };
    call.room = { remoteParticipants: new Map([['@b:h', participant]]) };

    for (const pub of publications.values()) call.onTrackPublished(pub, participant);
    expect(microphone.setSubscribed).toHaveBeenLastCalledWith(true);
    expect(camera.setSubscribed).toHaveBeenLastCalledWith(true);
    expect(screen.setSubscribed).toHaveBeenLastCalledWith(false);
    expect(screenAudio.setSubscribed).toHaveBeenLastCalledWith(false);

    call.setScreenSubscription('@b:h', true);
    expect(screen.setSubscribed).toHaveBeenLastCalledWith(true);
    expect(screenAudio.setSubscribed).toHaveBeenLastCalledWith(true);

    call.setScreenSubscription('@b:h', false);
    expect(screen.setSubscribed).toHaveBeenLastCalledWith(false);
    expect(screenAudio.setSubscribed).toHaveBeenLastCalledWith(false);
  });

  it('does not claim camera or screenshare success without a publication', async () => {
    stubCall();
    const call = new SfuCall({
      me: '@a:h',
      endpoint: 'https://sfu.example',
      joinToken: 'token',
      iceServers: [],
    });
    call.room = {
      localParticipant: {
        setCameraEnabled: vi.fn(async () => undefined),
        setScreenShareEnabled: vi.fn(async () => undefined),
      },
    };

    expect(await call.setVideoEnabled(true)).toBe(false);
    expect(await call.setScreenShareEnabled(true)).toBe(false);
  });

  it('reports audio-blocked state through the supplied callback', () => {
    const onAudioBlocked = vi.fn();
    const call = new SfuCall({
      me: '@a:h',
      endpoint: 'https://sfu.example',
      joinToken: 'token',
      iceServers: [],
      onAudioBlocked,
    });
    call.stop();
    expect(onAudioBlocked).toHaveBeenCalledWith(false);
  });
});

describe('SfuCall media sent in the clear', () => {
  function sealedCall() {
    const onError = vi.fn();
    const call = new SfuCall({
      me: '@a:h', endpoint: 'https://sfu.example', joinToken: 'token', iceServers: [],
      e2ee: { keyProvider: {}, worker: {} }, onError,
    });
    const plainMic = {
      kind: Track.Kind.Audio, source: Track.Source.Microphone, isEncrypted: false, setSubscribed: vi.fn(),
    };
    const plainScreen = {
      kind: Track.Kind.Video, source: Track.Source.ScreenShare, isEncrypted: false, setSubscribed: vi.fn(),
    };
    const sealedCamera = {
      kind: Track.Kind.Video, source: Track.Source.Camera, isEncrypted: true, setSubscribed: vi.fn(),
    };
    const participant = {
      identity: '@b:h',
      trackPublications: new Map([['mic', plainMic], ['screen', plainScreen], ['camera', sealedCamera]]),
      audioTrackPublications: new Map([['mic', plainMic]]),
    };
    call.room = {
      remoteParticipants: new Map([['@b:h', participant]]),
      localParticipant: { setMicrophoneEnabled: vi.fn(async () => ({})) },
    };
    return { call, onError, plainMic, plainScreen, sealedCamera, participant };
  }

  it('never subscribes to an unencrypted publication and says so once', () => {
    const { call, onError, plainMic, plainScreen, sealedCamera, participant } = sealedCall();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      for (const pub of participant.trackPublications.values()) call.onTrackPublished(pub, participant);
      expect(plainMic.setSubscribed).not.toHaveBeenCalledWith(true);
      expect(plainMic.setSubscribed).toHaveBeenLastCalledWith(false);
      expect(sealedCamera.setSubscribed).toHaveBeenLastCalledWith(true);
      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError.mock.calls[0][0].message).toMatch(/unencrypted/);

      call.setScreenSubscription('@b:h', true);
      call.setDeafened(true);
      call.setDeafened(false);
      expect(plainScreen.setSubscribed).not.toHaveBeenCalledWith(true);
      expect(plainMic.setSubscribed).not.toHaveBeenCalledWith(true);
      expect(onError).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('does not attach an unencrypted track that arrives anyway', () => {
    const { call, onError, plainMic, participant } = sealedCall();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const track = { kind: Track.Kind.Audio, attach: vi.fn() };
      call.onTrack(track, plainMic, participant);
      expect(track.attach).not.toHaveBeenCalled();
      expect(call.audioEls.size).toBe(0);
      expect(onError).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('leaves a call without encryption to subscribe as before', () => {
    const call = new SfuCall({
      me: '@a:h', endpoint: 'https://sfu.example', joinToken: 'token', iceServers: [],
    });
    const mic = {
      kind: Track.Kind.Audio, source: Track.Source.Microphone, isEncrypted: false, setSubscribed: vi.fn(),
    };
    call.onTrackPublished(mic, { identity: '@b:h' });
    expect(mic.setSubscribed).toHaveBeenLastCalledWith(true);
  });
});

function deafenedRoom() {
  const call = new SfuCall({
    me: '@a:h',
    endpoint: 'https://sfu.example',
    joinToken: 'token',
    iceServers: [],
  });
  const microphone = {
    kind: Track.Kind.Audio, source: Track.Source.Microphone, setSubscribed: vi.fn(),
  };
  const participant = {
    identity: '@b:h',
    audioTrackPublications: new Map([['mic', microphone]]),
  };
  const setMicrophoneEnabled = vi.fn(async () => ({}));
  call.room = {
    remoteParticipants: new Map([['@b:h', participant]]),
    localParticipant: { setMicrophoneEnabled },
  };
  const el = { muted: false };
  call.audioEls.set('@b:h|microphone', {
    identity: '@b:h', source: Track.Source.Microphone, el,
  });
  return { call, microphone, el, setMicrophoneEnabled };
}

function droppingCall() {
  const listeners = new Map();
  const onError = vi.fn();
  const onDropped = vi.fn();
  const call = new SfuCall({
    me: '@a:h', endpoint: 'https://sfu.example', joinToken: 'token', iceServers: [],
    onError, onDropped,
  });
  call.room = {
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(fn);
      return call.room;
    },
  };
  call.wireEvents();
  call.live = true;
  const disconnect = (reason) => {
    for (const fn of listeners.get(RoomEvent.Disconnected) || []) fn(reason);
  };
  return { disconnect, onError, onDropped };
}

describe('SfuCall dropped by the SFU', () => {
  it('hands an unexpected disconnect to whoever can rejoin', () => {
    const { disconnect, onError, onDropped } = droppingCall();
    disconnect(DisconnectReason.SIGNAL_CLOSE);
    expect(onDropped).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it('does not rejoin over another device of the same account', () => {
    const { disconnect, onError, onDropped } = droppingCall();
    disconnect(DisconnectReason.DUPLICATE_IDENTITY);
    expect(onDropped).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('says nothing about a teardown somebody meant', () => {
    for (const reason of [
      DisconnectReason.CLIENT_INITIATED,
      DisconnectReason.PARTICIPANT_REMOVED,
      DisconnectReason.ROOM_CLOSED,
      DisconnectReason.ROOM_DELETED,
    ]) {
      const { disconnect, onError, onDropped } = droppingCall();
      disconnect(reason);
      expect(onDropped).not.toHaveBeenCalled();
      expect(onError).not.toHaveBeenCalled();
    }
  });
});

describe('SfuCall deafen', () => {
  it('stops the outgoing track as well as the incoming ones', () => {
    const { call, microphone, el, setMicrophoneEnabled } = deafenedRoom();

    call.setDeafened(true);
    expect(microphone.setSubscribed).toHaveBeenLastCalledWith(false);
    expect(el.muted).toBe(true);
    expect(setMicrophoneEnabled).toHaveBeenLastCalledWith(false);

    call.setDeafened(false);
    expect(microphone.setSubscribed).toHaveBeenLastCalledWith(true);
    expect(el.muted).toBe(false);
    expect(setMicrophoneEnabled).toHaveBeenLastCalledWith(true);
  });

  it('leaves somebody who deafened while muted muted when they undeafen', () => {
    const { call, setMicrophoneEnabled } = deafenedRoom();

    call.setMuted(true);
    expect(setMicrophoneEnabled).toHaveBeenLastCalledWith(false);

    call.setDeafened(true);
    expect(setMicrophoneEnabled).toHaveBeenLastCalledWith(false);

    call.setDeafened(false);
    expect(setMicrophoneEnabled).toHaveBeenLastCalledWith(false);

    call.setMuted(false);
    expect(setMicrophoneEnabled).toHaveBeenLastCalledWith(true);
  });

  it('does not put a deafened person back on air when their input changes', () => {
    const { call, setMicrophoneEnabled } = deafenedRoom();
    call.setDeafened(true);
    call.setMuted(false);
    expect(setMicrophoneEnabled).toHaveBeenLastCalledWith(false);
  });
});

function watchedRoom() {
  const call = new SfuCall({
    me: '@a:h',
    endpoint: 'https://sfu.example',
    joinToken: 'token',
    iceServers: [],
  });
  const screen = {
    kind: Track.Kind.Video, source: Track.Source.ScreenShare,
    setSubscribed: vi.fn(), setVideoQuality: vi.fn(),
  };
  const screenAudio = {
    kind: Track.Kind.Audio, source: Track.Source.ScreenShareAudio,
    setSubscribed: vi.fn(), setVideoQuality: vi.fn(),
  };
  const camera = {
    kind: Track.Kind.Video, source: Track.Source.Camera,
    setSubscribed: vi.fn(), setVideoQuality: vi.fn(),
  };
  const participant = {
    identity: '@b:h',
    trackPublications: new Map([['screen', screen], ['screen-audio', screenAudio], ['camera', camera]]),
    audioTrackPublications: new Map(),
    videoTrackPublications: new Map(),
  };
  call.room = {
    remoteParticipants: new Map([['@b:h', participant]]),
    localParticipant: { attributes: {} },
  };
  return { call, screen, screenAudio, camera, participant };
}

describe('SfuCall watch quality', () => {
  it('asks LiveKit for the simulcast layer that matches the requested quality', () => {
    const { call, screen, screenAudio, camera } = watchedRoom();

    call.setScreenSubscription('@b:h', true, 'low');
    expect(screen.setVideoQuality).toHaveBeenLastCalledWith(VideoQuality.LOW);

    call.setWatchQuality('@b:h', 'medium');
    expect(screen.setVideoQuality).toHaveBeenLastCalledWith(VideoQuality.MEDIUM);

    call.setWatchQuality('@b:h', 'high');
    expect(screen.setVideoQuality).toHaveBeenLastCalledWith(VideoQuality.HIGH);

    expect(screenAudio.setVideoQuality).not.toHaveBeenCalled();
    expect(camera.setVideoQuality).not.toHaveBeenCalled();
  });

  it('treats auto as the top layer and leaves the rest to adaptive stream', () => {
    const { call, screen } = watchedRoom();
    call.setScreenSubscription('@b:h', true, 'auto');
    expect(screen.setVideoQuality).toHaveBeenLastCalledWith(VideoQuality.HIGH);
    expect(call.watchQualities.get('@b:h')).toBe('auto');

    call.setWatchQuality('@b:h', undefined);
    expect(call.watchQualities.get('@b:h')).toBe('auto');
    expect(screen.setVideoQuality).toHaveBeenLastCalledWith(VideoQuality.HIGH);
  });

  it('applies a quality chosen before the share arrived once the track is subscribed', () => {
    const { call, screen, participant } = watchedRoom();
    call.watchQualities.set('@b:h', 'low');
    const track = { kind: Track.Kind.Video, source: Track.Source.ScreenShare, mediaStream: null };
    call.onTrack(track, screen, participant);
    expect(screen.setVideoQuality).toHaveBeenLastCalledWith(VideoQuality.LOW);
  });

  it('follows the layer the SFU pushes on the watch topic, and only the SFU', () => {
    const { call, screen } = watchedRoom();
    call.setScreenSubscription('@b:h', true, 'auto');
    const encode = (message) => new TextEncoder().encode(JSON.stringify(message));

    call.onData(encode({ streamer: '@b:h', quality: 'low' }), undefined, WATCH_TOPIC);
    expect(screen.setVideoQuality).toHaveBeenLastCalledWith(VideoQuality.LOW);
    expect(call.watchQualities.get('@b:h')).toBe('low');

    call.onData(encode({ streamer: '@b:h', quality: 'high' }), { identity: '@c:h' }, WATCH_TOPIC);
    expect(call.watchQualities.get('@b:h')).toBe('low');

    call.onData(encode({ streamer: '@b:h', quality: 'high' }), undefined, 'telium.other');
    call.onData(new TextEncoder().encode('{not json'), undefined, WATCH_TOPIC);
    expect(call.watchQualities.get('@b:h')).toBe('low');
    expect(screen.setVideoQuality).toHaveBeenLastCalledWith(VideoQuality.LOW);
  });

  it('forgets the choice when the viewer stops watching or the call ends', () => {
    const { call } = watchedRoom();
    call.setScreenSubscription('@b:h', true, 'medium');
    expect(call.watchQualities.get('@b:h')).toBe('medium');
    call.setScreenSubscription('@b:h', false);
    expect(call.watchQualities.has('@b:h')).toBe(false);

    call.setScreenSubscription('@b:h', true, 'high');
    call.stop();
    expect(call.watchQualities.size).toBe(0);
  });
});

describe('SfuCall publish ceiling', () => {
  const ladderSum = (opts) => opts.screenShareEncoding.maxBitrate
    + (opts.screenShareSimulcastLayers || []).reduce((acc, p) => acc + p.encoding.maxBitrate, 0);

  it('settles the budget from the smallest ceiling in view', () => {
    const { call } = watchedRoom();
    call.maxBitrate = 2_500_000;
    expect(call.settleBudget({ max_bitrate: 8_000_000 }).total).toBe(2_500_000);

    call.room.localParticipant.attributes[MAX_BITRATE_ATTRIBUTE] = '500000';
    expect(call.settleBudget({ max_bitrate: 8_000_000 }).total).toBe(500_000);

    call.maxBitrate = null;
    call.room.localParticipant.attributes = {};
    expect(call.settleBudget({})).toBeNull();
  });

  it('publishes a screen share as a simulcast ladder that fits under the ceiling', async () => {
    stubCall();
    const { call } = watchedRoom();
    call.maxBitrate = 2_500_000;
    call.settleBudget({ max_bitrate: 2_500_000 });
    const setScreenShareEnabled = vi.fn(async () => ({}));
    call.room.localParticipant.setScreenShareEnabled = setScreenShareEnabled;

    expect(await call.setScreenShareEnabled(true, { width: 1920, height: 1080, fps: 30 })).toBe(true);
    const [on, capture, opts] = setScreenShareEnabled.mock.calls[0];
    expect(on).toBe(true);
    expect(capture).toEqual({ audio: true });
    expect(opts.simulcast).toBe(true);
    expect(opts.screenShareSimulcastLayers).toHaveLength(2);
    expect(opts.screenShareSimulcastLayers[0]).toBeInstanceOf(VideoPreset);
    expect(opts.screenShareSimulcastLayers.map((p) => [p.width, p.height]))
      .toEqual([[480, 270], [960, 540]]);
    expect(opts.screenShareEncoding.maxFramerate).toBe(30);
    expect(ladderSum(opts)).toBeLessThanOrEqual(call.budget.screen);
    expect(opts.audioPreset).toEqual({ maxBitrate: 48_000 });
  });

  it('publishes a single capped layer when the ceiling has no room for a ladder', async () => {
    stubCall();
    const { call } = watchedRoom();
    call.maxBitrate = 200_000;
    call.settleBudget({ max_bitrate: 200_000 });
    const setScreenShareEnabled = vi.fn(async () => ({}));
    call.room.localParticipant.setScreenShareEnabled = setScreenShareEnabled;

    await call.setScreenShareEnabled(true, { width: 1920, height: 1080, fps: 30 });
    const opts = setScreenShareEnabled.mock.calls[0][2];
    expect(opts.simulcast).toBe(false);
    expect(opts.screenShareSimulcastLayers).toBeUndefined();
    expect(opts.screenShareEncoding.maxBitrate).toBe(call.budget.screen);
  });

  it('leaves the encoder to its defaults when no ceiling was ever stated', async () => {
    stubCall();
    const { call } = watchedRoom();
    const setScreenShareEnabled = vi.fn(async () => ({}));
    call.room.localParticipant.setScreenShareEnabled = setScreenShareEnabled;

    await call.setScreenShareEnabled(true);
    expect(setScreenShareEnabled.mock.calls[0][2]).toEqual({ simulcast: true });
  });

  it('caps the camera the same way', async () => {
    stubCall();
    const { call } = watchedRoom();
    call.maxBitrate = 2_500_000;
    call.settleBudget({});
    const setCameraEnabled = vi.fn(async () => ({}));
    call.room.localParticipant.setCameraEnabled = setCameraEnabled;

    await call.setVideoEnabled(true);
    const [, capture, opts] = setCameraEnabled.mock.calls[0];
    expect(capture.resolution).toEqual({ width: 1280, height: 720, frameRate: 30 });
    const declared = opts.videoEncoding.maxBitrate
      + opts.videoSimulcastLayers.reduce((acc, p) => acc + p.encoding.maxBitrate, 0);
    expect(declared).toBeLessThanOrEqual(call.budget.camera);
    expect(opts.videoSimulcastLayers.length).toBeGreaterThan(0);
  });
});

describe('a share and the person sharing it are two sounds', () => {
  it('keeps the two levels apart on a mesh call', async () => {
    stubCall();
    const call = new MeshCall({ me: '@a:h', signal: vi.fn(async () => {}) });
    await call.start([]);
    call.sync(['@a:h', '@b:h']);
    const peer = call.peers.get('@b:h');
    peer.audio = { volume: 1 };
    peer.screenAudioEl = { volume: 1 };

    call.setShareVolume('@b:h', 0);
    expect(peer.screenAudioEl.volume).toBe(0);
    expect(peer.audio.volume).toBe(1);

    call.setVolume('@b:h', 50);
    expect(peer.audio.volume).toBe(0.5);
    expect(peer.screenAudioEl.volume).toBe(0);
  });

  it('amplifies a mesh participant above 100% without ever taking the element off their stream', async () => {
    stubCall();
    const call = new MeshCall({ me: '@a:h', signal: vi.fn(async () => {}) });
    await call.start([]);
    call.sync(['@a:h', '@b:h']);
    const peer = call.peers.get('@b:h');
    const stream = { id: 'remote-mic' };
    peer.audio = { volume: 1, srcObject: stream };
    peer.audioStream = stream;

    call.setVolume('@b:h', 200);

    expect(peer.audio.srcObject).toBe(stream);
    expect(peer.audio.volume).toBe(0);
    expect(peer.audioGraph.gain.gain.value).toBe(2);
    expect(peer.audioGraph.el.srcObject).toBe(peer.audioGraph.output.stream);
    expect(peer.audioGraph.el.volume).toBe(1);
    expect(document.body.contains(peer.audioGraph.el)).toBe(true);

    call.setVolume('@b:h', 125);
    expect(peer.audioGraph.gain.gain.value).toBe(1.25);
    const graph = peer.audioGraph;
    call.setVolume('@b:h', 999);
    expect(peer.audioGraph).toBe(graph);
    expect(peer.audioGraph.gain.gain.value).toBe(2);
    expect(peer.audio.volume).toBe(0);
  });

  it('takes the amplified element down with the peer', async () => {
    stubCall();
    const call = new MeshCall({ me: '@a:h', signal: vi.fn(async () => {}) });
    await call.start([]);
    call.sync(['@a:h', '@b:h']);
    const peer = call.peers.get('@b:h');
    const pump = { volume: 1, srcObject: { id: 'remote-mic' }, remove: vi.fn() };
    peer.audio = pump;
    peer.audioStream = { id: 'remote-mic' };

    call.setVolume('@b:h', 150);
    const el = peer.audioGraph.el;
    expect(document.body.contains(el)).toBe(true);

    call.drop('@b:h');
    expect(document.body.contains(el)).toBe(false);
    expect(el.srcObject).toBeNull();
    expect(pump.remove).toHaveBeenCalled();
  });

  it('deafens the amplified element as well as the one holding the stream', async () => {
    stubCall();
    const call = new MeshCall({ me: '@a:h', signal: vi.fn(async () => {}) });
    await call.start([]);
    call.sync(['@a:h', '@b:h']);
    const peer = call.peers.get('@b:h');
    peer.audio = { volume: 1, srcObject: { id: 'remote-mic' } };
    peer.audioStream = { id: 'remote-mic' };

    call.setVolume('@b:h', 150);
    expect(peer.audioGraph.el.muted).toBe(false);

    call.setDeafened(true);
    expect(peer.audio.muted).toBe(true);
    expect(peer.audioGraph.el.muted).toBe(true);

    call.setDeafened(false);
    expect(peer.audio.muted).toBe(false);
    expect(peer.audioGraph.el.muted).toBe(false);
  });

  it('opens a graph already mute if the peer is amplified while deafened', async () => {
    stubCall();
    const call = new MeshCall({ me: '@a:h', signal: vi.fn(async () => {}) });
    await call.start([]);
    call.sync(['@a:h', '@b:h']);
    const peer = call.peers.get('@b:h');
    peer.audio = { volume: 1, srcObject: { id: 'remote-mic' }, muted: true };
    peer.audioStream = { id: 'remote-mic' };

    call.setVolume('@b:h', 150);
    expect(peer.audioGraph.el.muted).toBe(true);
  });

  it('applies each remembered level to the element it belongs to as it arrives', async () => {
    stubCall();
    const call = new MeshCall({ me: '@a:h', signal: vi.fn(async () => {}) });
    await call.start([]);
    call.setVolume('@b:h', 40);
    call.setShareVolume('@b:h', 10);
    call.sync(['@a:h', '@b:h']);
    const peer = call.peers.get('@b:h');

    call.play('@b:h', peer, { id: 'mic' }, 'audio', false);
    call.play('@b:h', peer, { id: 'share' }, 'screenAudioEl', false);
    expect(peer.audio.volume).toBe(0.4);
    expect(peer.screenAudioEl.volume).toBe(0.1);
  });

  it('keeps the two levels apart on an SFU call', () => {
    const { call } = watchedRoom();
    const voice = { identity: '@b:h', source: Track.Source.Microphone, el: { volume: 1 } };
    const sound = { identity: '@b:h', source: Track.Source.ScreenShareAudio, el: { volume: 1 } };
    call.audioEls.set('@b:h/mic', voice);
    call.audioEls.set('@b:h/share', sound);

    call.setShareVolume('@b:h', 0);
    expect(sound.el.volume).toBe(0);
    expect(voice.el.volume).toBe(1);

    call.setVolume('@b:h', 20);
    expect(voice.el.volume).toBe(0.2);
    expect(sound.el.volume).toBe(0);
  });

  it('amplifies an SFU participant above 100% through a stage of its own', () => {
    stubCall();
    const { call } = watchedRoom();
    const stream = { id: 'remote-mic' };
    const voice = {
      identity: '@b:h',
      source: Track.Source.Microphone,
      el: { volume: 1, srcObject: stream, muted: false },
      stream,
      graph: null,
    };
    call.audioEls.set('@b:h/mic', voice);

    call.setVolume('@b:h', 175);

    expect(voice.el.srcObject).toBe(stream);
    expect(voice.el.volume).toBe(0);
    expect(voice.graph.gain.gain.value).toBe(1.75);
    expect(voice.graph.el.srcObject).toBe(voice.graph.output.stream);
    expect(voice.graph.el.volume).toBe(1);
    expect(document.body.contains(voice.graph.el)).toBe(true);

    call.setVolume('@b:h', 100);
    expect(voice.graph.gain.gain.value).toBe(1);
    expect(voice.el.volume).toBe(0);
  });

  it('deafens the amplified SFU element too', () => {
    stubCall();
    const { call } = watchedRoom();
    call.room.localParticipant.setMicrophoneEnabled = vi.fn(async () => ({}));
    const voice = {
      identity: '@b:h',
      source: Track.Source.Microphone,
      el: { volume: 1, srcObject: { id: 'remote-mic' }, muted: false },
      stream: { id: 'remote-mic' },
      graph: null,
    };
    call.audioEls.set('@b:h/mic', voice);

    call.setVolume('@b:h', 150);
    call.setDeafened(true);

    expect(voice.el.muted).toBe(true);
    expect(voice.graph.el.muted).toBe(true);
  });

  it('carries a level set before there were two of them over to the share', async () => {
    stubCall();
    const call = new MeshCall({ me: '@a:h', signal: vi.fn(async () => {}) });
    await call.start([]);
    call.setVolume('@b:h', 0);
    call.sync(['@a:h', '@b:h']);
    const peer = call.peers.get('@b:h');

    call.play('@b:h', peer, { id: 'share' }, 'screenAudioEl', false);
    expect(peer.screenAudioEl.volume).toBe(0);

    call.setVolume('@b:h', 60);
    expect(peer.screenAudioEl.volume).toBe(0.6);
    call.setShareVolume('@b:h', 10);
    call.setVolume('@b:h', 100);
    expect(peer.screenAudioEl.volume).toBe(0.1);
  });

  it('carries it over on an SFU call too', () => {
    const { call } = watchedRoom();
    const sound = { identity: '@b:h', source: Track.Source.ScreenShareAudio, el: { volume: 1 } };
    call.setVolume('@b:h', 0);
    call.audioEls.set('@b:h/share', sound);
    call.setVolume('@b:h', 0);
    expect(sound.el.volume).toBe(0);

    call.setShareVolume('@b:h', 50);
    call.setVolume('@b:h', 100);
    expect(sound.el.volume).toBe(0.5);
  });
});

describe('what a screenshare is of, on the wire', () => {
  it('publishes a game with the ladder and the preference that suit one', async () => {
    stubCall();
    const { call } = watchedRoom();
    call.maxBitrate = 2_500_000;
    call.settleBudget({ max_bitrate: 2_500_000 });
    const setScreenShareEnabled = vi.fn(async () => ({}));
    call.room.localParticipant.setScreenShareEnabled = setScreenShareEnabled;

    await call.setScreenShareEnabled(true, {
      width: 1920, height: 1080, fps: 60, content: 'motion', audio: true,
    });
    const opts = setScreenShareEnabled.mock.calls[0][2];
    expect(opts.degradationPreference).toBe('maintain-framerate');
    expect(opts.screenShareEncoding.maxFramerate).toBe(60);
    for (const layer of opts.screenShareSimulcastLayers) {
      expect(layer.encoding.maxFramerate).toBe(30);
    }
  });

  it('publishes a document the other way round out of the same budget', async () => {
    stubCall();
    const { call } = watchedRoom();
    call.maxBitrate = 2_500_000;
    call.settleBudget({ max_bitrate: 2_500_000 });
    const setScreenShareEnabled = vi.fn(async () => ({}));
    call.room.localParticipant.setScreenShareEnabled = setScreenShareEnabled;

    await call.setScreenShareEnabled(true, {
      width: 1920, height: 1080, fps: 15, content: 'detail', audio: true,
    });
    const opts = setScreenShareEnabled.mock.calls[0][2];
    expect(opts.degradationPreference).toBe('maintain-resolution');
    expect(opts.screenShareEncoding.maxBitrate).toBeGreaterThan(call.budget.screen * 0.8);
  });

  it('still says which way to give when no ceiling was ever stated', async () => {
    stubCall();
    const { call } = watchedRoom();
    const setScreenShareEnabled = vi.fn(async () => ({}));
    call.room.localParticipant.setScreenShareEnabled = setScreenShareEnabled;

    await call.setScreenShareEnabled(true, { content: 'motion' });
    expect(setScreenShareEnabled.mock.calls[0][2]).toEqual({
      simulcast: true, degradationPreference: 'maintain-framerate',
    });
  });

  it('does not ask LiveKit to capture audio the sharer turned off', async () => {
    stubCall();
    const { call } = watchedRoom();
    const setScreenShareEnabled = vi.fn(async () => ({}));
    call.room.localParticipant.setScreenShareEnabled = setScreenShareEnabled;

    await call.setScreenShareEnabled(true, { content: 'detail', audio: false });
    expect(setScreenShareEnabled.mock.calls[0][1]).toEqual({ audio: false });
  });

  it('stamps the hint on the track LiveKit captured for itself', async () => {
    stubCall();
    const { call } = watchedRoom();
    const mediaStreamTrack = fakeTrack('video');
    call.room.localParticipant.setScreenShareEnabled = vi.fn(async () => ({
      track: { mediaStreamTrack },
    }));

    await call.setScreenShareEnabled(true, { content: 'motion' });
    expect(mediaStreamTrack.contentHint).toBe('motion');
  });
});

function togglingRoom({ me = '@a:h' } = {}) {
  const listeners = new Map();
  const publications = new Map();
  let serial = 0;
  const emit = (event, ...args) => {
    for (const fn of listeners.get(event) || []) fn(...args);
  };
  const videoTrack = () => {
    serial += 1;
    return { id: `track-${serial}`, kind: 'video', stop: vi.fn() };
  };

  const localParticipant = {
    attributes: {},
    videoTrackPublications: publications,
    audioTrackPublications: new Map(),
    setCameraEnabled: vi.fn(async (on) => {
      const existing = publications.get(Track.Source.Camera);
      if (!on) {
        existing?.track.mediaStreamTrack.stop();
        if (existing) existing.muted = true;
        return existing;
      }
      if (existing) {
        existing.track.mediaStreamTrack = videoTrack();
        existing.muted = false;
        return existing;
      }
      const pub = {
        source: Track.Source.Camera,
        muted: false,
        track: {
          kind: Track.Kind.Video, source: Track.Source.Camera, mediaStreamTrack: videoTrack(),
        },
      };
      publications.set(Track.Source.Camera, pub);
      emit(RoomEvent.LocalTrackPublished, pub);
      return pub;
    }),
    setScreenShareEnabled: vi.fn(async (on) => {
      const existing = publications.get(Track.Source.ScreenShare);
      if (!on) {
        if (existing) {
          publications.delete(Track.Source.ScreenShare);
          existing.track.mediaStreamTrack.stop();
          emit(RoomEvent.LocalTrackUnpublished, existing);
        }
        return existing;
      }
      const pub = {
        source: Track.Source.ScreenShare,
        muted: false,
        track: {
          kind: Track.Kind.Video, source: Track.Source.ScreenShare, mediaStreamTrack: videoTrack(),
        },
      };
      publications.set(Track.Source.ScreenShare, pub);
      emit(RoomEvent.LocalTrackPublished, pub);
      return pub;
    }),
  };

  const call = new SfuCall({
    me, endpoint: 'https://sfu.example', joinToken: 'token', iceServers: [],
  });
  const previews = [];
  const shares = [];
  call.onCamera = (id, stream) => previews.push([id, stream]);
  call.onScreen = (id, stream) => shares.push([id, stream]);
  call.room = {
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(fn);
      return call.room;
    },
    remoteParticipants: new Map(),
    localParticipant,
  };
  call.live = true;
  call.wireEvents();
  return { call, previews, shares, publications };
}

const previewing = (call, id = '@a:h') => call.cameras.get(id)?.getVideoTracks()[0] ?? null;

describe('SfuCall local preview', () => {
  beforeEach(() => { vi.unstubAllGlobals(); });

  it('re-attaches the local preview every time the camera is turned off and on', async () => {
    stubCall();
    const { call, previews, publications } = togglingRoom();

    await call.setVideoEnabled(true);
    expect(previewing(call)).toBe(publications.get(Track.Source.Camera).track.mediaStreamTrack);

    for (let cycle = 2; cycle <= 5; cycle += 1) {
      await call.setVideoEnabled(false);
      expect(previewing(call)).toBeNull();

      await call.setVideoEnabled(true);
      const live = publications.get(Track.Source.Camera).track.mediaStreamTrack;
      expect(previewing(call), `start #${cycle} left the preview blank`).toBe(live);
    }

    expect(previews.map(([, stream]) => Boolean(stream)))
      .toEqual([true, false, true, false, true, false, true, false, true]);
  });

  it('does not hand the same camera track to the preview twice', async () => {
    stubCall();
    const { call, previews, publications } = togglingRoom();

    await call.setVideoEnabled(true);
    const pub = publications.get(Track.Source.Camera);
    call.onLocalTrack(pub);
    expect(previews).toHaveLength(1);
    expect(previewing(call)).toBe(pub.track.mediaStreamTrack);
  });

  it('re-attaches the local screen share across stop and start too', async () => {
    stubCall();
    const { call, shares, publications } = togglingRoom();

    for (let cycle = 1; cycle <= 3; cycle += 1) {
      await call.setScreenShareEnabled(true);
      const live = publications.get(Track.Source.ScreenShare).track.mediaStreamTrack;
      expect(call.screens.get('@a:h')?.getVideoTracks()[0], `share #${cycle} was blank`).toBe(live);

      await call.setScreenShareEnabled(false);
      expect(call.screens.get('@a:h')).toBeUndefined();
    }
    expect(shares.map(([, stream]) => Boolean(stream)))
      .toEqual([true, false, true, false, true, false]);
  });
});

describe('SfuCall seat removal', () => {
  function removedCall() {
    const listeners = new Map();
    const onError = vi.fn();
    const onDropped = vi.fn();
    const onRemoved = vi.fn();
    const call = new SfuCall({
      me: '@a:h', endpoint: 'https://sfu.example', joinToken: 'token', iceServers: [],
      onError, onDropped, onRemoved,
    });
    call.room = {
      on(event, fn) {
        if (!listeners.has(event)) listeners.set(event, []);
        listeners.get(event).push(fn);
        return call.room;
      },
    };
    call.wireEvents();
    call.live = true;
    const disconnect = (reason) => {
      for (const fn of listeners.get(RoomEvent.Disconnected) || []) fn(reason);
    };
    return { disconnect, onError, onDropped, onRemoved };
  }

  it('hands a server-initiated removal to the caller, not to the error list', () => {
    const { disconnect, onError, onDropped, onRemoved } = removedCall();
    disconnect(DisconnectReason.PARTICIPANT_REMOVED);
    expect(onRemoved).toHaveBeenCalledTimes(1);
    expect(onDropped).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it('reports nothing when nobody can react to a removal', () => {
    const listeners = new Map();
    const call = new SfuCall({
      me: '@a:h', endpoint: 'https://sfu.example', joinToken: 'token', iceServers: [],
    });
    call.room = {
      on(event, fn) {
        if (!listeners.has(event)) listeners.set(event, []);
        listeners.get(event).push(fn);
        return call.room;
      },
    };
    call.wireEvents();
    call.live = true;
    for (const fn of listeners.get(RoomEvent.Disconnected) || []) {
      fn(DisconnectReason.PARTICIPANT_REMOVED);
    }
    call.stop();
  });
});

describe('SfuCall token renewal', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  const renewingCall = async ({ sessionOk = true, renewOk = true } = {}) => {
    const sessions = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      const body = init?.body ? JSON.parse(init.body) : {};
      sessions.push({ url: String(url), body });
      if (!sessionOk) return { ok: false, status: 503, json: async () => ({}) };
      return {
        ok: true,
        json: async () => ({ url: 'wss://lk.example', token: 'lk-next', max_bitrate: 64_000 }),
      };
    }));
    const call = new SfuCall({
      me: '@a:h', endpoint: 'https://sfu.example', joinToken: 'join-1', iceServers: [],
      tokenTtl: 600,
      renewToken: renewOk ? vi.fn(async () => 'join-2') : vi.fn(async () => {
        throw new Error('offline');
      }),
    });
    call.live = true;
    call.room = { engine: { token: 'lk-old' }, localParticipant: { attributes: {} } };
    return { call, sessions };
  };

  it('spends a fresh join token at the session and installs the new grant', async () => {
    const { call, sessions } = await renewingCall();
    await call.renew();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].body.token).toBe('join-2');
    expect(call.joinToken).toBe('join-2');
    expect(call.room.engine.token).toBe('lk-next');
  });

  it('keeps the call on its feet when the renewal cannot land', async () => {
    const { call, sessions } = await renewingCall({ renewOk: false });
    await expect(call.renew()).resolves.toBe(false);
    expect(sessions).toHaveLength(0, 'no session is spent without a fresh token');
    expect(call.room.engine.token).toBe('lk-old');

    const failed = await renewingCall({ sessionOk: false });
    await expect(failed.call.renew()).resolves.toBe(false);
    expect(failed.call.room.engine.token).toBe('lk-old');
  });

  it('retries a failed renewal after a short pause, not a full half-TTL', async () => {
    vi.useFakeTimers();
    // A renewal that fails once, then lands.
    const call = new SfuCall({
      me: '@a:h', endpoint: 'https://sfu.example', joinToken: 'join-1', iceServers: [],
      tokenTtl: 600,
      renewToken: vi.fn()
        .mockImplementationOnce(async () => { throw new Error('offline'); })
        .mockImplementationOnce(async () => 'join-2'),
    });
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ url: 'wss://lk.example', token: 'lk-next', max_bitrate: 64_000 }),
    })));
    call.live = true;
    call.room = { engine: { token: 'lk-old' }, localParticipant: { attributes: {} } };

    call.scheduleRenew();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(call.renewToken).toHaveBeenCalledTimes(1);
    expect(call.room.engine.token).toBe('lk-old', 'the first attempt failed');

    await vi.advanceTimersByTimeAsync(30_000);
    expect(call.renewToken).toHaveBeenCalledTimes(2);
    expect(call.room.engine.token).toBe('lk-next');
    call.stop();
  });

  it('renews at half the token lifetime and stops when the call does', async () => {
    vi.useFakeTimers();
    const { call } = await renewingCall();
    call.scheduleRenew();
    expect(call.renewTimer).not.toBeNull();

    vi.advanceTimersByTime(299_999);
    expect(call.renewToken).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    await vi.waitFor(() => expect(call.room.engine.token).toBe('lk-next'));

    call.stop();
    expect(call.renewTimer).toBeNull();
    vi.advanceTimersByTime(10_000_000);
    expect(call.renewToken).toHaveBeenCalledTimes(1, 'no renewal after the call is gone');
  });

  it('says so once when the fresh grant cannot be installed on the room', async () => {
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { call } = await renewingCall();
    // An engine without its token property: what a livekit-client upgrade
    // that renamed it would look like.
    call.room = { engine: {}, localParticipant: { attributes: {} } };

    await expect(call.renew()).resolves.toBe(true, 'the grant was minted either way');
    expect(call.joinToken).toBe('join-2');
    expect(warned).toHaveBeenCalledTimes(1);
    expect(warned.mock.calls[0][0]).toContain('engine.token');

    await call.renew();
    expect(warned).toHaveBeenCalledTimes(1, 'the second renewal stays quiet');

    // A room with a usable engine installs again without another word.
    call.room = { engine: { token: 'lk-old' }, localParticipant: { attributes: {} } };
    await call.renew();
    expect(call.room.engine.token).toBe('lk-next');
    expect(warned).toHaveBeenCalledTimes(1);
    warned.mockRestore();
  });
});
