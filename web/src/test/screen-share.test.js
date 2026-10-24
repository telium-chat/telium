import { afterEach, describe, expect, it, vi } from 'vitest';
import { VideoQuality } from 'livekit-client';
import {
  DEFAULT_SCREEN_SHARE_CONTENT, SCREEN_SHARE_CONTENT, WATCH_QUALITIES, applyContentHint,
  applyDegradationPreference, contentPreset, displayAudioFailureReason, displayAudioSupport,
  displayAudioWarningReason, probeAudioTrackSignal, publishBudget,
  screenShareSettings, simulcastLadder, watchQualityLayer, withScreenShareConstraints,
} from '../lib/screenShare.js';

const sum = (ladder) => ladder.top.maxBitrate
  + ladder.layers.reduce((acc, l) => acc + l.encoding.maxBitrate, 0);

describe('the publish budget under the guild ceiling', () => {
  it('splits the ceiling so the parts never add up to more than it', () => {
    for (const cap of [64_000, 250_000, 1_000_000, 2_500_000, 8_000_000]) {
      const budget = publishBudget(cap);
      expect(budget.total).toBe(cap);
      expect(budget.audio * 2 + budget.camera + budget.screen).toBeLessThanOrEqual(cap);
      expect(budget.audio).toBeGreaterThan(0);
    }
  });

  it('gives a comfortable ceiling the full Opus rate and a camera slice', () => {
    expect(publishBudget(2_500_000)).toEqual({
      total: 2_500_000, audio: 48_000, camera: 480_800, screen: 1_923_200,
    });
  });

  it('keeps speech alive on a tiny ceiling by shrinking the video first', () => {
    const budget = publishBudget(64_000);
    expect(budget.audio).toBe(9_600);
    expect(budget.camera + budget.screen).toBe(64_000 - 2 * 9_600);
  });

  it('has nothing to say without a positive ceiling', () => {
    expect(publishBudget(0)).toBeNull();
    expect(publishBudget(-1)).toBeNull();
    expect(publishBudget(undefined)).toBeNull();
  });
});

describe('the simulcast ladder', () => {
  it('builds three layers for a 1080p share, halving each rung, under the budget', () => {
    const ladder = simulcastLadder({ width: 1920, height: 1080, fps: 30 }, 2_000_000);
    expect(ladder.layers.map((l) => [l.width, l.height])).toEqual([[480, 270], [960, 540]]);
    expect(ladder.layers[0].encoding.maxBitrate).toBeLessThan(ladder.layers[1].encoding.maxBitrate);
    expect(ladder.layers[1].encoding.maxBitrate).toBeLessThan(ladder.top.maxBitrate);
    expect(ladder.top.maxFramerate).toBe(30);
    expect(sum(ladder)).toBe(ladder.declared);
    expect(ladder.declared).toBeLessThanOrEqual(2_000_000);
  });

  it('steps the layer count down with the source size, the way LiveKit does', () => {
    expect(simulcastLadder({ width: 1280, height: 720 }, 4_000_000).layers).toHaveLength(2);
    expect(simulcastLadder({ width: 640, height: 480 }, 1_000_000).layers).toHaveLength(1);
    expect(simulcastLadder({ width: 320, height: 240 }, 1_000_000).layers).toHaveLength(0);
  });

  it('drops the bottom rungs when the budget cannot afford them', () => {
    const cramped = simulcastLadder({ width: 1920, height: 1080, fps: 30 }, 400_000);
    expect(cramped.layers).toHaveLength(1);
    expect(cramped.declared).toBeLessThanOrEqual(400_000);

    const starved = simulcastLadder({ width: 1920, height: 1080, fps: 30 }, 100_000);
    expect(starved.layers).toHaveLength(0);
    expect(starved.top.maxBitrate).toBe(100_000);
  });

  it('stays under every budget it is handed', () => {
    for (const budget of [50_000, 120_000, 333_333, 900_000, 1_923_200, 7_000_000]) {
      for (const source of [{ width: 3840, height: 2160, fps: 60 }, { width: 1280, height: 720, fps: 15 }]) {
        const ladder = simulcastLadder(source, budget);
        expect(ladder.declared).toBeLessThanOrEqual(budget);
        expect(ladder.top.maxBitrate).toBeGreaterThan(0);
        expect(ladder.top.maxFramerate).toBe(source.fps);
      }
    }
  });
});

