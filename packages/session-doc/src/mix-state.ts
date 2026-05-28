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
 * v2 — adds EQ state: LO (low-shelf), MID (peak), HI (high-shelf) in dB.
 * v3 — adds Comp-Clean state per channel: { threshold, ratio }. Only the
 *      two knobs that ship in the v0.2 strip UI; attack/release/makeup/mix
 *      use sensible defaults until the v0.3 deep-edit panel.
 */

export const MIX_STATE_VERSION = 3;

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

export const ChannelStateSchema = z.object({
  volume: z.number().min(0).max(8),
  pan: z.number().min(-1).max(1),
  muted: z.boolean(),
  soloed: z.boolean(),
  eq: ChannelEqSchema,
  comp: ChannelCompSchema,
});

export const MixStateSchema = z.object({
  version: z.literal(MIX_STATE_VERSION),
  channels: z.record(z.string(), ChannelStateSchema),
});

export type ChannelEq = z.infer<typeof ChannelEqSchema>;
export type ChannelComp = z.infer<typeof ChannelCompSchema>;
export type ChannelStateDoc = z.infer<typeof ChannelStateSchema>;
export type MixState = z.infer<typeof MixStateSchema>;

export const DEFAULT_CHANNEL_EQ: ChannelEq = { lo: 0, mid: 0, hi: 0 };
/**
 * Default Comp-Clean state — ratio 1.0 means the DSP fast-paths to a
 * passthrough, so a fresh channel is acoustically transparent.
 */
export const DEFAULT_CHANNEL_COMP: ChannelComp = { threshold: 0, ratio: 1 };

/** Baked-in defaults for the comp params the v0.2 UI doesn't expose. */
export const COMP_DEFAULTS = {
  attackMs: 10,
  releaseMs: 100,
  makeupDb: 0,
  mix: 1,
} as const;

export function emptyMixState(): MixState {
  return { version: MIX_STATE_VERSION, channels: {} };
}
