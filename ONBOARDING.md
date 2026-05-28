# Onboarding

Welcome. This document is what to read on day one.

## In order

1. Read `docs/brainstorm.html` end-to-end. It defines what aux is, what it isn't
   (§19.1 — the no-list — is mandatory), and the seven architecture commitments
   in §16 that bind every later decision.
2. Read `docs/implementation.html` for the tech stack, the monorepo structure,
   the test pyramid (§09), and the week-one tasks (§16). The two HTML files
   reference each other; they're one document split for readability.
3. Read `CONTRIBUTING.md` for PR conventions.
4. Read this repo's `README.md` for setup.

## Your first PR

- Pick a task from the project tracker labeled `good-first`.
- Branch from `main`. Names like `<your-handle>/<short-description>`.
- Open a draft PR early. Mark ready when CI passes.
- A reviewer responds within 24 hours.

## The local dev loop

```bash
pnpm install
pnpm dev                     # everything at once
pnpm --filter @aux/web dev   # just the mixer
```

## What surprises new engineers

- **The audio worklet runs on its own thread.** `console.log` works but is
  expensive — prefer `port.postMessage` for telemetry. See
  `packages/audio-engine/src/worklet.ts`.
- **SharedArrayBuffer requires special headers.** Both `apps/web` and any
  hosting environment must set `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp`. The web app sets these in
  `next.config.mjs`.
- **The session document is parameter-addressed.** Don't reach into nested
  objects — go through `readAtom('trk_kick.volume')` / `writeAtom(...)`. The
  whole undo, diff, and (eventual) collab story depend on this.
- **No CRDT in v1.** Solo-mixer only. We left the door open in §16.06 — when
  collab returns in v2, Yjs slots in over the same atom paths.

## When in doubt

- The no-list (`docs/brainstorm.html` §19.1) answers most "can we also..." questions.
- The architecture commitments (`docs/brainstorm.html` §16) answer "how should I build this?"
- Ask the founder/lead in #engineering on Slack.
