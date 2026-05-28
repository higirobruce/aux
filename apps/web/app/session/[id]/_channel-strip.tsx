'use client';

import type { Stem } from '@/lib/types';
import type { AudioHost } from '@aux/audio-engine';
import type { BusState, CompType } from '@aux/session-doc';
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
  onComp: (field: 'threshold' | 'ratio', value: number) => void;
  onCompType: (type: CompType) => void;
  /** Bus directory — used to populate the strip's output picker. */
  buses: Record<string, BusState>;
  onOutput: (busId: string) => void;
  /** Set a post-fader aux send level (creates the send if absent). */
  onSend: (busId: string, level: number) => void;
  /** Remove a post-fader aux send. */
  onRemoveSend: (busId: string) => void;
  /** Transient designer params (attack / sustain ∈ [-1, 1]). */
  onTransient: (field: 'attack' | 'sustain', value: number) => void;
  onTransientBypass: () => void;
  /** De-esser params: freq (2k..12k Hz), amount (0..1). */
  onDeEss: (field: 'freq' | 'amount', value: number) => void;
  onDeEssBypass: () => void;
  /** Imager width (0..2; 1 = unity). */
  onImager: (width: number) => void;
  onImagerBypass: () => void;
}

const EQ_KNOB_MIN_DB = -12;
const EQ_KNOB_MAX_DB = 12;

const COMP_THRESH_MIN = -40;
const COMP_THRESH_MAX = 0;
const COMP_RATIO_MIN = 1;
const COMP_RATIO_MAX = 10;

function formatEqDb(db: number): string {
  if (Math.abs(db) < 0.05) return '0';
  const sign = db > 0 ? '+' : '−';
  return `${sign}${Math.abs(db).toFixed(1)}`;
}

function formatThresh(db: number): string {
  if (Math.abs(db) < 0.05) return '0';
  return `−${Math.abs(db).toFixed(0)}`;
}

function formatRatio(r: number): string {
  return r < 1.05 ? '1:1' : `${r.toFixed(1)}:1`;
}

function formatTransient(v: number): string {
  if (Math.abs(v) < 0.02) return '0';
  const sign = v > 0 ? '+' : '−';
  return `${sign}${Math.round(Math.abs(v) * 100)}`;
}

function formatDeEssFreq(hz: number): string {
  if (hz >= 1000) return `${(hz / 1000).toFixed(hz % 1000 === 0 ? 0 : 1)}k`;
  return `${Math.round(hz)}`;
}

function formatDeEssAmount(v: number): string {
  return v < 0.01 ? 'off' : `${Math.round(v * 100)}`;
}

