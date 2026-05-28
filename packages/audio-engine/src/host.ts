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
   * the gain node. Insert order: source → eq8 → compClean → compColor →
   * gain → panner → …
   */
  compCleanWorkletUrl?: string | URL;
  /** URL to comp_clean_bg.wasm. */
  compCleanWasmUrl?: string | URL;
  /**
   * URL to the Comp-Color worklet processor (FET-style). When provided
   * alongside `compColorWasmUrl`, every channel also gets a Comp-Color
   * node sitting after Comp-Clean. The UI flips between Clean and Color
   * by bypassing the inactive one; the audio path doesn't change.
   */
  compColorWorkletUrl?: string | URL;
  /** URL to comp_color_bg.wasm. */
  compColorWasmUrl?: string | URL;
  /**
   * URL to the Limiter worklet (true-peak protection). When provided
   * alongside `limiterWasmUrl`, the Master bus inserts a Limiter node
   * between its gain stage and the final analyser. No effect on user buses
   * (yet) — those gain plugin chains in a later slice.
   */
  limiterWorkletUrl?: string | URL;
  /** URL to limiter_bg.wasm. */
  limiterWasmUrl?: string | URL;
  /**
   * URL to the Plate-reverb worklet (Dattorro-style). When both URLs are
   * present, any user bus can host one optional reverb insert via
   * addBusReverb(busId, 'plate'). The Master bus never hosts a reverb.
   */
  plateWorkletUrl?: string | URL;
  /** URL to plate_bg.wasm. */
  plateWasmUrl?: string | URL;
  /**
   * URL to the Hall-reverb worklet (denser diffusion, longer tank). Same
   * insertion model as Plate — a bus can host *one* reverb of either kind.
   */
  hallWorkletUrl?: string | URL;
  /** URL to hall_bg.wasm. */
  hallWasmUrl?: string | URL;
  /** Sample rate (default: AudioContext default). */
  sampleRate?: number;
}

/** Which reverb DSP fills the bus's single reverb slot. */
export type ReverbKind = 'plate' | 'hall';

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
  /** Bus id this channel's main output routes to. Defaults to MASTER_BUS_ID. */
  outputBusId?: string;
}

/**
 * Stable id for the always-present Master bus. Sessions never need to mint
 * this themselves — the host creates it during start() and exposes it as a
 * known target for channels and other buses.
 */
export const MASTER_BUS_ID = 'master';

export interface BusInit {
  id: string;
  /** Human-facing label. Server is the source of truth; defaults to `id`. */
  name?: string;
  /** Linear gain, 0..2. Default 1. */
  gain?: number;
}

interface BusInternals {
  id: string;
  name: string;
  /** Summing junction — channels and other buses connect here. */
  input: GainNode;
  /** Bus-level gain (fader). input → gainNode → [chain] → analyser. */
  gainNode: GainNode;
  /** True-peak limiter — populated only on the Master bus, and only when
   *  the host was started with limiter URLs. Sits between gainNode and
   *  analyser so the meter shows the post-limit signal. */
  limiter: AudioWorkletNode | null;
  /** Latest gain reduction (≥ 0) from the limiter — used to drive the
   *  Master strip's GR display. */
  limiterGrDb: number;
  /** Optional reverb insert on a user bus (Plate or Hall). Sits between
   *  `gainNode` and `analyser`. Master never hosts a reverb. */
  reverb: AudioWorkletNode | null;
  /** Kind currently filling the reverb slot; null when no reverb is set. */
  reverbKind: ReverbKind | null;
  analyser: AnalyserNode;
  meterBuffer: Float32Array<ArrayBuffer>;
  gain: number;
  muted: boolean;
  /**
   * Bus that this bus routes into. Null for the Master bus, whose output
   * feeds the masterGain → worklet → destination chain directly.
   */
  outputBusId: string | null;
}

