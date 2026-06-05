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
  return [
    {
      id: newClipId(),
      sourceIn: 0,
      sourceOut: totalSamples,
      timelineStart: 0,
      gainDb: 0,
      fadeInSamples: 0,
      fadeOutSamples: 0,
    },
  ];
}

/** Clamp a clip's fades so neither exceeds the clip length and they don't
 *  overlap (fadeIn + fadeOut ≤ length). Used after any length change. */
export function clampFades(clip: StemClip): StemClip {
  const len = clipLength(clip);
  const fadeInSamples = Math.max(0, Math.min(clip.fadeInSamples, len));
  const fadeOutSamples = Math.max(0, Math.min(clip.fadeOutSamples, len - fadeInSamples));
  return { ...clip, fadeInSamples, fadeOutSamples };
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
      // Left half keeps the fade-in + gain; the new inner edges get no fade.
      out.push(
        clampFades({
          id: newClipId(),
          sourceIn: c.sourceIn,
          sourceOut: c.sourceIn + offset,
          timelineStart: start,
          gainDb: c.gainDb,
          fadeInSamples: c.fadeInSamples,
          fadeOutSamples: 0,
        })
      );
      // Right half keeps the fade-out + gain.
      out.push(
        clampFades({
          id: newClipId(),
          sourceIn: c.sourceIn + offset,
          sourceOut: c.sourceOut,
          timelineStart: atSample,
          gainDb: c.gainDb,
          fadeInSamples: 0,
          fadeOutSamples: c.fadeOutSamples,
        })
      );
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
  return clampFades({
    ...clip,
    sourceIn: clip.sourceIn + applied,
    timelineStart: clip.timelineStart + applied,
  });
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
  return clampFades({ ...clip, sourceOut });
}

/** Clip gain bounds (dB), matching StemClipSchema. */
export const MIN_CLIP_GAIN_DB = -24;
export const MAX_CLIP_GAIN_DB = 12;

/** Drag the fade-in length by `deltaSamples`; clamped so fades don't overlap. */
export function setFadeIn(clip: StemClip, deltaSamples: number): StemClip {
  const max = Math.max(0, clipLength(clip) - clip.fadeOutSamples);
  const fadeInSamples = Math.max(0, Math.min(max, Math.round(clip.fadeInSamples + deltaSamples)));
  return { ...clip, fadeInSamples };
}

/** Drag the fade-out length by `deltaSamples`; clamped so fades don't overlap. */
export function setFadeOut(clip: StemClip, deltaSamples: number): StemClip {
  const max = Math.max(0, clipLength(clip) - clip.fadeInSamples);
  const fadeOutSamples = Math.max(0, Math.min(max, Math.round(clip.fadeOutSamples + deltaSamples)));
  return { ...clip, fadeOutSamples };
}

/** Nudge the clip gain by `deltaDb`, clamped to the schema range. */
export function setClipGain(clip: StemClip, deltaDb: number): StemClip {
  const gainDb = Math.max(MIN_CLIP_GAIN_DB, Math.min(MAX_CLIP_GAIN_DB, clip.gainDb + deltaDb));
  return { ...clip, gainDb };
}

/** A copy of `clip` with a fresh id, placed at `atSample` on the timeline.
 *  Source window + fades + gain are preserved. */
export function duplicateClip(clip: StemClip, atSample: number): StemClip {
  return { ...clip, id: newClipId(), timelineStart: Math.max(0, Math.round(atSample)) };
}

/**
 * Re-anchor `clipboard` so its earliest `timelineStart` lands on `atSample`,
 * preserving the clips' relative spacing and giving each a fresh id. Returns
 * the clips to ADD to a stem (caller appends to the existing array).
 */
export function pasteClips(clipboard: readonly StemClip[], atSample: number): StemClip[] {
  if (clipboard.length === 0) return [];
  const base = Math.min(...clipboard.map((c) => c.timelineStart));
  const at = Math.max(0, Math.round(atSample));
  return clipboard.map((c) => ({
    ...c,
    id: newClipId(),
    timelineStart: Math.max(0, at + (c.timelineStart - base)),
  }));
}

/**
 * Ripple-delete `clipId`: remove it and shift every clip starting at or after
 * it left by the removed clip's timeline length, so the gap closes.
 */
export function rippleDelete(clips: readonly StemClip[], clipId: string): StemClip[] {
  const target = clips.find((c) => c.id === clipId);
  if (!target) return clips.map((c) => ({ ...c }));
  const gap = clipLength(target);
  const cut = target.timelineStart;
  return clips
    .filter((c) => c.id !== clipId)
    .map((c) =>
      c.timelineStart >= cut
        ? { ...c, timelineStart: Math.max(0, c.timelineStart - gap) }
        : { ...c }
    );
}
