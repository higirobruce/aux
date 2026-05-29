import { describe, expect, it } from 'vitest';

/* ────────────────────────────────────────────────────────────────────────
 * §16.07 — the ship gate (audio render benchmark)
 *
 * CI blocks any PR that pushes the per-block render cost past the threshold
 * below. Run locally with:
 *
 *     pnpm --filter @aux/web test:perf
 *
 * SCAFFOLD NOTE: the real render path lives in an AudioWorkletProcessor
 * (`packages/audio-engine/src/worklet.ts`) which needs browser globals to
 * exercise. Until that graph is headless-testable, this harness times a
 * representative DSP workload — an 8-band biquad chain over a stereo block,
 * which is exactly the shape of the EQ-8 / Reference-Rooms hot path. The
 * timing + warmup + threshold machinery is the durable part; repoint
 * `renderOneBlock` at the worklet graph when it can run outside the browser.
 * ──────────────────────────────────────────────────────────────────────── */

const SAMPLE_RATE = 48_000;
const BLOCK_SIZE = 128; // AudioWorklet render quantum
const CHANNELS = 2;
const BANDS = 8; // EQ-8

// Real-time budget for one render quantum at 48 kHz.
const BLOCK_BUDGET_MS = (BLOCK_SIZE / SAMPLE_RATE) * 1000; // ≈ 2.667 ms

// §16.07 threshold: one block of the representative chain must render in well
// under real time. We gate at 15% of the quantum budget so there's ample
// headroom for the rest of the graph (sends, buses, master, metering).
const THRESHOLD_MS = BLOCK_BUDGET_MS * 0.15; // ≈ 0.40 ms

const WARMUP_BLOCKS = 2_000;
const MEASURE_BLOCKS = 20_000;

/* ── A transposed-direct-form-II biquad, the unit every band reduces to. ── */
interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
  z1: number;
  z2: number;
}

function makeBiquad(seed: number): Biquad {
  // RBJ-cookbook low-pass, normalized by a0. Coefficients are guaranteed
  // stable (poles inside the unit circle) for any Q > 0 — the point is the
  // FLOPs of a real band, not the exact response. Cutoff fans out per band.
  const f0 = 80 * 2 ** (seed % BANDS); // 80 Hz … ~10 kHz, all below Nyquist
  const q = Math.SQRT1_2; // Butterworth (1/√2)
  const w0 = (2 * Math.PI * f0) / SAMPLE_RATE;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  const a0 = 1 + alpha;
  return {
    b0: (1 - cos) / 2 / a0,
    b1: (1 - cos) / a0,
    b2: (1 - cos) / 2 / a0,
    a1: (-2 * cos) / a0,
    a2: (1 - alpha) / a0,
    z1: 0,
    z2: 0,
  };
}

function processBiquad(bq: Biquad, x: number): number {
  const y = bq.b0 * x + bq.z1;
  bq.z1 = bq.b1 * x - bq.a1 * y + bq.z2;
  bq.z2 = bq.b2 * x - bq.a2 * y;
  return y;
}

/* ── One render quantum: an 8-band chain per channel, fresh input → output,
 *    exactly as an AudioWorkletProcessor receives a new quantum each call. ── */
function renderOneBlock(input: Float32Array[], output: Float32Array[], chains: Biquad[][]): void {
  for (let ch = 0; ch < CHANNELS; ch++) {
    const inCh = input[ch];
    const outCh = output[ch];
    const chain = chains[ch];
    if (!inCh || !outCh || !chain) continue;
    let i = 0;
    for (const x of inCh) {
      let s = x;
      for (const bq of chain) {
        s = processBiquad(bq, s);
      }
      outCh[i] = s;
      i++;
    }
  }
}

describe('§16.07 audio render benchmark', () => {
  it('renders one block well within the real-time budget', () => {
    const input: Float32Array[] = Array.from(
      { length: CHANNELS },
      () => new Float32Array(BLOCK_SIZE)
    );
    const output: Float32Array[] = Array.from(
      { length: CHANNELS },
      () => new Float32Array(BLOCK_SIZE)
    );
    const chains: Biquad[][] = Array.from({ length: CHANNELS }, () =>
      Array.from({ length: BANDS }, (_, b) => makeBiquad(b))
    );

    // Deterministic bounded signal so the optimizer can't elide work.
    for (let ch = 0; ch < CHANNELS; ch++) {
      const inCh = input[ch];
      if (!inCh) continue;
      for (let i = 0; i < BLOCK_SIZE; i++) {
        inCh[i] = Math.sin((i / BLOCK_SIZE) * Math.PI * 2 * (ch + 1));
      }
    }

    for (let n = 0; n < WARMUP_BLOCKS; n++) renderOneBlock(input, output, chains);

    const start = performance.now();
    for (let n = 0; n < MEASURE_BLOCKS; n++) {
      renderOneBlock(input, output, chains);
    }
    const elapsed = performance.now() - start;

    const perBlockMs = elapsed / MEASURE_BLOCKS;

    // Keep the optimizer honest — touch the output.
    expect(Number.isFinite(output[0]?.[0] ?? Number.NaN)).toBe(true);

    console.log(
      `§16.07 render: ${perBlockMs.toFixed(4)} ms/block ` +
        `(budget ${BLOCK_BUDGET_MS.toFixed(3)} ms, gate ${THRESHOLD_MS.toFixed(3)} ms)`
    );

    expect(perBlockMs).toBeLessThan(THRESHOLD_MS);
  });
});
