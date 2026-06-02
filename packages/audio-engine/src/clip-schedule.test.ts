import { describe, expect, it } from 'vitest';
import {
  type ClipRegion,
  type ScheduledClip,
  clipsEndSample,
  planClipSchedule,
} from './clip-schedule';

const SR = 48_000;
const LEN = 480_000; // 10 s buffer

/** A scheduled clip with the v2 fade/gain fields at their no-op defaults. */
function sched(
  p: Partial<ScheduledClip> & Pick<ScheduledClip, 'whenOffsetSec' | 'offsetSec' | 'durationSec'>
): ScheduledClip {
  return { gainDb: 0, fadeInSec: 0, fadeOutSec: 0, fadeStartScale: 1, ...p };
}

describe('planClipSchedule', () => {
  it('empty clips ⇒ one whole-buffer clip at t=0 (today’s behaviour)', () => {
    const plan = planClipSchedule([], LEN, SR, 0);
    expect(plan).toEqual([sched({ whenOffsetSec: 0, offsetSec: 0, durationSec: 10 })]);
  });

  it('empty clips honour a mid-buffer seek offset', () => {
    const plan = planClipSchedule([], LEN, SR, 4);
    expect(plan).toEqual([sched({ whenOffsetSec: 0, offsetSec: 4, durationSec: 6 })]);
  });

  it('clip fully ahead of the playhead schedules into the future', () => {
    const clips: ClipRegion[] = [{ sourceIn: 0, sourceOut: SR, timelineStart: 2 * SR }];
    const plan = planClipSchedule(clips, LEN, SR, 0);
    expect(plan).toEqual([sched({ whenOffsetSec: 2, offsetSec: 0, durationSec: 1 })]);
  });

  it('clip entirely behind the playhead is skipped', () => {
    const clips: ClipRegion[] = [{ sourceIn: 0, sourceOut: SR, timelineStart: 0 }];
    const plan = planClipSchedule(clips, LEN, SR, 5);
    expect(plan).toEqual([]);
  });

  it('clip straddling the playhead starts now, mid-clip', () => {
    const clips: ClipRegion[] = [{ sourceIn: 1 * SR, sourceOut: 4 * SR, timelineStart: 2 * SR }];
    const plan = planClipSchedule(clips, LEN, SR, 3);
    expect(plan).toEqual([sched({ whenOffsetSec: 0, offsetSec: 2, durationSec: 2 })]);
  });

  it('handles multiple clips: skip past, start straddling, queue ahead', () => {
    const clips: ClipRegion[] = [
      { sourceIn: 0, sourceOut: SR, timelineStart: 0 },
      { sourceIn: 0, sourceOut: 2 * SR, timelineStart: 2 * SR },
      { sourceIn: 0, sourceOut: SR, timelineStart: 6 * SR },
    ];
    const plan = planClipSchedule(clips, LEN, SR, 3);
    expect(plan).toEqual([
      sched({ whenOffsetSec: 0, offsetSec: 1, durationSec: 1 }),
      sched({ whenOffsetSec: 3, offsetSec: 0, durationSec: 1 }),
    ]);
  });

  it('clamps trim bounds to the buffer length', () => {
    const clips: ClipRegion[] = [{ sourceIn: 0, sourceOut: LEN * 2, timelineStart: 0 }];
    const plan = planClipSchedule(clips, LEN, SR, 0);
    expect(plan).toEqual([sched({ whenOffsetSec: 0, offsetSec: 0, durationSec: 10 })]);
  });

  // ── v2: fades + gain ──────────────────────────────────────────────────
  it('carries gain + fades onto a fully-ahead clip', () => {
    const clips: ClipRegion[] = [
      {
        sourceIn: 0,
        sourceOut: 4 * SR,
        timelineStart: 2 * SR,
        gainDb: -6,
        fadeInSamples: SR / 2, // 0.5 s
        fadeOutSamples: SR, // 1 s
      },
    ];
    const plan = planClipSchedule(clips, LEN, SR, 0);
    expect(plan).toEqual([
      sched({
        whenOffsetSec: 2,
        offsetSec: 0,
        durationSec: 4,
        gainDb: -6,
        fadeInSec: 0.5,
        fadeOutSec: 1,
        fadeStartScale: 0, // a fade-in ⇒ begin from silence
      }),
    ]);
  });

  it('seeking into a fade-in resumes the ramp mid-way (no click)', () => {
    // 2 s fade-in on a clip at timeline 0; playhead at 1 s ⇒ halfway up.
    const clips: ClipRegion[] = [
      { sourceIn: 0, sourceOut: 8 * SR, timelineStart: 0, fadeInSamples: 2 * SR },
    ];
    const plan = planClipSchedule(clips, LEN, SR, 1);
    expect(plan).toEqual([
      sched({
        whenOffsetSec: 0,
        offsetSec: 1,
        durationSec: 7,
        fadeInSec: 1, // 1 s of the 2 s fade-in remains
        fadeStartScale: 0.5, // halfway up
      }),
    ]);
  });

  it('fades clamp to the clip length', () => {
    const clips: ClipRegion[] = [
      {
        sourceIn: 0,
        sourceOut: SR,
        timelineStart: 0,
        fadeInSamples: 5 * SR,
        fadeOutSamples: 5 * SR,
      },
    ];
    const plan = planClipSchedule(clips, LEN, SR, 0);
    expect(plan[0]?.fadeInSec).toBe(1); // clamped to the 1 s clip
    expect(plan[0]?.fadeOutSec).toBe(1);
  });
});

describe('clipsEndSample', () => {
  it('empty clips ⇒ full buffer length', () => {
    expect(clipsEndSample([], LEN)).toBe(LEN);
  });

  it('returns the furthest clip end on the timeline', () => {
    const clips: ClipRegion[] = [
      { sourceIn: 0, sourceOut: SR, timelineStart: 0 },
      { sourceIn: 0, sourceOut: 2 * SR, timelineStart: 5 * SR },
    ];
    expect(clipsEndSample(clips, LEN)).toBe(7 * SR);
  });
});
