/**
 * Audio host — main-thread side of the engine.
 *
 * Per docs/implementation.html §04 + §16.01. The graph topology stays
 * stable through the lifetime of the host; only sources come and go as
 * playback starts/stops:
 *
 *     [source: AudioBufferSourceNode]  ← created per play() call
 *           │
 *           ▼
 *     channel.gain  (GainNode — volume × mute × solo)
 *           │
 *           ▼
 *     channel.panner  (StereoPannerNode)
 *           │
 *           ▼  (× N channels)
 *     masterGain  (GainNode — master fader)
 *           │
 *           ▼
 *     workletNode  (AudioWorkletNode — pass-through DSP for now)
 *           │
 *           ▼
 *     AudioContext.destination
 */

import type { AudioGraph, WorkletEvent, WorkletMessage } from './types';

export interface AudioHostOptions {
  /** URL to the master pass-through worklet module. */
  workletUrl: string | URL;
  /**
   * URL to the EQ-8 worklet processor. When set together with `eq8WasmUrl`,
   * every channel gets a per-channel 8-band EQ inserted between source and
   * gain. Omit both to skip the EQ chain entirely (engine tests).
   */
  eq8WorkletUrl?: string | URL;
  /** URL to eq8_bg.wasm — fetched once and cloned into each worklet. */
  eq8WasmUrl?: string | URL;
  /**
   * URL to the Comp-Clean worklet processor. With `compCleanWasmUrl`, every
   * channel gets a per-channel VCA compressor inserted between the EQ and
   * the gain node. Insert order: source → eq8 → comp → gain → panner → ...
   */
  compCleanWorkletUrl?: string | URL;
  /** URL to comp_clean_bg.wasm. */
  compCleanWasmUrl?: string | URL;
  /** Sample rate (default: AudioContext default). */
  sampleRate?: number;
}

/** Numeric band-type enum, mirrors @aux/dsp-eq8's BandType. */
export const Eq8BandType = {
  Bypass: 0,
  HighPass: 1,
  LowShelf: 2,
  Peak: 3,
  HighShelf: 4,
  LowPass: 5,
} as const;
export type Eq8BandType = (typeof Eq8BandType)[keyof typeof Eq8BandType];

export interface ChannelInit {
  stemId: string;
  /** Linear gain, 0..2; 1 = unity (0 dB). Default 1. */
  volume?: number;
  /** Pan, -1..1; 0 = center. Default 0. */
  pan?: number;
}

interface ChannelInternals {
  stemId: string;
  buffer: AudioBuffer | null;
  /** EQ-8 worklet — receives the source, output feeds into `comp` (or `gain`
   *  if comp is null). Null when the host was started without EQ-8 URLs. */
  eq8: AudioWorkletNode | null;
  /** Comp-Clean worklet — receives `eq8` output (or source if no EQ).
   *  Output feeds `gain`. Null when started without comp URLs. */
  comp: AudioWorkletNode | null;
  /** Latest gain reduction in dB (≥ 0) reported by the comp worklet. */
  compGrDb: number;
  gain: GainNode;
  panner: StereoPannerNode;
  analyser: AnalyserNode;
  meterBuffer: Float32Array<ArrayBuffer>;
  volume: number;
  pan: number;
  muted: boolean;
  soloed: boolean;
  source: AudioBufferSourceNode | null;
}

export class AudioHost {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private listeners = new Set<(e: WorkletEvent) => void>();
  /** Compiled WASM module shared across worklets via structured clone. Null
   *  until start() loads the EQ-8 module (or if EQ-8 URLs weren't supplied). */
  private eq8WasmModule: WebAssembly.Module | null = null;
  /** Same pattern as eq8WasmModule, but for Comp-Clean. */
  private compWasmModule: WebAssembly.Module | null = null;

  private channels = new Map<string, ChannelInternals>();

  constructor(private readonly options: AudioHostOptions) {}

