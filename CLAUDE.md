# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What aux is

A web-based mixing & mastering DAW "for the engineer's chair." Currently in the
**v0.3** phase. Two HTML files are the source of truth and reference each other —
read them before making product or architecture decisions:

- **`docs/brainstorm.html`** — vision, principles, wireframes, the **§16
  architecture commitments** (seven, binding), and **§19.1 — the no-list**
  (what aux will never do; mandatory reading before proposing scope).
- **`docs/implementation.html`** — tech stack, test pyramid (§09), performance
  budgets (§16.07), phases.
- **`docs/progress.html`** — the living v0.3 phase tracker (kept current via `/progress`).

## Common commands

Monorepo driven by **turbo** + **pnpm** (Node ≥ 22, pnpm ≥ 10, both pinned).

```bash
pnpm dev                          # run every app in dev
pnpm --filter @aux/web dev        # mixer only        → http://localhost:3100
pnpm --filter @aux/marketing dev  # landing           → http://localhost:3101
pnpm --filter @aux/api dev        # API (NestJS)      → http://localhost:4000

pnpm lint        # Biome 1.9 (replaces ESLint+Prettier); lint:fix to autofix
pnpm typecheck   # tsc --noEmit across the workspace
pnpm test        # Vitest across the workspace
pnpm build       # turbo build
```

Single test / focused runs (Vitest):

```bash
pnpm --filter @aux/web test stem-match           # one file by name fragment
pnpm --filter @aux/session-doc test -t "writeAtom"  # by test-name pattern
```

DSP crates (Rust → WASM) — each `packages/dsp-*` builds the same way:

```bash
pnpm --filter @aux/dsp-tape build      # wasm-pack → packages/dsp-tape/wasm/
pnpm --filter @aux/dsp-tape test:rust  # cargo test --release
```

Requires `rust` + `cargo` + `wasm-pack`. Generated `wasm/` output is committed
and Biome-ignored. The `--target web` bundles need COOP/COEP headers to load
(see gotchas below).

Performance gate (§16.07) — blocks merge if the audio render regresses:

```bash
pnpm --filter @aux/web test:perf
```

Local infra (Postgres / Redis / MinIO) is available via `docker-compose.yml`.
The API needs `DATABASE_URL`; `pnpm --filter @aux/db generate` regenerates the
Prisma client.

## Workflow commands

aux is **staging-first**: every change lands on `staging` via PR before it
reaches `main`. Branch from `staging`, target PRs at `staging`. Never commit a
feature directly onto `staging` or `main`, and never bypass the pre-commit hook
with `--no-verify`. Custom slash commands (defined in `.claude/commands/`):

- **`/ship`** — runs the merge gates (`lint` → `typecheck` → `test` →
  `test:perf`), then opens a **draft PR into `staging`** with a templated body.
  Reach for it when a change is complete and the gates should pass.
- **`/progress`** — updates `docs/progress.html` from `git log` on `staging`,
  preserving its hand-authored markup. Run after a slice lands.

## Architecture — the big picture

### Audio runs across two threads
The engine (`packages/audio-engine`) splits along the Web Audio thread boundary,
and this split shapes most engine code:

- **Main thread** — `src/host.ts` exports `AudioHost`, which builds and owns the
  Web Audio graph: `source → channel.gain → channel.panner → (×N) → masterGain →
  workletNode → destination`. The **graph topology is stable for the host's
  lifetime**; only `AudioBufferSourceNode`s come and go per `play()`.
- **Worklet thread** — `src/worklet.ts` is the real-time DSP `process()` loop.
  It runs off-main-thread: `console.log` works but is expensive — prefer
  `port.postMessage` for telemetry.

### DSP plugins are Rust → WASM → worklet
Each effect is a Rust crate in `packages/dsp-*` (members of the root
`Cargo.toml` workspace) compiled to WASM via `wasm-pack --target web`. The host
fetches a plugin's `*_bg.wasm` once and clones it into per-channel/per-bus
worklet instances (see the `*WorkletUrl` / `*WasmUrl` options on
`AudioHostOptions`). Adding a plugin = new crate + register it in the root
`Cargo.toml` members. DSP code is **AGPL-3.0-only**; the rest of the app is MIT
(see `docs/LICENSE-NOTES.md`) — keep the boundary clean.

### The session document is parameter-addressed
`packages/session-doc` defines the session schema (Zod) and **atom-path
helpers**. Do not mutate nested session objects directly — go through
`readAtom(doc, 'tracks.trk_kick.params.volume.value')` and the immutable
`writeAtom(doc, path, value)` (returns the next doc). Undo, diff (`diffAtoms`),
and the eventual collab story all depend on this addressing.

`MixState` (`packages/session-doc/src/mix-state.ts`) is **versioned**
(`MIX_STATE_VERSION`); persisted sessions are migrated on load. When you change
the mix-state shape, bump the version and add the migration — don't silently
break hydration.

No CRDT in v1 (solo-mixer only); §16.06 leaves the door open for Yjs over the
same atom paths in v2.

### Apps & packages
- `apps/web` (Next.js 15) — the mixer at `/session/[id]`.
- `apps/marketing` (Next.js 15) — landing + `/playground`.
- `apps/api` (NestJS 10 + Fastify) — auth, sessions, signed URLs; Prisma → Postgres.
- `packages/ui` — shadcn components + custom audio controls (knob, fader, meter).
  Add components via `cd apps/web && pnpm dlx shadcn@latest add <name>` — they
  land in `packages/ui` per `components.json`.
- `packages/design-system`, `packages/shared`, `packages/db`.

Workspace imports use `@aux/*`; import from the package root unless a sub-path
is genuinely required.

## Gotchas

- **SharedArrayBuffer needs cross-origin isolation.** `apps/web` sets
  `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy:
  require-corp` in `next.config.mjs`; any host must too, or the worklet WASM
  won't load.
- **Commit titles are imperative** (`add eq-8 frequency curve`, not "added …").
  One logical change per commit. The pre-commit hook runs Biome on staged files.
- **Tests gate merge.** Per CONTRIBUTING + the §09 pyramid (unit / integration /
  E2E + axe a11y / DSP golden+property+latency) and the §16.07 perf gate — add
  tests with the feature, not after.
