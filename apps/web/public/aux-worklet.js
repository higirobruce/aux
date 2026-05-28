/**
 * aux audio worklet — pass-through DSP.
 *
 * Loaded via AudioContext.audioWorklet.addModule('/aux-worklet.js').
 * Plain JS so the browser can load it directly without a build step.
 * Mirrors packages/audio-engine/src/worklet.ts; keep the two in sync
 * until v0.3 when we wire a real build pipeline (Rust + WASM).
 */

class AuxProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.graph = null;
    this.port.onmessage = (e) => this.onMessage(e.data);
    this.emit({ type: 'ready' });
  }

  onMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'graph-update':
        // TODO: atomic graph swap via SharedArrayBuffer once worker exists.
        this.graph = msg.graph;
        break;
      // 'param-change' and 'transport' are no-ops until the scheduler lands.
    }
  }

  emit(event) {
    this.port.postMessage(event);
  }

  process(inputs, outputs) {
    // v0.2 pass-through. The host routes AudioBufferSourceNodes into our
    // input and we copy to output — the AudioWorklet stays in the chain
    // so per-channel DSP slots in later without restructuring.
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !output) return true;

    for (let ch = 0; ch < output.length; ch++) {
      const outCh = output[ch];
      if (!outCh) continue;
      const inCh = input[ch];
      if (inCh) {
        outCh.set(inCh);
      } else {
        outCh.fill(0);
      }
    }
    return true;
  }
}

registerProcessor('aux-processor', AuxProcessor);
