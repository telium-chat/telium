import { VideoQuality } from 'livekit-client';
import { sleep } from './util.js';

/// `telium_protocol::WATCH_QUALITIES`, in picker order; `auto` leaves the choice to LiveKit.
export const WATCH_QUALITIES = ['auto', 'low', 'medium', 'high'];

export function watchQualityLayer(quality) {
  switch (quality) {
    case 'low': return VideoQuality.LOW;
    case 'medium': return VideoQuality.MEDIUM;
    case 'high': return VideoQuality.HIGH;
    default: return null;
  }
}

const AUDIO_BITRATE = 48_000;
const AUDIO_FLOOR = 6_000;
const CAMERA_MAX = 1_500_000;
const LAYER_FLOOR = 80_000;

/// Splits a publish ceiling (bps) between mic and share audio (Opus budgets), the camera, and the screen share (the remainder).
export function publishBudget(cap) {
  const total = Math.max(0, Math.floor(Number(cap) || 0));
  if (total <= 0) return null;
  const audio = Math.min(AUDIO_BITRATE, Math.max(AUDIO_FLOOR, Math.floor(total * 0.15)));
  const video = Math.max(0, total - audio * 2);
  const camera = Math.min(CAMERA_MAX, Math.floor(video * 0.2));
  const screen = Math.max(0, video - camera);
  return { total, audio, camera, screen };
}

/// `hints` are `contentHint` values tried in order; `degradation` is the `RTCDegradationPreference`; `shares` splits the simulcast budget; `layerFpsDivisor` slows the lower rungs.
export const SCREEN_SHARE_CONTENT = [
  {
    value: 'detail',
    label: 'A document or code',
    description: 'Sharp text. Fewer frames a second, every pixel kept.',
    hints: ['text', 'detail'],
    degradation: 'maintain-resolution',
    fps: 15,
    // Weighted towards the top rung: small rungs of text are unreadable.
    shares: { 3: [1 / 32, 1 / 8, 1], 2: [1 / 8, 1], 1: [1] },
    layerFpsDivisor: 1,
  },
  {
    value: 'motion',
    label: 'A game or video',
    description: 'Smooth motion. Softens before it stutters when the link tightens.',
    hints: ['motion'],
    degradation: 'maintain-framerate',
    fps: 60,
    shares: { 3: [1 / 8, 1 / 3, 1], 2: [1 / 3, 1], 1: [1] },
    layerFpsDivisor: 2,
  },
];

export const DEFAULT_SCREEN_SHARE_CONTENT = 'detail';

export function contentPreset(content = DEFAULT_SCREEN_SHARE_CONTENT) {
  return SCREEN_SHARE_CONTENT.find((item) => item.value === content)
    || SCREEN_SHARE_CONTENT[0];
}

/// Assigning an unrecognised `contentHint` leaves the old value, so reading it back is the feature detection.
export function applyContentHint(track, content) {
  if (!track || !('contentHint' in track)) return null;
  for (const hint of contentPreset(content).hints) {
    try { track.contentHint = hint; } catch { return null; }
    if (track.contentHint === hint) return hint;
  }
  return null;
}

/// Mirrors livekit-client's presets (three layers from 960px, two from 480px); layers under `LAYER_FLOOR` are dropped; `layers` excludes the top.
export function simulcastLadder({ width, height, fps = 30 }, budget, content = null) {
  const w = Math.max(1, Math.floor(Number(width) || 0));
  const h = Math.max(1, Math.floor(Number(height) || 0));
  const maxFramerate = Math.max(1, Math.floor(Number(fps) || 30));
  const total = Math.max(1, Math.floor(Number(budget) || 0));
  const size = Math.max(w, h);
  let count = size >= 960 ? 3 : size >= 480 ? 2 : 1;

  const preset = content ? contentPreset(content) : null;
  const shares = preset?.shares || { 3: [1 / 16, 1 / 4, 1], 2: [1 / 4, 1], 1: [1] };
  const divisor = preset?.layerFpsDivisor || 1;
  const layerFramerate = Math.max(1, Math.min(maxFramerate, Math.floor(maxFramerate / divisor)));
  for (;;) {
    const ratios = shares[count];
    const top = Math.floor(total / ratios.reduce((sum, r) => sum + r, 0));
    const bitrates = ratios.map((r) => Math.floor(top * r));
    if (count === 1 || bitrates[0] >= LAYER_FLOOR) {
      const layers = bitrates.slice(0, -1).map((maxBitrate, index) => {
        const scale = 2 ** (count - 1 - index);
        return {
          width: Math.floor(w / scale),
          height: Math.floor(h / scale),
          scaleResolutionDownBy: scale,
          encoding: { maxBitrate, maxFramerate: layerFramerate },
        };
      });
      return {
        top: { maxBitrate: bitrates[count - 1], maxFramerate },
        layers,
        declared: bitrates.reduce((sum, b) => sum + b, 0),
        degradationPreference: preset?.degradation || null,
      };
    }
    count -= 1;
  }
}

