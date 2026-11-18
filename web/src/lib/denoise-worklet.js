// Audio render thread half of neural noise cancellation. No `fetch`, `importScripts` or dynamic `import` exists here, so the main thread posts the wasm bytes. Two engines can run behind the same ring buffer and can be swapped while the call is up: DeepFilterNet3 (`dsp/deepfilter`, a plain wasm module with a C ABI: no TextDecoder, which this scope lacks, and no JavaScript imports) and RNNoise (Emscripten, handed `wasmBinary`, hence not the base64-inlined `-sync` build). `performance` may be missing; timing falls back to `Date.now()`.

import createRNNWasmModule from '@jitsi/rnnoise-wasm/dist/rnnoise.js';

const FRAME = 480;

const QUANTUM = 128;

/// 128 and 480 don't divide, so the output can run up to 480 - gcd(128, 480) = 448 samples behind; prefilling that many zeros is the smallest buffer that never underruns (9.33 ms).
const PREFILL = 448;

/// Prefill plus one frame, rounded up to a power of two so the wrap is a mask.
const RING = 1024;

const PCM = 32768;

/// About once a second (375 quanta at 48 kHz).
const REPORT_QUANTA = 375;

/// Chromium does not expose `performance` in this scope, which used to leave the load unmeasured and the decision to a system-wide underrun count. `Date.now()` ticks in whole milliseconds, but a frame takes a fraction of one, so each reading is 0 or 1 with the right odds and a second's worth (about a hundred frames) adds up to the true cost.
const clock = typeof performance === 'object' && typeof performance?.now === 'function'
  ? () => performance.now()
  : () => Date.now();

/// RNNoise was trained on 16-bit PCM scale; Web Audio hands us +/-1.
class RnnoiseEngine {
  constructor(module) {
    this.module = module;
    this.state = module._rnnoise_create(0);
    this.ptr = module._malloc(FRAME * 4);
  }

  run(frame, out) {
    const { module, ptr } = this;
    const base = ptr >> 2;
    const heap = module.HEAPF32;
    for (let i = 0; i < FRAME; i += 1) heap[base + i] = frame[i] * PCM;
    module._rnnoise_process_frame(this.state, ptr, ptr);
    // `HEAPF32` is re-read: a growing heap replaces the view.
    const after = module.HEAPF32;
    for (let i = 0; i < FRAME; i += 1) out[i] = after[base + i] / PCM;
  }

  destroy() {
    this.module._rnnoise_destroy(this.state);
    this.module._free(this.ptr);
  }
}

/// Frames are 480 samples at 48 kHz, the same as RNNoise, so both slot into one ring. Everything is read out of the module's own memory, and the views are rebuilt whenever it grows.
class DeepFilterEngine {
  constructor(exports, state, input, output) {
    this.exports = exports;
    this.state = state;
    this.input = input;
    this.output = output;
  }

  run(frame, out) {
    const { exports, memory = exports.memory } = this;
    new Float32Array(memory.buffer, this.input, FRAME).set(frame);
    exports.df_process(this.state, this.input, this.output);
    out.set(new Float32Array(memory.buffer, this.output, FRAME));
  }

  destroy() {
    const { exports } = this;
    exports.df_destroy(this.state);
    exports.df_free(this.input, FRAME * 4);
    exports.df_free(this.output, FRAME * 4);
  }
}

async function startDeepFilter({ wasm, model }) {
  const { instance } = await WebAssembly.instantiate(wasm, {});
  const exports = instance.exports;
  const bytes = new Uint8Array(model);
  const at = exports.df_alloc(bytes.length);
  new Uint8Array(exports.memory.buffer, at, bytes.length).set(bytes);
  const state = exports.df_create(at, bytes.length, 100);
  exports.df_free(at, bytes.length);
  if (!state) throw new Error('the DeepFilterNet3 model was refused');
  if (exports.df_frame_len(state) !== FRAME) throw new Error('unexpected DeepFilterNet3 frame size');
  return new DeepFilterEngine(exports, state, exports.df_alloc(FRAME * 4), exports.df_alloc(FRAME * 4));
}

async function startRnnoise({ binary }) {
  const module = await createRNNWasmModule({ wasmBinary: binary });
  return new RnnoiseEngine(module);
}

class DenoiseProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.engine = null;
    this.engineName = null;
    this.loading = 0;        // bumped per request so a slow load cannot replace a newer one
    this.bypass = false;

    this.frame = new Float32Array(FRAME);
    this.cleaned = new Float32Array(FRAME);
    this.fill = 0;
    this.ring = new Float32Array(RING);
    this.read = 0;
    this.write = PREFILL;    // the prefill is already-zeroed ring, so just move the head

    this.quanta = 0;
    this.cpuMs = 0;
    this.worstMs = 0;

    this.port.onmessage = (event) => this.handle(event.data);
  }

  handle(message) {
    if (!message) return;
    if (message.type === 'bypass') {
      const on = Boolean(message.on);
      // Coming back starts from silence, not from whatever the ring held when it stopped being fed.
      if (this.bypass && !on) this.reset();
      this.bypass = on;
      return;
    }
    if (message.type !== 'engine') return;
    // Until instantiation resolves we are a wire: heard un-denoised rather than not heard.
    const ticket = this.loading + 1;
    this.loading = ticket;
    const retired = this.engine;
    this.engine = null;
    this.engineName = null;
    try { retired?.destroy(); } catch { /* it is being replaced either way */ }
    const start = message.engine === 'dfn3' ? startDeepFilter(message) : startRnnoise(message);
    start
      .then((engine) => {
        if (ticket !== this.loading) { engine.destroy(); return; }
        this.reset();
        this.engine = engine;
        this.engineName = message.engine;
        this.port.postMessage({ type: 'ready', engine: message.engine });
      })
      .catch((error) => {
        if (ticket !== this.loading) return;
        this.port.postMessage({ type: 'failed', engine: message.engine, message: String(error?.message || error) });
      });
  }

  /// Starts the ring from silence, so nothing left from before a pause or a swap is played.
  reset() {
    this.fill = 0;
    this.ring.fill(0);
    this.read = 0;
    this.write = PREFILL;
  }

  denoise() {
    try {
      this.engine.run(this.frame, this.cleaned);
    } catch (error) {
      // A trap in the engine ends it, not the call: the node turns into a wire and the main thread decides what comes next.
      const name = this.engineName;
      this.engine = null;
      this.engineName = null;
      this.port.postMessage({ type: 'failed', engine: name, message: String(error?.message || error) });
      this.cleaned.set(this.frame);
    }
    for (let i = 0; i < FRAME; i += 1) {
      this.ring[(this.write + i) & (RING - 1)] = this.cleaned[i];
    }
    this.write = (this.write + FRAME) & (RING - 1);
  }

  process(inputs, outputs) {
    const input = inputs[0]?.[0];
    const output = outputs[0]?.[0];
    if (!output) return true;

    // A gone microphone or muted track: the node stays in the graph so unmuting needs no rebuild, and emits silence.
    if (!input) { output.fill(0); return true; }

    // Anything that is not a working, wanted model is a straight copy; bypass is one boolean, not a graph edit racing the audio thread.
    if (this.bypass || !this.engine) { output.set(input); return true; }

    const started = clock();

    for (let i = 0; i < input.length; i += 1) {
      this.frame[this.fill] = input[i];
      this.fill += 1;
      if (this.fill === FRAME) { this.denoise(); this.fill = 0; }
    }
    for (let i = 0; i < output.length; i += 1) {
      output[i] = this.ring[(this.read + i) & (RING - 1)];
    }
    this.read = (this.read + output.length) & (RING - 1);

    const spent = clock() - started;
    this.cpuMs += spent;
    if (spent > this.worstMs) this.worstMs = spent;
    this.quanta += 1;
    if (this.quanta >= REPORT_QUANTA) {
      // `load` is the fraction of wall-clock time spent in this node; past ~0.6 there is no headroom left for resampling, mixing and echo cancellation.
      const wallMs = (this.quanta * QUANTUM * 1000) / sampleRate;
      this.port.postMessage({
        type: 'stats',
        load: this.cpuMs / wallMs,
        worstMs: this.worstMs,
        quantumMs: (QUANTUM * 1000) / sampleRate,
      });
      this.quanta = 0;
      this.cpuMs = 0;
      this.worstMs = 0;
    }
    return true;
  }
}

registerProcessor('telium-denoise', DenoiseProcessor);
