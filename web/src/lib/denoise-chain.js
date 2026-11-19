// Main-thread half of neural noise cancellation; only reached via dynamic `import()`.

import {
  DEEPFILTER_CEILING, DEEPFILTER_OVERLOAD, FRAME_SAMPLES, OVERLOAD, benchmarkVerdict, createGovernor, nextEngine,
} from './denoise.js';

// `?worker&url` (not `?url`) so Vite bundles the worklet's imports.
import workletUrl from './denoise-worklet.js?worker&url';

import modelUrl from '@jitsi/rnnoise-wasm/dist/rnnoise.wasm?url';

import createRNNWasmModule from '@jitsi/rnnoise-wasm/dist/rnnoise.js';

/// 150 frames (1.5 s) lets the GRU state and JIT settle; the ms cap is an early exit.
const WARMUP_FRAMES = 150;
const WARMUP_BUDGET_MS = 300;

// DeepFilterNet3 is build output (`bun run dsp:build`), so these are looked up rather than imported: a build without them finds nothing here and every call uses RNNoise.
const deepFilterAssets = import.meta.glob('../assets/dsp/deepfilter*', { query: '?url', import: 'default', eager: true });
const deepFilterUrl = (name) => deepFilterAssets[`../assets/dsp/${name}`] || null;

export const deepFilterShipped = () => Boolean(deepFilterUrl('deepfilter.wasm') && deepFilterUrl('deepfilter-model.bin'));

let deepFilterPromise = null;

function deepFilterBinaries() {
  if (!deepFilterPromise) {
    const get = (name) => fetch(deepFilterUrl(name)).then((response) => {
      if (!response.ok) throw new Error(`${name} fetch returned ${response.status}`);
      return response.arrayBuffer();
    });
    deepFilterPromise = Promise.all([get('deepfilter.wasm'), get('deepfilter-model.bin')])
      .then(([wasm, model]) => ({ wasm, model }))
      .catch((error) => { deepFilterPromise = null; throw error; });
  }
  return deepFilterPromise;
}

/// What the worklet needs to start an engine; the buffers are copied by `postMessage`, so the cached originals stay usable for a later swap.
async function engineMessage(engine) {
  if (engine === 'dfn3') return { type: 'engine', engine, ...(await deepFilterBinaries()) };
  return { type: 'engine', engine, binary: await modelBinary() };
}

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

/// Timed rather than feature-detected, and memoised. Returns `{ ok, reason, load, engine }`: `engine` is the best one this device can run, DeepFilterNet3 when it is shipped and fast enough here, else RNNoise.
export function probeNeural({ force = false } = {}) {
  if (force) probePromise = null;
  if (probePromise) return probePromise;
  probePromise = (async () => {
    const base = await probeRnnoise();
    if (!base.ok) return { ...base, engine: null };
    const better = await probeDeepFilter();
    return { ...base, engine: better.ok ? 'dfn3' : 'rnnoise', deepFilter: better };
  })();
  return probePromise;
}

/// DeepFilterNet3 on this device, in the same terms as RNNoise: the share of one core it needs for real time. A missing build or a failed load is a quiet "no", not an error: RNNoise is the floor.
async function probeDeepFilter() {
  if (!deepFilterShipped()) return { ok: false, reason: 'not-shipped', load: null };
  let engine = null;
  try {
    const { wasm, model } = await deepFilterBinaries();
    const { instance } = await WebAssembly.instantiate(wasm, {});
    const x = instance.exports;
    const bytes = new Uint8Array(model);
    const at = x.df_alloc(bytes.length);
    new Uint8Array(x.memory.buffer, at, bytes.length).set(bytes);
    const state = x.df_create(at, bytes.length, 100);
    x.df_free(at, bytes.length);
    if (!state) return { ok: false, reason: 'load-failed', load: null };
    const input = x.df_alloc(FRAME_SAMPLES * 4);
    const output = x.df_alloc(FRAME_SAMPLES * 4);
    engine = { x, state, input, output };
    // Noise again: it is the hard case, and the model's first frames are its slowest.
    const noise = new Float32Array(x.memory.buffer, input, FRAME_SAMPLES);
    for (let i = 0; i < FRAME_SAMPLES; i += 1) noise[i] = (Math.random() - 0.5) * 0.2;
    const started = performance.now();
    let frames = 0;
    let cpuMs = 0;
    while (frames < WARMUP_FRAMES && cpuMs < WARMUP_BUDGET_MS * 2) {
      x.df_process(state, input, output);
      frames += 1;
      cpuMs = performance.now() - started;
    }
    const verdict = benchmarkVerdict({ frames, cpuMs }, DEEPFILTER_CEILING);
    return { ok: verdict.ok, reason: verdict.ok ? null : verdict.reason, load: verdict.load };
  } catch {
    return { ok: false, reason: 'load-failed', load: null };
  } finally {
    if (engine) {
      try { engine.x.df_destroy(engine.state); } catch { /* the module is dropped with this scope anyway */ }
    }
  }
}

