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

/// DeepFilterNet3 costs about eleven times what RNNoise does (about 9% of a core against under 1% on a laptop-class CPU), so it is allowed far more headroom before it is judged too slow to start with; the governor still steps it down if it cannot keep up once a call is running.
export const DEEPFILTER_CEILING = 0.35;

/// The ladder: each engine yields to the next when a call cannot afford it, and the one after the last is the browser's own suppressor.
export const ENGINES = ['dfn3', 'rnnoise'];

export function nextEngine(engine) {
  const at = ENGINES.indexOf(engine);
  return at >= 0 && at + 1 < ENGINES.length ? ENGINES[at + 1] : null;
}

export function benchmarkVerdict({ frames, cpuMs }, ceiling = BENCHMARK_CEILING) {
  if (!Number.isFinite(frames) || frames <= 0 || !Number.isFinite(cpuMs) || cpuMs < 0) {
    return { ok: false, load: null, reason: 'no-measurement' };
  }
  const load = cpuMs / (frames * FRAME_MS);
  return load > ceiling
    ? { ok: false, load, reason: 'too-slow' }
    : { ok: true, load, reason: null };
}

/// The `prefs` event fires for every preference there is. A call must act on the noise setting only when it is the *setting* that changed: re-applying an unchanged `neural` would undo a call's own decision to stand down (it keeps what the person chose and runs something else for that call), and leave the microphone with no suppression at all.
export function noiseChange(applied, wanted) {
  const mode = normalizeNoiseMode(wanted);
  return mode === applied ? null : mode;
}

/// What a busy machine looks like. `load` is the model's own share of the audio thread (worklet clock); `underruns` is Chromium's whole-context underrun ratio, a hint that only counts when the worklet cannot report its own load, because it also rises when something else starves the audio thread, which dropping the model does not fix.
export const OVERLOAD = { load: 0.6, underruns: 0.05 };

/// Judged over a sliding window rather than in a row, and answered by pausing with a growing delay rather than by giving up: a game launching or a screen share starting is a bad half minute, not a verdict on the device.
export const GOVERNOR = {
  /// Windows are about a second long.
  window: 8,
  /// Bad windows out of `window` that pause the model.
  bad: 5,
  /// How long each successive pause lasts; running out of them is the only way to give up for the call.
  pauseMs: [15_000, 45_000, 120_000],
  /// Consecutive good windows after which earlier pauses are forgotten.
  calm: 60,
};

/// `true` bad, `false` good, `null` not measured (the count must not move).
export function judgeSample({ load = null, underrunRatio = null } = {}, limits = OVERLOAD) {
  if (Number.isFinite(load)) return load > limits.load;
  if (Number.isFinite(underrunRatio)) return underrunRatio > limits.underruns;
  return null;
}

/// Pure state machine; the chain owns the timers.
export function createGovernor(limits = GOVERNOR) {
  let history = [];
  let pauses = 0;
  let calm = 0;
  return {
    get pauses() { return pauses; },
    /// Returns `null`, `{ pauseMs }` or `{ giveUp: true }`.
    push(sample, overload = OVERLOAD) {
      const bad = judgeSample(sample, overload);
      if (bad === null) return null;
      history.push(bad);
      if (history.length > limits.window) history.shift();
      calm = bad ? 0 : calm + 1;
      if (calm >= limits.calm) pauses = 0;
      if (history.filter(Boolean).length < limits.bad) return null;
      history = [];
      pauses += 1;
      if (pauses > limits.pauseMs.length) return { giveUp: true };
      return { pauseMs: limits.pauseMs[pauses - 1] };
    },
    /// A resumed model is judged afresh.
    resumed() { history = []; calm = 0; },
  };
}

/// Only these end neural for the rest of the call. Everything else is a bad moment.
export const PERMANENT_REASONS = new Set([
  'no-audio-worklet', 'no-audio-context', 'insecure-context', 'no-wasm', 'one-core', 'no-48k',
  'load-failed', 'worklet-error',
]);

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
