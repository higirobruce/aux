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

import {
  type ClipRegion,
  type ScheduledClip,
  clipsEndSample,
  planClipSchedule,
} from './clip-schedule';
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
   * URL to the Meter worklet (BS.1770 LUFS + true-peak, read-only sink). When
   * provided with `meterWasmUrl`, every channel and the Master bus get a
   * metering tap feeding `getChannelLoudness` / `getMasterLoudness`.
   */
  meterWorkletUrl?: string | URL;
  /** URL to meter_bg.wasm. */
  meterWasmUrl?: string | URL;
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
  /**
   * URL to the Transient-designer worklet (attack/sustain shaper). When
   * loaded, every channel gets a Transient node spliced between Comp-Color
   * and gain. Audio path is silent when both params are 0.
   */
  transientWorkletUrl?: string | URL;
  /** URL to transient_bg.wasm. */
  transientWasmUrl?: string | URL;
  /**
   * URL to the Pitch worklet (monophonic corrector). When loaded, every
   * channel gets a Pitch node spliced between Transient and DeEss. Unlike
   * the other inserts it carries a constant latency when engaged (see
   * `getChannelPitchLatency`), which the host compensates across channels.
   */
  pitchWorkletUrl?: string | URL;
  /** URL to pitch_bg.wasm. */
  pitchWasmUrl?: string | URL;
  /**
   * URL to the DeEss worklet (split-band sibilance tamer). With its wasm,
   * every channel gets a DeEss insert between Transient and Imager.
   */
  deessWorkletUrl?: string | URL;
  /** URL to deess_bg.wasm. */
  deessWasmUrl?: string | URL;
  /**
   * URL to the Imager worklet (M/S stereo width). Sits last in the channel
   * chain so the panner sees the final stereo image.
   */
  imagerWorkletUrl?: string | URL;
  /** URL to imager_bg.wasm. */
  imagerWasmUrl?: string | URL;
  /**
   * URL to the Tape worklet (single-stage tape saturation). Sits between
   * the imager and the gain stage so the saturation works on the final
   * stereo image.
   */
  tapeWorkletUrl?: string | URL;
  /** URL to tape_bg.wasm. */
  tapeWasmUrl?: string | URL;
  /**
   * URL to the Console worklet (asymmetric-clip saturation). Inserts
   * after Tape so the channel chain ends with two cascaded saturators —
   * symmetric "tape" then asymmetric "console" — before the fader.
   */
  consoleWorkletUrl?: string | URL;
  /** URL to console_bg.wasm. */
  consoleWasmUrl?: string | URL;
  /**
   * URL to the MB-Comp worklet (3-band multiband compressor). Sits
   * between EQ-8 and Comp-Clean so the engineer can tame specific bands
   * before the wideband comp catches whatever's left.
   */
  mbcompWorkletUrl?: string | URL;
  /** URL to mbcomp_bg.wasm. */
  mbcompWasmUrl?: string | URL;
  /** Sample rate (default: AudioContext default). */
  sampleRate?: number;
}

/** Which reverb DSP fills the bus's single reverb slot. */
export type ReverbKind = 'plate' | 'hall';

/**
 * Reference Room — a small set of monitoring presets that filter the
 * post-master signal to simulate common playback systems. Engineers flip
 * between them mid-mix to spot-check translation ("does this still work
 * on AirPods?"). Implemented as a cascade of native BiquadFilterNodes
 * inserted between the master fader and the final worklet output, so
 * the meter / limiter still see the true mix.
 */
export type ReferenceRoomPreset = 'off' | 'laptop' | 'earbuds' | 'car';

interface BiquadSpec {
  type: BiquadFilterType;
  freq: number;
  gainDb?: number;
  q?: number;
}

const REFERENCE_ROOM_FILTERS: Record<ReferenceRoomPreset, BiquadSpec[]> = {
  off: [],
  // Laptop speakers: brutal high-pass (no bass extension), midrange bump
  // (tinny / boxed sound), rolled-off treble.
  laptop: [
    { type: 'highpass', freq: 200, q: 0.7 },
    { type: 'peaking', freq: 1500, gainDb: 4, q: 1.5 },
    { type: 'lowpass', freq: 10_000, q: 0.7 },
  ],
  // Earbuds / AirPods: gentle high-pass, presence boost around 3 kHz,
  // mild treble lift. Closer to flat than the laptop but still coloured.
  earbuds: [
    { type: 'highpass', freq: 80, q: 0.7 },
    { type: 'peaking', freq: 3500, gainDb: 3, q: 1.5 },
    { type: 'highshelf', freq: 8000, gainDb: 2 },
  ],
  // Car stereo: bass boost (subs), midrange scoop (cabin nulls), treble
  // roll-off (absorbent interior).
  car: [
    { type: 'lowshelf', freq: 100, gainDb: 6 },
    { type: 'peaking', freq: 400, gainDb: -4, q: 1.0 },
    { type: 'highshelf', freq: 8000, gainDb: -3 },
  ],
};

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

/**
 * A post-fader aux send: a level `gain` tapped from the channel fader, then a
 * `delay` that mirrors the channel's main-path plugin-delay-compensation so the
 * send arrives at its destination bus aligned with everything else (a pitched
 * channel's send would otherwise flam ~10 ms early against the other sends).
 */
