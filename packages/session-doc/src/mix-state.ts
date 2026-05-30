import { z } from 'zod';

/**
 * MixState — serialized form of the live mixer.
 *
 * Persisted to `sessions.mix_state` (Json column). Saved on every channel
 * change (debounced + flushed on page hide); hydrated on session open.
 *
 * Versioning
 * ----------
 * v1  — volume / pan / mute / solo.
 * v2  — adds EQ state per channel.
 * v3  — adds Comp-Clean state per channel.
 * v4  — adds compType.
 * v5  — adds buses + channel.outputBusId.
 * v6  — adds channel.sends.
 * v7  — adds masterChain (limiter on Master).
 * v8  — buses gain an optional `plate` field.
 * v9  — bus reverb slot generalised with `kind: 'plate' | 'hall'`.
 * v10 — adds per-channel `transient` (attack/sustain shaper + bypass).
 * v11 — adds per-channel `deess` (split-band) + `imager` (M/S width).
 * v12 — adds masterChain.referenceRoom (monitoring preset).
 * v13 — adds per-channel `tape` (saturation: drive / tone / mix + bypass).
 * v14 — adds per-channel `console` (asymmetric saturation: drive /
 *       character / mix + bypass).
 * v15 — adds per-channel `mbcomp` (3-band multiband compressor: per-band
 *       lo/mid/hi thresholds + shared ratio + bypass).
 * v16 — adds per-channel `clips` (timeline regions: sample-accurate
 *       sourceIn/sourceOut + timelineStart). Absent/empty = whole buffer
 *       at t=0, so v1–v15 docs stay correct without a rewrite.
 * v17 — adds `bypassed` to per-channel `eq` and `comp`. Optional with a
 *       `false` default, so v1–v16 docs stay valid (missing = engaged).
 * v18 — adds per-channel `eqFull` (5-band parametric: HP / low-shelf / two
 *       peaks / high-shelf, each type/freq/gain/q/on + an analyzer flag).
 *       Optional; when absent, hydration derives it from the legacy
 *       `eq.{lo,mid,hi}` quick knobs, which stay a mirror of bands 1/2/4.
 * v19 — surfaces the comp's `attackMs` / `releaseMs` / `makeupDb` (were
 *       baked-in defaults) + a UI-only `knee` for the transfer curve. All
 *       optional with the prior baked defaults, so v1–v18 docs stay valid.
 * v20 — adds the transient designer's `sens` + `mode` (UI/detector only —
 *       engine shapes from attack/sustain). Optional with defaults, so
 *       v1–v19 docs stay valid.
 * v21 — adds the tape's `bias` + `mode` (UI/visual only — engine drives from
 *       drive/tone/mix). Optional with defaults, so v1–v20 docs stay valid.
 * v22 — adds the imager's `balance` + `mode` (UI/goniometer only — engine
 *       images from width). Optional with defaults, so v1–v21 docs stay valid.
 * v23 — adds the master limiter's `style` (UI voicing only — engine limits
 *       from threshold/release/makeup). Optional default, so v1–v22 docs
 *       stay valid.
 */

export const MIX_STATE_VERSION = 23;

/**
 * Versions the strict parse still accepts. During the v15→v16 rollout we
 * tolerate both so a client on either side of a deploy can still save (the
 * API strict-parses with this same schema). Narrow back to a single
 * `z.literal(MIX_STATE_VERSION)` once every deployed surface is on v16.
 */
const ACCEPTED_VERSIONS = [z.literal(20), z.literal(21), z.literal(22), z.literal(23)] as const;

/** Stable id for the always-present Master bus. Sessions can omit it from
 *  their `buses` record; the client treats it as if explicitly present. */
export const MASTER_BUS_ID = 'master';

export const ReverbKindSchema = z.enum(['plate', 'hall']);
export type ReverbKind = z.infer<typeof ReverbKindSchema>;