describe('the watch quality vocabulary', () => {
  it('is the closed list the guild and the SFU share, in picker order', () => {
    expect(WATCH_QUALITIES).toEqual(['auto', 'low', 'medium', 'high']);
  });

  it('maps each named rung to the matching LiveKit layer and auto to none', () => {
    expect(watchQualityLayer('low')).toBe(VideoQuality.LOW);
    expect(watchQualityLayer('medium')).toBe(VideoQuality.MEDIUM);
    expect(watchQualityLayer('high')).toBe(VideoQuality.HIGH);
    expect(watchQualityLayer('auto')).toBeNull();
    expect(watchQualityLayer(undefined)).toBeNull();
    expect(watchQualityLayer('4k')).toBeNull();
  });
});

describe('screen share quality', () => {
  afterEach(() => vi.restoreAllMocks());

  it('maps the picker values to capture dimensions and a readable preset', () => {
    expect(screenShareSettings('1440p', 60, 'motion')).toEqual({
      width: 2560,
      height: 1440,
      fps: 60,
      content: 'motion',
      degradationPreference: 'maintain-framerate',
      audio: true,
      preset: 'motion 1440p@60',
    });
  });

  it('falls back to the content preset frame rate rather than an unrelated one', () => {
    expect(screenShareSettings('1080p', null, 'detail').fps).toBe(15);
    expect(screenShareSettings('1080p', null, 'motion').fps).toBe(60);
    expect(screenShareSettings('1080p', 23, 'motion').fps).toBe(60);
    expect(screenShareSettings('1080p', 30, 'detail').fps).toBe(30);
  });

  it('carries the share-audio answer through unchanged', () => {
    expect(screenShareSettings('1080p', 30, 'detail', false).audio).toBe(false);
    expect(screenShareSettings('1080p', 30, 'detail').audio).toBe(true);
  });

  it('asks for share audio without requiring a surface that cannot provide it', async () => {
    const original = vi.fn(async (constraints) => constraints);
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getDisplayMedia: original },
    });

    const result = await withScreenShareConstraints(
      screenShareSettings('1080p', 30),
      () => navigator.mediaDevices.getDisplayMedia({ video: true, audio: true }),
    );

    expect(result.audio).toEqual({ suppressLocalAudioPlayback: false });
    expect(result.systemAudio).toBe('include');
    expect(result.windowAudio).toBe('system');
  });

  it('applies the selected limits to the browser picker and restores it afterwards', async () => {
    const original = vi.fn(async (constraints) => constraints);
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getDisplayMedia: original },
    });

    const result = await withScreenShareConstraints(
      screenShareSettings('2160p', 60),
      () => navigator.mediaDevices.getDisplayMedia({ video: { cursor: 'always' }, audio: false }),
    );

    expect(result).toEqual({
      video: {
        cursor: 'always',
        width: { ideal: 3840 },
        height: { ideal: 2160 },
        frameRate: { ideal: 60 },
      },
      audio: false,
    });
    expect(navigator.mediaDevices.getDisplayMedia).toBe(original);
  });
});

describe('the content presets', () => {
  it('names two things a person can actually answer, not two codec modes', () => {
    expect(SCREEN_SHARE_CONTENT.map((item) => item.value)).toEqual(['detail', 'motion']);
    for (const item of SCREEN_SHARE_CONTENT) {
      expect(item.label).toMatch(/^A /);
      expect(item.label).not.toMatch(/bitrate|codec|simulcast|degradation|fps/i);
      expect(item.description.length).toBeGreaterThan(0);
    }
  });

  it('defaults to detail, and treats anything it does not know as that', () => {
    expect(DEFAULT_SCREEN_SHARE_CONTENT).toBe('detail');
    expect(contentPreset('nonsense').value).toBe('detail');
    expect(contentPreset(undefined).value).toBe('detail');
  });

  it('pairs each preset with the degradation preference that matches its promise', () => {
    expect(contentPreset('detail').degradation).toBe('maintain-resolution');
    expect(contentPreset('motion').degradation).toBe('maintain-framerate');
  });
});

