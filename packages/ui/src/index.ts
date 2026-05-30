/**
 * @aux/ui — base UI components (shadcn-installed) + custom domain components.
 *
 * Base components live in src/components/ and are installed via:
 *   pnpm dlx shadcn add <name>   (run from apps/web, target packages/ui)
 *
 * Custom mixer components (knob, fader, meter, channel strip) live in src/custom/.
 *
 * Per docs/implementation.html §02 — shadcn covers off-the-shelf UI; we hand-build
 * the mockup-island components where the product's identity lives.
 */

export { cn } from './lib/utils';
export { Button, buttonVariants, type ButtonProps } from './components/button';
export { Input, type InputProps } from './components/input';
export { Label, type LabelProps } from './components/label';

// Warm-analog primitive kit (custom mixer/plugin components).
export { type Accent, ACCENT, ACCENT_SOFT, clamp, lerp } from './custom/accent';
export { useDrag } from './custom/use-drag';
export { Knob } from './custom/knob';
export { Fader } from './custom/fader';
export { Toggle } from './custom/toggle';
export { Segmented } from './custom/segmented';
export { Readout } from './custom/readout';
export { Meter } from './custom/meter';
export { Spectrum } from './custom/spectrum';
export { WindowFrame } from './custom/window-frame';
export { Module } from './custom/module';