interface ChannelInternals {
  stemId: string;
  buffer: AudioBuffer | null;
  /** EQ-8 worklet — receives the source, output feeds into `comp` (or `gain`
   *  if comp is null). Null when the host was started without EQ-8 URLs. */
  eq8: AudioWorkletNode | null;
  /** Comp-Clean worklet — receives `eq8` output (or source if no EQ).
   *  Output feeds `compColor` if present, else `gain`. */
  comp: AudioWorkletNode | null;
  /** Comp-Color worklet — receives `comp` output (or source / eq if neither
   *  Clean nor EQ is configured). Output feeds `gain`. */
  compColor: AudioWorkletNode | null;
  /** Latest gain reduction (≥ 0) from whichever comp is currently active. */
  compGrDb: number;
  /** Latest GR from the Color-flavor comp, surfaced separately for the meter. */
  compColorGrDb: number;
  gain: GainNode;
  panner: StereoPannerNode;
  analyser: AnalyserNode;
  meterBuffer: Float32Array<ArrayBuffer>;
  volume: number;
  pan: number;
  muted: boolean;
  soloed: boolean;
  /** Id of the bus this channel routes to. Reconnections happen through
   *  reroute(), which disconnects from the prior bus's input and reattaches. */
  outputBusId: string;
  /**
   * Post-fader aux sends, keyed by destination bus id. Each send is a
   * GainNode tapped from `gain.output` and routed to the destination bus's
   * `input`. Live changes to the level write to the node's gain param.
   */
  sends: Map<string, GainNode>;
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
  /** Same again for Comp-Color (FET). */
  private compColorWasmModule: WebAssembly.Module | null = null;
  /** Limiter — currently only used on the Master bus. */
  private limiterWasmModule: WebAssembly.Module | null = null;
  /** Plate / Hall reverb modules — keyed by kind so addBusReverb can pick. */
  private reverbWasmModules: Partial<Record<ReverbKind, WebAssembly.Module>> = {};

  private channels = new Map<string, ChannelInternals>();
  private buses = new Map<string, BusInternals>();

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

    if (this.options.compColorWorkletUrl && this.options.compColorWasmUrl) {
      await this.ctx.audioWorklet.addModule(this.options.compColorWorkletUrl);
      const res = await fetch(this.options.compColorWasmUrl);
      if (!res.ok) throw new Error(`comp-color wasm fetch failed (${res.status})`);
      this.compColorWasmModule = await WebAssembly.compileStreaming(
        new Response(await res.arrayBuffer(), {
          headers: { 'Content-Type': 'application/wasm' },
        })
      );
    }

    if (this.options.limiterWorkletUrl && this.options.limiterWasmUrl) {
      await this.ctx.audioWorklet.addModule(this.options.limiterWorkletUrl);
      const res = await fetch(this.options.limiterWasmUrl);
      if (!res.ok) throw new Error(`limiter wasm fetch failed (${res.status})`);
      this.limiterWasmModule = await WebAssembly.compileStreaming(
        new Response(await res.arrayBuffer(), {
          headers: { 'Content-Type': 'application/wasm' },
        })
      );
    }

    if (this.options.plateWorkletUrl && this.options.plateWasmUrl) {
      await this.ctx.audioWorklet.addModule(this.options.plateWorkletUrl);
      const res = await fetch(this.options.plateWasmUrl);
      if (!res.ok) throw new Error(`plate wasm fetch failed (${res.status})`);
      this.reverbWasmModules.plate = await WebAssembly.compileStreaming(
        new Response(await res.arrayBuffer(), {
          headers: { 'Content-Type': 'application/wasm' },
        })
      );
    }

