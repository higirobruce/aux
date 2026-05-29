'use client';

/**
 * Read-only stem timeline (v0.3).
 *
 * Per the implementation plan §11 Stem timeline callout: one horizontal lane
 * per stem, sharing the mixer's playhead. Strictly read-only — no clip cut /
 * move / trim. Purpose is *seeing* the song's shape while mixing.
 *
 * What lives here:
 *   - <StemTimeline>     wrapper that draws the shared playhead + ruler over N lanes
 *   - <StemLane>         one row: name + S/M mirror + waveform canvas
 *   - <WaveCanvas>       canvas-only renderer for a peaks Float32Array
 *
 * What lives elsewhere:
 *   - peaks data is computed by `AudioHost.getStemPeaks()` in the audio
 *     engine and pushed in via the `peaks` prop
 *   - playhead position comes from the same transport ref the mixer reads,
 *     passed as `position` (seconds)
 *   - mute / solo are mirrors of the channel-strip state, not a fork — we
 *     dispatch back to MixerShell via the same callbacks the strip uses
 *
 * Click anywhere on a lane → seek. The handler talks to the MixerShell's
 * seek() callback, which restarts playback at the new offset if currently
 * playing (otherwise just updates position state).
 */

import type { Stem } from '@/lib/types';
import { useEffect, useRef } from 'react';

export interface StemPeaks {
  /** Interleaved min/max pairs — length = 2 * bins. */
  peaks: Float32Array;
  inSample: number;
  outSample: number;
  sampleRate: number;
  totalSamples: number;
}

interface StemLaneState {
  muted: boolean;
  soloed: boolean;
}

interface Props {
  stems: Stem[];
  /** Peaks keyed by stem id. Missing entry = lane shows "loading…" placeholder. */
  peaks: Record<string, StemPeaks | undefined>;
  /** Channel mute/solo state keyed by stem id. */
  laneState: Record<string, StemLaneState>;
  anySoloed: boolean;
  /** Duration of the longest loaded stem, in seconds. Drives the global x-axis. */
  duration: number;
  /** Live playhead position in seconds. Re-rendered every animation frame. */
  position: number;
  /** Whether transport is currently playing — used only for cursor styling. */
  playing: boolean;
  onMute: (stemId: string) => void;
  onSolo: (stemId: string) => void;
  onSeek: (seconds: number) => void;
}

const LANE_HEIGHT = 56;
const NAME_COL_WIDTH = 132;
const RULER_HEIGHT = 18;