describe('the content hint on the capture track', () => {
  const hintingTrack = (known) => {
    let value = '';
    return {
      get contentHint() { return value; },
      set contentHint(next) { if (known.includes(next)) value = next; },
    };
  };

  it('stamps text on a document share and motion on a game share', () => {
    const doc = hintingTrack(['text', 'detail', 'motion']);
    expect(applyContentHint(doc, 'detail')).toBe('text');
    expect(doc.contentHint).toBe('text');

    const game = hintingTrack(['text', 'detail', 'motion']);
    expect(applyContentHint(game, 'motion')).toBe('motion');
    expect(game.contentHint).toBe('motion');
  });

  it('falls back to detail where text is not recognised', () => {
    const track = hintingTrack(['detail', 'motion']);
    expect(applyContentHint(track, 'detail')).toBe('detail');
    expect(track.contentHint).toBe('detail');
  });

  it('says nothing stuck rather than throwing on a browser without hints', () => {
    expect(applyContentHint({}, 'detail')).toBeNull();
    expect(applyContentHint(null, 'detail')).toBeNull();
    const inert = hintingTrack([]);
    expect(applyContentHint(inert, 'motion')).toBeNull();
    expect(inert.contentHint).toBe('');
  });
});

describe('the ladder a content preset builds', () => {
  const source = { width: 1920, height: 1080, fps: 60 };

  it('spends the same budget either way, and carries the preference with it', () => {
    const detail = simulcastLadder(source, 2_000_000, 'detail');
    const motion = simulcastLadder(source, 2_000_000, 'motion');
    expect(detail.declared).toBeLessThanOrEqual(2_000_000);
    expect(motion.declared).toBeLessThanOrEqual(2_000_000);
    expect(detail.degradationPreference).toBe('maintain-resolution');
    expect(motion.degradationPreference).toBe('maintain-framerate');
  });

  it('gives detail a bigger top rung than motion out of the same budget', () => {
    const detail = simulcastLadder(source, 2_000_000, 'detail');
    const motion = simulcastLadder(source, 2_000_000, 'motion');
    expect(detail.top.maxBitrate).toBeGreaterThan(motion.top.maxBitrate);
    expect(motion.layers.length).toBeGreaterThanOrEqual(detail.layers.length);
  });

  it('halves the frame rate of the lower rungs for motion and leaves detail alone', () => {
    const motion = simulcastLadder(source, 4_000_000, 'motion');
    for (const layer of motion.layers) expect(layer.encoding.maxFramerate).toBe(30);
    expect(motion.top.maxFramerate).toBe(60);

    const detail = simulcastLadder({ ...source, fps: 15 }, 4_000_000, 'detail');
    for (const layer of detail.layers) expect(layer.encoding.maxFramerate).toBe(15);
  });

  it('states each rung as a scale factor as well as a size', () => {
    const ladder = simulcastLadder(source, 4_000_000, 'motion');
    for (const layer of ladder.layers) {
      expect(layer.width).toBe(Math.floor(1920 / layer.scaleResolutionDownBy));
      expect(layer.height).toBe(Math.floor(1080 / layer.scaleResolutionDownBy));
    }
  });

  it('leaves a camera on LiveKit proportions and with no preference at all', () => {
    const camera = simulcastLadder({ width: 1280, height: 720, fps: 30 }, 1_000_000);
    expect(camera.degradationPreference).toBeNull();
    for (const layer of camera.layers) expect(layer.encoding.maxFramerate).toBe(30);
  });
});

