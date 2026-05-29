import { defineConfig } from 'vitest/config';

/* The §16.07 ship gate. Kept separate from the unit suite so `pnpm test`
 * stays fast and deterministic, while `pnpm test:perf` runs the render
 * benchmark in isolation (single thread, no parallel noise). */
export default defineConfig({
  test: {
    include: ['perf/**/*.bench.ts'],
    pool: 'threads',
    poolOptions: { threads: { singleThread: true } },
    // A regressing benchmark should fail loudly, not flake on a busy box.
    retry: 0,
  },
});