/**
 * Per-bus reverb insert — Plate and Hall share the same params today, with
 * a `kind` discriminator picking which DSP is engaged. Hall accepts wider
 * pre-delay (up to 500 ms) so the schema's upper bound matches that; the
 * Plate DSP clamps internally to its own narrower range.
 */
export const ReverbStateSchema = z.object({
  kind: ReverbKindSchema,
  /** Feedback amount around the tank loop, 0..0.95. */
  decay: z.number().min(0).max(0.95),
  /** High-freq damping inside the tank, 0..1. */
  damping: z.number().min(0).max(1),
  /** Pre-delay in ms, 0..500. */
  preDelayMs: z.number().min(0).max(500),
  /** Dry/wet mix, 0..1. Typically 1.0 on a send-return bus. */
  mix: z.number().min(0).max(1),
  bypassed: z.boolean(),
});

export const BusStateSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(80),
  /** Linear gain 0..2; 1 = 0 dB. */
  gain: z.number().min(0).max(4),
  muted: z.boolean(),
  /** Optional reverb insert (Plate or Hall). Absent = no reverb. */
  reverb: ReverbStateSchema.optional(),
});

export const BusesSchema = z.record(z.string(), BusStateSchema);

export const CompTypeSchema = z.enum(['clean', 'color']);
export type CompType = z.infer<typeof CompTypeSchema>;

export const ChannelEqSchema = z.object({
  /** Low-shelf gain in dB — mirrors eqFull band 1. */
  lo: z.number().min(-24).max(24),
  /** Mid-peak gain in dB — mirrors eqFull band 2. */
  mid: z.number().min(-24).max(24),
  /** High-shelf gain in dB — mirrors eqFull band 4. */
  hi: z.number().min(-24).max(24),
  /** Insert bypass (v17+). Optional/false on v1–v16 docs = engaged. */
  bypassed: z.boolean().default(false),
});

/** Band types for the full parametric EQ (mirror the engine's Eq8 enum). */
export const EqFullBandTypeSchema = z.enum(['hp', 'lowshelf', 'peak', 'highshelf', 'lp']);
export type EqFullBandType = z.infer<typeof EqFullBandTypeSchema>;

/** One band of the 5-band parametric EQ (v18+). */
export const EqFullBandSchema = z.object({
  /** Stable band index 0..4 (also its EQ-8 slot). */
  id: z.number().int().min(0).max(7),
  type: EqFullBandTypeSchema,
  /** Centre/corner frequency in Hz, 20..20000. */
  freq: z.number().min(20).max(20000),
  /** Gain in dB (shelves + peaks; ignored by HP/LP), −24..24. */
  gain: z.number().min(-24).max(24),
  /** Resonance (peaks) / slope (shelves, HP/LP), 0.2..6. */
  q: z.number().min(0.2).max(6),
  /** Per-band enable; off = that slot passes through. */
  on: z.boolean(),
});
export type EqFullBand = z.infer<typeof EqFullBandSchema>;

/** Full parametric EQ (v18+). Optional; hydration derives it from the
 *  legacy `eq.{lo,mid,hi}` quick knobs when a v1–v17 doc lacks it. */
export const ChannelEqFullSchema = z.object({
  bands: z.array(EqFullBandSchema),
  /** Live analyzer (spectrum) shown behind the curve. */
  analyzer: z.boolean().default(true),
});
export type ChannelEqFull = z.infer<typeof ChannelEqFullSchema>;

export const ChannelCompSchema = z.object({
  /** Threshold in dB, −80..+12. */
  threshold: z.number().min(-80).max(12),
  /** Ratio 1..20; 1 = no compression. */
  ratio: z.number().min(1).max(20),
  /** Insert bypass (v17+). Optional/false on v1–v16 docs = engaged. */
  bypassed: z.boolean().default(false),
  /** Attack in ms (v19+). */
  attackMs: z.number().min(0.1).max(100).default(10),
  /** Release in ms (v19+). */
  releaseMs: z.number().min(10).max(1000).default(120),
  /** Make-up gain in dB (v19+). */
  makeupDb: z.number().min(0).max(24).default(0),
  /** Soft-knee width in dB (v19+). UI/curve only — engine has no knee param. */
  knee: z.number().min(0).max(24).default(6),
});