    if (this.options.hallWorkletUrl && this.options.hallWasmUrl) {
      await this.ctx.audioWorklet.addModule(this.options.hallWorkletUrl);
      const res = await fetch(this.options.hallWasmUrl);
      if (!res.ok) throw new Error(`hall wasm fetch failed (${res.status})`);
      this.reverbWasmModules.hall = await WebAssembly.compileStreaming(
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

    // The Master bus is the only bus that always exists; it's the implicit
    // routing target for new channels. Its input + gain feed directly into
    // masterGain (i.e. the existing final-stage node), so for v0.3 first
    // slice nothing audibly changes — we've just made the topology explicit
    // so user-created buses can plug into the same model.
    this.addBus({ id: MASTER_BUS_ID, name: 'Master', gain: 1 });
  }

  async stop(): Promise<void> {
    this.stopAll();
    for (const channel of this.channels.values()) {
      if (channel.eq8) channel.eq8.disconnect();
      if (channel.comp) channel.comp.disconnect();
      if (channel.compColor) channel.compColor.disconnect();
      for (const send of channel.sends.values()) send.disconnect();
      channel.sends.clear();
      channel.gain.disconnect();
      channel.panner.disconnect();
      channel.analyser.disconnect();
    }
    this.channels.clear();
    for (const bus of this.buses.values()) {
      bus.input.disconnect();
      bus.gainNode.disconnect();
      if (bus.limiter) bus.limiter.disconnect();
      if (bus.reverb) bus.reverb.disconnect();
      bus.analyser.disconnect();
    }
    this.buses.clear();
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

    const outputBusId = init.outputBusId ?? MASTER_BUS_ID;
    const outputBus = this.buses.get(outputBusId) ?? this.buses.get(MASTER_BUS_ID);
    if (!outputBus) throw new Error('master bus missing — start() not run?');

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
    //   source → [eq8] → [comp] → [compColor] → gain → panner → analyser → master
    //
    // Bracketed nodes are conditional: they only exist if the corresponding
    // WASM module was loaded at start(). With everything off the routing
    // reduces to source → gain → ... as before.
    let compColor: AudioWorkletNode | null = null;
    if (this.compColorWasmModule) {
      compColor = new AudioWorkletNode(this.ctx, 'aux-comp-color-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        processorOptions: { wasmModule: this.compColorWasmModule },
      });
      compColor.connect(gain);
    }

    let comp: AudioWorkletNode | null = null;
    if (this.compWasmModule) {
      comp = new AudioWorkletNode(this.ctx, 'aux-comp-clean-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        processorOptions: { wasmModule: this.compWasmModule },
      });
      comp.connect(compColor ?? gain);
    }

