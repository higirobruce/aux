/**
 * Pure clip-editing math for the stem timeline — no React, no DOM, fully
 * unit-tested. Operates on the persisted StemClip shape (samples). The lane
 * component supplies pixel→sample conversion and calls these to produce the
 * next clips array, which flows back through MixerShell → setChannelClips.
 *
 * All positions are in SAMPLES at the stem's own sample rate.
 */

import type { StemClip } from '@aux/session-doc';

let clipSeq = 0;
/** Stable-enough unique id. crypto.randomUUID when available, else a counter. */
export function newClipId(): string {
  const uuid =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}_${clipSeq++}`;
  return `clip_${uuid}`;
}

/** Length of a clip on the timeline, in samples. */
export function clipLength(clip: StemClip): number {
  return clip.sourceOut - clip.sourceIn;
}

/** Timeline sample one-past the clip's end. */
export function clipEnd(clip: StemClip): number {
  return clip.timelineStart + clipLength(clip);
}

/**
 * The clips to actually operate on. An empty array means the stem plays as one
 * implicit whole-buffer clip at t=0 — materialise that so edits have something
 * concrete to act on.
 */
export function materialise(clips: readonly StemClip[], totalSamples: number): StemClip[] {
  if (clips.length > 0) return clips.map((c) => ({ ...c }));
  return [{ id: newClipId(), sourceIn: 0, sourceOut: totalSamples, timelineStart: 0 }];
}

/**
 * Split whichever clip contains `atSample` (a global-timeline sample) into two
 * at that point. Empty clips are materialised first. A split exactly on a
 * boundary (or outside every clip) is a no-op beyond materialisation.
 */
export function splitClipsAt(
  clips: readonly StemClip[],
  totalSamples: number,
  atSample: number
): StemClip[] {
  const base = materialise(clips, totalSamples);
  const out: StemClip[] = [];
  let didSplit = false;
  for (const c of base) {
    const start = c.timelineStart;
    const end = clipEnd(c);
    if (!didSplit && atSample > start && atSample < end) {
      const offset = atSample - start; // samples into the clip
      out.push({
        id: newClipId(),
        sourceIn: c.sourceIn,
        sourceOut: c.sourceIn + offset,
        timelineStart: start,
      });
      out.push({
        id: newClipId(),
        sourceIn: c.sourceIn + offset,
        sourceOut: c.sourceOut,
        timelineStart: atSample,
      });
      didSplit = true;
    } else {
      out.push(c);
    }
  }
  return out;
}

/** Snap `value` to the nearest target within `threshold` samples, else value. */
export function snap(value: number, targets: readonly number[], threshold: number): number {
  let best = value;
  let bestDist = threshold;
  for (const t of targets) {
    const d = Math.abs(value - t);
    if (d <= bestDist) {
      bestDist = d;
      best = t;
    }
  }
  return best;
}

/** Candidate snap positions on the timeline: zero, sibling edges, playhead. */
export function snapTargets(
  clips: readonly StemClip[],
  exceptId: string,
  playheadSample: number
): number[] {
  const targets = [0, playheadSample];
  for (const c of clips) {
    if (c.id === exceptId) continue;
    targets.push(c.timelineStart, clipEnd(c));
  }
  return targets;
}

/** Move a clip along the timeline (source window unchanged). Clamps to >= 0. */
export function moveClip(
  clip: StemClip,
  deltaSamples: number,
  snapTo: readonly number[],
  snapThreshold: number
): StemClip {
  let timelineStart = Math.max(0, Math.round(clip.timelineStart + deltaSamples));
  timelineStart = Math.max(0, snap(timelineStart, snapTo, snapThreshold));
  return { ...clip, timelineStart };
}

/**
 * Trim the left edge. sourceIn and timelineStart move together so the audio
 * under the rest of the clip stays anchored in place. Clamps to a >= 1-sample
 * clip and a non-negative source.
 */
export function trimIn(
  clip: StemClip,
  deltaSamples: number,
  snapTo: readonly number[],
  snapThreshold: number
): StemClip {
  // Snap the timeline edge, then derive sourceIn from the snapped delta.
  let timelineStart = Math.round(clip.timelineStart + deltaSamples);
  timelineStart = snap(timelineStart, snapTo, snapThreshold);
  let applied = timelineStart - clip.timelineStart;
  // Clamp: sourceIn stays in [0, sourceOut - 1].
  const minDelta = -clip.sourceIn;
  const maxDelta = clip.sourceOut - 1 - clip.sourceIn;
  applied = Math.max(minDelta, Math.min(maxDelta, applied));
  return {
    ...clip,
    sourceIn: clip.sourceIn + applied,
    timelineStart: clip.timelineStart + applied,
  };
}

/**
 * Trim the right edge. sourceOut moves; sourceIn + timelineStart stay put.
 * Clamps to a >= 1-sample clip and the buffer length.
 */
export function trimOut(
  clip: StemClip,
  deltaSamples: number,
  totalSamples: number,
  snapTo: readonly number[],
  snapThreshold: number
): StemClip {
  // Snap the timeline end edge, then derive sourceOut.
  let end = Math.round(clipEnd(clip) + deltaSamples);
  end = snap(end, snapTo, snapThreshold);
  let sourceOut = clip.sourceIn + (end - clip.timelineStart);
  sourceOut = Math.max(clip.sourceIn + 1, Math.min(totalSamples, sourceOut));
  return { ...clip, sourceOut };
}
