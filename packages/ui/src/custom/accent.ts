/**
 * Analog accent palette — maps semantic accent names to the warm-analog CSS
 * vars defined in @aux/design-system/tokens.css. Used by all primitives.
 */
export const ACCENT = {
  gold: 'var(--gold)',
  rust: 'var(--rust)',
  sage: 'var(--sage)',
  teal: 'var(--teal)',
  mauve: 'var(--mauve)',
  violet: 'var(--violet)',
  red: 'var(--red)',
  green: 'var(--green)',
  neutral: 'var(--txt-1)',
} as const;

export type Accent = keyof typeof ACCENT;

/** Low-alpha soft fill per accent (chip backgrounds). */
export const ACCENT_SOFT: Record<string, string> = {
  gold: 'var(--gold-a)',
  rust: 'var(--rust-a)',
  sage: 'var(--sage-a)',
  teal: 'var(--teal-a)',
  mauve: 'var(--mauve-a)',
  violet: 'var(--violet-a)',
  red: 'var(--red-a)',
};

export const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