interface ChannelSend {
  gain: GainNode;
  delay: DelayNode;
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
   *  Clean nor EQ is configured). Output feeds `transient` if present, else `gain`. */
  compColor: AudioWorkletNode | null;
  /** Optional Transient designer between Comp-Color and gain. */
  transient: AudioWorkletNode | null;
  /** Optional Pitch corrector between Transient and DeEss. Carries a constant
   *  latency when engaged — tracked by `pitchEngaged` for delay-compensation. */
  pitch: AudioWorkletNode | null;
  /** Whether this channel's Pitch insert is currently engaged (not bypassed).
   *  Drives the channel's latency in the PDC calculation. */
  pitchEngaged: boolean;
  /** Latest detected fundamental (Hz, 0 = unvoiced/bypassed) posted by the
   *  Pitch worklet — for the corrector window's pitch graph. */
  pitchHz: number;
  /** Optional DeEss between Transient and Imager. */
  deess: AudioWorkletNode | null;
  /** Optional Imager (M/S width). */
  imager: AudioWorkletNode | null;
  /** Optional Tape saturation. */
  tape: AudioWorkletNode | null;
  /** Optional Console saturation — last channel insert before gain. */
  console: AudioWorkletNode | null;
  /** Optional 3-band multiband compressor — sits between EQ-8 and Comp. */
  mbcomp: AudioWorkletNode | null;
  /** Latest gain reduction (≥ 0) from whichever comp is currently active. */
  compGrDb: number;
  /** Latest GR from the Color-flavor comp, surfaced separately for the meter. */
  compColorGrDb: number;
  gain: GainNode;
  panner: StereoPannerNode;
  analyser: AnalyserNode;
  /** Plugin-delay-compensation: a delay between `analyser` and the output bus
   *  set to (maxChannelLatency − thisChannelLatency) so every channel's
   *  contribution arrives aligned regardless of the Pitch insert's latency. */
  compDelay: DelayNode;
  meterBuffer: Float32Array<ArrayBuffer>;
  /** Real stereo time-domain tap for the goniometer: panner → splitter →
   *  analyserL/R. Null when no metering worklet/feed was configured. */
  gonioSplit: ChannelSplitterNode | null;
  analyserL: AnalyserNode | null;
  analyserR: AnalyserNode | null;
  stereoBufL: Float32Array<ArrayBuffer>;
  stereoBufR: Float32Array<ArrayBuffer>;
  /** BS.1770 metering sink (0 outputs); posts loudness which we cache here. */
  meterNode: AudioWorkletNode | null;
  loudness: Loudness | null;
  volume: number;
  pan: number;
  muted: boolean;
  soloed: boolean;
  /** Id of the bus this channel routes to. Reconnections happen through
   *  reroute(), which disconnects from the prior bus's input and reattaches. */
  outputBusId: string;
  /**
   * Post-fader aux sends, keyed by destination bus id. Tapped from
   * `gain.output`, level → PDC delay → destination bus `input`. Live level
   * changes write to the send's gain param; recomputePdc() keeps its delay
   * matched to the main path.
   */
  sends: Map<string, ChannelSend>;
  /** Live buffer sources — one per scheduled clip (empty clips ⇒ one
   *  whole-buffer source). Recreated on every play / seek / clip edit. */
  sources: AudioBufferSourceNode[];
  /** Timeline clips for this stem, in samples. Empty = whole buffer at t=0. */
  clips: ClipRegion[];
}

/** Latest ITU-R BS.1770 readout posted by a Meter sink (LUFS + dBTP). */
export interface Loudness {
  /** Momentary (400 ms) loudness, LUFS. */
  momentary: number;
  /** Short-term (3 s) loudness, LUFS. */
  short: number;
  /** Integrated (gated) loudness since the last reset, LUFS. */
  integrated: number;
  /** Maximum true-peak since reset, dBTP. */
  truePeakDb: number;
  /** Count of samples over 0 dBTP since reset. */
  overs: number;
}

/** Constant group delay (samples) the Pitch insert imposes while engaged.
 *  Must match `Pitch::latency_samples()` in `@aux/dsp-pitch` (PSOLA synthesis:
 *  ANALYSIS_LAG + SYN_AHEAD = 1664). Used for plugin-delay-compensation. */
const PITCH_LATENCY_SAMPLES = 1664;

/** Half the master-dip duration (s) used to mask the audible delay step when a
 *  PDC change lands during playback (engaging/disengaging Pitch). */
const PDC_MASK_FADE = 0.006;

export class AudioHost {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private workletNode: AudioWorkletNode | null = null;
  /** BS.1770 metering sink on the Master bus (post-limiter) + its cached readout. */
  private masterMeterNode: AudioWorkletNode | null = null;
  private masterLoudness: Loudness | null = null;
  private listeners = new Set<(e: WorkletEvent) => void>();
  /** Transport tracking so a single channel can be re-scheduled mid-playback
   *  (e.g. after a clip edit) from the correct playhead position. */
  private playing = false;
  private playOffsetSec = 0;
  private playStartCtxTime = 0;
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
  /** Transient designer — per-channel insert. */
  private transientWasmModule: WebAssembly.Module | null = null;
  /** Pitch corrector — per-channel insert. */
  private pitchWasmModule: WebAssembly.Module | null = null;
  /** DeEss — per-channel insert. */
  private deessWasmModule: WebAssembly.Module | null = null;
  /** Imager — per-channel insert. */
  private imagerWasmModule: WebAssembly.Module | null = null;
  /** Tape — per-channel insert. */
  private tapeWasmModule: WebAssembly.Module | null = null;
  /** Console — per-channel insert. */
  private consoleWasmModule: WebAssembly.Module | null = null;
  /** MB-Comp — per-channel insert. */
  private mbcompWasmModule: WebAssembly.Module | null = null;
  /** Same pattern as eq8WasmModule, but for the BS.1770 Meter sink. */
  private meterWasmModule: WebAssembly.Module | null = null;

  /** Reference Room monitoring filter — between masterGain and the final
   *  worklet output. A list of BiquadFilterNodes wired in series; empty
   *  when preset = 'off'. Native Web Audio, no worklet involved. */
  private referenceRoomFilters: BiquadFilterNode[] = [];
  private referenceRoomPreset: ReferenceRoomPreset = 'off';

  private channels = new Map<string, ChannelInternals>();
  private buses = new Map<string, BusInternals>();
  /** Per-clip gain node for each live source (clip gain + fade envelope). */
  private clipGains = new WeakMap<AudioBufferSourceNode, GainNode>();

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

    if (this.options.transientWorkletUrl && this.options.transientWasmUrl) {
      await this.ctx.audioWorklet.addModule(this.options.transientWorkletUrl);
      const res = await fetch(this.options.transientWasmUrl);
      if (!res.ok) throw new Error(`transient wasm fetch failed (${res.status})`);
      this.transientWasmModule = await WebAssembly.compileStreaming(
        new Response(await res.arrayBuffer(), {
          headers: { 'Content-Type': 'application/wasm' },
        })
      );
    }

    if (this.options.pitchWorkletUrl && this.options.pitchWasmUrl) {
      await this.ctx.audioWorklet.addModule(this.options.pitchWorkletUrl);
      const res = await fetch(this.options.pitchWasmUrl);
      if (!res.ok) throw new Error(`pitch wasm fetch failed (${res.status})`);
      this.pitchWasmModule = await WebAssembly.compileStreaming(
        new Response(await res.arrayBuffer(), {
          headers: { 'Content-Type': 'application/wasm' },
        })
      );
    }