export const SCREEN_SHARE_QUALITIES = [
  { value: '720p', label: '720p (HD)', width: 1280, height: 720 },
  { value: '1080p', label: '1080p (Full HD)', width: 1920, height: 1080 },
  { value: '1440p', label: '1440p (QHD)', width: 2560, height: 1440 },
  { value: '2160p', label: '4K (2160p)', width: 3840, height: 2160 },
];

export const SCREEN_SHARE_FPS = [15, 30, 60];

let latestDisplayAudioFailure = null;
let latestDisplayAudioWarning = null;
let latestDesktopAudioTrack = null;

export function displayAudioFailureReason() {
  return latestDisplayAudioFailure;
}

export function displayAudioWarningReason() {
  return latestDisplayAudioWarning;
}

export async function probeAudioTrackSignal(track, {
  AudioContextCtor = globalThis.AudioContext || globalThis.webkitAudioContext,
  MediaStreamCtor = globalThis.MediaStream,
  checks = 20,
  intervalMs = 100,
  threshold = 2,
  wait = sleep,
} = {}) {
  if (!track || typeof AudioContextCtor !== 'function' || typeof MediaStreamCtor !== 'function') {
    return null;
  }

  let context = null;
  let source = null;
  try {
    context = new AudioContextCtor();
    if (context.state === 'suspended' && typeof context.resume === 'function') {
      await context.resume();
    }
    const analyser = context.createAnalyser();
    analyser.fftSize = 256;
    source = context.createMediaStreamSource(new MediaStreamCtor([track]));
    source.connect(analyser);

    const data = new Uint8Array(analyser.fftSize || 256);
    const rounds = Math.max(1, Number(checks) || 1);
    for (let round = 0; round < rounds; round += 1) {
      if (track.readyState === 'ended') return null;
      analyser.getByteTimeDomainData(data);
      let peak = 0;
      for (const value of data) peak = Math.max(peak, Math.abs(value - 128));
      if (peak > threshold) return true;
      if (round + 1 < rounds) await wait(intervalMs);
    }
    return false;
  } catch {
    return null;
  } finally {
    try { source?.disconnect?.(); } catch { /* best effort */ }
    try { await context?.close?.(); } catch { /* best effort */ }
  }
}

export function probeLatestDesktopAudioSignal(options) {
  if (!latestDesktopAudioTrack) return null;
  return probeAudioTrackSignal(latestDesktopAudioTrack, options);
}

export function screenShareSettings(
  quality = '1080p',
  fps = null,
  content = DEFAULT_SCREEN_SHARE_CONTENT,
  audio = true,
) {
  const picked = SCREEN_SHARE_QUALITIES.find((item) => item.value === quality)
    || SCREEN_SHARE_QUALITIES[1];
  const preset = contentPreset(content);
  const frameRate = SCREEN_SHARE_FPS.includes(Number(fps)) ? Number(fps) : preset.fps;
  return {
    width: picked.width,
    height: picked.height,
    fps: frameRate,
    content: preset.value,
    degradationPreference: preset.degradation,
    audio: audio !== false,
    preset: `${preset.value} ${picked.value}@${frameRate}`,
  };
}

