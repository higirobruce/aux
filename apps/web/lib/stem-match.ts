/**
 * Stem-swap matcher.
 *
 * Per brainstorm §05b: when new audio arrives for a session that already has
 * stems, score each (existing stem, new file) pair by name similarity and
 * length proximity, then pick the best non-conflicting assignment.
 *
 * Three signals from the brainstorm:
 *   - name similarity (with track-role aliases — kick = kk = BD)
 *   - length proximity (100 ms = strong, ~5 s = none)
 *   - spectral fingerprint  ← deferred to v0.3 (needs the WASM FFT)
 *
 * For v0.2 only name + length carry weight, weighted 0.6 / 0.4. The
 * brainstorm's three confidence buckets:
 *   ≥ 0.85 → auto-suggested as a swap (green)
 *   ≥ 0.60 → uncertain, engineer picks (yellow)
 *   <  0.60 → no plausible match — treated as a new stem  (red)
 */

import type { Stem } from './types';

export const MATCH_AUTO = 0.85;
export const MATCH_UNCERTAIN = 0.6;

export type MatchConfidence = 'matched' | 'uncertain' | 'unmatched';

export interface FileMetadata {
  /** The original File object — used later for upload. */
  file: File;
  /** Decoded audio length in ms (via apps/web/lib/audio-metadata.ts). */
  lengthMs: number;
}

export interface StemMatch {
  file: File;
  fileLengthMs: number;
  /** null when no existing stem scored >= MATCH_UNCERTAIN. */
  bestStem: Stem | null;
  /** Total score 0..1; 0 when bestStem is null. */
  score: number;
  /** Convenience derived from `score`. */
  confidence: MatchConfidence;
  /** Alternative stems if the user wants to override. Sorted, includes the
   *  best one. Empty array when nothing in the session scored >= MATCH_UNCERTAIN. */
  candidates: Array<{ stem: Stem; score: number }>;
}

// ──────────────────────────────────────────────────────────────────────────
// Role aliases — name normalization
// ──────────────────────────────────────────────────────────────────────────

/**
 * Each role has a canonical label and a set of aliases that should all
 * score as the same role. Aliases are matched as whole tokens (after
 * stripping separators) — substring matching would false-positive on
 * names like "kick_in_room" (room overhead, not kick).
 */
const ROLE_ALIASES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['kick', ['kick', 'kk', 'bd', 'bassdrum']],
  ['snare', ['snare', 'sn', 'sd', 'snr', 'snaretop', 'snarebtm', 'snarebot']],
  ['hat', ['hat', 'hh', 'hihat', 'hats']],
  ['tom', ['tom', 'tm', 'toms']],
  ['oh', ['oh', 'overhead', 'overheads', 'ohl', 'ohr']],
  ['room', ['room', 'rm']],
  ['bass', ['bass', 'sub', 'bs', 'bassdi', 'bassamp']],
  ['vox', ['vox', 'vocal', 'vocals', 'lead', 'bgv', 'harm', 'harmony']],
  ['fx', ['fx', 'riser', 'impact', 'swell', 'sweep']],
];

function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .replace(/\.[^.]+$/, '') // strip extension
    .replace(/[_\-.\s]+/g, ' ') // unify separators
    .trim();
}

function tokens(name: string): string[] {
  return normalizeName(name).split(' ').filter(Boolean);
}

function detectRole(name: string): string | null {
  const t = tokens(name);
  for (const [role, aliases] of ROLE_ALIASES) {
    for (const tok of t) {
      // Exact-token match OR strip trailing digits/letters (kick1, bd2)
      const stripped = tok.replace(/[0-9]+$/, '');
      if (aliases.includes(tok) || aliases.includes(stripped)) return role;
    }
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────────────
// Scoring
// ──────────────────────────────────────────────────────────────────────────

/**
 * Levenshtein with normalized cost — 1 = identical, 0 = max different.
 *
 * Flat Uint16Array DP table indexed as i*W+j; TypedArray reads return number
 * (not number | undefined) so the inner loop stays free of non-null asserts.
 * Fine for ≤ 100-char filenames; cost ceiling 65 535 is comfortably above
 * realistic edit distances here.
 */
function editSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  const max = Math.max(a.length, b.length);
  const W = b.length + 1;
  const dp = new Uint16Array((a.length + 1) * W);
  for (let i = 0; i <= a.length; i++) dp[i * W] = i;
  for (let j = 0; j <= b.length; j++) dp[j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      // ?? 0 is for TS's noUncheckedIndexedAccess — Uint16Array reads are
      // guaranteed defined, but TS treats them like a sparse array.
      const up = dp[(i - 1) * W + j] ?? 0;
      const left = dp[i * W + (j - 1)] ?? 0;
      const diag = dp[(i - 1) * W + (j - 1)] ?? 0;
      dp[i * W + j] = Math.min(up + 1, left + 1, diag + cost);
    }
  }
  return 1 - (dp[a.length * W + b.length] ?? max) / max;
}

