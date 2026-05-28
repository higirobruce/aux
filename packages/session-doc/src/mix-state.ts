import { z } from 'zod';

/**
 * MixState — minimal serialized form of the live mixer for v0.2.
 *
 * Per-channel volume / pan / mute / solo. This is the smallest possible
 * subset of [[SessionDoc]] needed to round-trip a working session. As we
 * add EQ / compression / sends / clip arrangement in later slices, this
 * grows toward the full SessionDoc.
 *
 * Persisted to `sessions.mix_state` (Json column). Saved on every change
 * (debounced); hydrated on session open.
 */

export const MIX_STATE_VERSION = 1;

export const ChannelStateSchema = z.object({
  volume: z.number().min(0).max(8),
  pan: z.number().min(-1).max(1),
  muted: z.boolean(),
  soloed: z.boolean(),
});

export const MixStateSchema = z.object({
  version: z.literal(MIX_STATE_VERSION),
  channels: z.record(z.string(), ChannelStateSchema),
});

export type ChannelStateDoc = z.infer<typeof ChannelStateSchema>;
export type MixState = z.infer<typeof MixStateSchema>;

export function emptyMixState(): MixState {
  return { version: MIX_STATE_VERSION, channels: {} };
}
