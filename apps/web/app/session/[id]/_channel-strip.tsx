'use client';

import type { Stem } from '@/lib/types';
import type { AudioHost } from '@aux/audio-engine';
import type { BusState, CompType } from '@aux/session-doc';
import type { Accent } from '@aux/ui';
import type { ReactNode } from 'react';
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
  onEqBypass: () => void;
  onComp: (field: 'threshold' | 'ratio', value: number) => void;
  onCompType: (type: CompType) => void;
  onCompBypass: () => void;
  /** Open a floating plugin window for this channel. */
  onOpenPlugin?: (type: 'eq' | 'comp' | 'trans') => void;
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
  /** Tape — driveDb (0..24), tone (-1..1), mix (0..1). */
  onTape: (field: 'driveDb' | 'tone' | 'mix', value: number) => void;
  onTapeBypass: () => void;
  /** Console — driveDb (0..24), character (0..1), mix (0..1). */
  onConsole: (field: 'driveDb' | 'character' | 'mix', value: number) => void;
  onConsoleBypass: () => void;
  /** MB-Comp — per-band thresholds (-40..0) + shared ratio (1..10). */
  onMbComp: (field: 'loThreshDb' | 'midThreshDb' | 'hiThreshDb' | 'ratio', value: number) => void;
  onMbCompBypass: () => void;
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

function formatTapeDrive(db: number): string {
  if (db < 0.05) return '0';
  return `+${db.toFixed(0)}`;
}

function formatTapeTone(v: number): string {
  if (Math.abs(v) < 0.02) return '0';
  const sign = v > 0 ? '+' : '−';
  return `${sign}${Math.round(Math.abs(v) * 100)}`;
}

function formatTapeMix(v: number): string {
  return v < 0.01 ? 'dry' : `${Math.round(v * 100)}`;
}

