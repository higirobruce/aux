import { z } from 'zod';

/**
 * Session document — JSON with parameter-level atoms.
 *
 * Per docs/brainstorm.html §16.02: every knob, fader, EQ band gain, clip start,
 * plugin parameter is independently addressable. v1 is solo-mixer (no CRDT);
 * v2 layers Yjs on top of the same atom paths.
 */

export const ClipSchema = z.object({
  id: z.string(),
  start: z.number().int().nonnegative(), // samples from session origin
  length: z.number().int().positive(), // samples
  src: z.string(), // stem id
  fadeIn: z.number().nonnegative().default(0),
  fadeOut: z.number().nonnegative().default(0),
});

export const AutomationPointSchema = z.object({
  t: z.number().nonnegative(), // samples
  v: z.number(),
});

export const AutomationLaneSchema = z.object({
  id: z.string(),
  param: z.string(), // e.g. "trk_kick.volume"
  points: z.array(AutomationPointSchema),
});

export const ParamValueSchema = z.object({
  value: z.number(),
  auto: z.string().optional(), // automation lane id
});

export const TrackSchema = z.object({
  name: z.string(),
  clips: z.array(ClipSchema),
  chain: z.array(z.string()), // plugin instance ids in order
  sends: z.array(z.object({ to: z.string(), gain: z.number() })).default([]),
  params: z.record(z.string(), ParamValueSchema),
});

export const PluginInstanceSchema = z.object({
  type: z.string(), // 'EQ-8', 'Comp-A', etc.
  schemaVersion: z.number().int().positive(),
  state: z.unknown(), // plugin-defined
  bypassed: z.boolean().default(false),
});

export const SnapshotRefSchema = z.object({
  id: z.string(),
  parentId: z.string().nullable(),
  ts: z.string().datetime(),
  message: z.string().nullable(),
});

export const SessionDocSchema = z.object({
  id: z.string(),
  version: z.number().int(),
  name: z.string(),
  storageMode: z.enum(['cloud', 'local']),
  sampleRate: z.number().int().default(48000),
  tracks: z.record(z.string(), TrackSchema),
  buses: z.record(z.string(), TrackSchema).default({}),
  fx: z.record(z.string(), PluginInstanceSchema).default({}),
  automation: z.record(z.string(), AutomationLaneSchema).default({}),
  snapshots: z.array(SnapshotRefSchema).default([]),
  master: z
    .object({
      chain: z.array(z.string()).default([]),
      targetLufs: z.number().nullable().default(-14),
    })
    .default({ chain: [], targetLufs: -14 }),
});

export type Clip = z.infer<typeof ClipSchema>;
export type AutomationPoint = z.infer<typeof AutomationPointSchema>;
export type AutomationLane = z.infer<typeof AutomationLaneSchema>;
export type ParamValue = z.infer<typeof ParamValueSchema>;
export type Track = z.infer<typeof TrackSchema>;
export type PluginInstance = z.infer<typeof PluginInstanceSchema>;
export type SnapshotRef = z.infer<typeof SnapshotRefSchema>;
export type SessionDoc = z.infer<typeof SessionDocSchema>;
