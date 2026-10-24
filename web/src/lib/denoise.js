// Pure decisions for mic noise suppression: modes, constraints, whether to offer RNNoise, when to give up on it. The graph is in `denoise-chain.js`.

export const NOISE_MODES = ['off', 'browser', 'neural'];

export const DEFAULT_NOISE_MODE = 'browser';

export function normalizeNoiseMode(value) {
  return NOISE_MODES.includes(value) ? value : DEFAULT_NOISE_MODE;
}

/// Echo cancellation and AGC stay on in all modes; `neural` turns off the browser suppressor because stacking two gates pumps on consonants.
export function micConstraints(mode, deviceId) {
  const selected = deviceId && deviceId !== 'default' ? { deviceId: { exact: deviceId } } : {};
  return {
    echoCancellation: true,
    autoGainControl: true,
    noiseSuppression: normalizeNoiseMode(mode) === 'browser',
    ...selected,
  };
}

/// Smallest SIMD wasm module; `validate` compiles nothing.
const SIMD_PROBE = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  0x01, 0x04, 0x01, 0x60, 0x00, 0x00,
  0x03, 0x02, 0x01, 0x00,
  0x0a, 0x09, 0x01, 0x07, 0x00, 0xfd, 0x0f, 0x00, 0x00, 0x1a, 0x0b,
]);

/// Bare module header: tells "no WebAssembly" from "CSP blocks compiling".
const WASM_PROBE = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

/// Hard impossibilities only; speed is settled by `benchmarkVerdict`. SIMD is reported but not required.
export function neuralCapability(env = globalThis) {
  const simd = (() => {
    try { return Boolean(env.WebAssembly?.validate?.(SIMD_PROBE)); } catch { return false; }
  })();
  const no = (reason) => ({ ok: false, reason, simd });

  if (typeof env.AudioWorkletNode !== 'function') return no('no-audio-worklet');
  if (typeof (env.AudioContext || env.webkitAudioContext) !== 'function') return no('no-audio-context');

  // `addModule` needs a secure context; only an explicit `false` refuses.
  if (env.isSecureContext === false) return no('insecure-context');

  try {
    if (!env.WebAssembly?.validate?.(WASM_PROBE)) return no('no-wasm');
  } catch { return no('no-wasm'); }

  // Unreported core counts get the benefit of the doubt; the benchmark catches them.
  const cores = Number(env.navigator?.hardwareConcurrency);
  if (Number.isFinite(cores) && cores > 0 && cores < 2) return no('one-core');

  return { ok: true, reason: null, simd };
}

export const FRAME_SAMPLES = 480;
export const FRAME_MS = 10;

/// Fraction of one core the model may take (laptop ~1.4%, mid phone ~10%).
export const BENCHMARK_CEILING = 0.25;

export function benchmarkVerdict({ frames, cpuMs }, ceiling = BENCHMARK_CEILING) {
  if (!Number.isFinite(frames) || frames <= 0 || !Number.isFinite(cpuMs) || cpuMs < 0) {
    return { ok: false, load: null, reason: 'no-measurement' };
  }
  const load = cpuMs / (frames * FRAME_MS);
  return load > ceiling
    ? { ok: false, load, reason: 'too-slow' }
    : { ok: true, load, reason: null };
}

/// Three consecutive bad windows, not one: a single one is usually GC or a screen share starting.
export const OVERLOAD = { load: 0.6, underruns: 0.02, strikes: 3 };

export function overloadStrike(strikes, { load = null, underrunRatio = null } = {}, limits = OVERLOAD) {
  const measured = Number.isFinite(load) || Number.isFinite(underrunRatio);
  if (!measured) return { strikes, bail: false };
  const bad = (Number.isFinite(load) && load > limits.load)
    || (Number.isFinite(underrunRatio) && underrunRatio > limits.underruns);
  const next = bad ? strikes + 1 : 0;
  return { strikes: next, bail: next >= limits.strikes };
}

export function unavailableBecause(reason) {
  return {
    'no-audio-worklet': 'This browser cannot run audio processing off the main thread.',
    'no-audio-context': 'This browser does not expose the Web Audio API.',
    'insecure-context': 'Audio processing needs a secure (https) connection.',
    'no-wasm': 'This browser will not run WebAssembly on this page.',
    'one-core': 'This device has too few CPU cores to spare one for the model.',
    'no-48k': 'This device’s audio hardware will not run at 48 kHz.',
    'too-slow': 'This device is not fast enough to run the model in real time.',
    // Duplicated in `catalog/en/voice.js` (`voice.noise.reason.*`); reword both.
    'load-failed': 'The neural model could not be loaded.',
    'no-measurement': 'The neural model could not be measured.',
  }[reason] || null;
}
