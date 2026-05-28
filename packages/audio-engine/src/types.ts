/**
 * Plugin API contract per docs/implementation.html §16.03.
 *
 * Every native plugin (and v2 third-party plugin) implements this interface.
 * The DSP itself runs as a WASM module; this is the host-side wrapper.
 */
export interface PluginModule {
  /** Initialize. Returns an internal pointer (for WASM modules). */
  init(sampleRate: number, maxBlockSize: number): number;

  /** Process one block. Parameters arrive as pre-smoothed Float32Arrays. */
  process(
    ptr: number,
    inputPtr: number,
    outputPtr: number,
    paramsPtr: number,
    nFrames: number
  ): void;

  /** Restore plugin state from JSON. */
  setState(ptr: number, json: string): void;

  /** Serialize plugin state to JSON. */
  getState(ptr: number): string;

  /** Return the declarative parameter schema (JSON). */
  getSchema(): string;

  /** Report plugin latency in samples (for plugin delay compensation). */
  latencySamples(ptr: number): number;
}

/** A node in the runtime audio graph. */
export interface GraphNode {
  id: string;
  type: 'channel' | 'bus' | 'master';
  inputs: string[];
  outputs: string[];
  fx: string[]; // plugin instance ids
  muted: boolean;
  soloed: boolean;
  volume: number; // 0..1, ramped per block
  pan: number; // -1..1
}

/** The audio graph as the worklet sees it. */
export interface AudioGraph {
  version: number;
  nodes: Record<string, GraphNode>;
  sampleRate: number;
  blockSize: number;
}

/** Message protocol between main thread and worklet. */
export type WorkletMessage =
  | { type: 'graph-update'; graph: AudioGraph }
  | { type: 'param-change'; nodeId: string; param: string; value: number }
  | { type: 'transport'; action: 'play' | 'pause' | 'stop' | 'seek'; positionMs?: number };

export type WorkletEvent =
  | { type: 'ready' }
  | { type: 'meter'; nodeId: string; peak: [number, number]; rms: [number, number] }
  | { type: 'error'; message: string };
