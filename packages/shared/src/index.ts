/**
 * @aux/shared — utilities used across apps and packages.
 */

/** Format a dB value with sign + fixed precision. */
export function formatDb(db: number, digits = 1): string {
  if (!Number.isFinite(db)) return '−∞ dB';
  const sign = db > 0 ? '+' : db < 0 ? '−' : '';
  return `${sign}${Math.abs(db).toFixed(digits)} dB`;
}

/** Format a frequency value (Hz / kHz). */
export function formatFreq(hz: number): string {
  if (hz < 1000) return `${Math.round(hz)} Hz`;
  return `${(hz / 1000).toFixed(hz >= 10000 ? 0 : 1)} kHz`;
}

/** Format LUFS. */
export function formatLufs(lufs: number): string {
  if (!Number.isFinite(lufs)) return '−∞ LUFS';
  const sign = lufs > 0 ? '+' : lufs < 0 ? '−' : '';
  return `${sign}${Math.abs(lufs).toFixed(1)} LUFS`;
}

/** Clamp a number to [min, max]. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Linear ↔ dB conversion. */
export const linearToDb = (x: number): number =>
  x > 0 ? 20 * Math.log10(x) : Number.NEGATIVE_INFINITY;
export const dbToLinear = (db: number): number => 10 ** (db / 20);
