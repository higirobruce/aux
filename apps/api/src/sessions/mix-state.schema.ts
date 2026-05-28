import { z } from 'zod';

/**
 * Server-side mirror of @aux/session-doc's MixStateSchema. See the note in
 * c361c37 for why the API can't import from the package at runtime.
 *
 * Versioning
 * ----------
 * v1 — volume / pan / mute / solo (autosave slice, 5d36165).
 * v2 — adds EQ state: LO (low-shelf), MID (peak), HI (high-shelf) in dB.
 * v3 — adds Comp-Clean state per channel: threshold + ratio (the two knobs
 *      surfaced in the strip UI). attack/release/makeup/mix stay at the
 *      v0.2 default until the deep-edit panel ships.
 *
 * The server only accepts the current version. Older docs in the DB are
 * migrated client-side at hydration time (defaults added in-memory).
 */

export const MIX_STATE_VERSION = 3;

export const ChannelEqSchema = z.object({
  lo: z.number().min(-24).max(24),
  mid: z.number().min(-24).max(24),
  hi: z.number().min(-24).max(24),
});

export const ChannelCompSchema = z.object({
  /** Threshold in dB, −80..+12. */
  threshold: z.number().min(-80).max(12),
  /** Ratio 1..20; 1 = no compression (fast-path passthrough in DSP). */
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
export type MixState = z.infer<typeof MixStateSchema>;
