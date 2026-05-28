import { z } from 'zod';

/**
 * Server-side mirror of @aux/session-doc's MixStateSchema. See the note in
 * c361c37 for why the API can't import from the package at runtime.
 *
 * Versioning
 * ----------
 * v1 — volume / pan / mute / solo (autosave slice, 5d36165).
 * v2 — adds EQ state: LO (low-shelf), MID (peak), HI (high-shelf) in dB
 *      (slice #58 + #59). Stored under `eq` per channel.
 *
 * The server only accepts v2 from clients that have been updated. v1 docs in
 * the database are migrated client-side at hydration time (older shape gets
 * an empty EQ section added).
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
export type MixState = z.infer<typeof MixStateSchema>;
