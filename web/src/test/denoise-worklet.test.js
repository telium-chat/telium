// Runs the real audio-worklet processor, with both real engines, outside a browser. The Web Audio globals are faked just far enough to construct it; the wasm is the same bytes the client ships.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ASSETS = join(process.cwd(), 'src', 'assets', 'dsp');
const hasDeepFilter = existsSync(join(ASSETS, 'deepfilter.wasm')) && existsSync(join(ASSETS, 'deepfilter-model.bin'));

const QUANTUM = 128;
let Processor = null;
const saved = {};

beforeAll(async () => {
  for (const name of ['AudioWorkletProcessor', 'registerProcessor', 'sampleRate']) saved[name] = globalThis[name];
  globalThis.sampleRate = 48000;
  globalThis.AudioWorkletProcessor = class { constructor() { this.port = { postMessage: (m) => this.sent.push(m), onmessage: null }; this.sent = []; } };
  globalThis.registerProcessor = (_name, ctor) => { Processor = ctor; };
  await import('../lib/denoise-worklet.js');
});

afterAll(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete globalThis[name]; else globalThis[name] = value;
  }
});

const until = async (node, type, ms = 20000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const hit = node.sent.find((m) => m.type === type);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`no ${type} message`);
};

// Hum plus a click train: the cases DeepFilterNet3 is there to fix.
const noisy = (seconds) => {
  const out = new Float32Array(Math.floor(48000 * seconds / QUANTUM) * QUANTUM);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = 0.2 * Math.sin((2 * Math.PI * 120 * i) / 48000) + (i % 6000 < 40 ? 0.3 : 0);
  }
  return out;
};

const run = (node, input) => {
  const output = new Float32Array(input.length);
  for (let at = 0; at < input.length; at += QUANTUM) {
    const out = [new Float32Array(QUANTUM)];
    node.process([[input.subarray(at, at + QUANTUM)]], [out]);
    output.set(out[0], at);
  }
  return output;
};

const rms = (a) => Math.sqrt(a.reduce((s, x) => s + x * x, 0) / a.length);

describe('the denoise worklet', () => {
  it('is a wire until an engine has loaded', () => {
    const node = new Processor();
    const input = noisy(0.1);
    expect(run(node, input)).toEqual(input);
  });

  it('runs RNNoise', async () => {
    const node = new Processor();
    const binary = readFileSync(join(process.cwd(), 'node_modules', '@jitsi', 'rnnoise-wasm', 'dist', 'rnnoise.wasm'));
    node.port.onmessage({ data: { type: 'engine', engine: 'rnnoise', binary: new Uint8Array(binary) } });
    await until(node, 'ready');
    const input = noisy(1);
    const out = run(node, input);
    expect(out.every(Number.isFinite)).toBe(true);
    expect(rms(out)).toBeLessThan(rms(input));
  });

  it.skipIf(!hasDeepFilter)('runs DeepFilterNet3 and takes hum out', async () => {
    const node = new Processor();
    node.port.onmessage({ data: { type: 'engine', engine: 'dfn3', wasm: readFileSync(join(ASSETS, 'deepfilter.wasm')), model: readFileSync(join(ASSETS, 'deepfilter-model.bin')) } });
    const ready = await until(node, 'ready');
    expect(ready.engine).toBe('dfn3');
    const input = noisy(3);
    const out = run(node, input);
    expect(out.every(Number.isFinite)).toBe(true);
    // The last second only, once the model has settled.
    expect(rms(out.subarray(-48000))).toBeLessThan(rms(input.subarray(-48000)) * 0.2);
  }, 60000);

  it('reports a broken engine and keeps the audio flowing', async () => {
    const node = new Processor();
    node.port.onmessage({ data: { type: 'engine', engine: 'dfn3', wasm: new Uint8Array([1, 2, 3]), model: new Uint8Array([]) } });
    const failed = await until(node, 'failed');
    expect(failed.engine).toBe('dfn3');
    const input = noisy(0.1);
    expect(run(node, input)).toEqual(input);
  });
});
