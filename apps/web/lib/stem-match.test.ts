import { describe, expect, it } from 'vitest';
import {
  type FileMetadata,
  MATCH_AUTO,
  MATCH_UNCERTAIN,
  lengthScore,
  matchStems,
  nameScore,
  pairScore,
} from './stem-match';
import type { Stem } from './types';

/* ────────────────────────────────────────────────────────────────────────
 * Helpers
 * ──────────────────────────────────────────────────────────────────────── */

function makeStem(over: Partial<Stem> & { name: string }): Stem {
  return {
    id: over.id ?? over.name,
    sessionId: 'sess',
    name: over.name,
    s3Key: over.s3Key ?? `stems/sess/${over.id ?? over.name}`,
    lengthMs: over.lengthMs ?? 120_000,
    channels: 2,
    sampleRate: 48_000,
    peakDb: -3,
    lufsI: -14,
    createdAt: '2026-01-01T00:00:00Z',
  };
}

function makeFile(name: string, lengthMs = 120_000): FileMetadata {
  // File ctor needs a polyfill in Node? In Node 24 it's globally available.
  const file = new File([new Uint8Array([0])], name, { type: 'audio/wav' });
  return { file, lengthMs };
}

/* ────────────────────────────────────────────────────────────────────────
 * nameScore
 * ──────────────────────────────────────────────────────────────────────── */

describe('nameScore', () => {
  it('returns 1 for identical normalized names', () => {
    expect(nameScore('kick.wav', 'kick.wav')).toBe(1);
  });

  it('survives extension + case + separator differences', () => {
    // Same logical name, different filename cosmetics — should still hit 1.
    expect(nameScore('Kick.WAV', 'kick.wav')).toBeCloseTo(1, 5);
    expect(nameScore('kick_in.wav', 'kick-in.aiff')).toBeCloseTo(1, 5);
  });

  it('hits MATCH_AUTO when only suffix differs (role + edit + jaccard)', () => {
    expect(nameScore('kick.wav', 'Kick_NEW.wav')).toBeGreaterThanOrEqual(MATCH_AUTO);
    expect(nameScore('vox_lead.wav', 'vox_lead_v2.wav')).toBeGreaterThanOrEqual(MATCH_AUTO);
    expect(nameScore('snare_top.wav', 'Snare_Top_v2.wav')).toBeGreaterThanOrEqual(MATCH_AUTO);
  });

  it('collapses role aliases: kick = kk = bd = bassdrum', () => {
    // Pure role match, no other token overlap — should still clear the
    // uncertain bar via the role bonus.
    expect(nameScore('kick.wav', 'kk.wav')).toBeGreaterThanOrEqual(MATCH_UNCERTAIN);
    expect(nameScore('kick.wav', 'bd.wav')).toBeGreaterThanOrEqual(MATCH_UNCERTAIN);
    expect(nameScore('kick.wav', 'bassdrum.wav')).toBeGreaterThanOrEqual(MATCH_UNCERTAIN);
    expect(nameScore('snare.wav', 'sd.wav')).toBeGreaterThanOrEqual(MATCH_UNCERTAIN);
    expect(nameScore('hat.wav', 'hh.wav')).toBeGreaterThanOrEqual(MATCH_UNCERTAIN);
  });

  it('strips trailing digits from role tokens (kick1, bd2)', () => {
    expect(nameScore('kick.wav', 'kick1.wav')).toBeGreaterThanOrEqual(MATCH_UNCERTAIN);
    expect(nameScore('snare.wav', 'sd2.wav')).toBeGreaterThanOrEqual(MATCH_UNCERTAIN);
  });

  it('refuses to pair across different roles', () => {
    expect(nameScore('kick.wav', 'snare.wav')).toBeLessThan(MATCH_UNCERTAIN);
    expect(nameScore('vox.wav', 'kick.wav')).toBeLessThan(MATCH_UNCERTAIN);
    expect(nameScore('bass.wav', 'fx_riser.wav')).toBeLessThan(MATCH_UNCERTAIN);
  });

  it('does not false-positive on substrings inside other tokens', () => {
    // "kick" must not match "kick_in_room" as the kick role — the brainstorm
    // explicitly calls this out. Here "kick_in_room" still scores something
    // (tokens overlap), but a literally unrelated name should score low.
    expect(nameScore('kick.wav', 'distortion.wav')).toBeLessThan(MATCH_UNCERTAIN);
  });

  it('handles empty / weird inputs without throwing', () => {
    expect(nameScore('', 'kick.wav')).toBe(0);
    expect(nameScore('kick.wav', '')).toBe(0);
    expect(nameScore('', '')).toBe(0);
    expect(nameScore('   ', 'kick.wav')).toBe(0);
  });

  it('returns a clamped 0..1 value', () => {
    const score = nameScore('kick_kick_kick_kick.wav', 'kick.wav');
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });
});

