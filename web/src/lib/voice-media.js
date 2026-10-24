/// Participant attribute the SFU stamps on LiveKit tokens with our ceiling (`telium_protocol::MAX_BITRATE_ATTRIBUTE`).
export const MAX_BITRATE_ATTRIBUTE = 'telium.max_bitrate';
/// Data topic the SFU uses to pick a viewer's layer (`telium_protocol::WATCH_TOPIC`).
export const WATCH_TOPIC = 'telium.watch';
/// The ladder under the ceiling starts here.
export const CAMERA_CAPTURE = { width: 1280, height: 720, fps: 30 };

export const SPEAKING_LEVEL = 8;
export const SPEAKING_HANG_MS = 250;

const MAX_PLAYBACK_VOLUME = 200;

export function clampPlaybackVolume(percent) {
  return Math.max(0, Math.min(MAX_PLAYBACK_VOLUME, Number(percent) || 0));
}

export function createPlaybackContext() {
  const Audio = window.AudioContext || window.webkitAudioContext;
  return Audio ? new Audio() : null;
}

/// Boosting past 1.0 needs WebAudio. The original element must stay on the peer's stream (muted): Chromium only feeds a remote stream to WebAudio while an element consumes it.
export function setPlaybackVolume(context, stream, el, graph, percent) {
  const value = clampPlaybackVolume(percent);

  if (graph && graph.stream !== stream) {
    stopPlaybackGraph(graph);
    graph = null;
  }

  // Keep the graph once built so toggling around 100% doesn't rebuild routing.
  if (!graph && value <= 100) {
    el.volume = value / 100;
    return null;
  }

  if (!graph) {
    if (
      !context || !stream
      || typeof context.createMediaStreamSource !== 'function'
      || typeof context.createGain !== 'function'
      || typeof context.createMediaStreamDestination !== 'function'
    ) {
      el.volume = Math.min(value, 100) / 100;
      return null;
    }
    const input = context.createMediaStreamSource(stream);
    const gain = context.createGain();
    const output = context.createMediaStreamDestination();
    input.connect(gain);
    gain.connect(output);
    const out = document.createElement('audio');
    out.autoplay = true;
    out.hidden = true;
    out.muted = Boolean(el.muted);
    out.srcObject = output.stream;
    document.body.appendChild(out);
    // The desktop output picker walks the document, so a new element must be pointed at the device itself.
    if (typeof out.setSinkId === 'function' && el.sinkId) {
      Promise.resolve(out.setSinkId(el.sinkId)).catch(() => {});
    }
    Promise.resolve(out.play?.()).catch(() => {});
    graph = { stream, input, gain, output, el: out };
    el.volume = 0;
    Promise.resolve(context.resume?.()).catch(() => {});
  }

  graph.gain.gain.value = value / 100;
  return graph;
}

/// Deafen must mute both the stream element and the graph element.
export function setPlaybackMuted(graph, el, muted) {
  if (el) el.muted = muted;
  if (graph?.el) graph.el.muted = muted;
}

export function stopPlaybackGraph(graph) {
  graph?.input?.disconnect?.();
  graph?.gain?.disconnect?.();
  const out = graph?.el;
  if (!out) return;
  out.srcObject = null;
  out.remove?.();
}

/// `navigator.mediaDevices` is absent outside a secure context.
function mediaDevices(method, what) {
  const media = navigator.mediaDevices;
  if (media?.[method]) return media;
  throw new Error(
    window.isSecureContext === false
      ? `A browser will only ${what} from a secure page. Open the client over `
        + 'https, or on localhost, and try again.'
      : `This browser cannot ${what}.`,
  );
}

export const displayMedia = () => mediaDevices('getDisplayMedia', 'share a screen');
export const userMedia = () => mediaDevices('getUserMedia', 'open a camera');

/// Dynamic import so model weights load only for those who use the setting; the probe refuses hardware that can't keep up.
export async function openDenoiser(onOverload) {
  const { DenoiseChain, probeNeural } = await import('./denoise-chain.js');
  const verdict = await probeNeural();
  if (!verdict.ok) {
    const error = new Error(`neural noise cancellation unavailable: ${verdict.reason}`);
    error.reason = verdict.reason;
    throw error;
  }
  return new DenoiseChain({ onOverload });
}

export function cameraVideoConstraints(facingMode = 'user') {
  return {
    width: { ideal: 1280 },
    height: { ideal: 720 },
    frameRate: { ideal: 30 },
    // `ideal`, not `exact`, so single-camera devices still work.
    facingMode: { ideal: facingMode },
  };
}

export function preferredScreenCodec(scope = globalThis) {
  return scope?.teliumDesktop?.platform === 'win32' ? 'h264' : null;
}

export function preferScreenCodec(transceiver, scope = globalThis) {
  const codec = preferredScreenCodec(scope);
  if (!codec || typeof transceiver?.setCodecPreferences !== 'function') return false;
  const capabilities = scope?.RTCRtpSender?.getCapabilities?.('video');
  const codecs = Array.isArray(capabilities?.codecs) ? capabilities.codecs : [];
  const preferred = codecs.filter((entry) => entry?.mimeType?.toLowerCase() === `video/${codec}`);
  if (!preferred.length) return false;
  const rest = codecs.filter((entry) => entry?.mimeType?.toLowerCase() !== `video/${codec}`);
  try {
    transceiver.setCodecPreferences([...preferred, ...rest]);
    return true;
  } catch {
    return false;
  }
}

/// Composing both flags keeps a user muted before deafening muted after undeafening.
export function micLive({ muted, deafened }) {
  return !(muted || deafened);
}

export function sameSet(a, b) {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

export function rttFromPc(pc) {
  return pc.getStats().then((report) => {
    let nominated = null;
    let succeeded = null;
    report.forEach((stat) => {
      if (stat.type !== 'candidate-pair') return;
      if (typeof stat.currentRoundTripTime !== 'number') return;
      if (stat.nominated) nominated = stat.currentRoundTripTime;
      else if (stat.state === 'succeeded') succeeded = stat.currentRoundTripTime;
    });
    const rtt = nominated ?? succeeded;
    return rtt == null ? null : Math.round(rtt * 1000);
  });
}
