import { describe, expect, it, vi } from 'vitest';
import { GOVERNOR } from '../lib/denoise.js';
import { DenoiseChain } from '../lib/denoise-chain.js';

const QUANTUM_MS = 128_000 / 48_000;

describe('a call whose DeepFilterNet3 frames run late', () => {
  it('moves to RNNoise instead of pausing and coming back to the same late frames', () => {
    const onEngine = vi.fn();
    const onPause = vi.fn();
    const chain = new DenoiseChain({ engine: 'dfn3', onEngine, onPause, onOverload: () => {} });
    for (let i = 0; i < GOVERNOR.bad; i += 1) {
      chain.onStats({ type: 'stats', load: 0.12, worstMs: 4, quantumMs: QUANTUM_MS });
    }
    expect(chain.engine).toBe('rnnoise');
    expect(onEngine).toHaveBeenCalledWith('rnnoise', 'too-slow');
    expect(onPause).not.toHaveBeenCalled();
  });

  it('leaves RNNoise running through long quanta it did not cause', () => {
    const onPause = vi.fn();
    const chain = new DenoiseChain({ engine: 'rnnoise', onPause, onOverload: () => {} });
    for (let i = 0; i < GOVERNOR.window; i += 1) {
      chain.onStats({ type: 'stats', load: 0.02, worstMs: 4, quantumMs: QUANTUM_MS });
    }
    expect(onPause).not.toHaveBeenCalled();
  });
});
