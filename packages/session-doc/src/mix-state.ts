import { z } from 'zod';

/**
 * MixState — serialized form of the live mixer.
 *
 * Persisted to `sessions.mix_state` (Json column). Saved on every channel
 * change (debounced + flushed on page hide); hydrated on session open.
 *
 * Versioning
 * ----------
 * v1 — volume / pan / mute / solo  (autosave slice, 5d36165).
 * v2 — adds EQ state per channel.
 * v3 — adds Comp-Clean state per channel.
 * v4 — adds compType ∈ { 'clean', 'color' }.
 * v5 — adds buses + channel.outputBusId.
 * v6 — adds channel.sends — a map of post-fader send levels keyed by bus id.
 */

export const MIX_STATE_VERSION = 6;

/** Stable id for the always-present Master bus. Sessions can omit it from
 *  their `buses` record; the client treats it as if explicitly present. */
export const MASTER_BUS_ID = 'master';

export const BusStateSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(80),
  /** Linear gain 0..2; 1 = 0 dB. */
  gain: z.number().min(0).max(4),
  muted: z.boolean(),
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
});

export const MixStateSchema = z.object({
  version: z.literal(MIX_STATE_VERSION),
  channels: z.record(z.string(), ChannelStateSchema),
  buses: BusesSchema,
});

export type ChannelEq = z.infer<typeof ChannelEqSchema>;
export type ChannelComp = z.infer<typeof ChannelCompSchema>;
export type ChannelStateDoc = z.infer<typeof ChannelStateSchema>;
export type BusState = z.infer<typeof BusStateSchema>;
export type MixState = z.infer<typeof MixStateSchema>;

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
  };
}