/// There is no capability flag, so `suppressLocalAudioPlayback` in the supported constraints is the signal. `likely` is a prediction.
export function displayAudioSupport(media = globalThis.navigator?.mediaDevices) {
  if (!media?.getDisplayMedia) {
    return { capture: false, likely: false, reason: 'This browser cannot share a screen at all.' };
  }
  const constraints = media.getSupportedConstraints?.() || {};
  // Electron's Linux shell supplies display audio via a PipeWire virtual input.
  const desktopFallback = Boolean(globalThis.teliumDesktop?.screenShareAudioFallback);
  const likely = Boolean(constraints.suppressLocalAudioPlayback || desktopFallback);
  return {
    capture: true,
    likely,
    reason: likely
      ? null
      : 'This browser may not be able to capture the sound of a share. Firefox and Safari '
        + 'have no display-audio capture; everyone will still hear your microphone.',
  };
}

/// Linux Electron display audio is unreliable (no track, or a silent one), so a PipeWire virtual source is captured instead.
async function desktopAudioInputs(media) {
  try {
    const devices = await media?.enumerateDevices?.();
    return (devices || []).filter((device) => device.kind === 'audioinput');
  } catch {
    return [];
  }
}

async function waitForDesktopAudioInput(media, label, before = new Set()) {
  // The virtual source registers asynchronously, so wait for device discovery.
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const inputs = await desktopAudioInputs(media);
    const named = inputs.find((device) => device.label === label);
    if (named) return named;

    const fresh = inputs.find((device) => (
      device.deviceId
      && device.deviceId !== 'default'
      && !before.has(device.deviceId)
    ));
    if (fresh) return fresh;

    if (attempt < 39) {
      await sleep(50);
    }
  }
  return null;
}

async function addDesktopDisplayAudio(media, stream, prepared, before) {
  const bridge = globalThis.teliumDesktop;
  if (
    !stream
    || typeof stream.addTrack !== 'function'
    || typeof media?.enumerateDevices !== 'function'
    || typeof media?.getUserMedia !== 'function'
    || typeof bridge?.screenShareAudioStop !== 'function'
    || prepared?.available !== true
    || !prepared?.deviceLabel
  ) return { attached: false, reason: 'Desktop audio capture is not available in this runtime.' };

  let capture = null;
  let cleaned = false;

  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    for (const track of capture?.getTracks?.() || []) {
      try { track.stop?.(); } catch { /* best effort */ }
    }
    try {
      const stopping = bridge.screenShareAudioStop();
      stopping?.catch?.(() => {});
    } catch { /* best effort */ }
  };

  try {
    const source = await waitForDesktopAudioInput(media, prepared.deviceLabel, before);
    if (!source) {
      cleanup();
      return {
        attached: false,
        reason: 'PipeWire created the screenshare source, but Chromium never exposed it as an audio input.',
      };
    }

    capture = await media.getUserMedia({
      audio: {
        deviceId: { exact: source.deviceId },
        autoGainControl: false,
        echoCancellation: false,
        noiseSuppression: false,
        channelCount: 2,
        sampleRate: 48_000,
        sampleSize: 16,
      },
      video: false,
    });
    const track = capture?.getAudioTracks?.()[0];
    if (!track) {
      cleanup();
      return { attached: false, reason: 'Chromium opened the PipeWire source but returned no audio track.' };
    }

    // Replace native tracks (possibly silent) only after the virtual source opened.
    for (const native of stream.getAudioTracks?.() || []) {
      if (native === track) continue;
      try { stream.removeTrack?.(native); } catch { /* best effort */ }
      try { native.stop?.(); } catch { /* best effort */ }
    }
    stream.addTrack(track);
    latestDesktopAudioTrack = track;
    const videoTracks = stream.getVideoTracks?.() || [];
    for (const videoTrack of videoTracks) {
      videoTrack.addEventListener?.('ended', cleanup, { once: true });
    }
    track.addEventListener?.('ended', cleanup, { once: true });
    return { attached: true, reason: null };
  } catch (error) {
    cleanup();
    return {
      attached: false,
      reason: error?.message || 'Chromium could not open the PipeWire screenshare source.',
    };
  }
}