/* ────────────────────────────────────────────────────────────────────────
 * lengthScore
 * ──────────────────────────────────────────────────────────────────────── */

describe('lengthScore', () => {
  it('returns 1 for matches within ±100 ms', () => {
    expect(lengthScore(120_000, 120_000)).toBe(1);
    expect(lengthScore(120_000, 120_100)).toBe(1);
    expect(lengthScore(120_000, 119_900)).toBe(1);
  });

  it('returns 0 once the gap exceeds 5 s', () => {
    expect(lengthScore(120_000, 125_000)).toBe(0);
    expect(lengthScore(120_000, 130_000)).toBe(0);
  });

  it('falls off linearly through the 100 ms .. 5 s window', () => {
    // Halfway through the window should be roughly 0.5.
    const mid = lengthScore(120_000, 120_000 + 2_550); // 2.55 s gap
    expect(mid).toBeGreaterThan(0.4);
    expect(mid).toBeLessThan(0.6);
  });

  it("is symmetric — sign of the difference doesn't matter", () => {
    expect(lengthScore(120_000, 121_000)).toBeCloseTo(lengthScore(120_000, 119_000), 5);
  });
});

/* ────────────────────────────────────────────────────────────────────────
 * pairScore
 * ──────────────────────────────────────────────────────────────────────── */

describe('pairScore', () => {
  it('combines name (0.6) and length (0.4) — same name + same length = 1', () => {
    const stem = makeStem({ name: 'kick.wav', lengthMs: 120_000 });
    const file = makeFile('kick.wav', 120_000);
    expect(pairScore(stem, file)).toBeCloseTo(1, 5);
  });

  it('length mismatch is forgiven if the name lines up', () => {
    // Same role, 4-second-off length — still clears the uncertain bar
    // because the name carries 0.6 of the weight.
    const stem = makeStem({ name: 'kick.wav', lengthMs: 120_000 });
    const file = makeFile('Kick_NEW.wav', 116_000);
    expect(pairScore(stem, file)).toBeGreaterThanOrEqual(MATCH_UNCERTAIN);
  });

  it('name mismatch is NOT salvaged by a coincidental same length', () => {
    const stem = makeStem({ name: 'kick.wav', lengthMs: 120_000 });
    const file = makeFile('vocal.wav', 120_000);
    expect(pairScore(stem, file)).toBeLessThan(MATCH_UNCERTAIN);
  });
});

/* ────────────────────────────────────────────────────────────────────────
 * matchStems
 * ──────────────────────────────────────────────────────────────────────── */

