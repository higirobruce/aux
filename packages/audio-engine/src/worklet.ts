/// <reference types="@types/audioworklet" />
/**
 * aux audio worklet — the audio thread.
 *
 * v0.1: pass-through DSP. The internal scheduler walks the graph each block.
 * Per docs/implementation.html §04 the real implementation will hot-swap the
 * graph via atomic pointer swap on a SharedArrayBuffer. For now we mirror the
 * message protocol and pipe input → output unchanged.
 *
 * Loaded via AudioContext.audioWorklet.addModule() — see host.ts.
 */

import type { AudioGraph, WorkletEvent, WorkletMessage } from './types';

class AuxProcessor extends AudioWorkletProcessor {
  private graph: AudioGraph | null = null;

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<WorkletMessage>) => this.onMessage(e.data);
    this.emit({ type: 'ready' });
  }

  private onMessage(msg: WorkletMessage) {
    switch (msg.type) {
      case 'graph-update':
        // TODO: swap atomically via SharedArrayBuffer once worker-side builder exists.
        this.graph = msg.graph;
        break;
      case 'param-change':
      case 'transport':
        // TODO: handle once the scheduler is in.
        break;
    }
  }

  private emit(event: WorkletEvent) {
    this.port.postMessage(event);
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    _parameters: Record<string, Float32Array>
  ): boolean {
    // v0.1 pass-through: copy first input to first output, channel by channel.
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !output) return true;

    for (let ch = 0; ch < output.length; ch++) {
      const inCh = input[ch];
      const outCh = output[ch];
      if (!outCh) continue;
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