export function StemTimeline({
  stems,
  peaks,
  laneState,
  anySoloed,
  duration,
  position,
  playing,
  onMute,
  onSolo,
  onSeek,
}: Props) {
  const trackRef = useRef<HTMLDivElement>(null);

  if (stems.length === 0) {
    return (
      <div className="stem-timeline empty">
        <div className="stem-timeline-empty">no stems</div>
      </div>
    );
  }

  // Track-area click handler — shared across the lanes + ruler. Translates
  // a pageX on the track to a seek time in seconds.
  function handleTrackClick(e: React.MouseEvent<HTMLDivElement>) {
    if (!duration || duration <= 0) return;
    const track = trackRef.current;
    if (!track) return;
    const rect = track.getBoundingClientRect();
    const x = e.clientX - rect.left;
    if (x < 0) return;
    const ratio = Math.max(0, Math.min(1, x / rect.width));
    onSeek(ratio * duration);
  }

  const playheadPct = duration > 0 ? (position / duration) * 100 : 0;

  return (
    <div className="stem-timeline">
      <div className="stem-timeline-ruler">
        <div className="stem-timeline-ruler-spacer" style={{ width: NAME_COL_WIDTH }} />
        <RulerMarks duration={duration} />
      </div>

      <div className="stem-timeline-lanes">
        {stems.map((stem) => {
          const state = laneState[stem.id];
          const effectivelyMuted = state ? state.muted || (anySoloed && !state.soloed) : false;
          return (
            <StemLane
              key={stem.id}
              stem={stem}
              peaks={peaks[stem.id]}
              globalDuration={duration}
              muted={state?.muted ?? false}
              soloed={state?.soloed ?? false}
              effectivelyMuted={effectivelyMuted}
              onMute={() => onMute(stem.id)}
              onSolo={() => onSolo(stem.id)}
            />
          );
        })}
      </div>

      {/* Overlay: covers the lanes (not the name column) so clicks anywhere
          in the waveform area seek; playhead floats on top via a separate
          absolutely-positioned div. */}
      <div
        ref={trackRef}
        className="stem-timeline-track"
        style={{ left: NAME_COL_WIDTH, top: RULER_HEIGHT }}
        onClick={handleTrackClick}
        role="slider"
        tabIndex={0}
        aria-label="Timeline playhead"
        aria-valuemin={0}
        aria-valuemax={Math.max(1, Math.round(duration))}
        aria-valuenow={Math.round(position)}
        onKeyDown={(e) => {
          // Arrow-key nudge — 1 second per press, matches typical DAW.
          if (!duration) return;
          if (e.key === 'ArrowLeft') onSeek(Math.max(0, position - 1));
          else if (e.key === 'ArrowRight') onSeek(Math.min(duration, position + 1));
        }}
      />

      <div
        className={`stem-timeline-playhead ${playing ? 'playing' : ''}`}
        style={{
          left: `calc(${NAME_COL_WIDTH}px + (100% - ${NAME_COL_WIDTH}px) * ${playheadPct / 100})`,
        }}
        aria-hidden="true"
      />
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Ruler — time tick marks above the lanes
// ──────────────────────────────────────────────────────────────────────────

function RulerMarks({ duration }: { duration: number }) {
  if (!duration || duration <= 0) {
    return <div className="stem-timeline-ruler-marks" />;
  }
  // Pick a sensible tick interval so we end up with ~6–12 labelled ticks.
  const desired = 8;
  const candidates = [1, 2, 5, 10, 15, 30, 60, 120, 300];
  let interval = candidates[candidates.length - 1] ?? 60;
  for (const c of candidates) {
    if (duration / c <= desired) {
      interval = c;
      break;
    }
  }
  const ticks: number[] = [];
  for (let t = 0; t <= duration + 0.0001; t += interval) ticks.push(t);

  return (
    <div className="stem-timeline-ruler-marks">
      {ticks.map((t) => (
        <span
          key={t}
          className="stem-timeline-ruler-tick"
          style={{ left: `${(t / duration) * 100}%` }}
        >
          <span className="stem-timeline-ruler-label">{formatRulerTime(t)}</span>
        </span>
      ))}
    </div>
  );
}

function formatRulerTime(sec: number): string {
  if (sec < 60) return `${Math.round(sec)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  if (s === 0) return `${m}m`;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// ──────────────────────────────────────────────────────────────────────────
// Per-stem lane
// ──────────────────────────────────────────────────────────────────────────

interface LaneProps {
  stem: Stem;
  peaks: StemPeaks | undefined;
  globalDuration: number;
  muted: boolean;
  soloed: boolean;
  effectivelyMuted: boolean;
  onMute: () => void;
  onSolo: () => void;
}

function StemLane({
  stem,
  peaks,
  globalDuration,
  muted,
  soloed,
  effectivelyMuted,
  onMute,
  onSolo,
}: LaneProps) {
  return (
    <div className={`stem-lane ${effectivelyMuted ? 'muted' : ''}`} style={{ height: LANE_HEIGHT }}>
      <div className="stem-lane-name" style={{ width: NAME_COL_WIDTH }}>
        <span className="stem-lane-title" title={stem.name}>
          {stem.name}
        </span>
        <div className="stem-lane-btns">
          <button
            type="button"
            className={`stem-lane-btn solo ${soloed ? 'on' : ''}`}
            aria-pressed={soloed}
            aria-label={`${stem.name} solo`}
            onClick={(e) => {
              e.stopPropagation();
              onSolo();
            }}
          >
            S
          </button>
          <button
            type="button"
            className={`stem-lane-btn mute ${muted ? 'on' : ''}`}
            aria-pressed={muted}
            aria-label={`${stem.name} mute`}
            onClick={(e) => {
              e.stopPropagation();
              onMute();
            }}
          >
            M
          </button>
        </div>
      </div>
      <div className="stem-lane-wave">
        {peaks ? (
          <WaveCanvas peaks={peaks} globalDuration={globalDuration} />
        ) : (
          <div className="stem-lane-loading">loading…</div>
        )}
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Canvas waveform renderer
// ──────────────────────────────────────────────────────────────────────────

function WaveCanvas({
  peaks,
  globalDuration,
}: {
  peaks: StemPeaks;
  globalDuration: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Draw on mount + on resize. The peaks Float32Array doesn't change once a
  // stem is loaded (swap creates a new entry under the same id, which gives
  // us a fresh `peaks` reference and triggers a re-render).
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;

    function draw() {
      if (!canvas || !wrap) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const dpr = window.devicePixelRatio || 1;
      const cssW = wrap.clientWidth;
      const cssH = wrap.clientHeight;
      const w = Math.max(1, Math.floor(cssW * dpr));
      const h = Math.max(1, Math.floor(cssH * dpr));
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
      canvas.style.width = `${cssW}px`;
      canvas.style.height = `${cssH}px`;

      const bins = peaks.peaks.length / 2;

      ctx.clearRect(0, 0, w, h);

      // Background
      ctx.fillStyle = '#0a0c10';
      ctx.fillRect(0, 0, w, h);

      // Zero line spans the full lane so empty regions still look anchored.
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, h / 2);
      ctx.lineTo(w, h / 2);
      ctx.stroke();

      if (bins === 0) return;

      // Constrain this stem's waveform to its fraction of the global timeline.
      // A 30-second stem on a 60-second global timeline only fills half the
      // lane — past that, the canvas stays dark so the timeline reads truthful.
      const stemDuration = peaks.sampleRate > 0 ? peaks.totalSamples / peaks.sampleRate : 0;
      const stemWidthFrac = globalDuration > 0 ? Math.min(1, stemDuration / globalDuration) : 1;
      const stemWidthPx = Math.max(1, Math.floor(stemWidthFrac * w));

      // Silent-region shading. inSample/outSample mark where audio actually
      // starts and ends inside this stem; the rest is silent intro/outro
      // padding we want visually de-emphasized.
      const inFrac = peaks.totalSamples > 0 ? peaks.inSample / peaks.totalSamples : 0;
      const outFrac =
        peaks.totalSamples > 0 ? Math.min(1, peaks.outSample / peaks.totalSamples) : 1;
      const inPx = Math.floor(inFrac * stemWidthPx);
      const outPx = Math.ceil(outFrac * stemWidthPx);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.03)';
      if (inPx > 0) ctx.fillRect(0, 0, inPx, h);
      if (outPx < stemWidthPx) ctx.fillRect(outPx, 0, stemWidthPx - outPx, h);

      // Waveform — one vertical line per pixel column inside [0, stemWidthPx).
      // We oversample by taking (min, max) across the bins that fall under
      // each column. Past stemWidthPx the canvas stays dark.
      ctx.strokeStyle = '#5fa6e8';
      ctx.lineWidth = 1;
      ctx.beginPath();
      const midY = h / 2;
      const halfH = midY - 1; // 1 px breathing room top/bottom
      for (let x = 0; x < stemWidthPx; x++) {
        const binStart = Math.floor((x / stemWidthPx) * bins);
        const binEnd = Math.max(binStart + 1, Math.floor(((x + 1) / stemWidthPx) * bins));
        let lo = Number.POSITIVE_INFINITY;
        let hi = Number.NEGATIVE_INFINITY;
        for (let b = binStart; b < binEnd && b < bins; b++) {
          const mn = peaks.peaks[b * 2] ?? 0;
          const mx = peaks.peaks[b * 2 + 1] ?? 0;
          if (mn < lo) lo = mn;
          if (mx > hi) hi = mx;
        }
        if (!Number.isFinite(lo) || !Number.isFinite(hi)) continue;
        const y1 = midY - hi * halfH;
        const y2 = midY - lo * halfH;
        ctx.moveTo(x + 0.5, y1);
        ctx.lineTo(x + 0.5, Math.max(y2, y1 + 1));
      }
      ctx.stroke();

      // In/out marker hairlines on top of the waveform, so the eye can find
      // exactly where each stem starts / ends audibly.
      ctx.strokeStyle = 'rgba(95, 166, 232, 0.45)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      if (inPx > 0) {
        ctx.moveTo(inPx + 0.5, 0);
        ctx.lineTo(inPx + 0.5, h);
      }
      if (outPx > 0 && outPx < stemWidthPx) {
        ctx.moveTo(outPx + 0.5, 0);
        ctx.lineTo(outPx + 0.5, h);
      }
      ctx.stroke();
    }

    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [peaks, globalDuration]);

  return (
    <div ref={wrapRef} className="stem-lane-wave-canvas-wrap">
      <canvas ref={canvasRef} className="stem-lane-wave-canvas" />
    </div>
  );
}
