# Contributing

## Before you propose a feature

Read **`docs/brainstorm.html` §19.1 — the no-list**. If the feature is on the
"permanent" list, decline with a link. If it's on the "v2+" list, file for
later. If it's neither, evaluate against §02 principles and §16 architecture.

## Pull requests

aux is **staging-first**: every change lands on `staging` before it reaches
`main`.

- Branch from `staging`, and target your PR at `staging` (not `main`).
- Open a draft PR early. Mark ready when CI passes.
- Title in imperative: `add eq-8 frequency curve`, not `added eq-8 ...`.
- Description should answer: what changes, why, and how to verify.
- Link the issue if there is one.
- `/ship` runs the gates and opens the draft PR into `staging` for you.

## Code review

- A reviewer responds within 24 hours.
- Reviews focus on: correctness, the no-list, architectural alignment, tests.
- Style is enforced by Biome — reviewers don't comment on formatting.

## Tests

Per `docs/implementation.html` §09 — the test pyramid:

- **Unit (Vitest)** for pure logic.
- **Integration** for API + DB.
- **E2E (Playwright)** for the five canonical UX flows.
- **Accessibility (`@axe-core/playwright`)** on every E2E test.
- **DSP** — golden outputs + property-based sweeps + latency assertions.

A PR that breaks any of these blocks merge. Add tests with the feature, not after.

## Commits

- Prefer one logical change per commit.
- Use imperative messages.
- Hooks run Biome on staged files — make sure they pass.
- Don't bypass hooks (`--no-verify`) unless you're rescuing a broken state and
  fixing it in the next commit.

## The ship gate (§16.07)

Performance is gated in CI by the audio render benchmark. Any PR that makes
it regress past the §16.07 threshold blocks merge. Run locally with:

```bash
pnpm --filter @aux/web test:perf
```

If your change is necessarily expensive, profile first, then justify the cost
in the PR description with numbers.