function formatImagerWidth(v: number): string {
  if (Math.abs(v - 1) < 0.02) return '1.00';
  return v.toFixed(2);
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
  onComp,
  onCompType,
  buses,
  onOutput,
  onSend,
  onRemoveSend,
  onTransient,
  onTransientBypass,
  onDeEss,
  onDeEssBypass,
  onImager,
  onImagerBypass,
}: Props) {
  const effectivelyMuted = state.muted || (anySoloed && !state.soloed);

  return (
    <div className={`ch-strip ${effectivelyMuted ? 'muted' : ''}`}>
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

      <div className="ch-comp">
        <fieldset className="ch-comp-type">
          <legend className="sr-only">{stem.name} comp flavour</legend>
          <label className={`ch-comp-type-btn ${state.compType === 'clean' ? 'on' : ''}`}>
            <input
              type="radio"
              name={`comp-type-${stem.id}`}
              value="clean"
              checked={state.compType === 'clean'}
              onChange={() => onCompType('clean')}
              className="sr-only"
            />
            Clean
          </label>
          <label className={`ch-comp-type-btn ${state.compType === 'color' ? 'on' : ''}`}>
            <input
              type="radio"
              name={`comp-type-${stem.id}`}
              value="color"
              checked={state.compType === 'color'}
              onChange={() => onCompType('color')}
              className="sr-only"
            />
            Color
          </label>
        </fieldset>
        <div className="ch-comp-knobs">
          <div className="knob-wrap">
            <Knob
              value={state.comp.threshold}
              min={COMP_THRESH_MIN}
              max={COMP_THRESH_MAX}
              defaultValue={0}
              ariaLabel={`${stem.name} comp threshold`}
              onChange={(v) => onComp('threshold', v)}
            />
            <span className="knob-label">Th</span>
            <span className="knob-readout">{formatThresh(state.comp.threshold)}</span>
          </div>
          <div className="knob-wrap">
            <Knob
              value={state.comp.ratio}
              min={COMP_RATIO_MIN}
              max={COMP_RATIO_MAX}
              defaultValue={1}
              ariaLabel={`${stem.name} comp ratio`}
              onChange={(v) => onComp('ratio', v)}
            />
            <span className="knob-label">Rt</span>
            <span className="knob-readout">{formatRatio(state.comp.ratio)}</span>
          </div>
        </div>
      </div>

      <div className="ch-transient">
        <button
          type="button"
          className={`ch-transient-toggle ${state.transient.bypassed ? '' : 'on'}`}
          onClick={onTransientBypass}
          aria-pressed={!state.transient.bypassed}
          title={
            state.transient.bypassed ? 'Transient bypassed — click to engage' : 'Transient active'
          }
        >
          Trans
        </button>
        <div className="ch-transient-knobs">
          <div className="knob-wrap">
            <Knob
              value={state.transient.attack}
              min={-1}
              max={1}
              defaultValue={0}
              ariaLabel={`${stem.name} transient attack`}
              onChange={(v) => onTransient('attack', v)}
            />
            <span className="knob-label">Att</span>
            <span className="knob-readout">{formatTransient(state.transient.attack)}</span>
          </div>
          <div className="knob-wrap">
            <Knob
              value={state.transient.sustain}
              min={-1}
              max={1}
              defaultValue={0}
              ariaLabel={`${stem.name} transient sustain`}
              onChange={(v) => onTransient('sustain', v)}
            />
            <span className="knob-label">Sus</span>
            <span className="knob-readout">{formatTransient(state.transient.sustain)}</span>
          </div>
        </div>
      </div>

      <div className="ch-deess">
        <button
          type="button"
          className={`ch-deess-toggle ${state.deess.bypassed ? '' : 'on'}`}
          onClick={onDeEssBypass}
          aria-pressed={!state.deess.bypassed}
          title={state.deess.bypassed ? 'De-ess bypassed — click to engage' : 'De-ess active'}
        >
          DeEss
        </button>
        <div className="ch-deess-knobs">
          <div className="knob-wrap">
            <Knob
              value={state.deess.freq}
              min={2000}
              max={12000}
              defaultValue={6000}
              ariaLabel={`${stem.name} de-ess frequency`}
              onChange={(v) => onDeEss('freq', v)}
            />
            <span className="knob-label">Frq</span>
            <span className="knob-readout">{formatDeEssFreq(state.deess.freq)}</span>
          </div>
          <div className="knob-wrap">
            <Knob
              value={state.deess.amount}
              min={0}
              max={1}
              defaultValue={0}
              ariaLabel={`${stem.name} de-ess amount`}
              onChange={(v) => onDeEss('amount', v)}
            />
            <span className="knob-label">Amt</span>
            <span className="knob-readout">{formatDeEssAmount(state.deess.amount)}</span>
          </div>
        </div>
      </div>

      <div className="ch-imager">
        <button
          type="button"
          className={`ch-imager-toggle ${state.imager.bypassed ? '' : 'on'}`}
          onClick={onImagerBypass}
          aria-pressed={!state.imager.bypassed}
          title={state.imager.bypassed ? 'Imager bypassed — click to engage' : 'Imager active'}
        >
          Img
        </button>
        <div className="ch-imager-knobs">
          <div className="knob-wrap">
            <Knob
              value={state.imager.width}
              min={0}
              max={2}
              defaultValue={1}
              ariaLabel={`${stem.name} imager width`}
              onChange={onImager}
            />
            <span className="knob-label">Wid</span>
            <span className="knob-readout">{formatImagerWidth(state.imager.width)}</span>
          </div>
        </div>
      </div>

      <SendsSection
        stemName={stem.name}
        buses={buses}
        outputBusId={state.outputBusId}
        sends={state.sends}
        onSend={onSend}
        onRemoveSend={onRemoveSend}
      />

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

      <div className="ch-output">
        <span className="ch-output-arrow" aria-hidden="true">
          →
        </span>
        <select
          aria-label={`${stem.name} output bus`}
          className="ch-output-select"
          value={state.outputBusId in buses ? state.outputBusId : 'master'}
          onChange={(e) => onOutput(e.target.value)}
        >
          {Object.values(buses).map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
      </div>
      {/* The track's scribble-strip name is rendered by MixerShell into a
          sibling row below .mixer-console — see <ChannelStripName> — so it
          stays always-visible regardless of how the engineer has scrolled
          the controls vertically. */}
    </div>
  );
}

/**
 * Scribble-strip name cell — rendered in the sibling row below the mixer
 * console. Each cell aligns 1:1 with a channel strip column above.
 */
export function ChannelStripName({
  stem,
  effectivelyMuted,
}: {
  stem: Stem;
  effectivelyMuted: boolean;
}) {
  return (
    <div className={`ch-name ${effectivelyMuted ? 'muted' : ''}`} title={stem.name}>
      {stem.name}
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────
 * Sends — post-fader aux routing
 * ──────────────────────────────────────────────────────────────────── */

interface SendsSectionProps {
  stemName: string;
  buses: Record<string, BusState>;
  outputBusId: string;
  sends: Record<string, number>;
  onSend: (busId: string, level: number) => void;
  onRemoveSend: (busId: string) => void;
}

const SEND_DEFAULT_LEVEL = 0.5;

/**
 * Compact sends sub-section. Hidden entirely when no candidate destination
 * buses exist (i.e. only Master, since sending to your own output bus is
 * usually a footgun). One row per active send; below the rows, a `+`
 * picker to add a new send.
 */
function SendsSection({
  stemName,
  buses,
  outputBusId,
  sends,
  onSend,
  onRemoveSend,
}: SendsSectionProps) {
  // Candidates = every bus except the channel's main output. (Master is
  // commonly the main output; sending back to it would double-route.)
  const candidates = Object.values(buses).filter((b) => b.id !== outputBusId);
  const activeSendIds = Object.keys(sends);
  const unusedCandidates = candidates.filter((b) => !activeSendIds.includes(b.id));

  if (candidates.length === 0 && activeSendIds.length === 0) return null;

  return (
    <div className="ch-sends">
      <div className="ch-sends-label">Sends</div>
      {activeSendIds.map((busId) => {
        const bus = buses[busId];
        if (!bus) return null;
        const level = sends[busId] ?? 0;
        return (
          <div key={busId} className="ch-send-row">
            <span className="ch-send-name" title={bus.name}>
              {bus.name}
            </span>
            <input
              type="range"
              min={0}
              max={1.5}
              step={0.01}
              value={level}
              onChange={(e) => onSend(busId, Number.parseFloat(e.target.value))}
              aria-label={`${stemName} send to ${bus.name}`}
              className="ch-send-slider"
            />
            <button
              type="button"
              className="ch-send-remove"
              onClick={() => onRemoveSend(busId)}
              aria-label={`Remove send to ${bus.name}`}
              title="Remove send"
            >
              ×
            </button>
          </div>
        );
      })}
      {unusedCandidates.length > 0 && (
        <select
          className="ch-send-add"
          value=""
          aria-label={`Add send for ${stemName}`}
          onChange={(e) => {
            const busId = e.target.value;
            if (busId) onSend(busId, SEND_DEFAULT_LEVEL);
          }}
        >
          <option value="">+ send…</option>
          {unusedCandidates.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