/** Post-fader aux sends keyed by destination bus id; value = linear gain. */
export const ChannelSendsSchema = z.record(z.string(), z.number().min(0).max(2));

export const TransientModeSchema = z.enum(['WIDE', 'TIGHT']);
export type TransientMode = z.infer<typeof TransientModeSchema>;

/** Transient designer per channel — attack/sustain shaper. */
export const ChannelTransientSchema = z.object({
  /** Attack scaling, -1..1. 0 = no change. */
  attack: z.number().min(-1).max(1),
  /** Sustain scaling, -1..1. 0 = no change. */
  sustain: z.number().min(-1).max(1),
  bypassed: z.boolean(),
  /** Detector sensitivity 0..100 (v20+). UI/detector only. */
  sens: z.number().min(0).max(100).default(50),
  /** Detector window (v20+). UI/detector only. */
  mode: TransientModeSchema.default('WIDE'),
});

/** DeEss per channel — split-band sibilance tamer. */
export const ChannelDeEssSchema = z.object({
  /** Crossover frequency, 2_000..12_000 Hz. */
  freq: z.number().min(2000).max(12000),
  /** De-ess amount, 0..1. 0 = off. */
  amount: z.number().min(0).max(1),
  bypassed: z.boolean(),
});

export const ImagerModeSchema = z.enum(['STEREO', 'MS']);
export type ImagerMode = z.infer<typeof ImagerModeSchema>;

/** Imager per channel — M/S stereo width. */
export const ChannelImagerSchema = z.object({
  /** Width, 0..2; 1 = unity (passthrough). */
  width: z.number().min(0).max(2),
  bypassed: z.boolean(),
  /** Stereo balance −1..1 (v22+). UI/goniometer only. */
  balance: z.number().min(-1).max(1).default(0),
  /** Display mode (v22+). UI/goniometer only. */
  mode: ImagerModeSchema.default('STEREO'),
});

export const TapeModeSchema = z.enum(['TAPE', 'TUBE', 'TRANS']);
export type TapeMode = z.infer<typeof TapeModeSchema>;

/** Tape per channel — single-stage tape saturation. */
export const ChannelTapeSchema = z.object({
  /** Pre-drive in dB, 0..24. 0 = clean. */
  driveDb: z.number().min(0).max(24),
  /** Tone tilt, -1..1. Negative = warm, positive = bright, 0 = flat. */
  tone: z.number().min(-1).max(1),
  /** Dry/wet mix, 0..1. 0 = dry passthrough. */
  mix: z.number().min(0).max(1),
  bypassed: z.boolean(),
  /** Bias offset −50..50 (v21+). UI/curve only. */
  bias: z.number().min(-50).max(50).default(0),
  /** Saturation flavour (v21+). UI/harmonics only. */
  mode: TapeModeSchema.default('TAPE'),
});

/** Console per channel — asymmetric soft-clip with iron-shelf bass + top-smooth. */
export const ChannelConsoleSchema = z.object({
  /** Pre-drive in dB, 0..24. 0 = clean. */
  driveDb: z.number().min(0).max(24),
  /** Console character, 0..1. 0 = symmetric tanh (no iron); 1 = full
   *  asymmetric clip + +3 dB iron shelf + -2 dB top smooth. */
  character: z.number().min(0).max(1),
  /** Dry/wet mix, 0..1. 0 = dry passthrough. */
  mix: z.number().min(0).max(1),
  bypassed: z.boolean(),
});

/**
 * A clip is a window into the stem's source buffer placed on the timeline.
 * All three positions are in SAMPLES (sample-accurate — avoids float-seconds
 * drift, and the engine already reasons in samples). v1 scope: edits stay
 * inside a single stem, so clips is an ordered per-channel array.
 */
