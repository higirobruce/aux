---
description: Update docs/progress.html — the living v0.3 phase tracker — from staging
argument-hint: "[optional note about what just landed]"
allowed-tools: Bash(git *), Read, Edit
---

You maintain **`docs/progress.html`**, aux's living phase tracker. It is a
hand-authored, styled HTML doc — **edit it semantically, preserve the existing
markup, classes, and voice.** Never reformat or restyle; only update content
that has gone stale since the last snapshot.

## 1. Find what's new
- `git log --oneline origin/staging -30` (the commit log section is sourced from
  **staging**, newest-first).
- Read `docs/progress.html` and locate the `.commitlog` block (section `04`).
  The top entry there is the last recorded slice. Everything in `git log` above
  it is unrecorded.

## 2. Update, in place
Touch only what changed:

- **Snapshot date** — the `.eyebrow` near the top (`aux · progress snapshot · <date>`)
  and the footer caption. Set to today.
- **Commit log** (section `04`) — prepend the new slices at the **top** of
  `.commitlog`, newest first, matching the exact span markup:
  ```html
  <span class="sha">SHORTSHA</span> <span class="v03">v0.3</span> <span class="msg">MESSAGE</span>
  ```
  Drop the `v03` span for commits that aren't part of the v0.3 phase (match how
  existing non-v0.3 rows are written).
- **Scope tracker** (section `01`) — if a landed slice changes a line item's
  status, update its `.pill-st` (`pill-shipped` / `pill-flight` / `pill-planned`
  / `pill-next`) and the Notes cell. Keep counts honest (e.g. the "N of 13"
  plugins pill).
- **Plugin suite** (section `02`) — if a DSP module shipped, reflect it there too.
- **Phase strip** — only if the overall phase status actually changed.

If `$ARGUMENTS` is given, use it as context for what landed, but still verify
against `git log` — don't record something that isn't committed.

## 3. Report
Summarize what you changed (which sections, which slices added, any status
flips). Do **not** commit — leave the edited file for Bruce to review and ship
via `/ship`.
