/**
 * Pure clip-scheduling planner — no Web Audio, no AudioContext, fully unit
 * testable. Given a channel's clips and the playhead, it returns the set of
 * AudioBufferSourceNode.start(when, offset, duration) arguments to schedule.
 *
 * All clip positions are in SAMPLES (matches the persisted StemClip). The
 * returned timings are in SECONDS, relative to "now" (whenOffsetSec is added
 * to ctx.currentTime by the caller).
 */

/** A timeline region of a stem's source buffer, in samples. */
export interface ClipRegion {
  /** First source-buffer sample played (trim-left). */
  sourceIn: number;
  /** One-past-last source-buffer sample played (trim-right). */
  sourceOut: number;
  /** Global-timeline sample where `sourceIn` lands. */
  timelineStart: number;
  /** Clip gain in dB (v2). Absent ⇒ 0 (unity). */
  gainDb?: number;
  /** Fade-in length in samples (v2). Absent ⇒ 0. */
  fadeInSamples?: number;
  /** Fade-out length in samples (v2). Absent ⇒ 0. */
  fadeOutSamples?: number;
}

/** Arguments for one scheduled `source.start(ctx.currentTime + whenOffsetSec, offsetSec, durationSec)`,
 *  plus the per-clip gain envelope the caller schedules on a dedicated GainNode. */
export interface ScheduledClip {
  /** Seconds from now to begin playback (0 = immediately). */
  whenOffsetSec: number;
  /** Offset into the source buffer, in seconds. */
  offsetSec: number;
  /** How long to play, in seconds (auto-stops at the clip edge). */
  durationSec: number;
  /** Clip gain in dB (steady-state level the fades ramp to/from). */
  gainDb: number;
  /** Remaining fade-in duration from playback start, in seconds (0 = none). */
  fadeInSec: number;
  /** Fade-out duration, in seconds, ending at playback end (0 = none). */
  fadeOutSec: number;
  /** Gain scale (0..1 of the steady level) at the instant playback begins —
   *  <1 only when seeking into a fade-in, so the envelope resumes mid-ramp. */
  fadeStartScale: number;
}

/**
 * Plan the buffer-source schedule for one channel.
 *
 * @param clips        the channel's clips; empty ⇒ one implicit whole-buffer clip at t=0
 * @param bufferLength source buffer length in samples (clamps trim bounds)
 * @param sampleRate   buffer sample rate
 * @param fromSec      playhead position on the global timeline, in seconds
 */
export function planClipSchedule(
  clips: readonly ClipRegion[],
  bufferLength: number,
  sampleRate: number,
  fromSec: number
): ScheduledClip[] {
  const head = Math.round(fromSec * sampleRate);
  const total = bufferLength;
  const effective: readonly ClipRegion[] =
    clips.length > 0 ? clips : [{ sourceIn: 0, sourceOut: total, timelineStart: 0 }];

  const out: ScheduledClip[] = [];
  for (const clip of effective) {
    // Defensive clamp to buffer bounds — never start/duration past the buffer.
    const sIn = Math.max(0, Math.min(clip.sourceIn, total));
    const sOut = Math.max(sIn, Math.min(clip.sourceOut, total));
    const len = sOut - sIn;
    if (len <= 0) continue;

    const clipStart = clip.timelineStart;
    const clipEnd = clipStart + len;

    if (clipEnd <= head) continue; // entirely behind the playhead — skip

    const gainDb = clip.gainDb ?? 0;
    // Fades clamped to the clip length (each), independent of the other.
    const fIn = Math.max(0, Math.min(clip.fadeInSamples ?? 0, len));
    const fOut = Math.max(0, Math.min(clip.fadeOutSamples ?? 0, len));

    if (clipStart >= head) {
      // Fully ahead: schedule to begin when the playhead reaches it.
      out.push({
        whenOffsetSec: (clipStart - head) / sampleRate,
        offsetSec: sIn / sampleRate,
        durationSec: len / sampleRate,
        gainDb,
        fadeInSec: fIn / sampleRate,
        fadeOutSec: fOut / sampleRate,
        fadeStartScale: fIn > 0 ? 0 : 1,
      });
    } else {
      // Straddles the playhead: begin now, mid-clip. Resume the fade-in mid-ramp
      // if the playhead is inside it; cap the fade-out to the remaining tail.
      const into = head - clipStart; // samples already elapsed within the clip
      const remaining = len - into;
      const fadeInLeft = Math.max(0, fIn - into);
      const startScale = fIn > 0 ? Math.min(1, into / fIn) : 1;
      out.push({
        whenOffsetSec: 0,
        offsetSec: (sIn + into) / sampleRate,
        durationSec: remaining / sampleRate,
        gainDb,
        fadeInSec: fadeInLeft / sampleRate,
        fadeOutSec: Math.min(fOut, remaining) / sampleRate,
        fadeStartScale: startScale,
      });
    }
  }
  return out;
}

/** Latest timeline sample a clip set reaches (its edited "length"), in samples. */
export function clipsEndSample(clips: readonly ClipRegion[], bufferLength: number): number {
  if (clips.length === 0) return bufferLength;
  let max = 0;
  for (const c of clips) {
    const len = Math.max(0, Math.min(c.sourceOut, bufferLength) - Math.max(0, c.sourceIn));
    const end = c.timelineStart + len;
    if (end > max) max = end;
  }
  return max;
}