export const StemClipSchema = z
  .object({
    /** Stable id — React keys, drag targeting, undo deltas. */
    id: z.string().min(1),
    /** First source-buffer sample the clip plays (trim-left). */
    sourceIn: z.number().int().min(0),
    /** One-past-last source-buffer sample (trim-right). */
    sourceOut: z.number().int().min(1),
    /** Global-timeline sample where `sourceIn` lands (move). */
    timelineStart: z.number().int().min(0),
  })
  .refine((c) => c.sourceOut > c.sourceIn, {
    message: 'clip sourceOut must be greater than sourceIn',
  });

export const StemClipsSchema = z.array(StemClipSchema);

/** MB-Comp per channel — 3-band multiband compressor. */
export const ChannelMbCompSchema = z.object({
  /** Low-band threshold in dB, -40..0. 0 = that band uncompressed. */
  loThreshDb: z.number().min(-40).max(0),
  /** Mid-band threshold in dB, -40..0. */
  midThreshDb: z.number().min(-40).max(0),
  /** High-band threshold in dB, -40..0. */
  hiThreshDb: z.number().min(-40).max(0),
  /** Shared ratio across all three bands, 1..10. */
  ratio: z.number().min(1).max(10),
  bypassed: z.boolean(),
});

export const ChannelStateSchema = z.object({
  volume: z.number().min(0).max(8),
  pan: z.number().min(-1).max(1),
  muted: z.boolean(),
  soloed: z.boolean(),
  eq: ChannelEqSchema,
  /** Full 5-band parametric EQ (v18+). Optional — derived from `eq` on load. */
  eqFull: ChannelEqFullSchema.optional(),
  comp: ChannelCompSchema,
  compType: CompTypeSchema,
  outputBusId: z.string().min(1),
  sends: ChannelSendsSchema,
  transient: ChannelTransientSchema,
  deess: ChannelDeEssSchema,
  imager: ChannelImagerSchema,
  tape: ChannelTapeSchema,
  console: ChannelConsoleSchema,
  mbcomp: ChannelMbCompSchema,
  /** Timeline regions for this stem. Optional/absent = whole buffer at t=0
   *  (keeps v1–v15 docs valid under the strict parse). Hydration normalises
   *  this to `[]` so the engine + UI can treat "no clips" uniformly. */
  clips: StemClipsSchema.optional(),
});

export const LimiterStyleSchema = z.enum(['CLEAR', 'PUNCH', 'GLUE', 'SAFE']);
export type LimiterStyle = z.infer<typeof LimiterStyleSchema>;

export const LimiterStateSchema = z.object({
  /** Brick-wall threshold in dBFS (typically −1.0 for true-peak safety). */
  thresholdDb: z.number().min(-24).max(0),
  /** Release time in ms. */
  releaseMs: z.number().min(5).max(2000),
  /** Pre-limit makeup gain in dB. */
  makeupDb: z.number().min(-12).max(24),
  bypassed: z.boolean(),
  /** Voicing (v23+). UI only — engine limits from threshold/release/makeup. */
  style: LimiterStyleSchema.default('GLUE'),
});

/**
 * Reference Room — monitoring preset that filters the post-master signal
 * (between masterGain and the final output) to simulate common playback
 * systems. "off" disables the filter chain entirely.
 */
export const ReferenceRoomPresetSchema = z.enum(['off', 'laptop', 'earbuds', 'car']);
export type ReferenceRoomPreset = z.infer<typeof ReferenceRoomPresetSchema>;

export const ReferenceRoomStateSchema = z.object({
  preset: ReferenceRoomPresetSchema,
});

export const MasterChainSchema = z.object({
  limiter: LimiterStateSchema,
  referenceRoom: ReferenceRoomStateSchema,
});

export const MixStateSchema = z.object({
  // Transition shim: accept v15 and v16 during rollout — see ACCEPTED_VERSIONS.
  version: z.union(ACCEPTED_VERSIONS),
  channels: z.record(z.string(), ChannelStateSchema),
  buses: BusesSchema,
  masterChain: MasterChainSchema,
});

