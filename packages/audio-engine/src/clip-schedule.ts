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
}

/** Arguments for one scheduled `source.start(ctx.currentTime + whenOffsetSec, offsetSec, durationSec)`. */
export interface ScheduledClip {
  /** Seconds from now to begin playback (0 = immediately). */
  whenOffsetSec: number;
  /** Offset into the source buffer, in seconds. */
  offsetSec: number;
  /** How long to play, in seconds (auto-stops at the clip edge). */
  durationSec: number;
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
  fromSec: number,
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

    if (clipStart >= head) {
      // Fully ahead: schedule to begin when the playhead reaches it.
      out.push({
        whenOffsetSec: (clipStart - head) / sampleRate,
        offsetSec: sIn / sampleRate,
        durationSec: len / sampleRate,
      });
    } else {
      // Straddles the playhead: begin now, mid-clip.
      const into = head - clipStart; // samples already elapsed within the clip
      out.push({
        whenOffsetSec: 0,
        offsetSec: (sIn + into) / sampleRate,
        durationSec: (len - into) / sampleRate,
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
