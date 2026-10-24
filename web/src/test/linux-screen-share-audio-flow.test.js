import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Track } from 'livekit-client';
import { MeshCall, SfuCall } from '../lib/voice.js';
import { screenShareSettings, withScreenShareConstraints } from '../lib/screenShare.js';
import { FakePC, fakeTrack, stubMedia } from './fake-webrtc.js';

function linuxCaptureHarness() {
  const base = stubMedia();
  const video = fakeTrack('video');
  const chromiumAudio = fakeTrack('audio');
  const venmicAudio = fakeTrack('audio');
  const tracks = [video, chromiumAudio];

  const displayStream = {
    getTracks: () => tracks,
    getVideoTracks: () => tracks.filter((track) => track.kind === 'video'),
    getAudioTracks: () => tracks.filter((track) => track.kind === 'audio'),
    addTrack: vi.fn((track) => tracks.push(track)),
    removeTrack: vi.fn((track) => {
      const index = tracks.indexOf(track);
      if (index >= 0) tracks.splice(index, 1);
    }),
  };
  const virtualCapture = {
    getTracks: () => [venmicAudio],
    getAudioTracks: () => [venmicAudio],
    getVideoTracks: () => [],
  };

  const media = navigator.mediaDevices;
  const originalUserMedia = media.getUserMedia;
  let enumeration = 0;
  media.getDisplayMedia = vi.fn(async (constraints = {}) => {
    if (constraints.audio === false) {
      return {
        getTracks: () => [video],
        getVideoTracks: () => [video],
        getAudioTracks: () => [],
        addTrack: vi.fn(),
        removeTrack: vi.fn(),
      };
    }
    return displayStream;
  });
  media.enumerateDevices = vi.fn(async () => {
    enumeration += 1;
    if (enumeration === 1) {
      return [{ kind: 'audioinput', deviceId: 'real-mic', label: 'Real microphone' }];
    }
    return [
      { kind: 'audioinput', deviceId: 'real-mic', label: 'Real microphone' },
      { kind: 'audioinput', deviceId: 'venmic-device', label: 'vencord-screen-share' },
    ];
  });
  media.getUserMedia = vi.fn(async (constraints) => {
    if (constraints?.audio?.deviceId?.exact === 'venmic-device') return virtualCapture;
    return originalUserMedia(constraints);
  });

  const start = vi.fn(async () => ({
    available: true,
    deviceLabel: 'vencord-screen-share',
    hasPipewirePulse: true,
    targetCount: 1,
  }));
  const stop = vi.fn(async () => true);
  globalThis.teliumDesktop = {
    screenShareAudioFallback: true,
    screenShareAudioStart: start,
    screenShareAudioStop: stop,
  };

  return {
    ...base,
    displayStream,
    chromiumAudio,
    venmicAudio,
    start,
    stop,
  };
}

