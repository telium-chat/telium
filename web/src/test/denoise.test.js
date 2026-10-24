import { describe, expect, it } from 'vitest';
import {
  BENCHMARK_CEILING, DEFAULT_NOISE_MODE, NOISE_MODES, OVERLOAD, benchmarkVerdict, micConstraints,
  neuralCapability, normalizeNoiseMode, overloadStrike, unavailableBecause,
} from '../lib/denoise.js';

const capable = (over = {}) => ({
  AudioWorkletNode: function AudioWorkletNode() {},
  AudioContext: function AudioContext() {},
  isSecureContext: true,
  WebAssembly: { validate: () => true },
  navigator: { hardwareConcurrency: 8 },
  ...over,
});

describe('noise modes', () => {
  it('keeps the three states and defaults to the browser suppressor', () => {
    expect(NOISE_MODES).toEqual(['off', 'browser', 'neural']);
    expect(normalizeNoiseMode(undefined)).toBe(DEFAULT_NOISE_MODE);
    expect(normalizeNoiseMode('neural-v2')).toBe('browser');
    expect(normalizeNoiseMode('off')).toBe('off');
    expect(normalizeNoiseMode('neural')).toBe('neural');
  });
});

describe('capture constraints', () => {
  it('moves only noiseSuppression between the modes', () => {
    expect(micConstraints('browser').noiseSuppression).toBe(true);
    expect(micConstraints('off').noiseSuppression).toBe(false);
    expect(micConstraints('neural').noiseSuppression).toBe(false);
    for (const mode of NOISE_MODES) {
      expect(micConstraints(mode).echoCancellation).toBe(true);
      expect(micConstraints(mode).autoGainControl).toBe(true);
    }
  });

  it('names a device only when one was chosen', () => {
    expect(micConstraints('browser').deviceId).toBeUndefined();
    expect(micConstraints('browser', 'default').deviceId).toBeUndefined();
    expect(micConstraints('browser', 'mic-7').deviceId).toEqual({ exact: 'mic-7' });
  });
});

describe('capability', () => {
  it('offers the model to a browser that has the parts', () => {
    const verdict = neuralCapability(capable());
    expect(verdict.ok).toBe(true);
    expect(verdict.reason).toBeNull();
  });

  it('refuses without an AudioWorklet rather than falling back to the main thread', () => {
    expect(neuralCapability(capable({ AudioWorkletNode: undefined })).reason)
      .toBe('no-audio-worklet');
    expect(neuralCapability(capable({ AudioContext: undefined })).reason)
      .toBe('no-audio-context');
  });

  it('refuses an insecure page, where addModule cannot fetch the worklet', () => {
    expect(neuralCapability(capable({ isSecureContext: false })).reason).toBe('insecure-context');
    expect(neuralCapability(capable({ isSecureContext: undefined })).ok).toBe(true);
  });

  it('refuses when WebAssembly will not compile, however it says so', () => {
    expect(neuralCapability(capable({ WebAssembly: undefined })).reason).toBe('no-wasm');
    expect(neuralCapability(capable({ WebAssembly: { validate: () => false } })).reason)
      .toBe('no-wasm');
    expect(neuralCapability(capable({
      WebAssembly: { validate: () => { throw new Error('blocked by CSP'); } },
    })).reason).toBe('no-wasm');
  });

  it('refuses a single-core device and forgives one that will not say', () => {
    expect(neuralCapability(capable({ navigator: { hardwareConcurrency: 1 } })).reason)
      .toBe('one-core');
    expect(neuralCapability(capable({ navigator: {} })).ok).toBe(true);
    expect(neuralCapability(capable({ navigator: undefined })).ok).toBe(true);
  });

  it('reports SIMD without gating on it', () => {
    const without = neuralCapability(capable({
      WebAssembly: { validate: (bytes) => bytes.length === 8 },
    }));
    expect(without.simd).toBe(false);
    expect(without.ok).toBe(true);
  });
});

describe('warm-up verdict', () => {
  it('reads the realtime factor off the measurement', () => {
    const fast = benchmarkVerdict({ frames: 150, cpuMs: 30 });
    expect(fast.ok).toBe(true);
    expect(fast.load).toBeCloseTo(0.02, 5);

    const slow = benchmarkVerdict({ frames: 150, cpuMs: 900 });
    expect(slow.ok).toBe(false);
    expect(slow.reason).toBe('too-slow');
    expect(slow.load).toBeCloseTo(0.6, 5);
  });

  it('sits exactly on the ceiling rather than just under it', () => {
    const edge = benchmarkVerdict({ frames: 100, cpuMs: 1000 * BENCHMARK_CEILING });
    expect(edge.ok).toBe(true);
  });

  it('refuses a measurement that did not happen', () => {
    expect(benchmarkVerdict({ frames: 0, cpuMs: 300 }).reason).toBe('no-measurement');
    expect(benchmarkVerdict({ frames: NaN, cpuMs: 10 }).reason).toBe('no-measurement');
    expect(benchmarkVerdict({ frames: 10, cpuMs: undefined }).reason).toBe('no-measurement');
  });
});

describe('giving up mid-call', () => {
  const bad = { load: 0.9 };
  const fine = { load: 0.1 };

  it('needs three bad windows in a row, not one', () => {
    let strikes = 0;
    for (const expected of [1, 2]) {
      const step = overloadStrike(strikes, bad);
      strikes = step.strikes;
      expect(strikes).toBe(expected);
      expect(step.bail).toBe(false);
    }
    expect(overloadStrike(strikes, bad).bail).toBe(true);
  });

  it('forgives rather than decrements, so a recovery starts over', () => {
    let strikes = overloadStrike(0, bad).strikes;
    strikes = overloadStrike(strikes, bad).strikes;
    strikes = overloadStrike(strikes, fine).strikes;
    expect(strikes).toBe(0);
    expect(overloadStrike(strikes, bad).bail).toBe(false);
  });

  it('counts underruns from renderCapacity as well as its own clock', () => {
    expect(overloadStrike(2, { underrunRatio: OVERLOAD.underruns + 0.01 }).bail).toBe(true);
    expect(overloadStrike(2, { underrunRatio: 0 }).strikes).toBe(0);
  });

  it('holds the count still when a browser reports neither', () => {
    expect(overloadStrike(2, {})).toEqual({ strikes: 2, bail: false });
    expect(overloadStrike(2, { load: null, underrunRatio: null }).bail).toBe(false);
  });
});

describe('explanations', () => {
  it('has a sentence for every reason the checks can produce', () => {
    const reasons = ['no-audio-worklet', 'no-audio-context', 'insecure-context', 'no-wasm',
      'one-core', 'no-48k', 'too-slow', 'load-failed', 'no-measurement'];
    for (const reason of reasons) expect(unavailableBecause(reason)).toMatch(/\w/);
    expect(unavailableBecause(null)).toBeNull();
  });
});