    if (this.options.deessWorkletUrl && this.options.deessWasmUrl) {
      await this.ctx.audioWorklet.addModule(this.options.deessWorkletUrl);
      const res = await fetch(this.options.deessWasmUrl);
      if (!res.ok) throw new Error(`deess wasm fetch failed (${res.status})`);
      this.deessWasmModule = await WebAssembly.compileStreaming(
        new Response(await res.arrayBuffer(), {
          headers: { 'Content-Type': 'application/wasm' },
        })
      );
    }

    if (this.options.imagerWorkletUrl && this.options.imagerWasmUrl) {
      await this.ctx.audioWorklet.addModule(this.options.imagerWorkletUrl);
      const res = await fetch(this.options.imagerWasmUrl);
      if (!res.ok) throw new Error(`imager wasm fetch failed (${res.status})`);
      this.imagerWasmModule = await WebAssembly.compileStreaming(
        new Response(await res.arrayBuffer(), {
          headers: { 'Content-Type': 'application/wasm' },
        })
      );
    }

    if (this.options.tapeWorkletUrl && this.options.tapeWasmUrl) {
      await this.ctx.audioWorklet.addModule(this.options.tapeWorkletUrl);
      const res = await fetch(this.options.tapeWasmUrl);
      if (!res.ok) throw new Error(`tape wasm fetch failed (${res.status})`);
      this.tapeWasmModule = await WebAssembly.compileStreaming(
        new Response(await res.arrayBuffer(), {
          headers: { 'Content-Type': 'application/wasm' },
        })
      );
    }

    if (this.options.consoleWorkletUrl && this.options.consoleWasmUrl) {
      await this.ctx.audioWorklet.addModule(this.options.consoleWorkletUrl);
      const res = await fetch(this.options.consoleWasmUrl);
      if (!res.ok) throw new Error(`console wasm fetch failed (${res.status})`);
      this.consoleWasmModule = await WebAssembly.compileStreaming(
        new Response(await res.arrayBuffer(), {
          headers: { 'Content-Type': 'application/wasm' },
        })
      );
    }

    if (this.options.mbcompWorkletUrl && this.options.mbcompWasmUrl) {
      await this.ctx.audioWorklet.addModule(this.options.mbcompWorkletUrl);
      const res = await fetch(this.options.mbcompWasmUrl);
      if (!res.ok) throw new Error(`mbcomp wasm fetch failed (${res.status})`);
      this.mbcompWasmModule = await WebAssembly.compileStreaming(
        new Response(await res.arrayBuffer(), {
          headers: { 'Content-Type': 'application/wasm' },
        })
      );
    }

    if (this.options.meterWorkletUrl && this.options.meterWasmUrl) {
      await this.ctx.audioWorklet.addModule(this.options.meterWorkletUrl);
      const res = await fetch(this.options.meterWasmUrl);
      if (!res.ok) throw new Error(`meter wasm fetch failed (${res.status})`);
      this.meterWasmModule = await WebAssembly.compileStreaming(
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
      if (channel.mbcomp) channel.mbcomp.disconnect();
      if (channel.comp) channel.comp.disconnect();
      if (channel.compColor) channel.compColor.disconnect();
      if (channel.transient) channel.transient.disconnect();
      if (channel.pitch) channel.pitch.disconnect();
      if (channel.deess) channel.deess.disconnect();
      if (channel.imager) channel.imager.disconnect();
      if (channel.tape) channel.tape.disconnect();
      if (channel.console) channel.console.disconnect();
      for (const send of channel.sends.values()) {
        send.gain.disconnect();
        send.delay.disconnect();
      }
      channel.sends.clear();
      channel.gain.disconnect();
      channel.panner.disconnect();
      channel.analyser.disconnect();
      channel.compDelay.disconnect();
      channel.gonioSplit?.disconnect();
      channel.analyserL?.disconnect();
      channel.analyserR?.disconnect();
      channel.meterNode?.disconnect();
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
    for (const node of this.referenceRoomFilters) {
      try {
        node.disconnect();
      } catch {
        // ignore
      }
    }
    this.referenceRoomFilters = [];
    this.referenceRoomPreset = 'off';
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
    // Plugin-delay-compensation node — delayTime set by recomputePdc().
    const compDelay = new DelayNode(this.ctx, { maxDelayTime: 0.25, delayTime: 0 });

    // Real stereo time-domain tap for the goniometer (pure Web Audio, no
    // worklet): panner → splitter → analyserL/R (no smoothing — we want raw
    // samples). The main `analyser` stays mono for level/spectrum.
    const gonioSplit = this.ctx.createChannelSplitter(2);
    const analyserL = this.ctx.createAnalyser();
    const analyserR = this.ctx.createAnalyser();
    analyserL.fftSize = 1024;
    analyserR.fftSize = 1024;
    analyserL.smoothingTimeConstant = 0;
    analyserR.smoothingTimeConstant = 0;

    // BS.1770 metering sink (0 outputs) — only when the worklet was loaded.
    let meterNode: AudioWorkletNode | null = null;
    if (this.meterWasmModule) {
      meterNode = new AudioWorkletNode(this.ctx, 'aux-meter-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 0,
        processorOptions: { wasmModule: this.meterWasmModule },
      });
    }

    const volume = init.volume ?? 1;
    const pan = init.pan ?? 0;
    gain.gain.value = volume;
    panner.pan.value = pan;

    // Per-channel inserts. Built from gain back to source so wiring is
    // straightforward: each new node connects to the previous "front" and
    // becomes the new front; the source ultimately connects to `front`.
    //
    //   source → [eq8] → [mbcomp] → [comp] → [compColor] → [transient] → [deess] → [imager] → [tape] → [console] → gain → panner → analyser → bus
    //
    // Bracketed nodes are conditional: they only exist if the corresponding
    // WASM module was loaded at start(). With everything off the routing
    // reduces to source → gain → ... as before.
    let consoleNode: AudioWorkletNode | null = null;
    if (this.consoleWasmModule) {
      consoleNode = new AudioWorkletNode(this.ctx, 'aux-console-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        processorOptions: { wasmModule: this.consoleWasmModule },
      });
      consoleNode.connect(gain);
    }

