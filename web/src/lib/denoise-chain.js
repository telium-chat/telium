// Main-thread half of neural noise cancellation; only reached via dynamic `import()`.

import { FRAME_SAMPLES, benchmarkVerdict, overloadStrike } from './denoise.js';

// `?worker&url` (not `?url`) so Vite bundles the worklet's imports.
import workletUrl from './denoise-worklet.js?worker&url';

import modelUrl from '@jitsi/rnnoise-wasm/dist/rnnoise.wasm?url';

import createRNNWasmModule from '@jitsi/rnnoise-wasm/dist/rnnoise.js';

/// 150 frames (1.5 s) lets the GRU state and JIT settle; the ms cap is an early exit.
const WARMUP_FRAMES = 150;
const WARMUP_BUDGET_MS = 300;

let binaryPromise = null;

function modelBinary() {
  if (!binaryPromise) {
    binaryPromise = fetch(modelUrl)
      .then((response) => {
        if (!response.ok) throw new Error(`model fetch returned ${response.status}`);
        return response.arrayBuffer();
      })
      .catch((error) => { binaryPromise = null; throw error; });
  }
  return binaryPromise;
}

let probePromise = null;

/// Timed rather than feature-detected, and memoised. Returns `{ ok, reason, load }`.
export function probeNeural({ force = false } = {}) {
  if (force) probePromise = null;
  if (probePromise) return probePromise;
  probePromise = (async () => {
    // RNNoise only runs at 48 kHz; some hardware will not oblige.
    const Ctor = globalThis.AudioContext || globalThis.webkitAudioContext;
    let context = null;
    try {
      context = new Ctor({ sampleRate: 48000, latencyHint: 'interactive' });
      if (context.sampleRate !== 48000) return { ok: false, reason: 'no-48k', load: null };
    } catch {
      return { ok: false, reason: 'no-48k', load: null };
    } finally {
      context?.close?.().catch?.(() => {});
    }

    let module;
    try {
      module = await createRNNWasmModule({ wasmBinary: new Uint8Array(await modelBinary()) });
    } catch {
      return { ok: false, reason: 'load-failed', load: null };
    }

    const state = module._rnnoise_create(0);
    const ptr = module._malloc(FRAME_SAMPLES * 4);
    const base = ptr >> 2;
    try {
      // Noise, not silence or a tone: silence is the easy case for the model.
      const heap = module.HEAPF32;
      for (let i = 0; i < FRAME_SAMPLES; i += 1) heap[base + i] = (Math.random() - 0.5) * 6000;
      const started = performance.now();
      let frames = 0;
      let cpuMs = 0;
      while (frames < WARMUP_FRAMES && cpuMs < WARMUP_BUDGET_MS) {
        module._rnnoise_process_frame(state, ptr, ptr);
        frames += 1;
        cpuMs = performance.now() - started;
      }
      const verdict = benchmarkVerdict({ frames, cpuMs });
      return { ok: verdict.ok, reason: verdict.reason, load: verdict.load };
    } finally {
      module._rnnoise_destroy(state);
      module._free(ptr);
    }
  })();
  return probePromise;
}

/// Owns its own 48 kHz `AudioContext`; LiveKit's would not guarantee the rate.
export class DenoiseChain {
  /// `onOverload` is called at most once, with a reason.
  constructor({ onOverload } = {}) {
    this.context = null;
    this.node = null;
    this.source = null;
    this.destination = null;
    this.onOverload = onOverload || (() => {});
    this.strikes = 0;
    this.spent = false;
    this.capacity = null;
    this.watching = null;
  }

  get processedTrack() {
    return this.destination?.stream?.getAudioTracks?.()[0] || null;
  }

  /// Separate from `start` because LiveKit's `setProcessor` throws on a track with no context.
  async open() {
    if (this.context) return this.context;
    const Ctor = globalThis.AudioContext || globalThis.webkitAudioContext;
    this.context = new Ctor({ sampleRate: 48000, latencyHint: 'interactive' });
    if (this.context.sampleRate !== 48000) {
      await this.stop();
      const error = new Error('no-48k');
      error.reason = 'no-48k';
      throw error;
    }
    // The user gesture may have expired by now.
    await this.context.resume().catch(() => {});
    await this.context.audioWorklet.addModule(workletUrl);

    this.node = new AudioWorkletNode(this.context, 'telium-denoise', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    this.node.port.onmessage = (event) => this.onStats(event.data);
    this.node.onprocessorerror = () => this.give('worklet-error');

    this.destination = this.context.createMediaStreamDestination();
    this.node.connect(this.destination);

    this.node.port.postMessage({ type: 'wasm', binary: await modelBinary() });
    this.monitor();
    return this.context;
  }

  async start(track) {
    await this.open();
    this.attach(track);
    return this.processedTrack;
  }

  async replace(track) {
    if (!this.node) return this.start(track);
    this.attach(track);
    return this.processedTrack;
  }

  attach(track) {
    this.source?.disconnect?.();
    const stream = new MediaStream([track]);
    this.source = this.context.createMediaStreamSource(stream);
    this.source.connect(this.node);
  }

  setBypass(on) {
    this.node?.port?.postMessage({ type: 'bypass', on: Boolean(on) });
  }

  /// Uses one signal to avoid double-counting: the worklet's clock when it reports, else Chromium's `renderCapacity`.
  monitor() {
    const capacity = this.context?.renderCapacity;
    if (!capacity?.start) return;
    this.capacity = capacity;
    capacity.addEventListener('update', (event) => {
      if (this.watching === 'worklet') return;
      this.watching = 'capacity';
      this.strike({ underrunRatio: event.underrunRatio });
    });
    try { capacity.start({ updateInterval: 1 }); } catch { this.capacity = null; }
  }

  onStats(message) {
    if (message?.type === 'failed') { this.give('load-failed'); return; }
    if (message?.type !== 'stats') return;
    if (!Number.isFinite(message.load)) return;
    // The worklet has a clock, so it wins and the capacity events stand down.
    this.watching = 'worklet';
    this.strike({ load: message.load });
  }

  strike(sample) {
    const { strikes, bail } = overloadStrike(this.strikes, sample);
    this.strikes = strikes;
    if (bail) this.give('too-slow');
  }

  give(reason) {
    if (this.spent) return;
    this.spent = true;
    this.onOverload(reason);
  }

  async stop() {
    try { this.capacity?.stop?.(); } catch { /* the context may already be gone */ }
    this.node?.port && (this.node.port.onmessage = null);
    this.source?.disconnect?.();
    this.node?.disconnect?.();
    this.destination?.disconnect?.();
    this.source = null;
    this.node = null;
    this.destination = null;
    const context = this.context;
    this.context = null;
    await context?.close?.().catch?.(() => {});
  }
}

/// The LiveKit `TrackProcessor` interface is experimental upstream, so the surface is kept to these four members.
export function neuralProcessor(chain) {
  return {
    name: 'telium-neural-denoise',
    chain,
    processedTrack: undefined,
    async init(opts) { this.processedTrack = await chain.start(opts.track); },
    async restart(opts) { this.processedTrack = await chain.replace(opts.track); },
    async destroy() { await chain.stop(); },
  };
}
