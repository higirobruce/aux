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

export { cn } from './lib/utils.js';
