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
 *      Stored under `eq` per channel. The 3 knobs map to bands 1, 3, 6
 *      of the EQ-8 (bands 0/2/4/5/7 are reserved for HP, extra peaks, LP
 *      when we expose the full 8-band UI in v0.3).
 */

export const MIX_STATE_VERSION = 2;

export const ChannelEqSchema = z.object({
  /** Low-shelf gain in dB (band 1, freq 100 Hz). */
  lo: z.number().min(-24).max(24),
  /** Mid-peak gain in dB (band 3, freq 1 kHz). */
  mid: z.number().min(-24).max(24),
  /** High-shelf gain in dB (band 6, freq 8 kHz). */
  hi: z.number().min(-24).max(24),
});

export const ChannelStateSchema = z.object({
  volume: z.number().min(0).max(8),
  pan: z.number().min(-1).max(1),
  muted: z.boolean(),
  soloed: z.boolean(),
  eq: ChannelEqSchema,
});

export const MixStateSchema = z.object({
  version: z.literal(MIX_STATE_VERSION),
  channels: z.record(z.string(), ChannelStateSchema),
});

export type ChannelEq = z.infer<typeof ChannelEqSchema>;
export type ChannelStateDoc = z.infer<typeof ChannelStateSchema>;
export type MixState = z.infer<typeof MixStateSchema>;

export const DEFAULT_CHANNEL_EQ: ChannelEq = { lo: 0, mid: 0, hi: 0 };

export function emptyMixState(): MixState {
  return { version: MIX_STATE_VERSION, channels: {} };
}
