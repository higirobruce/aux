import { z } from 'zod';

/**
 * Server-side mirror of @aux/session-doc's MixStateSchema.
 *
 * The web app loads @aux/session-doc through Next's bundler, which transpiles
 * .ts at build time. The API runs under `nest start` and ends up calling
 * `require("@aux/session-doc")` at runtime — but the package main is
 * ./src/index.ts and there's no emitted JS, so Node's ESM resolver fails on
 * the cross-file `export * from './schema'`. Until session-doc is built to
 * dist/ proper (separate cleanup), the API keeps its own copy of the schema.
 * Schema is tiny and rarely changes; drift cost is low.
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

export type MixState = z.infer<typeof MixStateSchema>;