describe('Linux screenshare audio from capture to listener', () => {
  beforeEach(() => {
    FakePC.all = [];
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    delete globalThis.teliumDesktop;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('sends the venmic track on the mesh screen-audio transceiver and the viewer plays that same track', async () => {
    const { chromiumAudio, venmicAudio } = linuxCaptureHarness();
    const call = new MeshCall({ me: '@sharer:h', signal: vi.fn(async () => {}) });
    await call.start([]);
    call.sync(['@viewer:h']);

    const settings = screenShareSettings('1080p', 30, 'motion', true);
    expect(await withScreenShareConstraints(
      settings,
      () => call.setScreenShareEnabled(true, settings),
    )).toBe(true);

    const peer = call.peers.get('@viewer:h');
    expect(chromiumAudio.stop).toHaveBeenCalledTimes(1);
    expect(call.screen.getAudioTracks()).toEqual([venmicAudio]);
    expect(peer.screenAudio.sender.track).toBe(venmicAudio);
    expect(peer.screenAudio.direction).toBe('sendrecv');

    const remoteAudio = fakeTrack('audio');
    const received = new MediaStream([remoteAudio]);
    peer.pc.receive(remoteAudio, [received], peer.screenAudio);

    expect(peer.screenAudioEl).toBeTruthy();
    expect(peer.screenAudioEl.srcObject).toBe(received);
    expect(peer.screenAudioEl.srcObject.getAudioTracks()).toEqual([remoteAudio]);
    expect(peer.screenAudioEl.muted).toBe(false);
    expect(peer.screenAudioEl.volume).toBe(1);
    expect(peer.screenAudioEl.play).toHaveBeenCalled();

    call.stop();
  });

  it('hands LiveKit the venmic track, publishes it as ScreenShareAudio, and reports audio only for that publication', async () => {
    const { chromiumAudio, venmicAudio } = linuxCaptureHarness();
    const audioTrackPublications = new Map();
    const videoTrackPublications = new Map();

    const localParticipant = {
      audioTrackPublications,
      videoTrackPublications,
      setScreenShareEnabled: vi.fn(async (on) => {
        if (!on) {
          audioTrackPublications.clear();
          videoTrackPublications.clear();
          return undefined;
        }

        const captured = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
        const [video] = captured.getVideoTracks();
        const [audio] = captured.getAudioTracks();

        const screen = {
          source: Track.Source.ScreenShare,
          track: { source: Track.Source.ScreenShare, mediaStreamTrack: video },
        };
        videoTrackPublications.set('screen-video', screen);
        if (audio) {
          audioTrackPublications.set('screen-audio', {
            source: Track.Source.ScreenShareAudio,
            track: { source: Track.Source.ScreenShareAudio, mediaStreamTrack: audio },
          });
        }
        return screen;
      }),
    };

    const call = new SfuCall({
      me: '@sharer:h',
      endpoint: 'https://sfu.example',
      joinToken: 'token',
      iceServers: [],
    });
    call.room = {
      localParticipant,
      remoteParticipants: new Map(),
    };

    const settings = screenShareSettings('1080p', 30, 'motion', true);
    expect(await withScreenShareConstraints(
      settings,
      () => call.setScreenShareEnabled(true, settings),
    )).toBe(true);

    expect(chromiumAudio.stop).toHaveBeenCalledTimes(1);
    const publishedAudio = [...audioTrackPublications.values()];
    expect(publishedAudio).toHaveLength(1);
    expect(publishedAudio[0].source).toBe(Track.Source.ScreenShareAudio);
    expect(publishedAudio[0].track.mediaStreamTrack).toBe(venmicAudio);
    expect(call.screenShareHasAudio()).toBe(true);

    call.stop();
  });

  it('attaches a subscribed LiveKit ScreenShareAudio track to a real document audio element', async () => {
    const { venmicAudio } = linuxCaptureHarness();
    const call = new SfuCall({
      me: '@viewer:h',
      endpoint: 'https://sfu.example',
      joinToken: 'token',
      iceServers: [],
    });
    call.room = { remoteParticipants: new Map() };

    const attached = vi.fn();
    const livekitTrack = {
      kind: Track.Kind.Audio,
      source: Track.Source.ScreenShareAudio,
      attach: vi.fn((element) => {
        const stream = new MediaStream([venmicAudio]);
        element.srcObject = stream;
        attached(stream);
        return element;
      }),
    };
    const publication = {
      kind: Track.Kind.Audio,
      source: Track.Source.ScreenShareAudio,
    };
    const participant = { identity: '@sharer:h' };

    call.onTrack(livekitTrack, publication, participant);

    const entry = call.audioEls.get(call.audioKey('@sharer:h', Track.Source.ScreenShareAudio));
    expect(livekitTrack.attach).toHaveBeenCalledTimes(1);
    expect(attached).toHaveBeenCalledTimes(1);
    expect(entry).toBeTruthy();
    expect(document.body.contains(entry.el)).toBe(true);
    expect(entry.el.srcObject.getAudioTracks()).toEqual([venmicAudio]);
    expect(entry.el.muted).toBe(false);
    expect(entry.el.volume).toBe(1);
    expect(entry.el.play).toHaveBeenCalled();

    call.stop();
  });

  it('never starts venmic when the sharer turns screen audio off', async () => {
    const { start } = linuxCaptureHarness();
    const call = new MeshCall({ me: '@sharer:h', signal: vi.fn(async () => {}) });
    await call.start([]);
    call.sync(['@viewer:h']);

    const settings = screenShareSettings('1080p', 30, 'motion', false);
    expect(await withScreenShareConstraints(
      settings,
      () => call.setScreenShareEnabled(true, settings),
    )).toBe(true);

    expect(start).not.toHaveBeenCalled();
    expect(call.peers.get('@viewer:h').screenAudio.sender.track).toBeNull();

    call.stop();
  });
});
