'use client';

import type { AudioHost } from '@aux/audio-engine';
import type { BusState } from '@aux/session-doc';
import { Fader } from './_fader';
import { Meter } from './_meter';

interface Props {
  bus: BusState;
  host: AudioHost | null;
  active: boolean;
  onGain: (value: number) => void;
  onMute: () => void;
}

// Same dB ↔ position mapping as the channel fader.
const FADER_UNITY_POS = 0.75;
const FADER_MIN_DB = -60;
const FADER_MAX_DB = 6;

function linearToDb(x: number): number {
  return x > 0 ? 20 * Math.log10(x) : Number.NEGATIVE_INFINITY;
}
function dbToLinear(db: number): number {
  return 10 ** (db / 20);
}

function positionToGain(pos: number): number {
  if (pos <= 0) return 0;
  const db =
    pos <= FADER_UNITY_POS
      ? FADER_MIN_DB + (pos / FADER_UNITY_POS) * -FADER_MIN_DB
      : ((pos - FADER_UNITY_POS) / (1 - FADER_UNITY_POS)) * FADER_MAX_DB;
  return dbToLinear(db);
}

function gainToPosition(gain: number): number {
  const db = linearToDb(gain);
  if (!Number.isFinite(db) || db <= FADER_MIN_DB) return 0;
  if (db <= 0) return ((db - FADER_MIN_DB) / -FADER_MIN_DB) * FADER_UNITY_POS;
  return FADER_UNITY_POS + (db / FADER_MAX_DB) * (1 - FADER_UNITY_POS);
}

function formatDb(gain: number): string {
  const db = linearToDb(gain);
  if (!Number.isFinite(db)) return '−∞';
  const sign = db > 0 ? '+' : db < 0 ? '−' : '';
  return `${sign}${Math.abs(db).toFixed(1)}`;
}

/**
 * Bus strip — same visual language as ChannelStrip but stripped down to
 * the essentials. No EQ / comp / pan, just fader + meter + mute + dB
 * readout. Used today for the Master bus; will host user-created buses
 * once the routing UI lands.
 */
export function BusStrip({ bus, host, active, onGain, onMute }: Props) {
  return (
    <div className={`ch-strip bus-strip ${bus.muted ? 'muted' : ''}`}>
      <div className="ch-name" title={bus.name}>
        {bus.name}
      </div>
      <div className="ch-meta">bus</div>

      <div className="ch-fader-meter">
        <Meter host={host} stemId={bus.id} active={active} variant="bus" />
        <Fader
          position={gainToPosition(bus.gain)}
          ariaLabel={`${bus.name} gain`}
          onChange={(pos) => onGain(positionToGain(pos))}
          onReset={() => onGain(1)}
        />
      </div>

      <div className="ch-buttons">
        <button
          type="button"
          aria-label={`${bus.name} mute`}
          aria-pressed={bus.muted}
          onClick={onMute}
          className={`ch-btn mute ${bus.muted ? 'on' : ''}`}
        >
          M
        </button>
      </div>

      <div className="ch-readout">
        <div className="ch-db">{formatDb(bus.gain)} dB</div>
      </div>
    </div>
  );
}