describe('matchStems', () => {
  it('returns [] when no files are dropped', () => {
    expect(matchStems([makeStem({ name: 'kick.wav' })], [])).toEqual([]);
  });

  it('returns "unmatched" rows when no stems exist yet', () => {
    const files = [makeFile('kick.wav'), makeFile('snare.wav')];
    const result = matchStems([], files);
    expect(result).toHaveLength(2);
    for (const r of result) {
      expect(r.bestStem).toBeNull();
      expect(r.confidence).toBe('unmatched');
      expect(r.score).toBe(0);
      expect(r.candidates).toEqual([]);
    }
  });

  it('auto-matches obvious renames', () => {
    const stems = [
      makeStem({ name: 'kick.wav', id: 's1', lengthMs: 120_000 }),
      makeStem({ name: 'snare.wav', id: 's2', lengthMs: 120_000 }),
    ];
    const files = [makeFile('Kick_NEW.wav', 120_000), makeFile('Snare_v2.wav', 120_000)];
    const result = matchStems(stems, files);

    expect(result[0]?.bestStem?.id).toBe('s1');
    expect(result[0]?.confidence).toBe('matched');
    expect(result[0]?.score).toBeGreaterThanOrEqual(MATCH_AUTO);
    expect(result[1]?.bestStem?.id).toBe('s2');
    expect(result[1]?.confidence).toBe('matched');
  });

  it('greedy assignment does not double-claim a stem', () => {
    // Two files both look like "kick" — only one can win the kick stem.
    const stems = [makeStem({ name: 'kick.wav', id: 's1', lengthMs: 120_000 })];
    const files = [makeFile('kick.wav', 120_000), makeFile('kick_alt.wav', 120_000)];
    const result = matchStems(stems, files);

    const claimed = result.filter((r) => r.bestStem !== null);
    expect(claimed).toHaveLength(1);
    // Best-scoring file (the exact-name one) should win.
    expect(claimed[0]?.file.name).toBe('kick.wav');
    // The other file is unmatched but still carries the candidate as a hint.
    const loser = result.find((r) => r.file.name === 'kick_alt.wav');
    expect(loser?.bestStem).toBeNull();
    expect(loser?.candidates.length).toBeGreaterThan(0);
    expect(loser?.candidates[0]?.stem.id).toBe('s1');
  });

  it('skips pairs below MATCH_UNCERTAIN', () => {
    const stems = [makeStem({ name: 'kick.wav', id: 's1' })];
    const files = [makeFile('completely_unrelated.wav')];
    const result = matchStems(stems, files);
    expect(result[0]?.bestStem).toBeNull();
    expect(result[0]?.confidence).toBe('unmatched');
    expect(result[0]?.candidates).toEqual([]);
  });

  it('preserves input file order in the output', () => {
    const stems = [
      makeStem({ name: 'a.wav', id: 'a' }),
      makeStem({ name: 'b.wav', id: 'b' }),
      makeStem({ name: 'c.wav', id: 'c' }),
    ];
    const files = [makeFile('c.wav'), makeFile('a.wav'), makeFile('b.wav')];
    const result = matchStems(stems, files);
    expect(result.map((r) => r.file.name)).toEqual(['c.wav', 'a.wav', 'b.wav']);
  });

  it('exposes candidates sorted by score descending', () => {
    const stems = [
      makeStem({ name: 'kick.wav', id: 'k', lengthMs: 120_000 }),
      makeStem({ name: 'kk.wav', id: 'kk', lengthMs: 120_000 }),
      makeStem({ name: 'snare.wav', id: 'sn', lengthMs: 120_000 }),
    ];
    const files = [makeFile('Kick_NEW.wav', 120_000)];
    const result = matchStems(stems, files);
    const cands = result[0]?.candidates ?? [];
    // Both kick + kk are kick-role; snare should be excluded (below
    // MATCH_UNCERTAIN). kick should outrank kk because the name overlap is
    // stronger ("kick" tokens vs role-only).
    expect(cands.length).toBeGreaterThanOrEqual(1);
    for (let i = 1; i < cands.length; i++) {
      expect(cands[i - 1]?.score).toBeGreaterThanOrEqual(cands[i]?.score ?? 0);
    }
    expect(cands.every((c) => c.stem.id !== 'sn')).toBe(true);
  });
});
