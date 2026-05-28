/**
 * @aux/db — Prisma client singleton + re-exports of generated types.
 *
 * Run `pnpm --filter @aux/db generate` once after `pnpm install` to produce
 * the client at ./prisma/generated. The exports below assume that step has
 * happened.
 */

export {
  PrismaClient,
  Prisma,
  type User,
  type Session,
  type Stem,
  type Snapshot,
  type Collaborator,
  type Render,
  type ShareLink,
  type UserPreset,
  type ChainPreset,
  type AuthSession,
  type Account,
  type Verification,
  StorageMode,
  CollaboratorRole,
  RenderFormat,
  RenderStatus,
} from '../prisma/generated/index.js';

import { PrismaClient } from '../prisma/generated/index.js';

let cached: PrismaClient | null = null;

/**
 * Single PrismaClient per process. Re-use across requests to avoid exhausting
 * the connection pool.
 */
export function getPrismaClient(): PrismaClient {
  if (cached) return cached;
  cached = new PrismaClient();
  return cached;
}
