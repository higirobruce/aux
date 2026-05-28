'use client';

import type { AudioHost, ReverbKind } from '@aux/audio-engine';
import type { BusState, LimiterState, ReverbState } from '@aux/session-doc';
import { useEffect, useRef, useState } from 'react';
import { Fader } from './_fader';
import { Knob } from './_knob';
import { Meter } from './_meter';

interface Props {
  bus: BusState;
  host: AudioHost | null;
  active: boolean;
  onGain: (value: number) => void;
  onMute: () => void;
  /** Provided only for user buses — Master is undeletable. */
  onDelete?: () => void;
  /** Provided only for user buses — Master's name is fixed. */
  onRename?: (name: string) => void;
  /** Master-only — limiter on the Master chain. */
  limiter?: LimiterState;
  onLimiter?: (field: 'thresholdDb' | 'releaseMs' | 'makeupDb', value: number) => void;
  onLimiterBypass?: () => void;
  /** User-bus-only — optional reverb insert (Plate or Hall). */
  reverb?: ReverbState;
  onAddReverb?: (kind: ReverbKind) => void;
  onRemoveReverb?: () => void;
  onReverb?: (field: 'decay' | 'damping' | 'preDelayMs' | 'mix', value: number) => void;
  onReverbBypass?: () => void;
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

function formatLimiterDb(db: number): string {
  if (Math.abs(db) < 0.05) return '0';
  const sign = db > 0 ? '+' : '−';
  return `${sign}${Math.abs(db).toFixed(1)}`;
}

/**
 * Bus strip — same visual language as ChannelStrip but stripped down to
 * the essentials. No EQ / comp / pan, just fader + meter + mute + dB
 * readout. Used today for the Master bus; will host user-created buses
 * once the routing UI lands.
 */
export function BusStrip({
  bus,
  host,
  active,
  onGain,
  onMute,
  onDelete,
  onRename,
  limiter,
  onLimiter,
  onLimiterBypass,
  reverb,
  onAddReverb,
  onRemoveReverb,
  onReverb,
  onReverbBypass,
}: Props) {
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState(bus.name);
  const inputRef = useRef<HTMLInputElement>(null);

  // When the parent renames externally (or another tab autosaves), keep the
  // draft in sync.
  useEffect(() => {
    if (!editing) setDraftName(bus.name);
  }, [bus.name, editing]);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  function commit() {
    setEditing(false);
    if (onRename && draftName.trim() && draftName.trim() !== bus.name) {
      onRename(draftName);
    } else {
      setDraftName(bus.name);
    }
  }

  function cancel() {
    setEditing(false);
    setDraftName(bus.name);
  }

  return (
    <div className={`ch-strip bus-strip ${bus.muted ? 'muted' : ''}`}>
      {editing && onRename ? (
        <input
          ref={inputRef}
          className="ch-name bus-name-edit"
          value={draftName}
          onChange={(e) => setDraftName(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            else if (e.key === 'Escape') cancel();
          }}
          maxLength={32}
          aria-label="Bus name"
        />
      ) : (
        <div
          className="ch-name"
          title={onRename ? 'Double-click to rename' : bus.name}
          onDoubleClick={() => onRename && setEditing(true)}
        >
          {bus.name}
          {onDelete && (
            <button
              type="button"
              className="bus-delete-btn"
              aria-label={`Delete ${bus.name}`}
              title="Delete bus"
              onClick={(e) => {
                e.stopPropagation();
                if (confirm(`Remove ${bus.name}? Channels routed here will return to Master.`)) {
                  onDelete();
                }
              }}
            >
              ×
            </button>
          )}
        </div>
      )}
      <div className="ch-meta">bus</div>

      {limiter && onLimiter && onLimiterBypass && (
        <div className="bus-limiter">
          <button
            type="button"
            className={`bus-limiter-toggle ${limiter.bypassed ? '' : 'on'}`}
            onClick={onLimiterBypass}
            aria-pressed={!limiter.bypassed}
            title={limiter.bypassed ? 'Limiter bypassed — click to engage' : 'Limiter active'}
          >
            Limiter
          </button>
          <div className="bus-limiter-knobs">
            <div className="knob-wrap">
              <Knob
                value={limiter.thresholdDb}
                min={-24}
                max={0}
                defaultValue={-1}
                ariaLabel="Limiter threshold"
                onChange={(v) => onLimiter('thresholdDb', v)}
              />
              <span className="knob-label">Th</span>
              <span className="knob-readout">{formatLimiterDb(limiter.thresholdDb)}</span>
            </div>
            <div className="knob-wrap">
              <Knob
                value={limiter.makeupDb}
                min={-12}
                max={24}
                defaultValue={0}
                ariaLabel="Limiter makeup"
                onChange={(v) => onLimiter('makeupDb', v)}
              />
              <span className="knob-label">Mk</span>
              <span className="knob-readout">{formatLimiterDb(limiter.makeupDb)}</span>
            </div>
          </div>
        </div>
      )}

      {onAddReverb && (
        <div className="bus-plate">
          {reverb ? (
            <>
              <div className="bus-plate-header">
                <select
                  className="bus-reverb-kind"
                  value={reverb.kind}
                  onChange={(e) => onAddReverb(e.target.value as ReverbKind)}
                  aria-label="Reverb kind"
                  title="Switch reverb kind"
                >
                  <option value="plate">Plate</option>
                  <option value="hall">Hall</option>
                </select>
                <button
                  type="button"
                  className={`bus-limiter-toggle ${reverb.bypassed ? '' : 'on'}`}
                  onClick={onReverbBypass}
                  aria-pressed={!reverb.bypassed}
                  title={reverb.bypassed ? 'Reverb bypassed — click to engage' : 'Reverb active'}
                >
                  On
                </button>
                {onRemoveReverb && (
                  <button
                    type="button"
                    className="bus-plate-remove"
                    aria-label="Remove reverb"
                    title="Remove reverb"
                    onClick={onRemoveReverb}
                  >
                    ×
                  </button>
                )}
              </div>
              <div className="bus-limiter-knobs">
                <div className="knob-wrap">
                  <Knob
                    value={reverb.decay}
                    min={0}
                    max={0.95}
                    defaultValue={reverb.kind === 'hall' ? 0.75 : 0.55}
                    ariaLabel="Reverb decay"
                    onChange={(v) => onReverb?.('decay', v)}
                  />
                  <span className="knob-label">Dcy</span>
                  <span className="knob-readout">{Math.round(reverb.decay * 100)}</span>
                </div>
                <div className="knob-wrap">
                  <Knob
                    value={reverb.damping}
                    min={0}
                    max={1}
                    defaultValue={reverb.kind === 'hall' ? 0.25 : 0.4}
                    ariaLabel="Reverb damping"
                    onChange={(v) => onReverb?.('damping', v)}
                  />
                  <span className="knob-label">Dmp</span>
                  <span className="knob-readout">{Math.round(reverb.damping * 100)}</span>
                </div>
              </div>
            </>
          ) : (
            <select
              className="bus-add-reverb-select"
              value=""
              aria-label="Add reverb"
              onChange={(e) => {
                const kind = e.target.value as ReverbKind | '';
                if (kind) onAddReverb(kind);
              }}
            >
              <option value="">+ reverb…</option>
              <option value="plate">Plate</option>
              <option value="hall">Hall</option>
            </select>
          )}
        </div>
      )}

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