  async start(): Promise<void> {
    if (this.ctx) return;
    this.ctx = new AudioContext({
      sampleRate: this.options.sampleRate,
      latencyHint: 'interactive',
    });

    await this.ctx.audioWorklet.addModule(this.options.workletUrl);

    // EQ-8 worklet + wasm. Both must be present to enable per-channel EQ —
    // otherwise the engine still works, just without the EQ stage.
    //
    // The WASM is compiled here on the main thread (where async compile is
    // unrestricted) and then structured-cloned into each per-channel worklet
    // via processorOptions. Browsers since 2023 support transferring
    // WebAssembly.Module across worklet boundaries; sync `new
    // WebAssembly.Module(bytes)` inside the worklet was the failure mode
    // surfaced as "Failed to construct 'AudioWorkletNode'" on first play.
    if (this.options.eq8WorkletUrl && this.options.eq8WasmUrl) {
      await this.ctx.audioWorklet.addModule(this.options.eq8WorkletUrl);
      const res = await fetch(this.options.eq8WasmUrl);
      if (!res.ok) throw new Error(`eq8 wasm fetch failed (${res.status})`);
      this.eq8WasmModule = await WebAssembly.compileStreaming(
        new Response(await res.arrayBuffer(), {
          headers: { 'Content-Type': 'application/wasm' },
        })
      );
    }

    if (this.options.compCleanWorkletUrl && this.options.compCleanWasmUrl) {
      await this.ctx.audioWorklet.addModule(this.options.compCleanWorkletUrl);
      const res = await fetch(this.options.compCleanWasmUrl);
      if (!res.ok) throw new Error(`comp-clean wasm fetch failed (${res.status})`);
      this.compWasmModule = await WebAssembly.compileStreaming(
        new Response(await res.arrayBuffer(), {
          headers: { 'Content-Type': 'application/wasm' },
        })
      );
    }

    this.workletNode = new AudioWorkletNode(this.ctx, 'aux-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });

    this.masterGain = this.ctx.createGain();

    this.workletNode.port.onmessage = (e: MessageEvent<WorkletEvent>) => {
      for (const l of this.listeners) l(e.data);
    };

    this.masterGain.connect(this.workletNode);
    this.workletNode.connect(this.ctx.destination);
  }

  async stop(): Promise<void> {
    this.stopAll();
    for (const channel of this.channels.values()) {
      if (channel.eq8) channel.eq8.disconnect();
      if (channel.comp) channel.comp.disconnect();
      channel.gain.disconnect();
      channel.panner.disconnect();
      channel.analyser.disconnect();
    }
    this.channels.clear();
    if (this.workletNode) {
      this.workletNode.disconnect();
      this.workletNode = null;
    }
    if (this.masterGain) {
      this.masterGain.disconnect();
      this.masterGain = null;
    }
    if (this.ctx) {
      await this.ctx.close();
      this.ctx = null;
    }
  }

  // ────────────────────────────────────────────────────────────────────
  // Channels
  // ────────────────────────────────────────────────────────────────────

  /** Register a channel for a stem; idempotent. */
  addChannel(init: ChannelInit): void {
    if (!this.ctx || !this.masterGain) throw new Error('AudioHost not started');
    if (this.channels.has(init.stemId)) return;

    const gain = this.ctx.createGain();
    const panner = this.ctx.createStereoPanner();
    const analyser = this.ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.5;

    const volume = init.volume ?? 1;
    const pan = init.pan ?? 0;
    gain.gain.value = volume;
    panner.pan.value = pan;

    // Per-channel inserts. Built from gain back to source so wiring is
    // straightforward: each new node connects to the previous "front" and
    // becomes the new front; the source ultimately connects to `front`.
    //
    //   source → [eq8] → [comp] → gain → panner → analyser → master
    //
    // Bracketed nodes are conditional: they only exist if the corresponding
    // WASM module was loaded at start(). With both off, the routing reduces
    // to source → gain → ... as before.
    let comp: AudioWorkletNode | null = null;
    if (this.compWasmModule) {
      comp = new AudioWorkletNode(this.ctx, 'aux-comp-clean-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        processorOptions: { wasmModule: this.compWasmModule },
      });
      comp.connect(gain);
    }

    let eq8: AudioWorkletNode | null = null;
    if (this.eq8WasmModule) {
      eq8 = new AudioWorkletNode(this.ctx, 'aux-eq8-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        processorOptions: { wasmModule: this.eq8WasmModule },
      });
      eq8.connect(comp ?? gain);
    }

    // gain → panner → analyser → master
    gain.connect(panner);
    panner.connect(analyser);
    analyser.connect(this.masterGain);

    const channelInternals: ChannelInternals = {
      stemId: init.stemId,
      buffer: null,
      eq8,
      comp,
      compGrDb: 0,
      gain,
      panner,
      analyser,
      meterBuffer: new Float32Array(analyser.fftSize),
      volume,
      pan,
      muted: false,
      soloed: false,
      source: null,
    };

    if (comp) {
      comp.port.onmessage = (e: MessageEvent<{ type: string; db: number }>) => {
        if (e.data?.type === 'gr') channelInternals.compGrDb = e.data.db;
      };
    }

