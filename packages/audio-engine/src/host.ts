/**
 * Audio host — main-thread side of the engine.
 *
 * Per docs/implementation.html §04: this file holds the AudioContext,
 * loads the worklet, and proxies messages between the React state and the
 * audio thread.
 *
 * v0.2 playback model — simple, deliberately:
 *
 *   AudioBufferSourceNode (per stem)
 *      └─→ master GainNode
 *               └─→ AudioWorkletNode  (pass-through DSP for now)
 *                        └─→ AudioContext.destination
 *
 * The worklet stays in the chain so future per-channel DSP slots in
 * without restructuring. Multi-source mixing happens at the master gain
 * node where Web Audio sums inputs.
 */

import type { AudioGraph, WorkletEvent, WorkletMessage } from './types';

export interface AudioHostOptions {
  /** URL to the compiled worklet module. */
  workletUrl: string | URL;
  /** Sample rate (default: AudioContext default). */
  sampleRate?: number;
}

export interface StemHandle {
  id: string;
  buffer: AudioBuffer;
}

export class AudioHost {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private node: AudioWorkletNode | null = null;
  private listeners = new Set<(e: WorkletEvent) => void>();

  /** Currently-playing source nodes, keyed by stem id, plus their stem id. */
  private activeSources = new Map<string, AudioBufferSourceNode>();

  /** Loaded stem buffers, keyed by stem id. */
  private buffers = new Map<string, AudioBuffer>();

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

    this.masterGain = this.ctx.createGain();

    this.node.port.onmessage = (e: MessageEvent<WorkletEvent>) => {
      for (const l of this.listeners) l(e.data);
    };

    // masterGain → worklet → destination
    this.masterGain.connect(this.node);
    this.node.connect(this.ctx.destination);
  }

  async stop(): Promise<void> {
    this.stopAll();
    if (this.node) {
      this.node.disconnect();
      this.node = null;
    }
    if (this.masterGain) {
      this.masterGain.disconnect();
      this.masterGain = null;
    }
    if (this.ctx) {
      await this.ctx.close();
      this.ctx = null;
    }
    this.buffers.clear();
  }

  /** Decode a fetched audio file into an AudioBuffer cached against the stem id. */
  async loadStem(stemId: string, audioData: ArrayBuffer): Promise<void> {
    if (!this.ctx) throw new Error('AudioHost not started');
    if (this.buffers.has(stemId)) return;
    const buffer = await this.ctx.decodeAudioData(audioData.slice(0));
    this.buffers.set(stemId, buffer);
  }

  /** Has the stem been decoded and cached? */
  isLoaded(stemId: string): boolean {
    return this.buffers.has(stemId);
  }

  /** Sum-duration of the longest loaded stem, in seconds. */
  get durationSeconds(): number {
    let max = 0;
    for (const b of this.buffers.values()) {
      if (b.duration > max) max = b.duration;
    }
    return max;
  }

  /** Start every loaded stem in-sync. `offsetSeconds` lets us start mid-session. */
  playAll(offsetSeconds = 0): void {
    if (!this.ctx || !this.masterGain) throw new Error('AudioHost not started');
    if (this.ctx.state === 'suspended') void this.ctx.resume();

    this.stopAll();

    for (const [stemId, buffer] of this.buffers) {
      const src = this.ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(this.masterGain);
      src.onended = () => this.activeSources.delete(stemId);
      src.start(0, Math.min(offsetSeconds, buffer.duration));
      this.activeSources.set(stemId, src);
    }
  }

  /** Stop every currently-playing source. */
  stopAll(): void {
    for (const src of this.activeSources.values()) {
      try {
        src.onended = null;
        src.stop(0);
      } catch {
        // Source already stopped.
      }
      src.disconnect();
    }
    this.activeSources.clear();
  }

  /** Are any sources currently playing? */
  get isPlaying(): boolean {
    return this.activeSources.size > 0;
  }

  /** Set the master output gain — 0..1 typically, 0 = silent. */
  setMasterGain(value: number, rampSeconds = 0.01): void {
    if (!this.masterGain || !this.ctx) return;
    const target = Math.max(0, Math.min(4, value));
    this.masterGain.gain.cancelScheduledValues(this.ctx.currentTime);
    this.masterGain.gain.linearRampToValueAtTime(target, this.ctx.currentTime + rampSeconds);
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

  /** AudioContext.currentTime — for transport math. */
  get currentTime(): number {
    return this.ctx?.currentTime ?? 0;
  }
}
