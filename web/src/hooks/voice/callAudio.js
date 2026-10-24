import { micConstraints } from '../../lib/denoise.js';
import { t } from '../../lib/i18n/index.js';
import { DESKTOP_AUDIO_OUTPUT_KEY } from '../../components/DesktopAudioDevices.jsx';

export function desktopAudioPreference(key) {
  try { return localStorage.getItem(key) || 'default'; } catch { return 'default'; }
}

export async function switchCallInput(call, deviceId, { ensurePublished = false } = {}) {
  if (!call) return;
  const selected = deviceId || 'default';

  if (call.room?.localParticipant) {
    if (ensurePublished) {
      const publication = await call.room.localParticipant.setMicrophoneEnabled(
        true,
        micConstraints(call.noiseMode, selected),
      );
      if (!publication) throw new Error(t('voice.devices.micPublishFailed'));
    } else if (call.room.switchActiveDevice) {
      await call.room.switchActiveDevice('audioinput', selected);
    } else {
      throw new Error(t('voice.devices.micSwitchUnsupported'));
    }
    call.micError = null;
    return;
  }

  if (call.peers && Object.prototype.hasOwnProperty.call(call, 'stream')) {
    await call.useDevice(selected);
  }
}

export async function applyDesktopAudioOutput(deviceId = desktopAudioPreference(DESKTOP_AUDIO_OUTPUT_KEY)) {
  if (typeof document === 'undefined') return;
  const selected = deviceId || 'default';
  const outputs = [...document.querySelectorAll('audio')]
    .filter((element) => typeof element.setSinkId === 'function');
  const results = await Promise.allSettled(outputs.map((element) => element.setSinkId(selected)));
  const failure = results.find((result) => result.status === 'rejected');
  if (failure) throw failure.reason;
}

export function playCallTone(kind) {
  if (typeof window === 'undefined') return;
  const Audio = window.AudioContext || window.webkitAudioContext;
  if (!Audio) return;
  const score = {
    join: [
      [0.00, 392.00, 0.12, 0.045, 'sine'],
      [0.07, 523.25, 0.15, 0.055, 'triangle'],
      [0.14, 659.25, 0.18, 0.050, 'sine'],
    ],
    leave: [
      [0.00, 659.25, 0.12, 0.045, 'sine'],
      [0.07, 493.88, 0.14, 0.050, 'triangle'],
      [0.14, 349.23, 0.18, 0.042, 'sine'],
    ],
    'screen-start': [
      [0.00, 523.25, 0.09, 0.040, 'triangle'],
      [0.055, 659.25, 0.11, 0.050, 'sine'],
      [0.11, 783.99, 0.16, 0.045, 'sine'],
    ],
    'screen-stop': [
      [0.00, 783.99, 0.08, 0.035, 'sine'],
      [0.05, 587.33, 0.11, 0.045, 'triangle'],
      [0.11, 440.00, 0.16, 0.040, 'sine'],
    ],
  }[kind];
  if (!score) return;
  try {
    const context = new Audio();
    const start = context.currentTime;
    let end = start;
    for (const [at, frequency, duration, peak, type] of score) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const begin = start + at;
      const stop = begin + duration;
      oscillator.type = type;
      oscillator.frequency.setValueAtTime(frequency, begin);
      gain.gain.setValueAtTime(0.0001, begin);
      gain.gain.exponentialRampToValueAtTime(peak, begin + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, stop);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start(begin);
      oscillator.stop(stop + 0.01);
      end = Math.max(end, stop);
    }
    window.setTimeout(() => context.close().catch(() => {}), Math.ceil((end - start + 0.08) * 1000));
  } catch {
    // A call should never fail because the UI sound could not be created
  }
}