describe('display audio support', () => {
  afterEach(() => vi.restoreAllMocks());

  const withMedia = (value) => Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value,
  });

  it('predicts capture where the browser advertises the constraint that implies it', () => {
    withMedia({
      getDisplayMedia: vi.fn(),
      getSupportedConstraints: () => ({ suppressLocalAudioPlayback: true }),
    });
    expect(displayAudioSupport()).toEqual({ capture: true, likely: true, reason: null });
  });

  it('recognizes the Electron Linux PipeWire fallback as display-audio support', () => {
    const previous = globalThis.teliumDesktop;
    try {
      globalThis.teliumDesktop = { screenShareAudioFallback: true };
      withMedia({ getDisplayMedia: vi.fn(), getSupportedConstraints: () => ({}) });
      expect(displayAudioSupport()).toEqual({ capture: true, likely: true, reason: null });
    } finally {
      if (previous === undefined) delete globalThis.teliumDesktop;
      else globalThis.teliumDesktop = previous;
    }
  });

  it('warns, without refusing, where it does not', () => {
    withMedia({ getDisplayMedia: vi.fn(), getSupportedConstraints: () => ({}) });
    const support = displayAudioSupport();
    expect(support.capture).toBe(true);
    expect(support.likely).toBe(false);
    expect(support.reason).toMatch(/microphone/);
  });

  it('says so plainly when the browser cannot share a screen at all', () => {
    withMedia({});
    expect(displayAudioSupport().capture).toBe(false);
  });
});

describe('a browser that refuses the share audio', () => {
  afterEach(() => vi.restoreAllMocks());

  it('still starts the share, video only, when no audio track comes back', async () => {
    const video = { kind: 'video', contentHint: '' };
    const original = vi.fn(async () => ({
      getVideoTracks: () => [video],
      getAudioTracks: () => [],
    }));
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getDisplayMedia: original },
    });

    const stream = await withScreenShareConstraints(
      screenShareSettings('1080p', 30, 'motion'),
      () => navigator.mediaDevices.getDisplayMedia({ video: true, audio: true }),
    );

    expect(stream.getAudioTracks()).toHaveLength(0);
    expect(stream.getVideoTracks()).toHaveLength(1);
    expect(video.contentHint).toBe('motion');
  });

  it('does not ask for audio at all when the sharer turned it off', async () => {
    const original = vi.fn(async (constraints) => ({
      constraints, getVideoTracks: () => [], getAudioTracks: () => [],
    }));
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getDisplayMedia: original },
    });

    const stream = await withScreenShareConstraints(
      screenShareSettings('1080p', 30, 'detail', false),
      () => navigator.mediaDevices.getDisplayMedia({ video: true, audio: true }),
    );

    expect(stream.constraints.audio).toBe(false);
    expect(stream.constraints.systemAudio).toBeUndefined();
  });
});

describe('Linux desktop screenshare audio signal diagnostics', () => {
  function contextWith(samples) {
    let index = 0;
    return class {
      constructor() { this.state = 'running'; }
      createAnalyser() {
        return {
          fftSize: 256,
          getByteTimeDomainData(buffer) {
            const peak = samples[Math.min(index, samples.length - 1)] ?? 0;
            index += 1;
            buffer.fill(128);
            if (peak > 0) buffer[0] = 128 + peak;
          },
        };
      }
      createMediaStreamSource() {
        return { connect() {}, disconnect() {} };
      }
      close() { return Promise.resolve(); }
    };
  }

  class FakeMediaStream {
    constructor(tracks) { this.tracks = tracks; }
  }

  it('distinguishes an audio track carrying samples from one that merely exists', async () => {
    const track = { readyState: 'live' };
    const hasSignal = await probeAudioTrackSignal(track, {
      AudioContextCtor: contextWith([0, 0, 12]),
      MediaStreamCtor: FakeMediaStream,
      checks: 3,
      intervalMs: 0,
      wait: async () => {},
    });
    expect(hasSignal).toBe(true);
  });

  it('reports silence when every inspected audio frame is flat', async () => {
    const track = { readyState: 'live' };
    const hasSignal = await probeAudioTrackSignal(track, {
      AudioContextCtor: contextWith([0, 0, 0]),
      MediaStreamCtor: FakeMediaStream,
      checks: 3,
      intervalMs: 0,
      wait: async () => {},
    });
    expect(hasSignal).toBe(false);
  });

  it('does not call an ended or unsupported track silent', async () => {
    expect(await probeAudioTrackSignal({ readyState: 'ended' }, {
      AudioContextCtor: contextWith([0]),
      MediaStreamCtor: FakeMediaStream,
      checks: 1,
      wait: async () => {},
    })).toBeNull();

    expect(await probeAudioTrackSignal({ readyState: 'live' }, {
      AudioContextCtor: null,
      MediaStreamCtor: FakeMediaStream,
    })).toBeNull();
  });
});