    let tape: AudioWorkletNode | null = null;
    if (this.tapeWasmModule) {
      tape = new AudioWorkletNode(this.ctx, 'aux-tape-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        processorOptions: { wasmModule: this.tapeWasmModule },
      });
      tape.connect(consoleNode ?? gain);
    }

    let imager: AudioWorkletNode | null = null;
    if (this.imagerWasmModule) {
      imager = new AudioWorkletNode(this.ctx, 'aux-imager-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        processorOptions: { wasmModule: this.imagerWasmModule },
      });
      imager.connect(tape ?? consoleNode ?? gain);
    }

    let deess: AudioWorkletNode | null = null;
    if (this.deessWasmModule) {
      deess = new AudioWorkletNode(this.ctx, 'aux-deess-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        processorOptions: { wasmModule: this.deessWasmModule },
      });
      deess.connect(imager ?? tape ?? consoleNode ?? gain);
    }

    let pitch: AudioWorkletNode | null = null;
    if (this.pitchWasmModule) {
      pitch = new AudioWorkletNode(this.ctx, 'aux-pitch-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        processorOptions: { wasmModule: this.pitchWasmModule },
      });
      pitch.connect(deess ?? imager ?? tape ?? consoleNode ?? gain);
    }

    let transient: AudioWorkletNode | null = null;
    if (this.transientWasmModule) {
      transient = new AudioWorkletNode(this.ctx, 'aux-transient-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        processorOptions: { wasmModule: this.transientWasmModule },
      });
      transient.connect(pitch ?? deess ?? imager ?? tape ?? consoleNode ?? gain);
    }

    let compColor: AudioWorkletNode | null = null;
    if (this.compColorWasmModule) {
      compColor = new AudioWorkletNode(this.ctx, 'aux-comp-color-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        processorOptions: { wasmModule: this.compColorWasmModule },
      });
      compColor.connect(transient ?? deess ?? imager ?? tape ?? consoleNode ?? gain);
    }

    let comp: AudioWorkletNode | null = null;
    if (this.compWasmModule) {
      comp = new AudioWorkletNode(this.ctx, 'aux-comp-clean-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        processorOptions: { wasmModule: this.compWasmModule },
      });
      comp.connect(compColor ?? transient ?? deess ?? imager ?? tape ?? consoleNode ?? gain);
    }

    let mbcomp: AudioWorkletNode | null = null;
    if (this.mbcompWasmModule) {
      mbcomp = new AudioWorkletNode(this.ctx, 'aux-mbcomp-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        processorOptions: { wasmModule: this.mbcompWasmModule },
      });
      mbcomp.connect(
        comp ?? compColor ?? transient ?? deess ?? imager ?? tape ?? consoleNode ?? gain
      );
    }

    let eq8: AudioWorkletNode | null = null;
    if (this.eq8WasmModule) {
      eq8 = new AudioWorkletNode(this.ctx, 'aux-eq8-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        processorOptions: { wasmModule: this.eq8WasmModule },
      });
      eq8.connect(
        mbcomp ?? comp ?? compColor ?? transient ?? deess ?? imager ?? tape ?? consoleNode ?? gain
      );
    }

    // gain → panner → analyser → compDelay (PDC) → outputBus.input
    gain.connect(panner);
    panner.connect(analyser);
    analyser.connect(compDelay);
    // Metering taps off the panner (post-pan, pre-PDC), parallel dead-ends.
    panner.connect(gonioSplit);
    gonioSplit.connect(analyserL, 0);
    gonioSplit.connect(analyserR, 1);
    if (meterNode) panner.connect(meterNode);
    compDelay.connect(outputBus.input);

    const channelInternals: ChannelInternals = {
      stemId: init.stemId,
      buffer: null,
      eq8,
      mbcomp,
      comp,
      compColor,
      transient,
      pitch,
      pitchEngaged: false,
      pitchHz: 0,
      deess,
      imager,
      tape,
      console: consoleNode,
      compGrDb: 0,
      compColorGrDb: 0,
      gain,
      panner,
      analyser,
      compDelay,
      meterBuffer: new Float32Array(analyser.fftSize),
      gonioSplit,
      analyserL,
      analyserR,
      stereoBufL: new Float32Array(analyserL.fftSize),
      stereoBufR: new Float32Array(analyserR.fftSize),
      meterNode,
      loudness: null,
      volume,
      pan,
      muted: false,
      soloed: false,
      outputBusId: outputBus.id,
      sends: new Map(),
      sources: [],
      clips: [],
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
    if (pitch) {
      pitch.port.onmessage = (e: MessageEvent<{ type: string; hz: number }>) => {
        if (e.data?.type === 'f0') channelInternals.pitchHz = e.data.hz;
      };
    }
    if (meterNode) {
      meterNode.port.onmessage = (e: MessageEvent<{ type: string } & Loudness>) => {
        if (e.data?.type === 'loudness') {
          channelInternals.loudness = {
            momentary: e.data.momentary,
            short: e.data.short,
            integrated: e.data.integrated,
            truePeakDb: e.data.truePeakDb,
            overs: e.data.overs,
          };
        }
      };
    }

    this.channels.set(init.stemId, channelInternals);
    this.recomputePdc();
  }

  /**
   * Plugin-delay-compensation. Each channel's latency is the Pitch insert's
   * constant delay when engaged, else 0. Every channel's `compDelay` is set
   * to (max latency across channels − its own), so all contributions arrive
   * aligned at their buses regardless of who's running Pitch.
   *
   * Both the main channel→bus path (`compDelay`) and every post-fader aux send
   * (its `delay`) are compensated, so a pitched channel stays aligned with the
   * mix on both paths.
   *
   * When a change lands during playback (toggling Pitch shifts maxLatency, which
   * steps every channel's delay and would click), `mask` dips the master for a
   * few ms across the step so the discontinuity is inaudible. Add/remove during
   * setup pass `mask: false` and apply instantly.
   */
  private recomputePdc(mask = false): void {
    if (!this.ctx) return;
    let maxLatency = 0;
    for (const ch of this.channels.values()) {
      const lat = ch.pitchEngaged ? PITCH_LATENCY_SAMPLES : 0;
      if (lat > maxLatency) maxLatency = lat;
    }

    const t = this.ctx.currentTime;
    const masking = mask && this.playing && !!this.masterGain;
    const applyAt = masking ? t + PDC_MASK_FADE : t;

    if (masking && this.masterGain) {
      // Brief master dip: fade to silence, jump the delays at the bottom, fade
      // back — turns a mix-wide click into an inaudible ~12 ms duck.
      const g = this.masterGain.gain;
      const vol = g.value;
      g.cancelScheduledValues(t);
      g.setValueAtTime(vol, t);
      g.linearRampToValueAtTime(0, applyAt);
      g.setValueAtTime(0, applyAt);
      g.linearRampToValueAtTime(vol, applyAt + PDC_MASK_FADE);
    }

    for (const ch of this.channels.values()) {
      const lat = ch.pitchEngaged ? PITCH_LATENCY_SAMPLES : 0;
      const seconds = (maxLatency - lat) / this.ctx.sampleRate;
      ch.compDelay.delayTime.setValueAtTime(seconds, applyAt);
      for (const send of ch.sends.values()) {
        send.delay.delayTime.setValueAtTime(seconds, applyAt);
      }
    }
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

  /** Duration in seconds of a stem's decoded buffer (0 if not loaded). */
  getStemDuration(stemId: string): number {
    return this.channels.get(stemId)?.buffer?.duration ?? 0;
  }

  /**
   * Downsampled waveform data for the read-only stem timeline.
   *
   * Reads the decoded AudioBuffer and computes `count` (min, max) pairs by
   * scanning the buffer in equal-width bins. For stereo buffers we fold the
   * channels by taking the per-bin extremes across both, which is what a
   * standard DAW waveform shows.
   *
   * Returns null when the stem isn't loaded yet. The result is independent
   * of the audio graph state — no playback or worklet involvement — so
   * callers can request it as soon as `loadStem()` resolves.
   *
   * `inSample` / `outSample` mark the first and last sample whose absolute
   * value exceeds `silenceThreshold`. Useful for showing where a stem has
   * audible content vs. silent intro/outro padding.
   */
  getStemPeaks(
    stemId: string,
    count: number,
    silenceThreshold = 0.001
  ): {
    peaks: Float32Array;
    inSample: number;
    outSample: number;
    sampleRate: number;
    totalSamples: number;
  } | null {
    const buffer = this.channels.get(stemId)?.buffer;
    if (!buffer || count <= 0) return null;
    const totalLen = buffer.length;
    const channels = buffer.numberOfChannels;

    // Stride channel data into a single linked view per channel so we can
    // walk both in lock-step. Web Audio's getChannelData returns the raw
    // Float32Array — zero copy.
    const channelData: Float32Array[] = [];
    for (let c = 0; c < channels; c++) channelData.push(buffer.getChannelData(c));

    const bins = Math.max(1, Math.min(count, totalLen));
    const peaks = new Float32Array(bins * 2);
    const samplesPerBin = totalLen / bins;
    for (let b = 0; b < bins; b++) {
      const start = Math.floor(b * samplesPerBin);
      const end = b === bins - 1 ? totalLen : Math.floor((b + 1) * samplesPerBin);
      let min = Number.POSITIVE_INFINITY;
      let max = Number.NEGATIVE_INFINITY;
      for (let c = 0; c < channels; c++) {
        const ch = channelData[c];
        if (!ch) continue;
        for (let i = start; i < end; i++) {
          const v = ch[i] ?? 0;
          if (v < min) min = v;
          if (v > max) max = v;
        }
      }
      if (!Number.isFinite(min) || !Number.isFinite(max)) {
        min = 0;
        max = 0;
      }
      peaks[b * 2] = min;
      peaks[b * 2 + 1] = max;
    }

    // Silence-trim: walk the first channel from each end. Stops at the first
    // sample exceeding the threshold. Cheap (linear scan) and accurate enough
    // for "where does the content start".
    let inSample = 0;
    let outSample = totalLen - 1;
    const probe = channelData[0];
    if (probe) {
      while (inSample < totalLen && Math.abs(probe[inSample] ?? 0) <= silenceThreshold) inSample++;
      while (outSample > inSample && Math.abs(probe[outSample] ?? 0) <= silenceThreshold) {
        outSample--;
      }
      if (inSample >= totalLen) {
        inSample = 0;
        outSample = totalLen - 1;
      }
    }

    return {
      peaks,
      inSample,
      outSample,
      sampleRate: buffer.sampleRate,
      totalSamples: totalLen,
    };
  }

  removeChannel(stemId: string): void {
    const channel = this.channels.get(stemId);
    if (!channel) return;
    this.stopChannelSources(channel);
    if (channel.eq8) channel.eq8.disconnect();
    if (channel.mbcomp) channel.mbcomp.disconnect();
    if (channel.comp) channel.comp.disconnect();
    if (channel.compColor) channel.compColor.disconnect();
    if (channel.transient) channel.transient.disconnect();
    if (channel.pitch) channel.pitch.disconnect();
    if (channel.deess) channel.deess.disconnect();
    if (channel.imager) channel.imager.disconnect();
    if (channel.tape) channel.tape.disconnect();
    if (channel.console) channel.console.disconnect();
    for (const send of channel.sends.values()) {
      send.gain.disconnect();
      send.delay.disconnect();
    }
    channel.sends.clear();
    channel.gain.disconnect();
    channel.panner.disconnect();
    channel.analyser.disconnect();
    channel.compDelay.disconnect();
    channel.gonioSplit?.disconnect();
    channel.analyserL?.disconnect();
    channel.analyserR?.disconnect();
    channel.meterNode?.disconnect();
    this.channels.delete(stemId);
    this.recomputePdc();
  }

  // ────────────────────────────────────────────────────────────────────
  // Per-channel Transient designer
  // ────────────────────────────────────────────────────────────────────

  /** Push attack/sustain params (both ∈ [-1, 1]) to a channel's transient. */
  setChannelTransient(stemId: string, attack: number, sustain: number): void {
    const transient = this.channels.get(stemId)?.transient;
    if (!transient) return;
    transient.port.postMessage({ type: 'set-params', attack, sustain });
  }

  setChannelTransientBypassed(stemId: string, bypassed: boolean): void {
    const transient = this.channels.get(stemId)?.transient;
    if (!transient) return;
    transient.port.postMessage({ type: 'set-bypassed', bypassed });
  }

  // ────────────────────────────────────────────────────────────────────
  // Per-channel Pitch corrector
  // ────────────────────────────────────────────────────────────────────

  /** keyRoot 0..11, scaleId 0..3, speed/amount/humanize 0..100. */
  setChannelPitch(
    stemId: string,
    keyRoot: number,
    scaleId: number,
    speed: number,
    amount: number,
    humanize: number,
    formant: number
  ): void {
    const pitch = this.channels.get(stemId)?.pitch;
    if (!pitch) return;
    pitch.port.postMessage({
      type: 'set-params',
      keyRoot,
      scaleId,
      speed,
      amount,
      humanize,
      formant,
    });
  }

  /** Engaging/bypassing Pitch changes the channel's latency, so this also
   *  re-runs plugin-delay-compensation to keep every stem aligned. */
  setChannelPitchBypassed(stemId: string, bypassed: boolean): void {
    const channel = this.channels.get(stemId);
    if (!channel?.pitch) return;
    channel.pitch.port.postMessage({ type: 'set-bypassed', bypassed });
    const engaged = !bypassed;
    if (engaged !== channel.pitchEngaged) {
      channel.pitchEngaged = engaged;
      this.recomputePdc(true); // mask the delay step when toggling mid-playback
    }
  }

  /** Constant Pitch-insert latency (samples) used for delay-compensation. */
  getChannelPitchLatencySamples(): number {
    return PITCH_LATENCY_SAMPLES;
  }

  /** Last detected fundamental for a channel (Hz, 0 = unvoiced/bypassed),
   *  cached from the Pitch worklet's `f0` posts — drives the corrector UI. */
  getChannelPitchHz(stemId: string): number {
    return this.channels.get(stemId)?.pitchHz ?? 0;
  }

  // ────────────────────────────────────────────────────────────────────
  // Per-channel DeEss
  // ────────────────────────────────────────────────────────────────────

  /** `freq` Hz (2k..12k), `amount` 0..1 (0 = off). */
  setChannelDeEss(stemId: string, freq: number, amount: number): void {
    const deess = this.channels.get(stemId)?.deess;
    if (!deess) return;
    deess.port.postMessage({ type: 'set-params', freq, amount });
  }

  setChannelDeEssBypassed(stemId: string, bypassed: boolean): void {
    const deess = this.channels.get(stemId)?.deess;
    if (!deess) return;
    deess.port.postMessage({ type: 'set-bypassed', bypassed });
  }

  // ────────────────────────────────────────────────────────────────────
  // Per-channel Imager (M/S width)
  // ────────────────────────────────────────────────────────────────────

  /** `width` 0..2; 1 = unity (passthrough). */
  setChannelImager(stemId: string, width: number): void {
    const imager = this.channels.get(stemId)?.imager;
    if (!imager) return;
    imager.port.postMessage({ type: 'set-width', width });
  }

  setChannelImagerBypassed(stemId: string, bypassed: boolean): void {
    const imager = this.channels.get(stemId)?.imager;
    if (!imager) return;
    imager.port.postMessage({ type: 'set-bypassed', bypassed });
  }

  // ────────────────────────────────────────────────────────────────────
  // Per-channel Tape (saturation)
  // ────────────────────────────────────────────────────────────────────

  /** `driveDb` 0..24, `tone` -1..1, `mix` 0..1 (0 = passthrough). */
  setChannelTape(stemId: string, driveDb: number, tone: number, mix: number): void {
    const tape = this.channels.get(stemId)?.tape;
    if (!tape) return;
    tape.port.postMessage({ type: 'set-params', driveDb, tone, mix });
  }

  setChannelTapeBypassed(stemId: string, bypassed: boolean): void {
    const tape = this.channels.get(stemId)?.tape;
    if (!tape) return;
    tape.port.postMessage({ type: 'set-bypassed', bypassed });
  }

  // ────────────────────────────────────────────────────────────────────
  // Per-channel Console (asymmetric saturation)
  // ────────────────────────────────────────────────────────────────────

  /** `driveDb` 0..24, `character` 0..1, `mix` 0..1 (0 = passthrough). */
  setChannelConsole(stemId: string, driveDb: number, character: number, mix: number): void {
    const node = this.channels.get(stemId)?.console;
    if (!node) return;
    node.port.postMessage({ type: 'set-params', driveDb, character, mix });
  }

  setChannelConsoleBypassed(stemId: string, bypassed: boolean): void {
    const node = this.channels.get(stemId)?.console;
    if (!node) return;
    node.port.postMessage({ type: 'set-bypassed', bypassed });
  }

  // ────────────────────────────────────────────────────────────────────
  // Per-channel MB-Comp (3-band multiband compressor)
  // ────────────────────────────────────────────────────────────────────

  /** Per-band thresholds in dB (each -40..0; 0 = that band uncompressed) and
   *  shared ratio (1..10). */
  setChannelMbComp(
    stemId: string,
    loThreshDb: number,
    midThreshDb: number,
    hiThreshDb: number,
    ratio: number
  ): void {
    const node = this.channels.get(stemId)?.mbcomp;
    if (!node) return;
    node.port.postMessage({ type: 'set-params', loThreshDb, midThreshDb, hiThreshDb, ratio });
  }

  setChannelMbCompBypassed(stemId: string, bypassed: boolean): void {
    const node = this.channels.get(stemId)?.mbcomp;
    if (!node) return;
    node.port.postMessage({ type: 'set-bypassed', bypassed });
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
      // BS.1770 metering sink on the post-limiter master signal.
      if (this.meterWasmModule) {
        const meterNode = new AudioWorkletNode(this.ctx, 'aux-meter-processor', {
          numberOfInputs: 1,
          numberOfOutputs: 0,
          processorOptions: { wasmModule: this.meterWasmModule },
        });
        analyser.connect(meterNode);
        meterNode.port.onmessage = (e: MessageEvent<{ type: string } & Loudness>) => {
          if (e.data?.type === 'loudness') {
            this.masterLoudness = {
              momentary: e.data.momentary,
              short: e.data.short,
              integrated: e.data.integrated,
              truePeakDb: e.data.truePeakDb,
              overs: e.data.overs,
            };
          }
        };
        this.masterMeterNode = meterNode;
      }
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
        send.gain.disconnect();
        send.delay.disconnect();
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
  // Master Reference Room (monitoring preset)
  // ────────────────────────────────────────────────────────────────────

  /**
   * Insert a Reference Room preset between masterGain and the final
   * worklet output. Setting `'off'` removes any filters. Calling with
   * the same preset is a no-op. The meter / limiter sit before this
   * stage in the chain, so they continue to show the true mix —
   * Reference Rooms only affect what the engineer monitors.
   */
  setMasterReferenceRoom(preset: ReferenceRoomPreset): void {
    if (!this.ctx || !this.masterGain || !this.workletNode) return;
    if (preset === this.referenceRoomPreset) return;

    // Tear down: disconnect masterGain from whichever node currently
    // follows it (either the head of the old filter chain, or directly
    // to the worklet), and disconnect every filter.
    try {
      this.masterGain.disconnect();
    } catch {
      // ignore — node may already be detached
    }
    for (const node of this.referenceRoomFilters) {
      try {
        node.disconnect();
      } catch {
        // ignore
      }
    }
    this.referenceRoomFilters = [];

    // Rebuild for the new preset.
    const specs = REFERENCE_ROOM_FILTERS[preset];
    if (specs.length === 0) {
      this.masterGain.connect(this.workletNode);
    } else {
      const nodes = specs.map((spec) => this.buildBiquad(spec));
      this.referenceRoomFilters = nodes;
      let cursor: AudioNode = this.masterGain;
      for (const node of nodes) {
        cursor.connect(node);
        cursor = node;
      }
      cursor.connect(this.workletNode);
    }

    this.referenceRoomPreset = preset;
  }

  /** Currently active Reference Room preset. */
  getMasterReferenceRoom(): ReferenceRoomPreset {
    return this.referenceRoomPreset;
  }

  private buildBiquad(spec: BiquadSpec): BiquadFilterNode {
    if (!this.ctx) throw new Error('AudioHost not started');
    const node = this.ctx.createBiquadFilter();
    node.type = spec.type;
    node.frequency.value = spec.freq;
    if (spec.gainDb != null) node.gain.value = spec.gainDb;
    if (spec.q != null) node.Q.value = spec.q;
    return node;
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
        // compDelay is the channel's tail node into the bus (PDC stage).
        channel.compDelay.disconnect(previous.input);
      } catch {
        // Edge case: the connection wasn't there (e.g. first wire-up).
      }
    }
    channel.compDelay.connect(target.input);
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
      const gainNode = this.ctx.createGain();
      gainNode.gain.value = 0;
      // PDC delay mirrors the channel's main path so the send arrives aligned.
      const delay = new DelayNode(this.ctx, {
        maxDelayTime: 0.25,
        delayTime: channel.compDelay.delayTime.value,
      });
      // Post-fader tap: channel.gain → sendGain → sendDelay → target.input.
      channel.gain.connect(gainNode);
      gainNode.connect(delay);
      delay.connect(target.input);
      send = { gain: gainNode, delay };
      channel.sends.set(busId, send);
    }
    const clamped = Math.max(0, Math.min(2, level));
    send.gain.gain.cancelScheduledValues(this.ctx.currentTime);
    send.gain.gain.linearRampToValueAtTime(clamped, this.ctx.currentTime + rampSec);
  }

  /** Tear down a single send from `stemId` to `busId`. Idempotent. */
  removeChannelSend(stemId: string, busId: string): void {
    const channel = this.channels.get(stemId);
    if (!channel) return;
    const send = channel.sends.get(busId);
    if (!send) return;
    send.gain.disconnect();
    send.delay.disconnect();
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

  /**
   * Fill `outL`/`outR` with the channel's current L/R time-domain samples (for
   * a real goniometer). Returns false (and leaves the buffers untouched) if the
   * channel or its stereo tap doesn't exist. Caller sizes the arrays; the tap
   * uses fftSize=1024.
   */
  getChannelStereo(
    stemId: string,
    outL: Float32Array<ArrayBuffer>,
    outR: Float32Array<ArrayBuffer>
  ): boolean {
    const channel = this.channels.get(stemId);
    if (!channel?.analyserL || !channel.analyserR) return false;
    channel.analyserL.getFloatTimeDomainData(outL);
    channel.analyserR.getFloatTimeDomainData(outR);
    return true;
  }

  /**
   * Inter-channel correlation (Pearson r, −1..+1) over the current L/R window:
   * +1 = mono, 0 = uncorrelated/wide, <0 = out-of-phase. Returns 1 when there's
   * no stereo tap or the signal is silent.
   */
  getChannelCorrelation(stemId: string): number {
    const channel = this.channels.get(stemId);
    if (!channel?.analyserL || !channel.analyserR) return 1;
    channel.analyserL.getFloatTimeDomainData(channel.stereoBufL);
    channel.analyserR.getFloatTimeDomainData(channel.stereoBufR);
    const l = channel.stereoBufL;
    const r = channel.stereoBufR;
    const n = Math.min(l.length, r.length);
    let sll = 0;
    let srr = 0;
    let slr = 0;
    for (let i = 0; i < n; i++) {
      const a = l[i] ?? 0;
      const b = r[i] ?? 0;
      sll += a * a;
      srr += b * b;
      slr += a * b;
    }
    const denom = Math.sqrt(sll * srr);
    if (denom < 1e-9) return 1; // silence reads as mono/centered
    return Math.max(-1, Math.min(1, slr / denom));
  }

  /** Latest BS.1770 loudness for a channel, or null if no Meter tap. */
  getChannelLoudness(stemId: string): Loudness | null {
    return this.channels.get(stemId)?.loudness ?? null;
  }

  /** Latest BS.1770 loudness for the Master bus, or null if no Meter tap. */
  getMasterLoudness(): Loudness | null {
    return this.masterLoudness;
  }

  /**
   * Reset integrated-loudness + true-peak accumulation on every Meter (channels
   * and Master). Call when transport (re)starts so the integrated reading
   * reflects the current pass, not the whole session.
   */
  resetLoudness(): void {
    for (const ch of this.channels.values()) {
      ch.meterNode?.port.postMessage({ type: 'reset' });
      ch.loudness = null;
    }
    this.masterMeterNode?.port.postMessage({ type: 'reset' });
    this.masterLoudness = null;
  }

  /**
   * Fill `out` (length = number of bins wanted) with the channel's current
   * frequency magnitudes mapped to 0..1, for the EQ-window spectrum backdrop.
   * Resamples the analyser's 128 frequency bins (fftSize 256) onto `out.length`
   * with a mild dB→linear curve. Returns false when the channel isn't live.
   */
  getChannelFrequencyData(stemId: string, out: Float32Array): boolean {
    const channel = this.channels.get(stemId);
    if (!channel) return false;
    const a = channel.analyser;
    const src = new Uint8Array(a.frequencyBinCount);
    a.getByteFrequencyData(src);
    const n = out.length;
    for (let i = 0; i < n; i++) {
      // log-ish frequency mapping so lows aren't over-represented
      const f = i / (n - 1 || 1);
      const idx = Math.min(src.length - 1, Math.floor(f ** 1.4 * (src.length - 1)));
      out[i] = (src[idx] ?? 0) / 255;
    }
    return true;
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

  /** The node a channel's buffer source connects to — front of the insert
   *  chain (eq8 first, falling through to gain when no inserts exist). */
  private channelFront(channel: ChannelInternals): AudioNode {
    return (
      channel.eq8 ??
      channel.mbcomp ??
      channel.comp ??
      channel.compColor ??
      channel.transient ??
      channel.deess ??
      channel.imager ??
      channel.tape ??
      channel.console ??
      channel.gain
    );
  }

  /** Stop + disconnect a single channel's live sources, leaving the chain. */
  private stopChannelSources(channel: ChannelInternals): void {
    for (const src of channel.sources) {
      try {
        src.onended = null;
        src.stop(0);
      } catch {
        // already stopped / ended
      }
      src.disconnect();
      const gain = this.clipGains.get(src);
      if (gain) {
        gain.disconnect();
        this.clipGains.delete(src);
      }
    }
    channel.sources = [];
  }

  /**
   * Schedule one channel's clips from `fromSec` on the global timeline.
   * Assumes the channel's existing sources have been stopped. Empty clips
   * play the whole buffer at t=0 (today's behaviour).
   */
  private scheduleChannel(channel: ChannelInternals, fromSec: number): void {
    if (!this.ctx || !channel.buffer) return;
    const buffer = channel.buffer;
    const front = this.channelFront(channel);
    const t0 = this.ctx.currentTime;
    const plan = planClipSchedule(channel.clips, buffer.length, buffer.sampleRate, fromSec);
    for (const p of plan) {
      const src = this.ctx.createBufferSource();
      src.buffer = buffer;
      // Per-clip gain node carries the clip's gain + fade envelope.
      const clipGain = this.ctx.createGain();
      src.connect(clipGain);
      clipGain.connect(front);
      this.scheduleClipEnvelope(clipGain, t0 + p.whenOffsetSec, p);
      this.clipGains.set(src, clipGain);
      src.onended = () => {
        const i = channel.sources.indexOf(src);
        if (i !== -1) channel.sources.splice(i, 1);
        const g = this.clipGains.get(src);
        if (g) {
          g.disconnect();
          this.clipGains.delete(src);
        }
      };
      src.start(t0 + p.whenOffsetSec, p.offsetSec, p.durationSec);
      channel.sources.push(src);
    }
  }

  /** Schedule a clip's gain + fade-in/out envelope on its dedicated GainNode. */
  private scheduleClipEnvelope(gain: GainNode, startAt: number, p: ScheduledClip): void {
    const base = 10 ** (p.gainDb / 20);
    const g = gain.gain;
    g.cancelScheduledValues(startAt);
    g.setValueAtTime(base * p.fadeStartScale, startAt);
    if (p.fadeInSec > 0) {
      g.linearRampToValueAtTime(base, startAt + p.fadeInSec);
    } else {
      g.setValueAtTime(base, startAt);
    }
    if (p.fadeOutSec > 0) {
      // Hold the steady level until the fade-out begins (never before the
      // fade-in completes), then ramp to silence at the clip end.
      const foStart = Math.max(startAt + p.fadeInSec, startAt + p.durationSec - p.fadeOutSec);
      g.setValueAtTime(base, foStart);
      g.linearRampToValueAtTime(0, startAt + p.durationSec);
    }
  }

  /** Start every loaded channel from the given offset (in seconds). */
  playAll(offsetSeconds = 0): void {
    if (!this.ctx) throw new Error('AudioHost not started');
    if (this.ctx.state === 'suspended') void this.ctx.resume();

    this.stopAll();
    this.resetLoudness(); // integrated LUFS reflects this pass, not the session
    this.playing = true;
    this.playOffsetSec = offsetSeconds;
    this.playStartCtxTime = this.ctx.currentTime;

    for (const channel of this.channels.values()) {
      if (!channel.buffer) continue;
      this.scheduleChannel(channel, offsetSeconds);
    }
  }

  /** Stop every currently-playing source. The channel chains stay intact. */
  stopAll(): void {
    this.playing = false;
    for (const channel of this.channels.values()) {
      this.stopChannelSources(channel);
    }
  }

  /** Current playhead on the global timeline, in seconds (0 when stopped). */
  private currentPositionSec(): number {
    if (!this.playing || !this.ctx) return 0;
    return this.playOffsetSec + (this.ctx.currentTime - this.playStartCtxTime);
  }

  /**
   * Replace a channel's timeline clips. If the transport is running, the
   * channel is re-scheduled from the current playhead so the edit is audible
   * immediately; otherwise it takes effect on the next play.
   */
  setChannelClips(stemId: string, clips: readonly ClipRegion[]): void {
    const channel = this.channels.get(stemId);
    if (!channel) return;
    channel.clips = clips.map((c) => ({ ...c }));
    if (this.playing && this.ctx) {
      this.stopChannelSources(channel);
      this.scheduleChannel(channel, this.currentPositionSec());
    }
  }

  /** Duration of the longest channel, in seconds — honours edited clip ends. */
  get durationSeconds(): number {
    let max = 0;
    for (const c of this.channels.values()) {
      if (!c.buffer) continue;
      const endSec = clipsEndSample(c.clips, c.buffer.length) / c.buffer.sampleRate;
      if (endSec > max) max = endSec;
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
    for (const c of this.channels.values()) if (c.sources.length > 0) return true;
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