export type StemClip = z.infer<typeof StemClipSchema>;
export type ChannelEq = z.infer<typeof ChannelEqSchema>;
export type ChannelComp = z.infer<typeof ChannelCompSchema>;
export type ChannelMbComp = z.infer<typeof ChannelMbCompSchema>;
export type ChannelStateDoc = z.infer<typeof ChannelStateSchema>;
export type BusState = z.infer<typeof BusStateSchema>;
export type ReverbState = z.infer<typeof ReverbStateSchema>;

/** Sensible defaults per reverb kind — both share most params, Hall just
 *  wants a longer tail and bigger pre-delay by default. */
export function defaultReverb(kind: ReverbKind): ReverbState {
  if (kind === 'hall') {
    return {
      kind: 'hall',
      decay: 0.75,
      damping: 0.25,
      preDelayMs: 30,
      mix: 1.0,
      bypassed: false,
    };
  }
  return {
    kind: 'plate',
    decay: 0.55,
    damping: 0.4,
    preDelayMs: 10,
    mix: 1.0,
    bypassed: false,
  };
}
export type LimiterState = z.infer<typeof LimiterStateSchema>;
export type MasterChain = z.infer<typeof MasterChainSchema>;
export type MixState = z.infer<typeof MixStateSchema>;

/**
 * Sensible Master limiter defaults. −1 dBFS threshold protects against
 * inter-sample peaks on consumer playback even without true-peak detection.
 */
export const DEFAULT_LIMITER_STATE: LimiterState = {
  thresholdDb: -1,
  releaseMs: 100,
  makeupDb: 0,
  bypassed: false,
  style: 'GLUE',
};

export const DEFAULT_REFERENCE_ROOM = {
  preset: 'off',
} as const;

export const DEFAULT_MASTER_CHAIN: MasterChain = {
  limiter: { ...DEFAULT_LIMITER_STATE },
  referenceRoom: { preset: 'off' },
};

/** Default Master bus, added in hydration when absent. */
export const DEFAULT_MASTER_BUS: BusState = {
  id: MASTER_BUS_ID,
  name: 'Master',
  gain: 1,
  muted: false,
};

export const DEFAULT_CHANNEL_EQ: ChannelEq = { lo: 0, mid: 0, hi: 0, bypassed: false };

/**
 * Default 5-band parametric layout (HP / low-shelf / two peaks / high-shelf),
 * all flat. The HP starts off so a fresh channel is fully transparent. Band
 * ids double as EQ-8 slots; the strip's Lo/Mid/Hi mirror bands 1/2/4.
 */
export const DEFAULT_EQ_FULL_BANDS: EqFullBand[] = [
  { id: 0, type: 'hp', freq: 32, gain: 0, q: 0.7, on: false },
  { id: 1, type: 'lowshelf', freq: 120, gain: 0, q: 0.7, on: true },
  { id: 2, type: 'peak', freq: 650, gain: 0, q: 1.4, on: true },
  { id: 3, type: 'peak', freq: 3200, gain: 0, q: 1.0, on: true },
  { id: 4, type: 'highshelf', freq: 9000, gain: 0, q: 0.7, on: true },
];

/** Band ids the strip's Lo / Mid / Hi quick knobs drive. */
export const EQ_QUICK_BAND_IDS = { lo: 1, mid: 2, hi: 4 } as const;

/** Build a full-EQ state from the legacy quick knobs (used on hydration of a
 *  pre-v18 doc, and as the v18 default). */
/** Read the Lo/Mid/Hi quick-knob gains back out of a full-EQ state, so the
 *  strip's quick knobs stay a faithful mirror of bands 1/2/4 on load. */
