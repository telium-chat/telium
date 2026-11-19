import { describe, expect, it, vi } from 'vitest';
import { GOVERNOR, OVERLOAD } from '../lib/denoise.js';
import { DenoiseChain } from '../lib/denoise-chain.js';

const QUANTUM_MS = 128_000 / 48_000;

describe('a call that cannot afford DeepFilterNet3', () => {
  it('moves to RNNoise instead of pausing and coming back to the same heavy model', () => {
    const onEngine = vi.fn();
    const onPause = vi.fn();
    const chain = new DenoiseChain({ engine: 'dfn3', onEngine, onPause, onOverload: () => {} });
    for (let i = 0; i < GOVERNOR.bad; i += 1) {
      chain.onStats({ type: 'stats', load: OVERLOAD.load + 0.1 });
    }
    expect(chain.engine).toBe('rnnoise');
    expect(onEngine).toHaveBeenCalledWith('rnnoise', 'too-slow');
    expect(onPause).not.toHaveBeenCalled();
  });

  it('keeps DeepFilterNet3 on a fast machine through the odd long quantum', () => {
    const onEngine = vi.fn();
    const onPause = vi.fn();
    const chain = new DenoiseChain({ engine: 'dfn3', onEngine, onPause, onOverload: () => {} });
    for (let i = 0; i < GOVERNOR.window * 2; i += 1) {
      chain.onStats({ type: 'stats', load: 0.03, worstMs: 4, quantumMs: QUANTUM_MS });
    }
    expect(chain.engine).toBe('dfn3');
    expect(onEngine).not.toHaveBeenCalled();
    expect(onPause).not.toHaveBeenCalled();
  });
});
