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
 */

export const MIX_STATE_VERSION = 12;

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
  /** Low-shelf gain in dB (band 1, freq 100 Hz). */
  lo: z.number().min(-24).max(24),
  /** Mid-peak gain in dB (band 3, freq 1 kHz). */
  mid: z.number().min(-24).max(24),
  /** High-shelf gain in dB (band 6, freq 8 kHz). */
  hi: z.number().min(-24).max(24),
});

export const ChannelCompSchema = z.object({
  /** Threshold in dB, −80..+12. */
  threshold: z.number().min(-80).max(12),
  /** Ratio 1..20; 1 = no compression. */
  ratio: z.number().min(1).max(20),
});

/** Post-fader aux sends keyed by destination bus id; value = linear gain. */
export const ChannelSendsSchema = z.record(z.string(), z.number().min(0).max(2));

/** Transient designer per channel — attack/sustain shaper. */
export const ChannelTransientSchema = z.object({
  /** Attack scaling, -1..1. 0 = no change. */
  attack: z.number().min(-1).max(1),
  /** Sustain scaling, -1..1. 0 = no change. */
  sustain: z.number().min(-1).max(1),
  bypassed: z.boolean(),
});

/** DeEss per channel — split-band sibilance tamer. */
export const ChannelDeEssSchema = z.object({
  /** Crossover frequency, 2_000..12_000 Hz. */
  freq: z.number().min(2000).max(12000),
  /** De-ess amount, 0..1. 0 = off. */
  amount: z.number().min(0).max(1),
  bypassed: z.boolean(),
});

/** Imager per channel — M/S stereo width. */
export const ChannelImagerSchema = z.object({
  /** Width, 0..2; 1 = unity (passthrough). */
  width: z.number().min(0).max(2),
  bypassed: z.boolean(),
});

export const ChannelStateSchema = z.object({
  volume: z.number().min(0).max(8),
  pan: z.number().min(-1).max(1),
  muted: z.boolean(),
  soloed: z.boolean(),
  eq: ChannelEqSchema,
  comp: ChannelCompSchema,
  compType: CompTypeSchema,
  outputBusId: z.string().min(1),
  sends: ChannelSendsSchema,
  transient: ChannelTransientSchema,
  deess: ChannelDeEssSchema,
  imager: ChannelImagerSchema,
});

export const LimiterStateSchema = z.object({
  /** Brick-wall threshold in dBFS (typically −1.0 for true-peak safety). */
  thresholdDb: z.number().min(-24).max(0),
  /** Release time in ms. */
  releaseMs: z.number().min(5).max(2000),
  /** Pre-limit makeup gain in dB. */
  makeupDb: z.number().min(-12).max(24),
  bypassed: z.boolean(),
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
  version: z.literal(MIX_STATE_VERSION),
  channels: z.record(z.string(), ChannelStateSchema),
  buses: BusesSchema,
  masterChain: MasterChainSchema,
});

export type ChannelEq = z.infer<typeof ChannelEqSchema>;
export type ChannelComp = z.infer<typeof ChannelCompSchema>;
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

export const DEFAULT_CHANNEL_EQ: ChannelEq = { lo: 0, mid: 0, hi: 0 };
/**
 * Default Comp-Clean state — ratio 1.0 means the DSP fast-paths to a
 * passthrough, so a fresh channel is acoustically transparent.
 */
export const DEFAULT_CHANNEL_COMP: ChannelComp = { threshold: 0, ratio: 1 };

/** Default Transient state — both knobs at 0 = passthrough. */
export const DEFAULT_CHANNEL_TRANSIENT = {
  attack: 0,
  sustain: 0,
  bypassed: false,
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
} as const;

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