export function quickFromEqFull(eqFull: ChannelEqFull): { lo: number; mid: number; hi: number } {
  const gainOf = (id: number) => eqFull.bands.find((b) => b.id === id)?.gain ?? 0;
  return {
    lo: gainOf(EQ_QUICK_BAND_IDS.lo),
    mid: gainOf(EQ_QUICK_BAND_IDS.mid),
    hi: gainOf(EQ_QUICK_BAND_IDS.hi),
  };
}

export function eqFullFromQuick(eq: { lo: number; mid: number; hi: number }): ChannelEqFull {
  const quickGain: Record<number, number> = {
    [EQ_QUICK_BAND_IDS.lo]: eq.lo,
    [EQ_QUICK_BAND_IDS.mid]: eq.mid,
    [EQ_QUICK_BAND_IDS.hi]: eq.hi,
  };
  const bands = DEFAULT_EQ_FULL_BANDS.map((b) =>
    b.id in quickGain ? { ...b, gain: quickGain[b.id] ?? b.gain } : { ...b }
  );
  return { bands, analyzer: true };
}
/**
 * Default Comp-Clean state — ratio 1.0 means the DSP fast-paths to a
 * passthrough, so a fresh channel is acoustically transparent.
 */
export const DEFAULT_CHANNEL_COMP: ChannelComp = {
  threshold: 0,
  ratio: 1,
  bypassed: false,
  attackMs: 10,
  releaseMs: 120,
  makeupDb: 0,
  knee: 6,
};

/** Default Transient state — both knobs at 0 = passthrough. */
export const DEFAULT_CHANNEL_TRANSIENT = {
  attack: 0,
  sustain: 0,
  bypassed: false,
  sens: 50,
  mode: 'WIDE',
} as const;

/** Default DeEss — 6 kHz crossover, amount 0 = passthrough. */
export const DEFAULT_CHANNEL_DEESS = {
  freq: 6000,
  amount: 0,
  bypassed: false,
} as const;

/** Default Imager — width 1 = passthrough. */
export const DEFAULT_CHANNEL_IMAGER = {
  width: 1,
  bypassed: false,
  balance: 0,
  mode: 'STEREO',
} as const;

/** Default Tape — clean, dry. */
export const DEFAULT_CHANNEL_TAPE = {
  driveDb: 0,
  tone: 0,
  mix: 0,
  bypassed: false,
  bias: 0,
  mode: 'TAPE',
} as const;

/** Default Console — clean, dry. */
export const DEFAULT_CHANNEL_CONSOLE = {
  driveDb: 0,
  character: 0,
  mix: 0,
  bypassed: false,
} as const;

/** Default MB-Comp — all bands at 0 dB (uncompressed), ratio 4:1. */
export const DEFAULT_CHANNEL_MBCOMP = {
  loThreshDb: 0,
  midThreshDb: 0,
  hiThreshDb: 0,
  ratio: 4,
  bypassed: false,
} as const;

/** Default clips — empty = play the whole stem buffer at t=0. */
export const DEFAULT_STEM_CLIPS: StemClip[] = [];

/** Default comp flavour for new channels. */
export const DEFAULT_COMP_TYPE: CompType = 'clean';

/** Baked-in defaults for the Clean-flavor comp params the UI doesn't expose. */
export const COMP_DEFAULTS = {
  attackMs: 10,
  releaseMs: 100,
  makeupDb: 0,
  mix: 1,
} as const;

/**
 * Color-flavor needs the same five-plus-drive defaults. Attack is much
 * faster and there's a fixed 6 dB of drive that gives the FET its
 * characteristic warmth without forcing the engineer to dial it in.
 */
export const COMP_COLOR_DEFAULTS = {
  attackMs: 1,
  releaseMs: 50,
  makeupDb: 0,
  mix: 1,
  driveDb: 6,
} as const;

export function emptyMixState(): MixState {
  return {
    version: MIX_STATE_VERSION,
    channels: {},
    buses: { [MASTER_BUS_ID]: { ...DEFAULT_MASTER_BUS } },
    masterChain: {
      limiter: { ...DEFAULT_LIMITER_STATE },
      referenceRoom: { preset: 'off' },
    },
  };
}