describe('Linux desktop screenshare audio fallback', () => {
  const previousDesktop = globalThis.teliumDesktop;

  afterEach(() => {
    vi.restoreAllMocks();
    if (previousDesktop === undefined) delete globalThis.teliumDesktop;
    else globalThis.teliumDesktop = previousDesktop;
  });

  it('adds the PipeWire virtual input when display capture returned no audio', async () => {
    const videoListeners = {};
    const audioListeners = {};
    const video = {
      kind: 'video',
      contentHint: '',
      addEventListener: vi.fn((type, listener) => { videoListeners[type] = listener; }),
    };
    const audio = {
      kind: 'audio',
      stop: vi.fn(),
      addEventListener: vi.fn((type, listener) => { audioListeners[type] = listener; }),
    };
    const displayAudio = [];
    const displayStream = {
      getVideoTracks: () => [video],
      getAudioTracks: () => displayAudio,
      addTrack: vi.fn((track) => displayAudio.push(track)),
    };
    const capture = {
      getAudioTracks: () => [audio],
      getTracks: () => [audio],
    };
    const getDisplayMedia = vi.fn(async () => displayStream);
    let enumerations = 0;
    const enumerateDevices = vi.fn(async () => {
      enumerations += 1;
      if (enumerations <= 2) {
        return [{ kind: 'audioinput', label: 'Real microphone', deviceId: 'mic-real' }];
      }
      return [
        { kind: 'audioinput', label: 'Real microphone', deviceId: 'mic-real' },
        { kind: 'audioinput', label: '', deviceId: 'pipewire-virtual' },
      ];
    });
    const getUserMedia = vi.fn(async () => capture);
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getDisplayMedia, enumerateDevices, getUserMedia },
    });

    const start = vi.fn(async () => ({
      available: true,
      deviceLabel: 'vencord-screen-share',
    }));
    const stop = vi.fn(async () => true);
    globalThis.teliumDesktop = {
      screenShareAudioStart: start,
      screenShareAudioStop: stop,
    };

    const stream = await withScreenShareConstraints(
      screenShareSettings('1080p', 30, 'motion'),
      () => navigator.mediaDevices.getDisplayMedia({ video: true, audio: true }),
    );

    expect(start).toHaveBeenCalledTimes(1);
    expect(enumerateDevices).toHaveBeenCalledTimes(3);
    expect(start.mock.invocationCallOrder[0]).toBeLessThan(
      getDisplayMedia.mock.invocationCallOrder[0],
    );
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: {
        deviceId: { exact: 'pipewire-virtual' },
        autoGainControl: false,
        echoCancellation: false,
        noiseSuppression: false,
        channelCount: 2,
        sampleRate: 48_000,
        sampleSize: 16,
      },
      video: false,
    });
    expect(stream.getAudioTracks()).toEqual([audio]);
    expect(displayStream.addTrack).toHaveBeenCalledWith(audio);

    videoListeners.ended();
    expect(audio.stop).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);

    audioListeners.ended();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('keeps the native failure reason for the UI when venmic cannot start', async () => {
    const displayStream = {
      getVideoTracks: () => [],
      getAudioTracks: () => [],
      addTrack: vi.fn(),
    };
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getDisplayMedia: vi.fn(async () => displayStream),
        enumerateDevices: vi.fn(async () => []),
        getUserMedia: vi.fn(),
      },
    });

    globalThis.teliumDesktop = {
      screenShareAudioStart: vi.fn(async () => ({
        available: false,
        reason: 'pipewire connection unavailable',
      })),
      screenShareAudioStop: vi.fn(),
    };

    await withScreenShareConstraints(
      screenShareSettings('1080p', 30, 'motion'),
      () => navigator.mediaDevices.getDisplayMedia({ video: true, audio: true }),
    );

    expect(displayAudioFailureReason()).toBe('pipewire connection unavailable');
  });

  it('warns when venmic created a track but saw zero shareable PipeWire playback streams', async () => {
    const audio = { kind: 'audio', stop: vi.fn(), addEventListener: vi.fn() };
    const audioTracks = [];
    const displayStream = {
      getVideoTracks: () => [],
      getAudioTracks: () => audioTracks,
      addTrack: vi.fn((track) => audioTracks.push(track)),
      removeTrack: vi.fn(),
    };
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getDisplayMedia: vi.fn(async () => displayStream),
        enumerateDevices: vi.fn(async () => [
          { kind: 'audioinput', label: 'vencord-screen-share', deviceId: 'pipewire-virtual' },
        ]),
        getUserMedia: vi.fn(async () => ({
          getAudioTracks: () => [audio],
          getTracks: () => [audio],
        })),
      },
    });

    globalThis.teliumDesktop = {
      screenShareAudioStart: vi.fn(async () => ({
        available: true,
        deviceLabel: 'vencord-screen-share',
        hasPipewirePulse: true,
        targetCount: 0,
      })),
      screenShareAudioStop: vi.fn(),
    };

    await withScreenShareConstraints(
      screenShareSettings('1080p', 30, 'motion'),
      () => navigator.mediaDevices.getDisplayMedia({ video: true, audio: true }),
    );

    expect(displayAudioWarningReason()).toMatch(/zero|no shareable|no .*playback/i);
  });

  it('warns when pipewire-pulse is absent even if the virtual track is available', async () => {
    const audio = { kind: 'audio', stop: vi.fn(), addEventListener: vi.fn() };
    const audioTracks = [];
    const displayStream = {
      getVideoTracks: () => [],
      getAudioTracks: () => audioTracks,
      addTrack: vi.fn((track) => audioTracks.push(track)),
      removeTrack: vi.fn(),
    };
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getDisplayMedia: vi.fn(async () => displayStream),
        enumerateDevices: vi.fn(async () => [
          { kind: 'audioinput', label: 'vencord-screen-share', deviceId: 'pipewire-virtual' },
        ]),
        getUserMedia: vi.fn(async () => ({
          getAudioTracks: () => [audio],
          getTracks: () => [audio],
        })),
      },
    });

    globalThis.teliumDesktop = {
      screenShareAudioStart: vi.fn(async () => ({
        available: true,
        deviceLabel: 'vencord-screen-share',
        hasPipewirePulse: false,
      })),
      screenShareAudioStop: vi.fn(),
    };

    await withScreenShareConstraints(
      screenShareSettings('1080p', 30, 'motion'),
      () => navigator.mediaDevices.getDisplayMedia({ video: true, audio: true }),
    );

    expect(displayAudioWarningReason()).toMatch(/pipewire-pulse/i);
  });

  it('tears the pre-armed PipeWire source down when the picker is cancelled', async () => {
    const getDisplayMedia = vi.fn(async () => {
      const error = new Error('cancelled');
      error.name = 'AbortError';
      throw error;
    });
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getDisplayMedia,
        enumerateDevices: vi.fn(async () => []),
        getUserMedia: vi.fn(),
      },
    });

    const start = vi.fn(async () => ({
      available: true,
      deviceLabel: 'vencord-screen-share',
    }));
    const stop = vi.fn(async () => true);
    globalThis.teliumDesktop = {
      screenShareAudioStart: start,
      screenShareAudioStop: stop,
    };

    await expect(withScreenShareConstraints(
      screenShareSettings('1080p', 30, 'motion'),
      () => navigator.mediaDevices.getDisplayMedia({ video: true, audio: true }),
    )).rejects.toMatchObject({ name: 'AbortError' });

    expect(start).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('replaces a Linux Chromium audio track with venmic instead of trusting a silent track', async () => {
    const nativeAudio = { kind: 'audio', stop: vi.fn() };
    const virtualAudio = { kind: 'audio', stop: vi.fn(), addEventListener: vi.fn() };
    const audioTracks = [nativeAudio];
    const displayStream = {
      getVideoTracks: () => [],
      getAudioTracks: () => audioTracks,
      removeTrack: vi.fn((track) => {
        const index = audioTracks.indexOf(track);
        if (index >= 0) audioTracks.splice(index, 1);
      }),
      addTrack: vi.fn((track) => audioTracks.push(track)),
    };
    const getDisplayMedia = vi.fn(async () => displayStream);
    const enumerateDevices = vi.fn(async () => [
      { kind: 'audioinput', label: 'vencord-screen-share', deviceId: 'pipewire-virtual' },
    ]);
    const getUserMedia = vi.fn(async () => ({
      getAudioTracks: () => [virtualAudio],
      getTracks: () => [virtualAudio],
    }));
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getDisplayMedia, enumerateDevices, getUserMedia },
    });

    const start = vi.fn(async () => ({
      available: true,
      deviceLabel: 'vencord-screen-share',
    }));
    globalThis.teliumDesktop = {
      screenShareAudioStart: start,
      screenShareAudioStop: vi.fn(),
    };

    const stream = await withScreenShareConstraints(
      screenShareSettings('1080p', 30, 'motion'),
      () => navigator.mediaDevices.getDisplayMedia({ video: true, audio: true }),
    );

    expect(start).toHaveBeenCalledTimes(1);
    expect(displayStream.removeTrack).toHaveBeenCalledWith(nativeAudio);
    expect(nativeAudio.stop).toHaveBeenCalledTimes(1);
    expect(displayStream.addTrack).toHaveBeenCalledWith(virtualAudio);
    expect(stream.getAudioTracks()).toEqual([virtualAudio]);
  });

  it('keeps native display audio when no Linux desktop bridge exists', async () => {
    const nativeAudio = { kind: 'audio' };
    const displayStream = {
      getVideoTracks: () => [],
      getAudioTracks: () => [nativeAudio],
      addTrack: vi.fn(),
    };
    const getDisplayMedia = vi.fn(async () => displayStream);
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getDisplayMedia },
    });
    delete globalThis.teliumDesktop;

    const stream = await withScreenShareConstraints(
      screenShareSettings('1080p', 30, 'motion'),
      () => navigator.mediaDevices.getDisplayMedia({ video: true, audio: true }),
    );

    expect(stream.getAudioTracks()).toEqual([nativeAudio]);
    expect(displayStream.addTrack).not.toHaveBeenCalled();
  });
});

