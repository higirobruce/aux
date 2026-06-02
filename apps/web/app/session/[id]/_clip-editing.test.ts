import type { StemClip } from '@aux/session-doc';
import { describe, expect, it } from 'vitest';
import {
  clipEnd,
  duplicateClip,
  materialise,
  moveClip,
  pasteClips,
  rippleDelete,
  setClipGain,
  setFadeIn,
  setFadeOut,
  snap,
  snapTargets,
  splitClipsAt,
  trimIn,
  trimOut,
} from './_clip-editing';

const TOTAL = 480_000; // 10 s @ 48k
const NO_SNAP = { targets: [] as number[], threshold: 0 };

function clip(over: Partial<StemClip> = {}): StemClip {
  return {
    id: 'c1',
    sourceIn: 0,
    sourceOut: TOTAL,
    timelineStart: 0,
    gainDb: 0,
    fadeInSamples: 0,
    fadeOutSamples: 0,
    ...over,
  };
}

describe('materialise', () => {
  it('turns empty clips into one whole-buffer clip', () => {
    const m = materialise([], TOTAL);
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ sourceIn: 0, sourceOut: TOTAL, timelineStart: 0 });
  });
});

describe('splitClipsAt', () => {
  it('splits the implicit whole-buffer clip at the playhead', () => {
    const out = splitClipsAt([], TOTAL, 120_000);
    expect(out).toHaveLength(2);
    const [first, second] = out;
    if (!first || !second) throw new Error('expected two clips');
    expect(first).toMatchObject({ sourceIn: 0, sourceOut: 120_000, timelineStart: 0 });
    expect(second).toMatchObject({ sourceIn: 120_000, sourceOut: TOTAL, timelineStart: 120_000 });
    // Adjacent on the timeline — no gap, no overlap.
    expect(clipEnd(first)).toBe(second.timelineStart);
  });

  it('splits only the clip under the playhead', () => {
    const a = clip({ id: 'a', sourceOut: 100_000, timelineStart: 0 }); // [0,100k)
    const b = clip({ id: 'b', sourceIn: 100_000, sourceOut: 200_000, timelineStart: 100_000 });
    const out = splitClipsAt([a, b], TOTAL, 150_000);
    expect(out).toHaveLength(3); // a untouched, b split
    expect(out[0]?.id).toBe('a');
  });

  it('does not split on a boundary (no-op beyond materialise)', () => {
    const out = splitClipsAt([clip()], TOTAL, 0);
    expect(out).toHaveLength(1);
  });
});

describe('snap', () => {
  it('snaps to the nearest target within threshold', () => {
    expect(snap(102, [100, 500], 5)).toBe(100);
  });
  it('leaves the value alone outside threshold', () => {
    expect(snap(120, [100, 500], 5)).toBe(120);
  });
});

describe('snapTargets', () => {
  it('includes zero, the playhead, and sibling edges (not the dragged clip)', () => {
    const a = clip({ id: 'a', sourceOut: 100_000, timelineStart: 50_000 }); // [50k,150k)
    const dragged = clip({ id: 'd' });
    const targets = snapTargets([a, dragged], 'd', 999);
    expect(targets).toContain(0);
    expect(targets).toContain(999); // playhead
    expect(targets).toContain(50_000); // a.start
    expect(targets).toContain(150_000); // a.end
  });
});

describe('moveClip', () => {
  it('shifts timelineStart and clamps to >= 0', () => {
    expect(
      moveClip(clip({ timelineStart: 1000 }), 500, NO_SNAP.targets, NO_SNAP.threshold).timelineStart
    ).toBe(1500);
    expect(
      moveClip(clip({ timelineStart: 100 }), -9999, NO_SNAP.targets, NO_SNAP.threshold)
        .timelineStart
    ).toBe(0);
  });
  it('leaves the source window unchanged', () => {
    const m = moveClip(clip({ sourceIn: 10, sourceOut: 20 }), 500, [], 0);
    expect(m.sourceIn).toBe(10);
    expect(m.sourceOut).toBe(20);
  });
});

describe('trimIn', () => {
  it('moves sourceIn and timelineStart together (audio stays anchored)', () => {
    const c = clip({ sourceIn: 0, sourceOut: 1000, timelineStart: 500 });
    const t = trimIn(c, 200, [], 0);
    expect(t.sourceIn).toBe(200);
    expect(t.timelineStart).toBe(700);
    expect(t.sourceOut).toBe(1000);
  });
  it('clamps so the clip keeps >= 1 sample', () => {
    const c = clip({ sourceIn: 0, sourceOut: 1000, timelineStart: 0 });
    const t = trimIn(c, 99_999, [], 0);
    expect(t.sourceIn).toBe(999);
  });
});

