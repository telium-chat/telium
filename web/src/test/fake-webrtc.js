import { vi } from 'vitest';

export class FakePC {
  static all = [];

  constructor(config) {
    this.config = config;
    this.signalingState = 'stable';
    this.connectionState = 'new';
    this.localDescription = null;
    this.remoteDescription = null;
    this.transceivers = [];
    this.candidates = [];
    this.restarts = 0;
    this.closed = false;
    this.needed = false;
    FakePC.all.push(this);
  }

  addTransceiver(trackOrKind, init = {}) {
    const pc = this;
    const transceiver = {
      current: init.direction || 'sendrecv',
      streams: init.streams || [],
      sender: {
        track: typeof trackOrKind === 'string' ? null : trackOrKind,
        replaceTrack(track) { this.track = track; return Promise.resolve(); },
        params: { encodings: [{}] },
        getParameters() { return this.params; },
        setParameters(params) { this.params = params; return Promise.resolve(); },
      },
      get direction() { return this.current; },
      set direction(value) {
        if (value === this.current) return;
        this.current = value;
        pc.negotiate();
      },
    };
    this.transceivers.push(transceiver);
    this.negotiate();
    return transceiver;
  }

  negotiate() {
    this.needed = true;
    setTimeout(() => {
      if (this.needed && this.signalingState === 'stable') this.onnegotiationneeded?.();
    }, 0);
  }

  async setLocalDescription(desc) {
    const type = desc?.type
      || (this.signalingState === 'have-remote-offer' ? 'answer' : 'offer');
    this.localDescription = { type, sdp: `local-${type}` };
    this.signalingState = type === 'offer' ? 'have-local-offer' : 'stable';
    this.needed = false;
  }

  async setRemoteDescription(desc) {
    if (desc.type === 'answer' && this.signalingState !== 'have-local-offer') {
      throw new Error('Failed to set remote answer sdp: called in wrong state');
    }
    this.remoteDescription = desc;
    this.signalingState = desc.type === 'offer' ? 'have-remote-offer' : 'stable';
  }

  async addIceCandidate(candidate) {
    if (!this.remoteDescription) throw new Error('the remote description was null');
    this.candidates.push(candidate);
  }

  restartIce() { this.restarts += 1; this.negotiate(); }
  close() { this.closed = true; }

  settle(state) { this.connectionState = state; this.onconnectionstatechange?.(); }

  receive(track = { kind: 'audio' }, streams = [], transceiver = undefined) {
    this.ontrack?.({ track, streams, transceiver });
  }
}

export function fakeTrack(kind = 'audio') {
  const listeners = new Map();
  let hint = '';
  return {
    kind,
    enabled: true,
    muted: false,
    stop: vi.fn(),
    get contentHint() { return hint; },
    set contentHint(value) {
      if (['', 'text', 'detail', 'motion'].includes(value)) hint = value;
    },
    addEventListener(type, fn) {
      listeners.set(type, [...(listeners.get(type) || []), fn]);
    },
    emit(type) {
      for (const fn of listeners.get(type) || []) fn();
    },
  };
}

const audioTrack = () => fakeTrack('audio');

function fakeStream(kind) {
  const tracks = [fakeTrack(kind)];
  const video = kind === 'video';
  return [{
    getTracks: () => tracks,
    getVideoTracks: () => (video ? tracks : []),
    getAudioTracks: () => (video ? [] : tracks),
  }, tracks];
}

export function stubMedia() {
  FakePC.all = [];
  const [stream, tracks] = fakeStream('audio');
  const [screen, screenVideoTracks] = fakeStream('video');
  const screenAudioTracks = [fakeTrack('audio')];
  const screenTracks = [...screenVideoTracks, ...screenAudioTracks];
  screen.getTracks = () => screenTracks;
  screen.getVideoTracks = () => screenVideoTracks;
  screen.getAudioTracks = () => screenAudioTracks;
  const [camera, cameraTracks] = fakeStream('video');
  vi.stubGlobal('RTCPeerConnection', FakePC);
  vi.stubGlobal('MediaStream', class {
    constructor(of = []) { this.tracks = of; }
    getTracks() { return this.tracks; }
    getAudioTracks() { return this.tracks.filter((t) => t.kind !== 'video'); }
    getVideoTracks() { return this.tracks.filter((t) => t.kind === 'video'); }
  });
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: vi.fn(async (constraints) => (constraints?.video ? camera : stream)),
      getDisplayMedia: vi.fn(async () => screen),
      getSupportedConstraints: () => ({ suppressLocalAudioPlayback: true }),
    },
  });
  vi.stubGlobal('AudioContext', class {
    createAnalyser() {
      return {
        fftSize: 0,
        frequencyBinCount: 8,
        getByteTimeDomainData: (buffer) => buffer.fill(128),
      };
    }
    createMediaStreamSource() { return { connect: () => {}, disconnect: () => {} }; }
    createGain() {
      return { gain: { value: 1 }, connect: () => {}, disconnect: () => {} };
    }
    createMediaStreamDestination() {
      return { stream: new MediaStream([fakeTrack('audio')]) };
    }
    resume() { return Promise.resolve(); }
    close() { return Promise.resolve(); }
  });
  HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve());
  return {
    stream, tracks, screen, screenTracks, screenVideoTracks, screenAudioTracks,
    camera, cameraTracks,
  };
}

export function stubCall() {
  const media = stubMedia();
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  return media;
}

export const settle = () => new Promise((r) => setTimeout(r, 0));
