import { describe, expect, it } from 'vitest';
import {
  BENCHMARK_CEILING, DEFAULT_NOISE_MODE, NOISE_MODES, OVERLOAD, benchmarkVerdict, micConstraints,
  neuralCapability, normalizeNoiseMode, createGovernor, ENGINES, noiseChange, GOVERNOR, nextEngine, judgeSample, PERMANENT_REASONS, unavailableBecause,
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

describe('standing aside mid-call', () => {
  const bad = { load: 0.9 };
  const fine = { load: 0.1 };
  const feed = (governor, sample, times) => {
    let last = null;
    for (let i = 0; i < times; i += 1) last = governor.push(sample) || last;
    return last;
  };

  it('does not react to a few bad seconds', () => {
    const governor = createGovernor();
    expect(feed(governor, bad, GOVERNOR.bad - 1)).toBeNull();
  });

  it('pauses when enough of the recent windows are bad, not only consecutive ones', () => {
    const governor = createGovernor();
    let verdict = null;
    for (const sample of [bad, fine, bad, bad, fine, bad, bad]) verdict = governor.push(sample) || verdict;
    expect(verdict).toEqual({ pauseMs: GOVERNOR.pauseMs[0] });
  });

  it('lets pauses grow, then gives up for the call and only then', () => {
    const governor = createGovernor();
    const lengths = [];
    let verdict = null;
    for (let round = 0; round < GOVERNOR.pauseMs.length + 1; round += 1) {
      verdict = feed(governor, bad, GOVERNOR.bad);
      lengths.push(verdict.pauseMs);
      governor.resumed();
    }
    expect(lengths.slice(0, -1)).toEqual(GOVERNOR.pauseMs);
    expect(verdict).toEqual({ giveUp: true });
  });

  it('forgets earlier pauses after a long calm', () => {
    const governor = createGovernor();
    feed(governor, bad, GOVERNOR.bad);
    governor.resumed();
    feed(governor, fine, GOVERNOR.calm);
    expect(governor.pauses).toBe(0);
    expect(feed(governor, bad, GOVERNOR.bad)).toEqual({ pauseMs: GOVERNOR.pauseMs[0] });
  });

  it('uses the underrun count only when the model cannot report its own load', () => {
    expect(judgeSample({ underrunRatio: OVERLOAD.underruns + 0.01 })).toBe(true);
    expect(judgeSample({ underrunRatio: 0 })).toBe(false);
    expect(judgeSample({ load: 0.1, underrunRatio: 0.9 })).toBe(false);
  });

  it('holds still when a browser reports neither', () => {
    expect(judgeSample({})).toBeNull();
    expect(createGovernor().push({ load: null, underrunRatio: null })).toBeNull();
  });

  it('treats only hard failures as reasons to stop for the call', () => {
    expect(PERMANENT_REASONS.has('no-wasm')).toBe(true);
    expect(PERMANENT_REASONS.has('too-slow')).toBe(false);
  });
});

describe('the engine ladder', () => {
  it('goes from the better model to the lighter one to nothing', () => {
    expect(ENGINES).toEqual(['dfn3', 'rnnoise']);
    expect(nextEngine('dfn3')).toBe('rnnoise');
    expect(nextEngine('rnnoise')).toBeNull();
    expect(nextEngine('something-else')).toBeNull();
  });
});

describe('reacting to the noise setting', () => {
  it('acts only when the setting changed, so an unrelated preference cannot undo a stand-down', () => {
    expect(noiseChange('neural', 'neural')).toBeNull();
    expect(noiseChange('neural', undefined)).toBe('browser');
    expect(noiseChange('browser', 'neural')).toBe('neural');
    expect(noiseChange('browser', 'garbage')).toBeNull();
  });
});
