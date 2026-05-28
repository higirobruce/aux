'use client';

import type { Stem } from '@/lib/types';
import type { ChannelState } from './_mixer-shell';

interface Props {
  stem: Stem;
  state: ChannelState;
  loaded: boolean;
  anySoloed: boolean;
  onVolume: (value: number) => void;
  onPan: (value: number) => void;
  onMute: () => void;
  onSolo: () => void;
}

function linearToDb(x: number): number {
  return x > 0 ? 20 * Math.log10(x) : Number.NEGATIVE_INFINITY;
}
function dbToLinear(db: number): number {
  return 10 ** (db / 20);
}

function formatDb(linear: number): string {
  const db = linearToDb(linear);
  if (!Number.isFinite(db)) return '−∞';
  const sign = db > 0 ? '+' : db < 0 ? '−' : '';
  return `${sign}${Math.abs(db).toFixed(1)}`;
}

function formatPan(value: number): string {
  if (Math.abs(value) < 0.02) return 'C';
  const pct = Math.round(Math.abs(value) * 100);
  return value < 0 ? `L${pct}` : `R${pct}`;
}

/**
 * Fader value mapping. The slider is linear 0..100; we map to dB so dragging
 * feels musical:
 *   0   → −60 dB (effectively silent)
 *   75  →   0 dB (unity)
 *   100 →  +6 dB (a little headroom)
 */
const FADER_MIN_DB = -60;
const FADER_UNITY_PCT = 75;
const FADER_MAX_DB = 6;

function pctToVolume(pct: number): number {
  if (pct <= 0) return 0;
  const db =
    pct <= FADER_UNITY_PCT
      ? FADER_MIN_DB + (pct / FADER_UNITY_PCT) * (0 - FADER_MIN_DB)
      : ((pct - FADER_UNITY_PCT) / (100 - FADER_UNITY_PCT)) * FADER_MAX_DB;
  return dbToLinear(db);
}

function volumeToPct(volume: number): number {
  const db = linearToDb(volume);
  if (!Number.isFinite(db) || db <= FADER_MIN_DB) return 0;
  if (db <= 0) {
    return ((db - FADER_MIN_DB) / -FADER_MIN_DB) * FADER_UNITY_PCT;
  }
  return FADER_UNITY_PCT + (db / FADER_MAX_DB) * (100 - FADER_UNITY_PCT);
}

export function ChannelStrip({
  stem,
  state,
  loaded,
  anySoloed,
  onVolume,
  onPan,
  onMute,
  onSolo,
}: Props) {
  const effectivelyMuted = state.muted || (anySoloed && !state.soloed);

  return (
    <div
      className={`grid grid-cols-[1.5fr_1fr_2fr_auto_auto] items-center gap-4 px-4 py-3 ${effectivelyMuted ? 'opacity-50' : ''}`}
    >
      {/* Name */}
      <div className="min-w-0">
        <p className="font-mono text-sm text-ink truncate" title={stem.name}>
          {stem.name}
        </p>
        <p className="font-mono text-xs text-ink-3">
          {stem.channels === 1 ? 'mono' : 'stereo'} · {Math.round(stem.sampleRate / 1000)}k
          {!loaded && <span className="ml-2 text-ink-3">(not loaded)</span>}
        </p>
      </div>

      {/* Pan */}
      <div className="flex items-center gap-2">
        <span className="font-mono text-xs text-ink-3 w-10 text-right tabular-nums">
          {formatPan(state.pan)}
        </span>
        <input
          type="range"
          aria-label={`${stem.name} pan`}
          min={-1}
          max={1}
          step={0.01}
          value={state.pan}
          onChange={(e) => onPan(Number(e.target.value))}
          onDoubleClick={() => onPan(0)}
          className="flex-1 accent-azure"
        />
      </div>

      {/* Fader (volume) */}
      <div className="flex items-center gap-2">
        <input
          type="range"
          aria-label={`${stem.name} volume`}
          min={0}
          max={100}
          step={0.1}
          value={volumeToPct(state.volume)}
          onChange={(e) => onVolume(pctToVolume(Number(e.target.value)))}
          onDoubleClick={() => onVolume(1)}
          className="flex-1 accent-ink"
        />
        <span className="font-mono text-xs text-ink-2 w-14 text-right tabular-nums">
          {formatDb(state.volume)} dB
        </span>
      </div>

      {/* Solo / Mute */}
      <div className="flex gap-1">
        <button
          type="button"
          aria-label={`${stem.name} solo`}
          aria-pressed={state.soloed}
          onClick={onSolo}
          className={`font-mono text-xs w-8 h-8 rounded border transition-colors ${
            state.soloed
              ? 'bg-azure text-white border-azure'
              : 'border-line text-ink-3 hover:border-ink'
          }`}
        >
          S
        </button>
        <button
          type="button"
          aria-label={`${stem.name} mute`}
          aria-pressed={state.muted}
          onClick={onMute}
          className={`font-mono text-xs w-8 h-8 rounded border transition-colors ${
            state.muted ? 'bg-ink text-paper border-ink' : 'border-line text-ink-3 hover:border-ink'
          }`}
        >
          M
        </button>
      </div>

      {/* Peak readout (static — from upload metadata; live meter is v0.3) */}
      <div className="font-mono text-xs text-ink-3 w-12 text-right">
        {Number.isFinite(stem.peakDb) ? `${stem.peakDb.toFixed(1)}` : '−∞'}
      </div>
    </div>
  );
}
