/**
 * aux EQ-8 worklet — one AudioWorkletNode per channel strip, each running
 * an 8-band parametric EQ from @aux/dsp-eq8 (Rust → WASM).
 *
 * Loaded via AudioContext.audioWorklet.addModule('/eq8-worklet.js'). Imports
 * the wasm-bindgen-generated bindings via static ES import — supported in
 * AudioWorkletGlobalScope on Chrome 96+, Firefox 105+, Safari 17+.
 *
 * The host passes WASM bytes through processorOptions at construction time;
 * the processor calls initSync() so its DSP is ready by the first process()
 * call. No async-not-ready window.
 *
 * Message protocol (main → worklet):
 *   { type: 'set-band', idx, bandType, freq, gainDb, q }
 *   { type: 'set-bypassed', bypassed }
 *   { type: 'reset' }
 *
 * Keep this in sync with packages/audio-engine/src/eq8-worklet.ts (the typed
 * reference). Plain JS until the worklet build pipeline lands.
 */

import { Eq8, initSync } from '/eq8.js';

class Eq8Processor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const wasmBytes = options?.processorOptions?.wasmBytes;
    if (!wasmBytes) {
      throw new Error('eq8-worklet: missing processorOptions.wasmBytes');
    }
    initSync({ module: wasmBytes });
    this.eq = new Eq8(sampleRate);
    this.bypassed = false;

    this.port.onmessage = (e) => this.onMessage(e.data);
  }

  onMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'set-band':
        // bandType is the numeric enum value from BandType.
        this.eq.set_band(msg.idx, msg.bandType, msg.freq, msg.gainDb, msg.q);
        break;
      case 'set-bypassed':
        this.bypassed = !!msg.bypassed;
        this.eq.set_bypassed(this.bypassed);
        break;
      case 'reset':
        this.eq.reset();
        break;
    }
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !output) return true;

    // Per-channel: copy input → output, then process in place. The DSP
    // mutates the output buffer; with one Eq8 instance shared across L/R it
    // keeps independent state per channel index.
    for (let ch = 0; ch < output.length; ch++) {
      const inCh = input[ch];
      const outCh = output[ch];
      if (!outCh) continue;
      if (inCh) {
        outCh.set(inCh);
        this.eq.process(outCh, ch);
      } else {
        outCh.fill(0);
      }
    }
    return true;
  }
}

registerProcessor('aux-eq8-processor', Eq8Processor);
