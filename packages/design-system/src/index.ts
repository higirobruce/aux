/**
 * @aux/design-system — tokens are CSS-only (see ./tokens.css).
 * This module re-exports type-level constants for consumers that
 * need to read tokens in JS (e.g., for canvas rendering).
 */

export const tokens = {
  color: {
    paper: '#EEF2F7',
    paper2: '#E3EAF3',
    paper3: '#D2DCE8',
    ink: '#16181D',
    ink2: '#353A43',
    ink3: '#626973',
    ink4: '#939AA5',
    azure: '#2E5FA8',
    azureSoft: '#C5D5EC',
    azureDeep: '#14355F',
    line: '#D3DCE7',
    lineStrong: '#B5C2D2',
    highlight: '#DCE7F5',
  },
  space: {
    1: 4,
    2: 8,
    3: 12,
    4: 16,
    5: 24,
    6: 32,
    7: 48,
    8: 64,
    9: 96,
  },
  radius: {
    1: 2,
    2: 4,
    3: 8,
  },
  font: {
    display: '"Tiempos", "Iowan Old Style", "Georgia", serif',
    sans: '"Söhne", "Inter", -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif',
    mono: '"JetBrains Mono", "SF Mono", "Menlo", monospace',
  },
} as const;

export type Tokens = typeof tokens;