function formatConsoleCharacter(v: number): string {
  return v < 0.01 ? '0' : `${Math.round(v * 100)}`;
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

// ─── Insert accordion (design StripModule) ──────────────────────────────
// Each fixed-chain insert is a collapsible module: a header row with a
// toggle dot (filled = on → knobs shown; hollow = off → knobs hidden), the
// insert label, and a ↗ that opens the floating plugin window. Mirrors the
// design's StripModule.

const ACCENT_VAR: Record<Accent, string> = {
  gold: 'var(--gold)',
  rust: 'var(--rust)',
  sage: 'var(--sage)',
  teal: 'var(--teal)',
  mauve: 'var(--mauve)',
  violet: 'var(--violet)',
  red: 'var(--red)',
  green: 'var(--green)',
  neutral: 'var(--txt-2)',
};

function StripModule({
  label,
  accent,
  on,
  onToggle,
  onOpen,
  children,
}: {
  label: string;
  accent: Accent;
  /** Filled dot + knobs shown when true. */
  on: boolean;
  onToggle: () => void;
  /** Opens the floating plugin window (undefined → no ↗, header inert). */
  onOpen?: () => void;
  children: ReactNode;
}) {
  return (
    <div
      className="ch-mod"
      data-on={on}
      style={{ '--mod': ACCENT_VAR[accent] } as React.CSSProperties}
    >
      <div className="ch-mod-head2">
        <button
          type="button"
          className="ch-mod-dot"
          aria-pressed={on}
          aria-label={`${label} ${on ? 'on' : 'off'}`}
          title={on ? `${label} on — click to bypass` : `${label} off — click to engage`}
          onClick={onToggle}
        />
        <button
          type="button"
          className="ch-mod-open-btn"
          onClick={onOpen}
          disabled={!onOpen}
          title={onOpen ? `Open ${label}` : undefined}
        >
          <span className="ch-mod-label">{label}</span>
          {onOpen && (
            <span className="ch-mod-open" aria-hidden="true">
              ↗
            </span>
          )}
        </button>
      </div>
      {on && <div className="ch-mod-body">{children}</div>}
    </div>
  );
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
  onEqBypass,
  onComp,
  onCompType,
  onCompBypass,
  onOpenPlugin,
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
  onTape,
  onTapeBypass,
  onConsole,
  onConsoleBypass,
  onMbComp,
  onMbCompBypass,
}: Props) {
  const effectivelyMuted = state.muted || (anySoloed && !state.soloed);

  return (
    <div className={`ch-strip ${effectivelyMuted ? 'muted' : ''}`}>
      <div className="ch-meta">
        {stem.channels === 1 ? 'mono' : 'stereo'} · {Math.round(stem.sampleRate / 1000)}k
        {!loaded && <div>(not loaded)</div>}
      </div>

      {/* Processing chain scrolls inside the strip; the fader/meter footer
          below stays pinned (design: "scrollable only on the plugins"). */}
      <div className="ch-chain">
        <StripModule
          label="EQ"
          accent="gold"
          on={!state.eq.bypassed}
          onToggle={onEqBypass}
          onOpen={() => onOpenPlugin?.('eq')}
        >
          <div className="knob-wrap">
            <Knob
              value={state.eq.lo}
              min={EQ_KNOB_MIN_DB}
              max={EQ_KNOB_MAX_DB}
              defaultValue={0}
              accent="gold"
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
              accent="gold"
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
              accent="gold"
              ariaLabel={`${stem.name} EQ high`}
              onChange={(v) => onEq('hi', v)}
            />
            <span className="knob-label">Hi</span>
            <span className="knob-readout">{formatEqDb(state.eq.hi)}</span>
          </div>
        </StripModule>

        <StripModule
          label="COMP"
          accent="sage"
          on={!state.comp.bypassed}
          onToggle={onCompBypass}
          onOpen={() => onOpenPlugin?.('comp')}
        >
          <div className="ch-comp-stack">
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
                  accent="sage"
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
                  accent="sage"
                  ariaLabel={`${stem.name} comp ratio`}
                  onChange={(v) => onComp('ratio', v)}
                />
                <span className="knob-label">Rt</span>
                <span className="knob-readout">{formatRatio(state.comp.ratio)}</span>
              </div>
            </div>
          </div>
        </StripModule>

        <StripModule
          label="TRANS"
          accent="teal"
          on={!state.transient.bypassed}
          onToggle={onTransientBypass}
          onOpen={() => onOpenPlugin?.('trans')}
        >
          <div className="knob-wrap">
            <Knob
              value={state.transient.attack}
              min={-1}
              max={1}
              defaultValue={0}
              accent="teal"
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
              accent="teal"
              ariaLabel={`${stem.name} transient sustain`}
              onChange={(v) => onTransient('sustain', v)}
            />
            <span className="knob-label">Sus</span>
            <span className="knob-readout">{formatTransient(state.transient.sustain)}</span>
          </div>
        </StripModule>

        <StripModule
          label="DEESS"
          accent="teal"
          on={!state.deess.bypassed}
          onToggle={onDeEssBypass}
        >
          <div className="knob-wrap">
            <Knob
              value={state.deess.freq}
              min={2000}
              max={12000}
              defaultValue={6000}
              accent="teal"
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
              accent="teal"
              ariaLabel={`${stem.name} de-ess amount`}
              onChange={(v) => onDeEss('amount', v)}
            />
            <span className="knob-label">Amt</span>
            <span className="knob-readout">{formatDeEssAmount(state.deess.amount)}</span>
          </div>
        </StripModule>

        <StripModule
          label="IMG"
          accent="mauve"
          on={!state.imager.bypassed}
          onToggle={onImagerBypass}
        >
          <div className="knob-wrap">
            <Knob
              value={state.imager.width}
              min={0}
              max={2}
              defaultValue={1}
              accent="mauve"
              ariaLabel={`${stem.name} imager width`}
              onChange={onImager}
            />
            <span className="knob-label">Wid</span>
            <span className="knob-readout">{formatImagerWidth(state.imager.width)}</span>
          </div>
        </StripModule>

        <StripModule label="TAPE" accent="rust" on={!state.tape.bypassed} onToggle={onTapeBypass}>
          <div className="knob-wrap">
            <Knob
              value={state.tape.driveDb}
              min={0}
              max={24}
              defaultValue={0}
              accent="rust"
              ariaLabel={`${stem.name} tape drive`}
              onChange={(v) => onTape('driveDb', v)}
            />
            <span className="knob-label">Drv</span>
            <span className="knob-readout">{formatTapeDrive(state.tape.driveDb)}</span>
          </div>
          <div className="knob-wrap">
            <Knob
              value={state.tape.tone}
              min={-1}
              max={1}
              defaultValue={0}
              accent="rust"
              ariaLabel={`${stem.name} tape tone`}
              onChange={(v) => onTape('tone', v)}
            />
            <span className="knob-label">Tone</span>
            <span className="knob-readout">{formatTapeTone(state.tape.tone)}</span>
          </div>
          <div className="knob-wrap">
            <Knob
              value={state.tape.mix}
              min={0}
              max={1}
              defaultValue={0}
              accent="rust"
              ariaLabel={`${stem.name} tape mix`}
              onChange={(v) => onTape('mix', v)}
            />
            <span className="knob-label">Mix</span>
            <span className="knob-readout">{formatTapeMix(state.tape.mix)}</span>
          </div>
        </StripModule>

        <StripModule
          label="CONS"
          accent="violet"
          on={!state.console.bypassed}
          onToggle={onConsoleBypass}
        >
          <div className="knob-wrap">
            <Knob
              value={state.console.driveDb}
              min={0}
              max={24}
              defaultValue={0}
              accent="violet"
              ariaLabel={`${stem.name} console drive`}
              onChange={(v) => onConsole('driveDb', v)}
            />
            <span className="knob-label">Drv</span>
            <span className="knob-readout">{formatTapeDrive(state.console.driveDb)}</span>
          </div>
          <div className="knob-wrap">
            <Knob
              value={state.console.character}
              min={0}
              max={1}
              defaultValue={0}
              accent="violet"
              ariaLabel={`${stem.name} console character`}
              onChange={(v) => onConsole('character', v)}
            />
            <span className="knob-label">Cha</span>
            <span className="knob-readout">{formatConsoleCharacter(state.console.character)}</span>
          </div>
          <div className="knob-wrap">
            <Knob
              value={state.console.mix}
              min={0}
              max={1}
              defaultValue={0}
              accent="violet"
              ariaLabel={`${stem.name} console mix`}
              onChange={(v) => onConsole('mix', v)}
            />
            <span className="knob-label">Mix</span>
            <span className="knob-readout">{formatTapeMix(state.console.mix)}</span>
          </div>
        </StripModule>

        <StripModule
          label="MBC"
          accent="sage"
          on={!state.mbcomp.bypassed}
          onToggle={onMbCompBypass}
        >
          <div className="knob-wrap">
            <Knob
              value={state.mbcomp.loThreshDb}
              min={COMP_THRESH_MIN}
              max={COMP_THRESH_MAX}
              defaultValue={0}
              accent="sage"
              ariaLabel={`${stem.name} MB-Comp low threshold`}
              onChange={(v) => onMbComp('loThreshDb', v)}
            />
            <span className="knob-label">Lo</span>
            <span className="knob-readout">{formatThresh(state.mbcomp.loThreshDb)}</span>
          </div>
          <div className="knob-wrap">
            <Knob
              value={state.mbcomp.midThreshDb}
              min={COMP_THRESH_MIN}
              max={COMP_THRESH_MAX}
              defaultValue={0}
              accent="sage"
              ariaLabel={`${stem.name} MB-Comp mid threshold`}
              onChange={(v) => onMbComp('midThreshDb', v)}
            />
            <span className="knob-label">Mid</span>
            <span className="knob-readout">{formatThresh(state.mbcomp.midThreshDb)}</span>
          </div>
          <div className="knob-wrap">
            <Knob
              value={state.mbcomp.hiThreshDb}
              min={COMP_THRESH_MIN}
              max={COMP_THRESH_MAX}
              defaultValue={0}
              accent="sage"
              ariaLabel={`${stem.name} MB-Comp high threshold`}
              onChange={(v) => onMbComp('hiThreshDb', v)}
            />
            <span className="knob-label">Hi</span>
            <span className="knob-readout">{formatThresh(state.mbcomp.hiThreshDb)}</span>
          </div>
          <div className="knob-wrap">
            <Knob
              value={state.mbcomp.ratio}
              min={COMP_RATIO_MIN}
              max={COMP_RATIO_MAX}
              defaultValue={4}
              accent="sage"
              ariaLabel={`${stem.name} MB-Comp ratio`}
              onChange={(v) => onMbComp('ratio', v)}
            />
            <span className="knob-label">Rat</span>
            <span className="knob-readout">{formatRatio(state.mbcomp.ratio)}</span>
          </div>
        </StripModule>

        <SendsSection
          stemName={stem.name}
          buses={buses}
          outputBusId={state.outputBusId}
          sends={state.sends}
          onSend={onSend}
          onRemoveSend={onRemoveSend}
        />
      </div>

      {/* Footer: fader + meter, with pan on the right, vertically centered. */}
      <div className="ch-fader-meter">
        <Fader
          position={volumeToPosition(state.volume)}
          ariaLabel={`${stem.name} volume`}
          onChange={(pos) => onVolume(positionToVolume(pos))}
          onReset={() => onVolume(1)}
        />
        <Meter host={host} stemId={stem.id} active={active && loaded} />
        <div className="knob-wrap ch-pan-side">
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
      {/* Track name — pinned at the bottom of the strip (design: the name is
          part of the channel strip, not a separate scribble row). */}
      <div className="ch-name" title={stem.name}>
        {stem.name}
      </div>
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