    this.channels.set(init.stemId, channelInternals);
  }

  /** Decode and attach an audio buffer to its channel. Auto-creates the channel. */
  async loadStem(stemId: string, audioData: ArrayBuffer): Promise<void> {
    if (!this.ctx) throw new Error('AudioHost not started');
    if (!this.channels.has(stemId)) this.addChannel({ stemId });
    const channel = this.channels.get(stemId);
    if (!channel) throw new Error(`channel ${stemId} missing`);
    if (channel.buffer) return;
    channel.buffer = await this.ctx.decodeAudioData(audioData.slice(0));
  }

  isLoaded(stemId: string): boolean {
    return this.channels.get(stemId)?.buffer != null;
  }

  removeChannel(stemId: string): void {
    const channel = this.channels.get(stemId);
    if (!channel) return;
    if (channel.source) {
      try {
        channel.source.onended = null;
        channel.source.stop(0);
      } catch {
        // already stopped
      }
      channel.source.disconnect();
      channel.source = null;
    }
    if (channel.eq8) channel.eq8.disconnect();
    if (channel.comp) channel.comp.disconnect();
    channel.gain.disconnect();
    channel.panner.disconnect();
    channel.analyser.disconnect();
    this.channels.delete(stemId);
  }

  // ────────────────────────────────────────────────────────────────────
  // EQ-8 parameters
  // ────────────────────────────────────────────────────────────────────

  /**
   * Configure one band of the channel's EQ-8. No-op if the host was started
   * without EQ-8 worklet URLs.
   *
   * @param idx       band index 0..7 (see docs — typically 0=HP, 1=LS,
   *                  2..5=Peak, 6=HS, 7=LP)
   * @param bandType  numeric BandType (mirror of @aux/dsp-eq8)
   * @param freq      Hz, clamped server-side to (10, Nyquist−1)
   * @param gainDb    dB, used by shelves + peaks; ignored by HP/LP
   * @param q         resonance (peaks) or slope (shelves / HP / LP)
   */
  setChannelEqBand(
    stemId: string,
    idx: number,
    bandType: Eq8BandType,
    freq: number,
    gainDb: number,
    q: number
  ): void {
    const channel = this.channels.get(stemId);
    if (!channel?.eq8) return;
    channel.eq8.port.postMessage({ type: 'set-band', idx, bandType, freq, gainDb, q });
  }

  setChannelEqBypassed(stemId: string, bypassed: boolean): void {
    const channel = this.channels.get(stemId);
    if (!channel?.eq8) return;
    channel.eq8.port.postMessage({ type: 'set-bypassed', bypassed });
  }

  resetChannelEq(stemId: string): void {
    const channel = this.channels.get(stemId);
    if (!channel?.eq8) return;
    channel.eq8.port.postMessage({ type: 'reset' });
  }

  // ────────────────────────────────────────────────────────────────────
  // Comp-Clean parameters
  // ────────────────────────────────────────────────────────────────────

  /**
   * Push all six compressor params at once. No-op if the host was started
   * without Comp-Clean URLs.
   *
   * The DSP fast-paths ratio = 1 (passes input through), so callers can
   * "bypass" a channel just by setting ratio = 1 without flipping bypass.
   */
  setChannelComp(
    stemId: string,
    thresholdDb: number,
    ratio: number,
    attackMs: number,
    releaseMs: number,
    makeupDb: number,
    mix: number
  ): void {
    const channel = this.channels.get(stemId);
    if (!channel?.comp) return;
    channel.comp.port.postMessage({
      type: 'set-params',
      thresholdDb,
      ratio,
      attackMs,
      releaseMs,
      makeupDb,
      mix,
    });
  }

  setChannelCompBypassed(stemId: string, bypassed: boolean): void {
    const channel = this.channels.get(stemId);
    if (!channel?.comp) return;
    channel.comp.port.postMessage({ type: 'set-bypassed', bypassed });
  }

  /** Most recent gain-reduction in dB for the channel's compressor (≥ 0). */
  getChannelCompGr(stemId: string): number {
    return this.channels.get(stemId)?.compGrDb ?? 0;
  }

  /**
   * Read the current peak amplitude (0..1) for a channel — for a live meter.
   * Returns 0 if the channel doesn't exist or nothing is playing.
   */
  getChannelLevel(stemId: string): number {
    const channel = this.channels.get(stemId);
    if (!channel) return 0;
    channel.analyser.getFloatTimeDomainData(channel.meterBuffer);
    let peak = 0;
    for (let i = 0; i < channel.meterBuffer.length; i++) {
      const v = Math.abs(channel.meterBuffer[i] ?? 0);
      if (v > peak) peak = v;
    }
    return peak;
  }

  // ────────────────────────────────────────────────────────────────────
  // Channel parameters
  // ────────────────────────────────────────────────────────────────────

  setChannelVolume(stemId: string, value: number, rampSec = 0.01): void {
    const channel = this.channels.get(stemId);
    if (!channel || !this.ctx) return;
    channel.volume = Math.max(0, Math.min(4, value));
    this.applyEffectiveGain(channel, rampSec);
  }

  setChannelPan(stemId: string, value: number, rampSec = 0.01): void {
    const channel = this.channels.get(stemId);
    if (!channel || !this.ctx) return;
    const pan = Math.max(-1, Math.min(1, value));
    channel.pan = pan;
    channel.panner.pan.cancelScheduledValues(this.ctx.currentTime);
    channel.panner.pan.linearRampToValueAtTime(pan, this.ctx.currentTime + rampSec);
  }

  setChannelMute(stemId: string, muted: boolean): void {
    const channel = this.channels.get(stemId);
    if (!channel) return;
    channel.muted = muted;
    this.applyEffectiveGain(channel);
  }

  setChannelSolo(stemId: string, soloed: boolean): void {
    const channel = this.channels.get(stemId);
    if (!channel) return;
    channel.soloed = soloed;
    // Solo on any channel changes effective gain across every channel.
    for (const c of this.channels.values()) this.applyEffectiveGain(c);
  }

  /**
   * Compute the actual gain to apply to a channel based on volume + mute +
   * global solo state. Writes to the GainNode.
   */
  private applyEffectiveGain(channel: ChannelInternals, rampSec = 0.005): void {
    if (!this.ctx) return;
    const anySoloed = [...this.channels.values()].some((c) => c.soloed);
    let effective = channel.volume;
    if (channel.muted) effective = 0;
    else if (anySoloed && !channel.soloed) effective = 0;

    channel.gain.gain.cancelScheduledValues(this.ctx.currentTime);
    channel.gain.gain.linearRampToValueAtTime(effective, this.ctx.currentTime + rampSec);
  }

  // ────────────────────────────────────────────────────────────────────
  // Transport
  // ────────────────────────────────────────────────────────────────────

  /** Start every loaded channel from the given offset (in seconds). */
  playAll(offsetSeconds = 0): void {
    if (!this.ctx) throw new Error('AudioHost not started');
    if (this.ctx.state === 'suspended') void this.ctx.resume();

    this.stopAll();

    for (const channel of this.channels.values()) {
      if (!channel.buffer) continue;
      const src = this.ctx.createBufferSource();
      src.buffer = channel.buffer;
      // Routing front: prefer eq8 if present, else comp, else gain.
      // addChannel() chains eq8 → comp → gain when both inserts exist.
      src.connect(channel.eq8 ?? channel.comp ?? channel.gain);
      src.onended = () => {
        if (channel.source === src) channel.source = null;
      };
      src.start(0, Math.min(offsetSeconds, channel.buffer.duration));
      channel.source = src;
    }
  }

  /** Stop every currently-playing source. The channel chain stays intact. */
  stopAll(): void {
    for (const channel of this.channels.values()) {
      if (channel.source) {
        try {
          channel.source.onended = null;
          channel.source.stop(0);
        } catch {
          // already stopped
        }
        channel.source.disconnect();
        channel.source = null;
      }
    }
  }

  /** Duration of the longest loaded channel, in seconds. */
  get durationSeconds(): number {
    let max = 0;
    for (const c of this.channels.values()) {
      if (c.buffer && c.buffer.duration > max) max = c.buffer.duration;
    }
    return max;
  }

  /** Master volume, 0..4; 1 = 0 dB. */
  setMasterGain(value: number, rampSec = 0.01): void {
    if (!this.masterGain || !this.ctx) return;
    const target = Math.max(0, Math.min(4, value));
    this.masterGain.gain.cancelScheduledValues(this.ctx.currentTime);
    this.masterGain.gain.linearRampToValueAtTime(target, this.ctx.currentTime + rampSec);
  }

  get isPlaying(): boolean {
    for (const c of this.channels.values()) if (c.source) return true;
    return false;
  }

  // ────────────────────────────────────────────────────────────────────
  // Misc
  // ────────────────────────────────────────────────────────────────────

  send(msg: WorkletMessage): void {
    if (!this.workletNode) throw new Error('AudioHost not started');
    this.workletNode.port.postMessage(msg);
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

  get currentTime(): number {
    return this.ctx?.currentTime ?? 0;
  }
}
