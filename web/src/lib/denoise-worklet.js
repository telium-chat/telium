// Audio render thread half of neural noise cancellation. No `fetch`, `importScripts` or dynamic `import` exists here, so the main thread posts the wasm bytes and they are handed to Emscripten as `wasmBinary` (hence not the base64-inlined `-sync` build). `performance` may be missing; timing is then best-effort.

import createRNNWasmModule from '@jitsi/rnnoise-wasm/dist/rnnoise.js';

const FRAME = 480;

const QUANTUM = 128;

/// 128 and 480 don't divide, so the output can run up to 480 - gcd(128, 480) = 448 samples behind; prefilling that many zeros is the smallest buffer that never underruns (9.33 ms).
const PREFILL = 448;

/// Prefill plus one frame, rounded up to a power of two so the wrap is a mask.
const RING = 1024;

/// RNNoise was trained on 16-bit PCM scale; Web Audio hands us +/-1.
const PCM = 32768;

/// About once a second (375 quanta at 48 kHz).
const REPORT_QUANTA = 375;

const clock = typeof performance === 'object' && typeof performance?.now === 'function'
  ? () => performance.now()
  : null;

class DenoiseProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.module = null;
    this.state = 0;          // rnnoise_create handle
    this.heapPtr = 0;        // the one 480-float scratch buffer, reused forever
    this.bypass = false;
    this.failed = false;

    this.frame = new Float32Array(FRAME);
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
    if (message.type === 'bypass') { this.bypass = Boolean(message.on); return; }
    if (message.type !== 'wasm') return;
    // Until instantiation resolves we are a wire: heard un-denoised rather than not heard.
    createRNNWasmModule({ wasmBinary: message.binary })
      .then((module) => {
        this.module = module;
        this.state = module._rnnoise_create(0);
        this.heapPtr = module._malloc(FRAME * 4);
        this.port.postMessage({ type: 'ready' });
      })
      .catch((error) => {
        this.failed = true;
        this.port.postMessage({ type: 'failed', message: String(error?.message || error) });
      });
  }

  denoise() {
    const { module, heapPtr } = this;
    const base = heapPtr >> 2;
    const heap = module.HEAPF32;
    for (let i = 0; i < FRAME; i += 1) heap[base + i] = this.frame[i] * PCM;
    module._rnnoise_process_frame(this.state, heapPtr, heapPtr);
    for (let i = 0; i < FRAME; i += 1) {
      this.ring[(this.write + i) & (RING - 1)] = heap[base + i] / PCM;
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
    if (this.bypass || this.failed || !this.module) { output.set(input); return true; }

    const started = clock ? clock() : 0;

    for (let i = 0; i < input.length; i += 1) {
      this.frame[this.fill] = input[i];
      this.fill += 1;
      if (this.fill === FRAME) { this.denoise(); this.fill = 0; }
    }
    for (let i = 0; i < output.length; i += 1) {
      output[i] = this.ring[(this.read + i) & (RING - 1)];
    }
    this.read = (this.read + output.length) & (RING - 1);

    if (clock) {
      const spent = clock() - started;
      this.cpuMs += spent;
      if (spent > this.worstMs) this.worstMs = spent;
    }
    this.quanta += 1;
    if (this.quanta >= REPORT_QUANTA) {
      // `load` is the fraction of wall-clock time spent in this node; past ~0.6 there is no headroom left for resampling, mixing and echo cancellation.
      const wallMs = (this.quanta * QUANTUM * 1000) / sampleRate;
      this.port.postMessage({
        type: 'stats',
        load: clock ? this.cpuMs / wallMs : null,
        worstMs: clock ? this.worstMs : null,
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