describe('trimOut', () => {
  it('moves sourceOut only', () => {
    const c = clip({ sourceIn: 0, sourceOut: 1000, timelineStart: 500 });
    const t = trimOut(c, -300, TOTAL, [], 0);
    expect(t.sourceOut).toBe(700);
    expect(t.sourceIn).toBe(0);
    expect(t.timelineStart).toBe(500);
  });
  it('clamps to the buffer length', () => {
    const c = clip({ sourceIn: 0, sourceOut: 1000, timelineStart: 0 });
    const t = trimOut(c, 9_999_999, TOTAL, [], 0);
    expect(t.sourceOut).toBe(TOTAL);
  });
  it('re-clamps a fade longer than the trimmed length', () => {
    const c = clip({ sourceIn: 0, sourceOut: 1000, timelineStart: 0, fadeOutSamples: 800 });
    const t = trimOut(c, -600, TOTAL, [], 0); // length 1000 → 400
    expect(t.sourceOut).toBe(400);
    expect(t.fadeOutSamples).toBeLessThanOrEqual(400);
  });
});

describe('fades', () => {
  it('setFadeIn grows the fade, clamped against the fade-out', () => {
    const c = clip({ sourceIn: 0, sourceOut: 1000, timelineStart: 0, fadeOutSamples: 300 });
    expect(setFadeIn(c, 200).fadeInSamples).toBe(200);
    expect(setFadeIn(c, -50).fadeInSamples).toBe(0); // can't go negative
    expect(setFadeIn(c, 5000).fadeInSamples).toBe(700); // capped at length − fadeOut
  });
  it('setFadeOut is symmetric', () => {
    const c = clip({ sourceIn: 0, sourceOut: 1000, timelineStart: 0, fadeInSamples: 400 });
    expect(setFadeOut(c, 250).fadeOutSamples).toBe(250);
    expect(setFadeOut(c, 5000).fadeOutSamples).toBe(600); // length − fadeIn
  });
  it('split clears the inner-edge fades, keeps the outer + gain', () => {
    const c = clip({
      sourceIn: 0,
      sourceOut: 1000,
      timelineStart: 0,
      gainDb: -3,
      fadeInSamples: 100,
      fadeOutSamples: 120,
    });
    const [left, right] = splitClipsAt([c], TOTAL, 400);
    expect(left?.fadeInSamples).toBe(100);
    expect(left?.fadeOutSamples).toBe(0);
    expect(right?.fadeInSamples).toBe(0);
    expect(right?.fadeOutSamples).toBe(120);
    expect(left?.gainDb).toBe(-3);
    expect(right?.gainDb).toBe(-3);
  });
});

describe('setClipGain', () => {
  it('nudges within the schema range', () => {
    expect(setClipGain(clip(), -6).gainDb).toBe(-6);
    expect(setClipGain(clip(), 99).gainDb).toBe(12); // clamp max
    expect(setClipGain(clip(), -99).gainDb).toBe(-24); // clamp min
  });
});

describe('duplicateClip', () => {
  it('copies with a fresh id at the target sample, preserving the source window', () => {
    const c = clip({
      sourceIn: 100,
      sourceOut: 900,
      timelineStart: 0,
      gainDb: -2,
      fadeInSamples: 50,
    });
    const d = duplicateClip(c, clipEnd(c));
    expect(d.id).not.toBe(c.id);
    expect(d.timelineStart).toBe(clipEnd(c));
    expect(d.sourceIn).toBe(100);
    expect(d.sourceOut).toBe(900);
    expect(d.gainDb).toBe(-2);
    expect(d.fadeInSamples).toBe(50);
  });
});

describe('pasteClips', () => {
  it('re-anchors the earliest clip to the playhead, keeps relative spacing + fresh ids', () => {
    const board = [
      clip({ id: 'a', sourceIn: 0, sourceOut: 1000, timelineStart: 2000 }),
      clip({ id: 'b', sourceIn: 0, sourceOut: 1000, timelineStart: 2500 }),
    ];
    const out = pasteClips(board, 10_000);
    expect(out).toHaveLength(2);
    expect(out[0]?.timelineStart).toBe(10_000);
    expect(out[1]?.timelineStart).toBe(10_500); // 500-sample gap preserved
    expect(out[0]?.id).not.toBe('a');
    expect(out[1]?.id).not.toBe('b');
  });
  it('empty clipboard ⇒ nothing', () => {
    expect(pasteClips([], 0)).toEqual([]);
  });
});

describe('rippleDelete', () => {
  it('removes the clip and closes the gap for later clips', () => {
    const clips = [
      clip({ id: 'a', sourceIn: 0, sourceOut: 1000, timelineStart: 0 }), // len 1000 @ 0
      clip({ id: 'b', sourceIn: 0, sourceOut: 1000, timelineStart: 1000 }), // @ 1000
      clip({ id: 'c', sourceIn: 0, sourceOut: 1000, timelineStart: 2000 }), // @ 2000
    ];
    const out = rippleDelete(clips, 'b'); // removes b (len 1000), shifts c left by 1000
    expect(out.map((x) => x.id)).toEqual(['a', 'c']);
    expect(out.find((x) => x.id === 'a')?.timelineStart).toBe(0); // before — unchanged
    expect(out.find((x) => x.id === 'c')?.timelineStart).toBe(1000); // closed the gap
  });
  it('unknown id ⇒ unchanged copy', () => {
    const clips = [clip({ id: 'a' })];
    expect(rippleDelete(clips, 'zzz').map((c) => c.id)).toEqual(['a']);
  });
});
