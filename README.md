# aux

A web-based mixing &amp; mastering DAW for the engineer's chair.

> **Status:** v0.1 skeleton — monorepo + app shells + design system + audio
> worklet stub. Nothing user-facing yet. See `docs/implementation.html` §16
> for the week-one milestone this represents.

## Repository layout

```
aux/
├── apps/
│   ├── web/           Next.js 15 — the mixer ("/session/[id]")
│   ├── marketing/     Next.js 15 — landing + /playground
│   └── api/           NestJS 10 + Fastify — auth, sessions, signed URLs
├── packages/
│   ├── audio-engine/  AudioWorklet + host (TypeScript)
│   ├── design-system/ Tokens (CSS) + JS export
│   ├── ui/            shadcn-installed components + custom (knob, fader, meter)
│   ├── session-doc/   Session schema (Zod) + atom-path helpers
│   ├── db/            Prisma schema + generated client
│   ├── shared/        Cross-cutting utilities (formatters, math)
│   └── plugins/       Native DSP plugins (Rust → WASM) — placeholder
├── tooling/
│   └── tsconfig/      Shared TypeScript configs
├── docs/              brainstorm.html · implementation.html · LICENSE-NOTES.md
└── runbooks/          Operational SQL (revoke sessions, revoke share links)
```

## Quick start

```bash
# Install dependencies (one time, takes a few minutes).
pnpm install

# Run everything in dev.
pnpm dev

# Run a single app.
pnpm --filter @aux/web dev          # mixer at http://localhost:3000
pnpm --filter @aux/marketing dev    # landing at http://localhost:3001
pnpm --filter @aux/api dev          # api at http://localhost:4000
```

## Prerequisites

- **Node ≥ 22** (`.nvmrc` pins this)
- **pnpm ≥ 10** (`packageManager` pins the exact version)
- **PostgreSQL** for the API — provided by Neon in production; locally,
  either use Docker (`docker run -p 5432:5432 -e POSTGRES_PASSWORD=dev postgres:16`)
  or connect to a Neon dev branch via `DATABASE_URL` in `apps/api/.env`.
- **Rust + cargo + wasm-pack** — only needed to build the DSP plugins.
  See `packages/plugins/README.md`.

## Add a shadcn component

```bash
cd apps/web
pnpm dlx shadcn@latest add button
# Lands in packages/ui/src/components/button.tsx (per components.json).
```

## The docs

Two source-of-truth documents:

- **`docs/brainstorm.html`** — product vision, principles, wireframes, the
  interactive mockups (mixer, Smart EQ, Reference Rooms, Stem swap, Pre-flight),
  architecture commitments, decisions, sustainability triad.
- **`docs/implementation.html`** — tech stack, monorepo structure, CI/CD,
  observability, phases, team, cost, risks, week-one tasks, accessibility,
  security, presets, performance budgets.

Open them in any browser — no build step.

## Conventions

- **Formatter / linter:** Biome 1.9 (replaces ESLint + Prettier).
  `pnpm lint` runs the check; `pnpm lint:fix` fixes what it can.
- **Imports:** workspace packages use `@aux/*`. Always import from the
  package root unless you genuinely need a sub-path.
- **Commits:** the no-list lives in `docs/brainstorm.html` §19.1 — read it
  before proposing scope changes.

## License

Mixed — see [`docs/LICENSE-NOTES.md`](docs/LICENSE-NOTES.md). The mixer app is
MIT; the DSP plugins are AGPL-3.0-only.