describe('the degradation preference on a live sender', () => {
  it('sets the preference the content asked for', async () => {
    const params = { encodings: [{}] };
    const sender = { getParameters: () => params, setParameters: vi.fn(async () => {}) };
    expect(await applyDegradationPreference(sender, 'maintain-resolution')).toBe(true);
    expect(sender.setParameters).toHaveBeenCalledWith(
      expect.objectContaining({ degradationPreference: 'maintain-resolution' }),
    );
  });

  it('leaves a sender that already agrees alone', async () => {
    const sender = {
      getParameters: () => ({ degradationPreference: 'maintain-framerate' }),
      setParameters: vi.fn(async () => {}),
    };
    expect(await applyDegradationPreference(sender, 'maintain-framerate')).toBe(false);
    expect(sender.setParameters).not.toHaveBeenCalled();
  });

  it('swallows a browser that will not take one, because a share is not worth it', async () => {
    const sender = {
      getParameters: () => ({}),
      setParameters: async () => { throw new Error('unimplemented'); },
    };
    expect(await applyDegradationPreference(sender, 'maintain-resolution')).toBe(false);
    expect(await applyDegradationPreference(null, 'maintain-resolution')).toBe(false);
    expect(await applyDegradationPreference({ getParameters: () => ({}) }, null)).toBe(false);
  });
});
