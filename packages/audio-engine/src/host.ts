/**
 * Audio host — main-thread side of the engine.
 *
 * Per docs/implementation.html §04: this file holds the AudioContext,
 * loads the worklet, and proxies messages between the React state and the
 * audio thread. The graph-builder worker will sit alongside this once the
 * hot-swap protocol is implemented.
 */

import type { AudioGraph, WorkletEvent, WorkletMessage } from './types';

export interface AudioHostOptions {
  /** URL to the compiled worklet module. */
  workletUrl: string | URL;
  /** Sample rate (default: AudioContext default). */
  sampleRate?: number;
}

export class AudioHost {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private listeners = new Set<(e: WorkletEvent) => void>();

  constructor(private readonly options: AudioHostOptions) {}

  async start(): Promise<void> {
    if (this.ctx) return;
    this.ctx = new AudioContext({
      sampleRate: this.options.sampleRate,
      latencyHint: 'interactive',
    });

    await this.ctx.audioWorklet.addModule(this.options.workletUrl);

    this.node = new AudioWorkletNode(this.ctx, 'aux-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });

    this.node.port.onmessage = (e: MessageEvent<WorkletEvent>) => {
      for (const l of this.listeners) l(e.data);
    };

    this.node.connect(this.ctx.destination);
  }

  async stop(): Promise<void> {
    if (this.node) {
      this.node.disconnect();
      this.node = null;
    }
    if (this.ctx) {
      await this.ctx.close();
      this.ctx = null;
    }
  }

  send(msg: WorkletMessage): void {
    if (!this.node) throw new Error('AudioHost not started');
    this.node.port.postMessage(msg);
  }

  updateGraph(graph: AudioGraph): void {
    this.send({ type: 'graph-update', graph });
  }

  onEvent(listener: (e: WorkletEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get context(): AudioContext | null {
    return this.ctx;
  }
}
