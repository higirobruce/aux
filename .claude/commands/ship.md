---
description: Run the aux merge gates, then open a draft PR into staging
argument-hint: "[PR title — optional; defaults to the branch's lead commit]"
allowed-tools: Bash(pnpm *), Bash(git *), Bash(gh *), Read
---

You are running the **aux ship gate** for Bruce. aux is **staging-first**: every
change lands on `staging` via PR before it ever reaches `main`. Follow these
steps in order and STOP at the first failure, reporting exactly what failed and
the relevant output — do not try to "fix and continue" unless asked.

## 1. Branch check
- `git branch --show-current` and `git status --short`.
- If the current branch is `staging` or `main`: **stop**. Tell Bruce to branch
  first (suggest a kebab-case name from his intended change) — never commit a
  feature directly onto `staging`/`main`.
- If the working tree has uncommitted changes, list them and ask whether to
  commit them as part of this ship. If yes, write a commit with an **imperative**
  message (one logical change; e.g. `add eq-8 frequency curve`). **Never** use
  `--no-verify` — the pre-commit hook runs Biome and must pass.

## 2. Gates (the things CI + §16.07 enforce)
Run from repo root, in this order; stop at the first failure:
1. `pnpm lint`        — Biome
2. `pnpm typecheck`
3. `pnpm test`        — unit/integration suite
4. `pnpm --filter @aux/web test:perf`  — the §16.07 audio render ship gate

If the perf gate regresses, report the `ms/block` number vs the gate and stop —
per CONTRIBUTING, an expensive change must be profiled and justified with numbers
in the PR body, not waved through.

## 3. Push + open the PR
Only if all gates are green:
- `git push -u origin <branch>` (current branch).
- Open a **draft** PR targeting **staging** (CONTRIBUTING: open a draft early,
  mark ready when CI passes):
  ```
  gh pr create --draft --base staging --title "<title>" --body "<body>"
  ```
- Title: use `$ARGUMENTS` if provided; otherwise derive an imperative title from
  the lead commit. Reject past-tense titles ("added …") — rewrite to imperative.
- Body must answer the three CONTRIBUTING questions, plus the gate result:
  ```
  ## What
  <one-paragraph summary of the change>

  ## Why
  <motivation; link the issue if there is one>

  ## How to verify
  <concrete steps a reviewer runs>

  ## Gates
  - lint ✓ · typecheck ✓ · test ✓
  - §16.07 render: <ms/block> (gate 0.400 ms) ✓
  ```

## 4. Report
Print the PR URL and a one-line summary of gate results. Remind Bruce it's a
**draft** — mark ready once CI is green. Do not merge.
