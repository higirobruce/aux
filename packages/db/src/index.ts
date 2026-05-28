/**
 * @aux/db — Prisma client wrapper.
 *
 * Re-exports the generated Prisma client so consumers import from one place.
 * Run `pnpm --filter @aux/db generate` after installing dependencies to
 * produce the client in ./prisma/generated.
 */

// The generated client only exists after `prisma generate`.
// Until then, this is a stub that other packages can still type against.

export type PrismaClient = unknown;

let cached: PrismaClient | null = null;

export async function getPrismaClient(): Promise<PrismaClient> {
  if (cached) return cached;
  // Dynamic import so the package builds even before `prisma generate` has run.
  const mod = (await import('../prisma/generated/index.js' as string).catch(() => null)) as
    | { PrismaClient: new () => PrismaClient }
    | null;
  if (!mod) {
    throw new Error('Prisma client not generated. Run: pnpm --filter @aux/db generate');
  }
  cached = new mod.PrismaClient();
  return cached;
}
