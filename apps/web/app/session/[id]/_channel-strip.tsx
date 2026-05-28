'use client';

import type { Stem } from '@/lib/types';
import type { AudioHost } from '@aux/audio-engine';
import { Fader } from './_fader';
import { Knob } from './_knob';
import { Meter } from './_meter';
import type { ChannelState, EqBand } from './_mixer-shell';

interface Props {
  stem: Stem;
  state: ChannelState;
  loaded: boolean;
  anySoloed: boolean;
  host: AudioHost | null;
  active: boolean;
  onVolume: (value: number) => void;
  onPan: (value: number) => void;
  onMute: () => void;
  onSolo: () => void;
  onEq: (band: EqBand, gainDb: number) => void;
}

const EQ_KNOB_MIN_DB = -12;
const EQ_KNOB_MAX_DB = 12;

function formatEqDb(db: number): string {
  if (Math.abs(db) < 0.05) return '0';
  const sign = db > 0 ? '+' : '−';
  return `${sign}${Math.abs(db).toFixed(1)}`;
}

// ─── dB <-> linear ──────────────────────────────────────────────────────

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
  return value < 0 ? `L${Math.round(Math.abs(value) * 100)}` : `R${Math.round(value * 100)}`;
}

/**
 * Fader maps 0..1 position → dB so 0.75 = unity:
 *   pos 0    → −60 dB (silent)
 *   pos 0.75 →  0 dB
 *   pos 1    → +6 dB
 */
const FADER_UNITY_POS = 0.75;
const FADER_MIN_DB = -60;
const FADER_MAX_DB = 6;

function positionToVolume(pos: number): number {
  if (pos <= 0) return 0;
  const db =
    pos <= FADER_UNITY_POS
      ? FADER_MIN_DB + (pos / FADER_UNITY_POS) * -FADER_MIN_DB
      : ((pos - FADER_UNITY_POS) / (1 - FADER_UNITY_POS)) * FADER_MAX_DB;
  return dbToLinear(db);
}

function volumeToPosition(volume: number): number {
  const db = linearToDb(volume);
  if (!Number.isFinite(db) || db <= FADER_MIN_DB) return 0;
  if (db <= 0) return ((db - FADER_MIN_DB) / -FADER_MIN_DB) * FADER_UNITY_POS;
  return FADER_UNITY_POS + (db / FADER_MAX_DB) * (1 - FADER_UNITY_POS);
}

// ─── Strip ──────────────────────────────────────────────────────────────

export function ChannelStrip({
  stem,
  state,
  loaded,
  anySoloed,
  host,
  active,
  onVolume,
  onPan,
  onMute,
  onSolo,
  onEq,
}: Props) {
  const effectivelyMuted = state.muted || (anySoloed && !state.soloed);

  return (
    <div className={`ch-strip ${effectivelyMuted ? 'muted' : ''}`}>
      <div className="ch-name" title={stem.name}>
        {stem.name}
      </div>
      <div className="ch-meta">
        {stem.channels === 1 ? 'mono' : 'stereo'} · {Math.round(stem.sampleRate / 1000)}k
        {!loaded && <div>(not loaded)</div>}
      </div>

      <div className="ch-eq">
        <div className="knob-wrap">
          <Knob
            value={state.eq.lo}
            min={EQ_KNOB_MIN_DB}
            max={EQ_KNOB_MAX_DB}
            defaultValue={0}
            ariaLabel={`${stem.name} EQ low`}
            onChange={(v) => onEq('lo', v)}
          />
          <span className="knob-label">Lo</span>
          <span className="knob-readout">{formatEqDb(state.eq.lo)}</span>
        </div>
        <div className="knob-wrap">
          <Knob
            value={state.eq.mid}
            min={EQ_KNOB_MIN_DB}
            max={EQ_KNOB_MAX_DB}
            defaultValue={0}
            ariaLabel={`${stem.name} EQ mid`}
            onChange={(v) => onEq('mid', v)}
          />
          <span className="knob-label">Mid</span>
          <span className="knob-readout">{formatEqDb(state.eq.mid)}</span>
        </div>
        <div className="knob-wrap">
          <Knob
            value={state.eq.hi}
            min={EQ_KNOB_MIN_DB}
            max={EQ_KNOB_MAX_DB}
            defaultValue={0}
            ariaLabel={`${stem.name} EQ high`}
            onChange={(v) => onEq('hi', v)}
          />
          <span className="knob-label">Hi</span>
          <span className="knob-readout">{formatEqDb(state.eq.hi)}</span>
        </div>
      </div>

      <div className="ch-pan-row">
        <div className="knob-wrap">
          <Knob
            variant="pan"
            value={state.pan}
            min={-1}
            max={1}
            defaultValue={0}
            ariaLabel={`${stem.name} pan`}
            onChange={onPan}
          />
          <span className="knob-label">Pan</span>
          <span className="knob-readout">{formatPan(state.pan)}</span>
        </div>
      </div>

      <div className="ch-fader-meter">
        <Meter host={host} stemId={stem.id} active={active && loaded} />
        <Fader
          position={volumeToPosition(state.volume)}
          ariaLabel={`${stem.name} volume`}
          onChange={(pos) => onVolume(positionToVolume(pos))}
          onReset={() => onVolume(1)}
        />
      </div>

      <div className="ch-buttons">
        <button
          type="button"
          aria-label={`${stem.name} solo`}
          aria-pressed={state.soloed}
          onClick={onSolo}
          className={`ch-btn solo ${state.soloed ? 'on' : ''}`}
        >
          S
        </button>
        <button
          type="button"
          aria-label={`${stem.name} mute`}
          aria-pressed={state.muted}
          onClick={onMute}
          className={`ch-btn mute ${state.muted ? 'on' : ''}`}
        >
          M
        </button>
      </div>

      <div className="ch-readout">
        <div className="ch-db">{formatDb(state.volume)} dB</div>
      </div>
    </div>
  );
}