export function nameScore(oldName: string, newName: string): number {
  const a = normalizeName(oldName);
  const b = normalizeName(newName);
  if (!a || !b) return 0;

  // Token-level Jaccard — gives partial credit for "kick" matching "kick_v2".
  const tokA = new Set(tokens(a));
  const tokB = new Set(tokens(b));
  let common = 0;
  for (const t of tokA) if (tokB.has(t)) common++;
  const jaccard = tokA.size + tokB.size > 0 ? common / new Set([...tokA, ...tokB]).size : 0;

  // Edit-distance on the whole normalized strings — catches "vox_lead" vs
  // "vox_lead_v2" where Jaccard already gives high partial credit.
  const edit = editSimilarity(a, b);

  // Role match — strong bonus if both names parse to the same role. Misses
  // cancel each other out (different roles → 0 bonus, not negative penalty).
  const roleA = detectRole(a);
  const roleB = detectRole(b);
  const roleBonus = roleA && roleA === roleB ? 0.35 : 0;

  return Math.min(1, jaccard * 0.4 + edit * 0.4 + roleBonus);
}

export function lengthScore(oldMs: number, newMs: number): number {
  const diff = Math.abs(oldMs - newMs);
  if (diff <= 100) return 1;
  if (diff >= 5000) return 0;
  // Smooth fall-off from 1 → 0 over the [100ms, 5000ms] window.
  return 1 - (diff - 100) / 4900;
}

export function pairScore(stem: Stem, file: FileMetadata): number {
  const ns = nameScore(stem.name, file.file.name);
  const ls = lengthScore(stem.lengthMs, file.lengthMs);
  // Name carries more — length alone is too coincidental (lots of stems are
  // about the same length within a session).
  return ns * 0.6 + ls * 0.4;
}

function bucket(score: number): MatchConfidence {
  if (score >= MATCH_AUTO) return 'matched';
  if (score >= MATCH_UNCERTAIN) return 'uncertain';
  return 'unmatched';
}

// ──────────────────────────────────────────────────────────────────────────
// Assignment
// ──────────────────────────────────────────────────────────────────────────

/**
 * Greedy bipartite assignment.
 *
 *  - Score every (existing stem × new file) pair.
 *  - Sort all pairs by score descending.
 *  - Walk the sorted list; assign a pair only if neither side is already
 *    taken AND the score is ≥ MATCH_UNCERTAIN.
 *  - Anything left unassigned becomes a 'unmatched' file (best-guess
 *    candidate kept as a hint, so the UI can still propose it).
 *
 * Not optimal in the Kuhn-Munkres sense, but adequate at v0.2 stem counts
 * (≤ 50). Returns one entry per dropped file, preserving input order.
 */
export function matchStems(stems: Stem[], files: FileMetadata[]): StemMatch[] {
  if (files.length === 0) return [];
  if (stems.length === 0) {
    return files.map((f) => ({
      file: f.file,
      fileLengthMs: f.lengthMs,
      bestStem: null,
      score: 0,
      confidence: 'unmatched',
      candidates: [],
    }));
  }

  // 1. Score every pair.
  type Pair = { fi: number; si: number; score: number };
  const pairs: Pair[] = [];
  for (let fi = 0; fi < files.length; fi++) {
    const f = files[fi];
    if (!f) continue;
    for (let si = 0; si < stems.length; si++) {
      const s = stems[si];
      if (!s) continue;
      pairs.push({ fi, si, score: pairScore(s, f) });
    }
  }
  pairs.sort((a, b) => b.score - a.score);

  // 2. Greedy non-conflicting assignment.
  const fileTaken = new Array<boolean>(files.length).fill(false);
  const stemTaken = new Array<boolean>(stems.length).fill(false);
  const assignment = new Array<Pair | null>(files.length).fill(null);
  for (const p of pairs) {
    if (p.score < MATCH_UNCERTAIN) break; // anything below threshold isn't a match
    if (fileTaken[p.fi] || stemTaken[p.si]) continue;
    fileTaken[p.fi] = true;
    stemTaken[p.si] = true;
    assignment[p.fi] = p;
  }

  // 3. Build result rows in original file order, with candidates for each.
  return files.map((f, fi) => {
    const candidates = stems
      .map((stem, si) => ({ stem, score: pairScore(stem, f) }))
      .filter((c) => c.score >= MATCH_UNCERTAIN)
      .sort((a, b) => b.score - a.score);
    const a = assignment[fi];
    return {
      file: f.file,
      fileLengthMs: f.lengthMs,
      bestStem: a ? (stems[a.si] ?? null) : null,
      score: a?.score ?? 0,
      confidence: a ? bucket(a.score) : 'unmatched',
      candidates,
    };
  });
}