/// The RNNoise half of the probe, as it always was.
async function probeRnnoise() {
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
}

/// Owns its own 48 kHz `AudioContext`; LiveKit's would not guarantee the rate.
export class DenoiseChain {
  /// `onPause` and `onResume` bracket a stretch where the machine was too busy and the model stood aside; `onOverload` is called at most once, when it has been busy so often that the call should stop asking.
  constructor({ onOverload, onPause, onResume, onEngine, engine = 'rnnoise' } = {}) {
    this.context = null;
    this.node = null;
    this.source = null;
    this.destination = null;
    this.onOverload = onOverload || (() => {});
    this.onPause = onPause || (() => {});
    this.onResume = onResume || (() => {});
    this.onEngine = onEngine || (() => {});
    this.engine = engine;
    this.governor = createGovernor();
    this.paused = false;
    this.pauseTimer = null;
    this.lastLoad = null;
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

    this.node.port.postMessage(await engineMessage(this.engine));
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
      if (this.watching === 'worklet' || this.paused) return;
      this.watching = 'capacity';
      this.strike({ underrunRatio: event.underrunRatio });
    });
    try { capacity.start({ updateInterval: 1 }); } catch { this.capacity = null; }
  }

  onStats(message) {
    if (message?.type === 'failed') {
      // Only the engine now running can fail the call; news of one already replaced is old.
      if (message.engine === this.engine) this.stepDown('load-failed');
      return;
    }
    if (message?.type !== 'stats') return;
    if (!Number.isFinite(message.load)) return;
    this.lastLoad = message.load;
    // The worklet has a clock, so it wins and the capacity events stand down.
    this.watching = 'worklet';
    this.strike({ load: message.load, worstMs: message.worstMs, quantumMs: message.quantumMs });
  }

  strike(sample) {
    if (this.paused || this.spent) return;
    const heavy = this.engine === 'dfn3';
    const verdict = this.governor.push(sample, heavy ? DEEPFILTER_OVERLOAD : OVERLOAD);
    if (!verdict) return;
    // A model with a lighter one below it is swapped for that one, not paused: a pause only brings the same late frames back in 15 seconds.
    if (verdict.giveUp || (heavy && nextEngine(this.engine))) { this.stepDown('too-slow'); return; }
    this.pause(verdict.pauseMs, sample);
  }

  /// The engine could not be afforded or could not run: the next one down takes over, in place, and only when none is left does the call give up on neural altogether.
  stepDown(reason) {
    const next = nextEngine(this.engine);
    if (!next) { this.give(reason); return; }
    console.info('[denoise] stepping down', { from: this.engine, to: next, reason, lastLoad: this.lastLoad });
    clearTimeout(this.pauseTimer);
    this.pauseTimer = null;
    this.paused = false;
    this.governor = createGovernor();
    this.watching = null;
    this.engine = next;
    this.setBypass(false);
    engineMessage(next)
      .then((message) => { if (!this.spent && this.node) this.node.port.postMessage(message); })
      .catch(() => this.give('load-failed'));
    try { this.onEngine(next, reason); } catch { /* a UI callback must not break the call */ }
  }

  /// Passes the microphone straight through, then tries again. The graph stays up, so coming back is a flag and not a rebuild.
  pause(ms, sample) {
    this.paused = true;
    // Left in the console so a report of "it turned itself off" can say what the machine was doing.
    console.info('[denoise] paused', { ms, load: sample?.load ?? null, underrunRatio: sample?.underrunRatio ?? null, pauses: this.governor.pauses });
    this.setBypass(true);
    try { this.onPause({ reason: 'too-slow', load: sample?.load ?? null, pauses: this.governor.pauses }); } catch { /* a UI callback must not break the call */ }
    clearTimeout(this.pauseTimer);
    this.pauseTimer = setTimeout(() => {
      this.pauseTimer = null;
      if (this.spent || !this.node) return;
      this.paused = false;
      this.governor.resumed();
      this.setBypass(false);
      try { this.onResume(); } catch { /* as above */ }
    }, ms);
  }

  /// The call has stopped using the model (its own decision, not ours): no timer may switch it back on.
  retire() {
    this.spent = true;
    clearTimeout(this.pauseTimer);
    this.pauseTimer = null;
    this.setBypass(true);
  }

  give(reason) {
    if (this.spent) return;
    this.spent = true;
    console.info('[denoise] giving up for this call', { reason, lastLoad: this.lastLoad });
    this.onOverload(reason);
  }

  async stop() {
    clearTimeout(this.pauseTimer);
    this.pauseTimer = null;
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