/// Wraps getDisplayMedia so the chosen quality reaches both backends (mesh calls it directly, LiveKit inside setScreenShareEnabled).
export async function withScreenShareConstraints(settings, start) {
  const media = navigator.mediaDevices;
  const original = media?.getDisplayMedia;
  if (!original) return start();

  const wantsAudio = settings?.audio !== false;
  const bridge = globalThis.teliumDesktop;
  const canDesktopFallback = wantsAudio
    && typeof media?.enumerateDevices === 'function'
    && typeof media?.getUserMedia === 'function'
    && typeof bridge?.screenShareAudioStart === 'function'
    && typeof bridge?.screenShareAudioStop === 'function';

  // Start venmic before getDisplayMedia; starting after the picker races device discovery.
  let prepared = null;
  let desktopStarted = false;
  let fallbackAttached = false;
  let startCompleted = false;
  let inputsBefore = new Set();
  if (wantsAudio) {
    latestDisplayAudioFailure = null;
    latestDisplayAudioWarning = null;
    latestDesktopAudioTrack = null;
  }
  if (canDesktopFallback) {
    try {
      inputsBefore = new Set(
        (await desktopAudioInputs(media)).map((device) => device.deviceId).filter(Boolean),
      );
      prepared = await bridge.screenShareAudioStart();
      desktopStarted = prepared?.available === true;
      if (desktopStarted) {
        const warnings = [];
        if (prepared?.targetCount === 0) {
          warnings.push(
            'venmic started, but no shareable PipeWire playback stream was visible. '
            + 'If something was already playing, PipeWire is not exposing it to Telium.',
          );
        }
        if (prepared?.hasPipewirePulse === false) {
          warnings.push(
            'pipewire-pulse was not detected; only applications already running on PipeWire can be captured.',
          );
        }
        latestDisplayAudioWarning = warnings.length ? warnings.join(' ') : null;
      }
      if (!desktopStarted) {
        latestDisplayAudioFailure = prepared?.reason || 'The Linux desktop audio bridge could not start.';
      }
    } catch (error) {
      prepared = null;
      desktopStarted = false;
      latestDisplayAudioFailure = error?.message || 'The Linux desktop audio bridge could not start.';
    }
  }

  const stopPrepared = () => {
    if (!desktopStarted) return;
    desktopStarted = false;
    try {
      const stopping = bridge.screenShareAudioStop();
      stopping?.catch?.(() => {});
    } catch { /* best effort */ }
  };

  media.getDisplayMedia = async function getDisplayMedia(options = {}) {
    const video = options.video === true || options.video == null ? {} : options.video;
    const asking = wantsAudio && options.audio !== false && options.audio != null;
    const audio = !wantsAudio ? false : (options.audio === true
      ? { suppressLocalAudioPlayback: false }
      : options.audio);
    const stream = await original.call(this, {
      ...options,
      ...(asking ? { systemAudio: 'include', windowAudio: 'system' } : {}),
      audio,
      video: {
        ...video,
        width: { ideal: settings.width },
        height: { ideal: settings.height },
        frameRate: { ideal: settings.fps },
      },
    });
    for (const track of stream?.getVideoTracks?.() || []) {
      applyContentHint(track, settings?.content);
    }

    // venmic is authoritative on Linux Electron even if Chromium returned a (possibly silent) track.
    if (asking && desktopStarted) {
      const fallback = await addDesktopDisplayAudio(media, stream, prepared, inputsBefore);
      fallbackAttached = fallback.attached;
      if (fallbackAttached) {
        latestDisplayAudioFailure = null;
      } else {
        latestDisplayAudioFailure = fallback.reason;
        stopPrepared();
      }
    } else if (desktopStarted) {
      stopPrepared();
    }
    return stream;
  };

  try {
    const result = await start();
    startCompleted = Boolean(result);
    return result;
  } finally {
    media.getDisplayMedia = original;
    // Keep the PipeWire graph only for a started share whose virtual track owns cleanup.
    if (desktopStarted && (!fallbackAttached || !startCompleted)) stopPrepared();
  }
}

/// Advisory; unimplemented in some engines.
export async function applyDegradationPreference(sender, preference) {
  if (!sender?.getParameters || !preference) return false;
  try {
    const params = sender.getParameters();
    if (params.degradationPreference === preference) return false;
    params.degradationPreference = preference;
    await sender.setParameters(params);
    return true;
  } catch {
    return false;
  }
}
