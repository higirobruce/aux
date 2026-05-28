import { describe, expect, it } from 'vitest';
import { clamp, dbToLinear, formatDb, formatFreq, formatLufs, linearToDb } from './index.js';

describe('formatDb', () => {
  it('formats positive values with + and a fixed decimal', () => {
    expect(formatDb(3)).toBe('+3.0 dB');
  });
  it('formats negative values with the figure dash', () => {
    expect(formatDb(-2.345)).toBe('−2.3 dB');
  });
  it('formats zero without a sign', () => {
    expect(formatDb(0)).toBe('0.0 dB');
  });
  it('renders −∞ for negative infinity', () => {
    expect(formatDb(Number.NEGATIVE_INFINITY)).toBe('−∞ dB');
  });
});

describe('formatFreq', () => {
  it('returns integer Hz under 1 kHz', () => {
    expect(formatFreq(440)).toBe('440 Hz');
  });
  it('returns one-decimal kHz between 1k and 10k', () => {
    expect(formatFreq(2500)).toBe('2.5 kHz');
  });
  it('returns integer kHz at or above 10 kHz', () => {
    expect(formatFreq(12000)).toBe('12 kHz');
  });
});

describe('formatLufs', () => {
  it('formats negative LUFS with the figure dash', () => {
    expect(formatLufs(-14)).toBe('−14.0 LUFS');
  });
});

describe('clamp', () => {
  it('clips to upper bound', () => {
    expect(clamp(10, 0, 5)).toBe(5);
  });
  it('clips to lower bound', () => {
    expect(clamp(-3, 0, 5)).toBe(0);
  });
  it('passes through values in range', () => {
    expect(clamp(2.5, 0, 5)).toBe(2.5);
  });
});

describe('linearToDb / dbToLinear', () => {
  it('round-trips to within float epsilon', () => {
    const original = -6;
    const recovered = linearToDb(dbToLinear(original));
    expect(recovered).toBeCloseTo(original, 6);
  });
  it('0 dB = 1.0 linear', () => {
    expect(dbToLinear(0)).toBeCloseTo(1, 6);
  });
  it('-6 dB ≈ 0.5 linear', () => {
    expect(dbToLinear(-6)).toBeCloseTo(0.5012, 3);
  });
});