    let eq8: AudioWorkletNode | null = null;
    if (this.eq8WasmModule) {
      eq8 = new AudioWorkletNode(this.ctx, 'aux-eq8-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        processorOptions: { wasmModule: this.eq8WasmModule },
      });
      eq8.connect(comp ?? compColor ?? gain);
    }

    // gain → panner → analyser → outputBus.input
    gain.connect(panner);
    panner.connect(analyser);
    analyser.connect(outputBus.input);

    const channelInternals: ChannelInternals = {
      stemId: init.stemId,
      buffer: null,
      eq8,
      comp,
      compColor,
      compGrDb: 0,
      compColorGrDb: 0,
      gain,
      panner,
      analyser,
      meterBuffer: new Float32Array(analyser.fftSize),
      volume,
      pan,
      muted: false,
      soloed: false,
      outputBusId: outputBus.id,
      sends: new Map(),
      source: null,
    };

    if (comp) {
      comp.port.onmessage = (e: MessageEvent<{ type: string; db: number }>) => {
        if (e.data?.type === 'gr') channelInternals.compGrDb = e.data.db;
      };
    }
    if (compColor) {
      compColor.port.onmessage = (e: MessageEvent<{ type: string; db: number }>) => {
        if (e.data?.type === 'gr') channelInternals.compColorGrDb = e.data.db;
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
    if (channel.compColor) channel.compColor.disconnect();
    for (const send of channel.sends.values()) send.disconnect();
    channel.sends.clear();
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

  // ────────────────────────────────────────────────────────────────────
  // Comp-Color parameters (FET-style)
  // ────────────────────────────────────────────────────────────────────

  /**
   * Push the seven Color-flavor params at once. Drive is the extra
   * parameter Comp-Clean doesn't have — pre-gain into the tanh stage,
   * 0..24 dB. No-op if the host was started without Color URLs.
   */
  setChannelCompColor(
    stemId: string,
    thresholdDb: number,
    ratio: number,
    attackMs: number,
    releaseMs: number,
    makeupDb: number,
    mix: number,
    driveDb: number
  ): void {
    const channel = this.channels.get(stemId);
    if (!channel?.compColor) return;
    channel.compColor.port.postMessage({
      type: 'set-params',
      thresholdDb,
      ratio,
      attackMs,
      releaseMs,
      makeupDb,
      mix,
      driveDb,
    });
  }

  setChannelCompColorBypassed(stemId: string, bypassed: boolean): void {
    const channel = this.channels.get(stemId);
    if (!channel?.compColor) return;
    channel.compColor.port.postMessage({ type: 'set-bypassed', bypassed });
  }

  getChannelCompColorGr(stemId: string): number {
    return this.channels.get(stemId)?.compColorGrDb ?? 0;
  }

  // ────────────────────────────────────────────────────────────────────
  // Buses
  // ────────────────────────────────────────────────────────────────────

  /**
   * Create a new bus. The Master bus is created automatically by start();
   * user-defined buses go through here. Idempotent (re-calling with the
   * same id returns silently).
   *
   * Wiring: `input → gainNode → analyser → outputTarget`. For Master the
   * outputTarget is the engine's existing masterGain node (so the final
   * stage stays unchanged). For other buses the outputTarget is the
   * master bus's `input` (single-level routing for now).
   */
  addBus(init: BusInit): void {
    if (!this.ctx || !this.masterGain) throw new Error('AudioHost not started');
    if (this.buses.has(init.id)) return;

    const input = this.ctx.createGain();
    const gainNode = this.ctx.createGain();
    const analyser = this.ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.5;

    const gain = init.gain ?? 1;
    gainNode.gain.value = gain;

    input.connect(gainNode);

    // Master gets a true-peak limiter inserted between its gain stage and
    // the analyser, so the post-limit signal is what the meter shows. User
    // buses skip this until the bus-chain support slice lands.
    const isMaster = init.id === MASTER_BUS_ID;
    let limiter: AudioWorkletNode | null = null;
    if (isMaster && this.limiterWasmModule) {
      limiter = new AudioWorkletNode(this.ctx, 'aux-limiter-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        processorOptions: { wasmModule: this.limiterWasmModule },
      });
      gainNode.connect(limiter);
      limiter.connect(analyser);
    } else {
      gainNode.connect(analyser);
    }

    if (isMaster) {
      analyser.connect(this.masterGain);
    } else {
      const master = this.buses.get(MASTER_BUS_ID);
      if (!master) throw new Error('master bus must exist before child buses');
      analyser.connect(master.input);
    }

    const busInternals: BusInternals = {
      id: init.id,
      name: init.name ?? init.id,
      input,
      gainNode,
      limiter,
      limiterGrDb: 0,
      reverb: null,
      reverbKind: null,
      analyser,
      meterBuffer: new Float32Array(analyser.fftSize),
      gain,
      muted: false,
      outputBusId: isMaster ? null : MASTER_BUS_ID,
    };

    if (limiter) {
      limiter.port.onmessage = (e: MessageEvent<{ type: string; db: number }>) => {
        if (e.data?.type === 'gr') busInternals.limiterGrDb = e.data.db;
      };
    }

    this.buses.set(init.id, busInternals);
  }

  removeBus(busId: string): void {
    if (busId === MASTER_BUS_ID) return; // refuse to drop the only required bus
    const bus = this.buses.get(busId);
    if (!bus) return;
    // Reroute any channels pointing here back to Master before tearing down.
    for (const channel of this.channels.values()) {
      if (channel.outputBusId === busId) this.setChannelOutput(channel.stemId, MASTER_BUS_ID);
      // Drop any aux sends pointing at this bus.
      const send = channel.sends.get(busId);
      if (send) {
        send.disconnect();
        channel.sends.delete(busId);
      }
    }
    bus.input.disconnect();
    bus.gainNode.disconnect();
    if (bus.limiter) bus.limiter.disconnect();
    if (bus.reverb) bus.reverb.disconnect();
    bus.analyser.disconnect();
    this.buses.delete(busId);
  }

  // ────────────────────────────────────────────────────────────────────
  // Master-bus limiter
  // ────────────────────────────────────────────────────────────────────

  /**
   * Set the master limiter's three params. No-op if the host wasn't started
   * with limiter URLs (no limiter node was inserted).
   */
  setMasterLimiter(thresholdDb: number, releaseMs: number, makeupDb: number): void {
    const master = this.buses.get(MASTER_BUS_ID);
    if (!master?.limiter) return;
    master.limiter.port.postMessage({
      type: 'set-params',
      thresholdDb,
      releaseMs,
      makeupDb,
    });
  }

  setMasterLimiterBypassed(bypassed: boolean): void {
    const master = this.buses.get(MASTER_BUS_ID);
    if (!master?.limiter) return;
    master.limiter.port.postMessage({ type: 'set-bypassed', bypassed });
  }

  /** Most recent gain-reduction in dB from the master limiter (≥ 0). */
  getMasterLimiterGr(): number {
    return this.buses.get(MASTER_BUS_ID)?.limiterGrDb ?? 0;
  }

  // ────────────────────────────────────────────────────────────────────
  // Per-bus Reverb slot (user buses only)
  // ────────────────────────────────────────────────────────────────────

  /** Returns the kind of reverb currently on a bus, or null. */
  getBusReverbKind(busId: string): ReverbKind | null {
    return this.buses.get(busId)?.reverbKind ?? null;
  }

  /**
   * Insert (or swap to) a reverb of the given kind on a user bus. No-op
   * if the bus is Master, unknown, or the requested DSP module wasn't
   * loaded at start(). If a different reverb is already present it's
   * removed first; calling with the same kind is a no-op.
   *
   * Wiring: the existing analyser is unhooked from gainNode, the reverb
   * is spliced in between, and the analyser hangs off the reverb so the
   * meter shows the wet output.
   */
  addBusReverb(busId: string, kind: ReverbKind): void {
    if (!this.ctx || busId === MASTER_BUS_ID) return;
    const bus = this.buses.get(busId);
    if (!bus) return;
    if (bus.reverbKind === kind) return;
    if (bus.reverb) this.removeBusReverb(busId);
    const module = this.reverbWasmModules[kind];
    if (!module) return;

    const processorName = kind === 'plate' ? 'aux-plate-processor' : 'aux-hall-processor';
    const reverb = new AudioWorkletNode(this.ctx, processorName, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: { wasmModule: module },
    });

    try {
      bus.gainNode.disconnect(bus.analyser);
    } catch {
      // Already disconnected; repair below.
    }
    bus.gainNode.connect(reverb);
    reverb.connect(bus.analyser);
    bus.reverb = reverb;
    bus.reverbKind = kind;
  }

  /** Remove the reverb on a user bus and re-bridge gainNode → analyser. */
  removeBusReverb(busId: string): void {
    const bus = this.buses.get(busId);
    if (!bus || !bus.reverb) return;
    try {
      bus.gainNode.disconnect(bus.reverb);
    } catch {
      // Was never wired; nothing to undo.
    }
    bus.reverb.disconnect();
    bus.reverb = null;
    bus.reverbKind = null;
    bus.gainNode.connect(bus.analyser);
  }

  /**
   * Set the four shared reverb params (decay, damping, pre-delay ms, mix).
   * Both Plate and Hall accept the same message shape.
   */
  setBusReverbParams(
    busId: string,
    decay: number,
    damping: number,
    preDelayMs: number,
    mix: number
  ): void {
    const reverb = this.buses.get(busId)?.reverb;
    if (!reverb) return;
    reverb.port.postMessage({ type: 'set-params', decay, damping, preDelayMs, mix });
  }

  setBusReverbBypassed(busId: string, bypassed: boolean): void {
    const reverb = this.buses.get(busId)?.reverb;
    if (!reverb) return;
    reverb.port.postMessage({ type: 'set-bypassed', bypassed });
  }

  setBusGain(busId: string, value: number, rampSec = 0.01): void {
    const bus = this.buses.get(busId);
    if (!bus || !this.ctx) return;
    bus.gain = Math.max(0, Math.min(4, value));
    bus.gainNode.gain.cancelScheduledValues(this.ctx.currentTime);
    bus.gainNode.gain.linearRampToValueAtTime(
      bus.muted ? 0 : bus.gain,
      this.ctx.currentTime + rampSec
    );
  }

  setBusMute(busId: string, muted: boolean, rampSec = 0.005): void {
    const bus = this.buses.get(busId);
    if (!bus || !this.ctx) return;
    bus.muted = muted;
    bus.gainNode.gain.cancelScheduledValues(this.ctx.currentTime);
    bus.gainNode.gain.linearRampToValueAtTime(muted ? 0 : bus.gain, this.ctx.currentTime + rampSec);
  }

  /** Switch a channel's main output to a different bus. */
  setChannelOutput(stemId: string, busId: string): void {
    const channel = this.channels.get(stemId);
    const target = this.buses.get(busId);
    if (!channel || !target) return;
    const previous = this.buses.get(channel.outputBusId);
    if (previous) {
      try {
        channel.analyser.disconnect(previous.input);
      } catch {
        // Edge case: the connection wasn't there (e.g. first wire-up).
      }
    }
    channel.analyser.connect(target.input);
    channel.outputBusId = busId;
  }

  /**
   * Set the level of a post-fader aux send from `stemId` to `busId`. Creates
   * the send node on first call. `level` is linear gain (0..2; 1 = unity).
   * A non-existent destination bus or non-existent channel is a no-op.
   * Master is a valid send target but unusual — sends are typically to
   * effect-return buses, not the main mix.
   */
  setChannelSend(stemId: string, busId: string, level: number, rampSec = 0.01): void {
    const channel = this.channels.get(stemId);
    const target = this.buses.get(busId);
    if (!channel || !target || !this.ctx) return;
    let send = channel.sends.get(busId);
    if (!send) {
      send = this.ctx.createGain();
      send.gain.value = 0;
      // Post-fader tap: channel.gain → send → target.input.
      channel.gain.connect(send);
      send.connect(target.input);
      channel.sends.set(busId, send);
    }
    const clamped = Math.max(0, Math.min(2, level));
    send.gain.cancelScheduledValues(this.ctx.currentTime);
    send.gain.linearRampToValueAtTime(clamped, this.ctx.currentTime + rampSec);
  }

  /** Tear down a single send from `stemId` to `busId`. Idempotent. */
  removeChannelSend(stemId: string, busId: string): void {
    const channel = this.channels.get(stemId);
    if (!channel) return;
    const send = channel.sends.get(busId);
    if (!send) return;
    send.disconnect();
    channel.sends.delete(busId);
  }

  /** Peak amplitude (0..1) at the bus output — for the bus's live meter. */
  getBusLevel(busId: string): number {
    const bus = this.buses.get(busId);
    if (!bus) return 0;
    bus.analyser.getFloatTimeDomainData(bus.meterBuffer);
    let peak = 0;
    for (let i = 0; i < bus.meterBuffer.length; i++) {
      const v = Math.abs(bus.meterBuffer[i] ?? 0);
      if (v > peak) peak = v;
    }
    return peak;
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
      src.connect(channel.eq8 ?? channel.comp ?? channel.compColor ?? channel.gain);
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
