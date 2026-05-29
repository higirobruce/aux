import { describe, expect, it } from 'vitest';
import { type ClipRegion, clipsEndSample, planClipSchedule } from './clip-schedule';

const SR = 48_000;
const LEN = 480_000; // 10 s buffer

describe('planClipSchedule', () => {
  it('empty clips ⇒ one whole-buffer clip at t=0 (today’s behaviour)', () => {
    const plan = planClipSchedule([], LEN, SR, 0);
    expect(plan).toEqual([{ whenOffsetSec: 0, offsetSec: 0, durationSec: 10 }]);
  });

  it('empty clips honour a mid-buffer seek offset', () => {
    const plan = planClipSchedule([], LEN, SR, 4);
    expect(plan).toEqual([{ whenOffsetSec: 0, offsetSec: 4, durationSec: 6 }]);
  });

  it('clip fully ahead of the playhead schedules into the future', () => {
    // clip: source [0, 1s) placed at timeline 2s; playhead at 0.
    const clips: ClipRegion[] = [{ sourceIn: 0, sourceOut: SR, timelineStart: 2 * SR }];
    const plan = planClipSchedule(clips, LEN, SR, 0);
    expect(plan).toEqual([{ whenOffsetSec: 2, offsetSec: 0, durationSec: 1 }]);
  });

  it('clip entirely behind the playhead is skipped', () => {
    const clips: ClipRegion[] = [{ sourceIn: 0, sourceOut: SR, timelineStart: 0 }];
    const plan = planClipSchedule(clips, LEN, SR, 5); // playhead at 5s, clip ends at 1s
    expect(plan).toEqual([]);
  });

  it('clip straddling the playhead starts now, mid-clip', () => {
    // source [1s, 4s) (trim-in 1s) placed at timeline 2s ⇒ spans [2s, 5s).
    // playhead at 3s ⇒ 1s into the clip.
    const clips: ClipRegion[] = [{ sourceIn: 1 * SR, sourceOut: 4 * SR, timelineStart: 2 * SR }];
    const plan = planClipSchedule(clips, LEN, SR, 3);
    // offset = sourceIn(1s) + into(1s) = 2s; duration = clipLen(3s) − into(1s) = 2s.
    expect(plan).toEqual([{ whenOffsetSec: 0, offsetSec: 2, durationSec: 2 }]);
  });

  it('handles multiple clips: skip past, start straddling, queue ahead', () => {
    const clips: ClipRegion[] = [
      { sourceIn: 0, sourceOut: SR, timelineStart: 0 }, // [0,1s) — past
      { sourceIn: 0, sourceOut: 2 * SR, timelineStart: 2 * SR }, // [2,4s) — straddles @3s
      { sourceIn: 0, sourceOut: SR, timelineStart: 6 * SR }, // [6,7s) — ahead
    ];
    const plan = planClipSchedule(clips, LEN, SR, 3);
    expect(plan).toEqual([
      { whenOffsetSec: 0, offsetSec: 1, durationSec: 1 }, // 1s into the 2s clip
      { whenOffsetSec: 3, offsetSec: 0, durationSec: 1 }, // begins 3s from now
    ]);
  });

  it('clamps trim bounds to the buffer length', () => {
    const clips: ClipRegion[] = [{ sourceIn: 0, sourceOut: LEN * 2, timelineStart: 0 }];
    const plan = planClipSchedule(clips, LEN, SR, 0);
    expect(plan).toEqual([{ whenOffsetSec: 0, offsetSec: 0, durationSec: 10 }]);
  });
});

describe('clipsEndSample', () => {
  it('empty clips ⇒ full buffer length', () => {
    expect(clipsEndSample([], LEN)).toBe(LEN);
  });

  it('returns the furthest clip end on the timeline', () => {
    const clips: ClipRegion[] = [
      { sourceIn: 0, sourceOut: SR, timelineStart: 0 }, // ends @ 1s
      { sourceIn: 0, sourceOut: 2 * SR, timelineStart: 5 * SR }, // ends @ 7s
    ];
    expect(clipsEndSample(clips, LEN)).toBe(7 * SR);
  });
});
