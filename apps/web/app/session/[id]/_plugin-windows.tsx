'use client';

/**
 * Floating plugin windows (warm-analog redesign, phase 5). A lightweight
 * manager renders the open windows over the mixer; each is wired to the real
 * audio engine for the focused channel. EQ shows a live response curve over
 * the channel's real spectrum; Compressor shows a transfer curve + real
 * gain-reduction meter. More modules follow the same pattern.
 */

import type { AudioHost, Loudness } from '@aux/audio-engine';
import type { EqFullBand, LimiterState, PitchKey, PitchScale } from '@aux/session-doc';
import { Knob, Readout, Segmented, Spectrum, Toggle, WindowFrame, clamp } from '@aux/ui';
import { useEffect, useRef, useState } from 'react';
import type { ChannelState, CompField, EqBand } from './_mixer-shell';

export type PluginType = 'eq' | 'comp' | 'trans' | 'tape' | 'img' | 'limiter' | 'pitch';
export interface OpenPlugin {
  type: PluginType;
  stemId: string;
}

interface HostBundle {
  host: AudioHost | null;
  channelState: Record<string, ChannelState>;
  stemName: (id: string) => string;
  onEq: (stemId: string, band: EqBand, db: number) => void;
  onEqBand: (stemId: string, bandId: number, patch: Partial<EqFullBand>) => void;
  onEqAnalyzer: (stemId: string, analyzer: boolean) => void;
  onEqBypass: (stemId: string) => void;
  onComp: (stemId: string, field: CompField, value: number) => void;
  onCompType: (stemId: string, type: 'clean' | 'color') => void;
  onCompBypass: (stemId: string) => void;
  onTransient: (stemId: string, field: 'attack' | 'sustain' | 'sens', value: number) => void;
  onTransientMode: (stemId: string, mode: 'WIDE' | 'TIGHT') => void;
  onTransientBypass: (stemId: string) => void;
  onTape: (stemId: string, field: 'driveDb' | 'tone' | 'mix' | 'bias', value: number) => void;
  onTapeMode: (stemId: string, mode: 'TAPE' | 'TUBE' | 'TRANS') => void;
  onTapeBypass: (stemId: string) => void;
  onImager: (stemId: string, width: number) => void;
  onImagerBalance: (stemId: string, balance: number) => void;
  onImagerMode: (stemId: string, mode: 'STEREO' | 'MS') => void;
  onImagerBypass: (stemId: string) => void;
  /** Master limiter (the only master-bus plugin). */
  limiter: LimiterState;
  onLimiter: (field: 'thresholdDb' | 'releaseMs' | 'makeupDb', value: number) => void;
  onLimiterStyle: (style: 'CLEAR' | 'PUNCH' | 'GLUE' | 'SAFE') => void;
  onLimiterBypass: () => void;
  onPitch: (stemId: string, field: 'speed' | 'amount' | 'human' | 'formant', value: number) => void;
  onPitchKey: (stemId: string, key: PitchKey) => void;
  onPitchScale: (stemId: string, scale: PitchScale) => void;
  onPitchBypass: (stemId: string) => void;
}

/* ============================================================
   Parametric EQ — 5 draggable bands, live spectrum, response curve
   ============================================================ */
const EQ_FMIN = 20;
const EQ_FMAX = 20000;
const EQ_RANGE = 18; // ± dB shown on the graph
const fToX = (f: number, W: number) => (Math.log(f / EQ_FMIN) / Math.log(EQ_FMAX / EQ_FMIN)) * W;
const xToF = (x: number, W: number) => EQ_FMIN * (EQ_FMAX / EQ_FMIN) ** (x / W);
const gToY = (g: number, H: number) => H / 2 - (g / EQ_RANGE) * (H / 2 - 8);
const yToG = (y: number, H: number) => ((H / 2 - y) / (H / 2 - 8)) * EQ_RANGE;

const BAND_COLORS = ['#cf6b39', '#e7a948', '#9aa85e', '#4fa39b', '#b285ac'];

function bandMag(band: EqFullBand, f: number): number {
  if (!band.on) return 0;
  const lf = Math.log(f);
  const lc = Math.log(band.freq);
  if (band.type === 'peak') {
    const bw = 1.0 / band.q;
    return band.gain * Math.exp(-(((lf - lc) / bw) ** 2));
  }
  if (band.type === 'lowshelf') return band.gain * (1 / (1 + Math.exp((lf - lc) * 2.2)));
  if (band.type === 'highshelf') return band.gain * (1 / (1 + Math.exp(-(lf - lc) * 2.2)));
  if (band.type === 'hp') return lf < lc ? -((lc - lf) * 12) : 0;
  if (band.type === 'lp') return lf > lc ? -((lf - lc) * 12) : 0;
  return 0;
}

const fmtFreq = (f: number) =>
  f >= 1000 ? `${(f / 1000).toFixed(f < 10000 ? 2 : 1)}k` : `${Math.round(f)}`;

/* ============================================================
   Compressor — soft-knee transfer curve + threshold marker + moving dot
   ============================================================ */
type CompShape = { threshold: number; ratio: number; knee: number; makeup: number };

/** Soft-knee transfer fn (in dB → out dB), matching the design. */
function compTransfer(x: number, s: CompShape): number {
  const { threshold: th, ratio: r, knee: kn } = s;
  if (x < th - kn / 2) return x;
  if (x > th + kn / 2) return th + (x - th) / r;
  const d = x - th + kn / 2;
  return x + ((1 / r - 1) * d * d) / (2 * kn || 1);
}

const COMP_GRAPH = 200;

/** dB from a 0..1 peak level (−60 floor when silent). */
function levelToDb(level: number): number {
  return level > 0.0001 ? Math.max(-60, 20 * Math.log10(level)) : -60;
}

function CompGraph({ shape, getInDb }: { shape: CompShape; getInDb: () => number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const s = useRef(shape);
  s.current = shape;
  const inDbFn = useRef(getInDb);
  inDbFn.current = getInDb;
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    let raf = 0;
    const draw = () => {
      const W = COMP_GRAPH;
      const H = COMP_GRAPH;
      cv.width = W * dpr;
      cv.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      const sh = s.current;
      const toX = (db: number) => ((db + 60) / 60) * W;
      const toY = (db: number) => H - ((db + 60) / 66) * H;
      // grid
      ctx.strokeStyle = 'var(--line)';
      ctx.lineWidth = 1;
      for (const g of [-48, -36, -24, -12]) {
        ctx.beginPath();
        ctx.moveTo(toX(g), 0);
        ctx.lineTo(toX(g), H);
        ctx.moveTo(0, toY(g));
        ctx.lineTo(W, toY(g));
        ctx.stroke();
      }
      // 1:1 reference
      ctx.strokeStyle = 'var(--txt-3)';
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(toX(-60), toY(-60));
      ctx.lineTo(toX(0), toY(0));
      ctx.stroke();
      ctx.setLineDash([]);
      // transfer curve
      ctx.strokeStyle = '#9aa85e';
      ctx.lineWidth = 2;
      ctx.shadowColor = 'rgba(154,168,94,0.6)';
      ctx.shadowBlur = 5;
      ctx.beginPath();
      for (let db = -60; db <= 0; db += 1) {
        const y = compTransfer(db, sh) + sh.makeup;
        const px = toX(db);
        const py = Math.max(0, Math.min(H, toY(y)));
        if (db === -60) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
      ctx.shadowBlur = 0;
      // threshold marker
      ctx.strokeStyle = 'rgba(231,169,72,0.7)';
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(toX(sh.threshold), 0);
      ctx.lineTo(toX(sh.threshold), H);
      ctx.stroke();
      ctx.setLineDash([]);
      // live operating-point dot — real channel input level → transfer curve
      const inDb = inDbFn.current();
      if (inDb > -60) {
        const outDb = compTransfer(inDb, sh) + sh.makeup;
        ctx.fillStyle = '#e7a948';
        ctx.shadowColor = '#e7a948';
        ctx.shadowBlur = 6;
        ctx.beginPath();
        ctx.arc(toX(inDb), toY(outDb), 4, 0, 7);
        ctx.fill();
        ctx.shadowBlur = 0;
      }
      raf = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, []);
  return <canvas ref={ref} style={{ width: COMP_GRAPH, height: COMP_GRAPH, display: 'block' }} />;
}

/** Horizontal gain-reduction meter (draws right→left), fed by the real engine. */
function GrMeterH({
  getGr,
  max = 20,
  width = 220,
}: { getGr: () => number; max?: number; width?: number }) {
  const fillRef = useRef<HTMLDivElement>(null);
  const valRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const gr = Math.max(0, getGr());
      const pct = Math.min(1, gr / max) * 100;
      if (fillRef.current) fillRef.current.style.width = `${pct}%`;
      if (valRef.current) valRef.current.textContent = `-${gr.toFixed(1)} dB`;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [getGr, max]);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, width }}>
      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
        <span className="lbl" style={{ fontSize: 8 }}>
          GAIN REDUCTION
        </span>
        <span ref={valRef} className="val" style={{ fontSize: 10, color: 'var(--sage)' }}>
          -0.0 dB
        </span>
      </div>
      <div
        style={{
          position: 'relative',
          height: 12,
          background: 'var(--inset)',
          borderRadius: 3,
          overflow: 'hidden',
          boxShadow: 'inset 0 0 0 1px var(--line)',
        }}
      >
        <div
          ref={fillRef}
          style={{
            position: 'absolute',
            right: 0,
            top: 0,
            bottom: 0,
            width: '0%',
            background: 'linear-gradient(90deg,var(--sage),var(--gold))',
          }}
        />
        {[5, 10, 15].map((tk) => (
          <div
            key={tk}
            style={{
              position: 'absolute',
              right: `${(tk / max) * 100}%`,
              top: 0,
              bottom: 0,
              width: 1,
              background: 'var(--line)',
            }}
          />
        ))}
      </div>
    </div>
  );
}

const EQ_W = 500;
const EQ_H = 230;
const EQ_GRID_F = [50, 100, 200, 500, 1000, 2000, 5000, 10000];
const EQ_GRID_G = [-12, -6, 0, 6, 12];
const eqColor = (id: number) => BAND_COLORS[id % BAND_COLORS.length] ?? '#e7a948';

function EqWindow({
  b,
  p,
  z,
  onClose,
  onFocus,
}: { b: HostBundle; p: OpenPlugin; z: number; onClose: () => void; onFocus: () => void }) {
  const ch = b.channelState[p.stemId];
  const [sel, setSel] = useState(1);
  const wrapRef = useRef<HTMLDivElement>(null);
  if (!ch) return null;

  const bands = ch.eqFull.bands;
  const analyzer = ch.eqFull.analyzer;
  const setBand = (id: number, patch: Partial<EqFullBand>) => b.onEqBand(p.stemId, id, patch);
  const selBand = bands.find((x) => x.id === sel) ?? bands[0];
  if (!selBand) return null;

  const totalMag = (f: number) => bands.reduce((a, band) => a + bandMag(band, f), 0);
  const pts: string[] = [];
  for (let x = 0; x <= EQ_W; x += 3) {
    const g = clamp(totalMag(xToF(x, EQ_W)), -EQ_RANGE, EQ_RANGE);
    pts.push(`${x},${gToY(g, EQ_H).toFixed(1)}`);
  }
  const curvePath = `M${pts.join(' L')}`;
  const fillPath = `M0,${EQ_H / 2} L${pts.join(' L')} L${EQ_W},${EQ_H / 2} Z`;

  const dragNode = (band: EqFullBand) => (e: React.PointerEvent) => {
    e.stopPropagation();
    setSel(band.id);
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect) return;
    const move = (ev: PointerEvent) => {
      const x = clamp(ev.clientX - rect.left, 0, EQ_W);
      const y = clamp(ev.clientY - rect.top, 0, EQ_H);
      const patch: Partial<EqFullBand> = { freq: clamp(xToF(x, EQ_W), EQ_FMIN, EQ_FMAX) };
      if (band.type !== 'hp' && band.type !== 'lp')
        patch.gain = clamp(yToG(y, EQ_H), -EQ_RANGE, EQ_RANGE);
      setBand(band.id, patch);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const wheelQ = (band: EqFullBand) => (e: React.WheelEvent) => {
    if (band.type === 'hp' || band.type === 'lp') return;
    setBand(band.id, { q: clamp(band.q + (e.deltaY < 0 ? 0.1 : -0.1), 0.2, 6) });
  };

  return (
    <WindowFrame
      title="PARAMETRIC EQ"
      sub={`5-BAND · ${b.stemName(p.stemId)}`}
      accent="gold"
      width={524}
      z={z}
      initial={{ x: 340, y: 96 }}
      onClose={onClose}
      onFocus={onFocus}
      bypass={ch.eq.bypassed}
      onBypass={() => b.onEqBypass(p.stemId)}
    >
      <div style={{ padding: 12 }}>
        <div
          ref={wrapRef}
          style={{
            position: 'relative',
            width: EQ_W,
            height: EQ_H,
            background: 'var(--inset)',
            borderRadius: 'var(--r-md)',
            overflow: 'hidden',
            border: '1px solid var(--line)',
            cursor: 'crosshair',
          }}
        >
          {analyzer && (
            <div style={{ position: 'absolute', inset: 0, opacity: 0.4 }}>
              <Spectrum
                accent="gold"
                height={EQ_H}
                bins={110}
                getData={(out) => b.host?.getChannelFrequencyData(p.stemId, out) ?? false}
              />
            </div>
          )}
          <svg
            width={EQ_W}
            height={EQ_H}
            style={{ position: 'absolute', inset: 0 }}
            aria-label="EQ response"
          >
            <title>EQ response curve</title>
            {EQ_GRID_F.map((f) => (
              <line
                key={f}
                x1={fToX(f, EQ_W)}
                y1={0}
                x2={fToX(f, EQ_W)}
                y2={EQ_H}
                stroke="var(--line)"
              />
            ))}
            {EQ_GRID_F.map((f) => (
              <text
                key={`t${f}`}
                x={fToX(f, EQ_W) + 3}
                y={EQ_H - 5}
                fill="var(--txt-3)"
                fontSize="8"
                fontFamily="var(--mono)"
              >
                {f >= 1000 ? `${f / 1000}k` : f}
              </text>
            ))}
            {EQ_GRID_G.map((g) => (
              <line
                key={g}
                x1={0}
                y1={gToY(g, EQ_H)}
                x2={EQ_W}
                y2={gToY(g, EQ_H)}
                stroke={g === 0 ? 'var(--line-2)' : 'var(--line)'}
                strokeDasharray={g === 0 ? '' : '2 4'}
              />
            ))}
            <path d={fillPath} fill="var(--gold)" opacity="0.1" />
            <path
              d={curvePath}
              fill="none"
              stroke="var(--gold)"
              strokeWidth="2"
              style={{ filter: 'drop-shadow(0 0 5px rgba(231,169,72,0.6))' }}
            />
            {bands.map((band) => {
              const x = fToX(band.freq, EQ_W);
              const y = band.type === 'hp' || band.type === 'lp' ? EQ_H / 2 : gToY(band.gain, EQ_H);
              const c = eqColor(band.id);
              return (
                <g
                  key={band.id}
                  onPointerDown={dragNode(band)}
                  onWheel={wheelQ(band)}
                  style={{ cursor: 'grab' }}
                >
                  {band.id === sel && (
                    <circle
                      cx={x}
                      cy={y}
                      r="13"
                      fill="none"
                      stroke={c}
                      strokeWidth="1"
                      opacity="0.4"
                    />
                  )}
                  <circle
                    cx={x}
                    cy={y}
                    r={band.id === sel ? 8 : 6}
                    fill={band.on ? c : 'var(--bg-3)'}
                    stroke={band.on ? 'var(--bg-0)' : c}
                    strokeWidth="1.5"
                    style={{ filter: band.id === sel ? `drop-shadow(0 0 6px ${c})` : 'none' }}
                  />
                  <text
                    x={x}
                    y={y + 3}
                    textAnchor="middle"
                    fill={band.on ? 'var(--bg-0)' : c}
                    fontSize="8"
                    fontWeight="700"
                    fontFamily="var(--mono)"
                    style={{ pointerEvents: 'none' }}
                  >
                    {band.id + 1}
                  </text>
                </g>
              );
            })}
          </svg>
        </div>

        <div style={{ display: 'flex', gap: 10, marginTop: 12, alignItems: 'center' }}>
          <div style={{ display: 'flex', gap: 4 }}>
            {bands.map((band) => (
              <button
                type="button"
                key={band.id}
                onClick={() => setSel(band.id)}
                className="lbl"
                style={{
                  width: 26,
                  height: 26,
                  borderRadius: 4,
                  fontSize: 11,
                  fontWeight: 700,
                  cursor: 'pointer',
                  border: `1px solid ${band.id === sel ? eqColor(band.id) : 'var(--line-2)'}`,
                  background: band.id === sel ? `${eqColor(band.id)}22` : 'transparent',
                  color: band.on ? eqColor(band.id) : 'var(--txt-3)',
                }}
              >
                {band.id + 1}
              </button>
            ))}
          </div>
          <div style={{ width: 1, height: 44, background: 'var(--line)' }} />
          <div style={{ display: 'flex', gap: 14, alignItems: 'center', flex: 1 }}>
            <Readout label="TYPE" value={selBand.type.toUpperCase()} accent="gold" />
            <Knob
              size={40}
              label="FREQ"
              value={Math.log(selBand.freq)}
              min={Math.log(EQ_FMIN)}
              max={Math.log(EQ_FMAX)}
              accent="gold"
              display={fmtFreq(selBand.freq)}
              ariaLabel="band frequency"
              onChange={(v) => setBand(selBand.id, { freq: clamp(Math.exp(v), EQ_FMIN, EQ_FMAX) })}
            />
            {selBand.type !== 'hp' && selBand.type !== 'lp' && (
              <Knob
                size={40}
                label="GAIN"
                value={selBand.gain}
                min={-EQ_RANGE}
                max={EQ_RANGE}
                bipolar
                defaultValue={0}
                accent="gold"
                display={(selBand.gain >= 0 ? '+' : '') + selBand.gain.toFixed(1)}
                ariaLabel="band gain"
                onChange={(v) => setBand(selBand.id, { gain: v })}
              />
            )}
            {selBand.type === 'peak' && (
              <Knob
                size={40}
                label="Q"
                value={selBand.q}
                min={0.2}
                max={6}
                defaultValue={1}
                accent="gold"
                display={selBand.q.toFixed(2)}
                ariaLabel="band Q"
                onChange={(v) => setBand(selBand.id, { q: v })}
              />
            )}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <Toggle
              on={analyzer}
              accent="gold"
              mini
              onClick={() => b.onEqAnalyzer(p.stemId, !analyzer)}
            >
              ANALYZER
            </Toggle>
            <Toggle
              on={selBand.on}
              accent="gold"
              mini
              onClick={() => setBand(selBand.id, { on: !selBand.on })}
            >
              BAND {selBand.on ? 'ON' : 'OFF'}
            </Toggle>
          </div>
        </div>
      </div>
    </WindowFrame>
  );
}

function CompWindow({
  b,
  p,
  z,
  onClose,
  onFocus,
}: { b: HostBundle; p: OpenPlugin; z: number; onClose: () => void; onFocus: () => void }) {
  const ch = b.channelState[p.stemId];
  if (!ch) return null;
  const c = ch.comp;
  const getGr = () =>
    b.host
      ? ch.compType === 'color'
        ? b.host.getChannelCompColorGr(p.stemId)
        : b.host.getChannelCompGr(p.stemId)
      : 0;
  return (
    <WindowFrame
      title="COMPRESSOR"
      sub={`${ch.compType === 'color' ? 'FET' : 'VCA'} · ${b.stemName(p.stemId)}`}
      accent="sage"
      width={470}
      z={z}
      initial={{ x: 400, y: 140 }}
      onClose={onClose}
      onFocus={onFocus}
      bypass={c.bypassed}
      onBypass={() => b.onCompBypass(p.stemId)}
    >
      <div style={{ display: 'flex', gap: 12, padding: 12 }}>
        <div
          style={{
            width: COMP_GRAPH,
            height: COMP_GRAPH,
            flexShrink: 0,
            position: 'relative',
            background: 'var(--inset)',
            borderRadius: 'var(--r-md)',
            border: '1px solid var(--line)',
            overflow: 'hidden',
          }}
        >
          <CompGraph
            shape={{ threshold: c.threshold, ratio: c.ratio, knee: c.knee, makeup: c.makeupDb }}
            getInDb={() => levelToDb(b.host?.getChannelLevel(p.stemId) ?? 0)}
          />
          <span
            className="lbl"
            style={{
              position: 'absolute',
              bottom: 4,
              right: 6,
              fontSize: 8,
              color: 'var(--txt-3)',
            }}
          >
            IN → OUT
          </span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, flex: 1 }}>
          <Segmented
            options={[
              { value: 'clean', label: 'CLEAN' },
              { value: 'color', label: 'COLOR' },
            ]}
            value={ch.compType}
            accent="sage"
            onChange={(v) => b.onCompType(p.stemId, v as 'clean' | 'color')}
          />
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(3,1fr)',
              gap: 10,
              justifyItems: 'center',
            }}
          >
            <Knob
              size={44}
              label="THRESH"
              value={c.threshold}
              min={-40}
              max={0}
              defaultValue={0}
              accent="sage"
              display={c.threshold.toFixed(1)}
              ariaLabel="threshold"
              onChange={(v) => b.onComp(p.stemId, 'threshold', v)}
            />
            <Knob
              size={44}
              label="RATIO"
              value={c.ratio}
              min={1}
              max={12}
              defaultValue={2}
              accent="sage"
              display={`${c.ratio.toFixed(1)}:1`}
              ariaLabel="ratio"
              onChange={(v) => b.onComp(p.stemId, 'ratio', v)}
            />
            <Knob
              size={44}
              label="KNEE"
              value={c.knee}
              min={0}
              max={24}
              defaultValue={6}
              accent="sage"
              display={c.knee.toFixed(0)}
              ariaLabel="knee"
              onChange={(v) => b.onComp(p.stemId, 'knee', v)}
            />
            <Knob
              size={44}
              label="ATTACK"
              value={c.attackMs}
              min={0.1}
              max={100}
              defaultValue={10}
              accent="sage"
              display={c.attackMs.toFixed(1)}
              unit="ms"
              ariaLabel="attack"
              onChange={(v) => b.onComp(p.stemId, 'attackMs', v)}
            />
            <Knob
              size={44}
              label="RELEASE"
              value={c.releaseMs}
              min={10}
              max={1000}
              defaultValue={120}
              accent="sage"
              display={c.releaseMs.toFixed(0)}
              unit="ms"
              ariaLabel="release"
              onChange={(v) => b.onComp(p.stemId, 'releaseMs', v)}
            />
            <Knob
              size={44}
              label="MAKEUP"
              value={c.makeupDb}
              min={0}
              max={24}
              defaultValue={0}
              accent="gold"
              display={`+${c.makeupDb.toFixed(1)}`}
              ariaLabel="makeup"
              onChange={(v) => b.onComp(p.stemId, 'makeupDb', v)}
            />
          </div>
          <GrMeterH getGr={getGr} />
        </div>
      </div>
    </WindowFrame>
  );
}

/* ============================================================
   Transient designer — envelope visualiser + attack/sustain shaper
   ============================================================ */
const TRANS_W = 280;
const TRANS_H = 130;

function TransGraph({
  attack,
  sustain,
  getLevel,
}: { attack: number; sustain: number; getLevel: () => number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const v = useRef({ attack, sustain });
  v.current = { attack, sustain };
  const lvlFn = useRef(getLevel);
  lvlFn.current = getLevel;
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    let raf = 0;
    let smooth = 0;
    const draw = () => {
      const W = TRANS_W;
      const H = TRANS_H;
      cv.width = W * dpr;
      cv.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      const { attack: a, sustain: s } = v.current;
      const aBoost = 1 + a;
      const sBoost = 1 + s;
      // Live signal scales the shaped envelope's amplitude.
      const lvl = clamp(lvlFn.current(), 0, 1);
      smooth += (lvl - smooth) * 0.25;
      const energy = 0.08 + 0.92 * smooth;
      const pts: [number, number][] = [];
      for (let x = 0; x <= W; x += 2) {
        const hit = ((x / W) * 4) % 1;
        const att = Math.exp(-hit * 30) * aBoost;
        const sus = Math.exp(-hit * 3) * 0.5 * sBoost;
        const val = clamp(Math.max(att, sus) * energy, 0, 1.6);
        pts.push([x, H - val * (H - 10) * 0.6 - 4]);
      }
      // baseline
      ctx.strokeStyle = 'var(--line-2)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, H - 4);
      ctx.lineTo(W, H - 4);
      ctx.stroke();
      // fill
      ctx.beginPath();
      ctx.moveTo(0, H - 4);
      for (const [x, y] of pts) ctx.lineTo(x, y);
      ctx.lineTo(W, H - 4);
      ctx.closePath();
      ctx.fillStyle = 'rgba(79,163,155,0.1)';
      ctx.fill();
      // envelope line
      ctx.strokeStyle = '#4fa39b';
      ctx.lineWidth = 2;
      ctx.shadowColor = 'rgba(79,163,155,0.5)';
      ctx.shadowBlur = 4;
      ctx.beginPath();
      pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.stroke();
      ctx.shadowBlur = 0;
      raf = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, []);
  return <canvas ref={ref} style={{ width: TRANS_W, height: TRANS_H, display: 'block' }} />;
}

function TransWindow({
  b,
  p,
  z,
  onClose,
  onFocus,
}: { b: HostBundle; p: OpenPlugin; z: number; onClose: () => void; onFocus: () => void }) {
  const ch = b.channelState[p.stemId];
  if (!ch) return null;
  const tr = ch.transient;
  const att = Math.round(tr.attack * 100);
  const sus = Math.round(tr.sustain * 100);
  return (
    <WindowFrame
      title="TRANSIENT"
      sub={`SHAPER · ${b.stemName(p.stemId)}`}
      accent="teal"
      width={470}
      z={z}
      initial={{ x: 380, y: 130 }}
      onClose={onClose}
      onFocus={onFocus}
      bypass={tr.bypassed}
      onBypass={() => b.onTransientBypass(p.stemId)}
    >
      <div style={{ display: 'flex', gap: 14, padding: 14 }}>
        <div
          style={{
            position: 'relative',
            width: TRANS_W,
            height: TRANS_H,
            flexShrink: 0,
            background: 'var(--inset)',
            borderRadius: 'var(--r-md)',
            border: '1px solid var(--line)',
            overflow: 'hidden',
          }}
        >
          <TransGraph
            attack={tr.attack}
            sustain={tr.sustain}
            getLevel={() => b.host?.getChannelLevel(p.stemId) ?? 0}
          />
          <span
            className="lbl"
            style={{ position: 'absolute', top: 5, left: 7, fontSize: 8, color: 'var(--teal)' }}
          >
            ENVELOPE
          </span>
        </div>
        <div
          style={{ display: 'flex', flexDirection: 'column', gap: 14, justifyContent: 'center' }}
        >
          <div style={{ display: 'flex', gap: 16 }}>
            <Knob
              size={50}
              label="ATTACK"
              value={att}
              min={-100}
              max={100}
              bipolar
              defaultValue={0}
              accent="teal"
              display={(att > 0 ? '+' : '') + att}
              ariaLabel="transient attack"
              onChange={(val) => b.onTransient(p.stemId, 'attack', val / 100)}
            />
            <Knob
              size={50}
              label="SUSTAIN"
              value={sus}
              min={-100}
              max={100}
              bipolar
              defaultValue={0}
              accent="teal"
              display={(sus > 0 ? '+' : '') + sus}
              ariaLabel="transient sustain"
              onChange={(val) => b.onTransient(p.stemId, 'sustain', val / 100)}
            />
          </div>
          <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
            <Knob
              size={36}
              label="SENS"
              value={tr.sens}
              min={0}
              max={100}
              defaultValue={50}
              accent="teal"
              display={tr.sens.toFixed(0)}
              ariaLabel="transient sensitivity"
              onChange={(val) => b.onTransient(p.stemId, 'sens', val)}
            />
            <Segmented
              options={[
                { value: 'WIDE', label: 'WIDE' },
                { value: 'TIGHT', label: 'TIGHT' },
              ]}
              value={tr.mode}
              accent="teal"
              onChange={(v) => b.onTransientMode(p.stemId, v as 'WIDE' | 'TIGHT')}
            />
          </div>
        </div>
      </div>
    </WindowFrame>
  );
}

/* ============================================================
   Tape / Saturation — tanh transfer curve + animated harmonics
   ============================================================ */
const TAPE_BOX = 170;

function TapeCurve({ driveDb, bias }: { driveDb: number; bias: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const v = useRef({ driveDb, bias });
  v.current = { driveDb, bias };
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    let raf = 0;
    const draw = () => {
      const W = TAPE_BOX;
      const H = TAPE_BOX;
      cv.width = W * dpr;
      cv.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      const drive = 1 + v.current.driveDb / 4;
      const b = v.current.bias / 100;
      // axes
      ctx.strokeStyle = 'var(--line)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(W / 2, 0);
      ctx.lineTo(W / 2, H);
      ctx.moveTo(0, H / 2);
      ctx.lineTo(W, H / 2);
      ctx.stroke();
      // unity diagonal
      ctx.strokeStyle = 'var(--txt-3)';
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(0, H);
      ctx.lineTo(W, 0);
      ctx.stroke();
      ctx.setLineDash([]);
      // tanh transfer (with bias offset)
      ctx.strokeStyle = '#cf6b39';
      ctx.lineWidth = 2.5;
      ctx.shadowColor = 'rgba(207,107,57,0.6)';
      ctx.shadowBlur = 5;
      ctx.beginPath();
      for (let i = 0; i <= 80; i++) {
        const x = (i / 80) * 2 - 1;
        const y = Math.tanh((x + b) * drive) / Math.tanh(drive || 1);
        const px = ((x + 1) / 2) * W;
        const py = H - ((y + 1) / 2) * H;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
      ctx.shadowBlur = 0;
      raf = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, []);
  return <canvas ref={ref} style={{ width: TAPE_BOX, height: TAPE_BOX, display: 'block' }} />;
}

function TapeHarmonics({
  driveDb,
  mode,
  getLevel,
}: { driveDb: number; mode: 'TAPE' | 'TUBE' | 'TRANS'; getLevel: () => number }) {
  const refs = useRef<(HTMLDivElement | null)[]>([]);
  const v = useRef({ driveDb, mode });
  v.current = { driveDb, mode };
  const lvlFn = useRef(getLevel);
  lvlFn.current = getLevel;
  useEffect(() => {
    let raf = 0;
    let smooth = 0;
    const tick = () => {
      // Real signal energy drives the harmonic display; drive + mode shape it.
      const lvl = clamp(lvlFn.current(), 0, 1);
      smooth += (lvl - smooth) * 0.3; // ballistic smoothing
      const drvNorm = v.current.driveDb / 24;
      for (let i = 0; i < 6; i++) {
        const even = (i + 1) % 2 === 0;
        const base = 0.6 ** i * (drvNorm + 0.1);
        const flav =
          v.current.mode === 'TUBE'
            ? even
              ? 1.4
              : 0.7
            : v.current.mode === 'TAPE'
              ? even
                ? 0.6
                : 1.2
              : 1;
        const h = clamp(base * flav * (0.05 + 1.6 * smooth), 0.02, 1);
        const el = refs.current[i];
        if (el) el.style.height = `${h * 100}%`;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-end',
        gap: 4,
        height: 40,
        padding: '0 4px',
        background: 'var(--inset)',
        borderRadius: 'var(--r-md)',
        border: '1px solid var(--line)',
      }}
    >
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <div
          key={i}
          ref={(el) => {
            refs.current[i] = el;
          }}
          style={{
            flex: 1,
            height: '2%',
            alignSelf: 'flex-end',
            borderRadius: '2px 2px 0 0',
            background: i % 2 ? 'var(--gold)' : 'var(--rust)',
          }}
        />
      ))}
    </div>
  );
}

function TapeWindow({
  b,
  p,
  z,
  onClose,
  onFocus,
}: { b: HostBundle; p: OpenPlugin; z: number; onClose: () => void; onFocus: () => void }) {
  const ch = b.channelState[p.stemId];
  if (!ch) return null;
  const tp = ch.tape;
  const tone = Math.round(tp.tone * 100);
  const mix = Math.round(tp.mix * 100);
  return (
    <WindowFrame
      title="TAPE / SATURATION"
      sub={`ANALOG · ${b.stemName(p.stemId)}`}
      accent="rust"
      width={440}
      z={z}
      initial={{ x: 400, y: 140 }}
      onClose={onClose}
      onFocus={onFocus}
      bypass={tp.bypassed}
      onBypass={() => b.onTapeBypass(p.stemId)}
    >
      <div style={{ display: 'flex', gap: 14, padding: 14 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div
            style={{
              position: 'relative',
              width: TAPE_BOX,
              height: TAPE_BOX,
              background: 'var(--inset)',
              borderRadius: 'var(--r-md)',
              border: '1px solid var(--line)',
            }}
          >
            <TapeCurve driveDb={tp.driveDb} bias={tp.bias} />
            <span
              className="lbl"
              style={{ position: 'absolute', top: 5, left: 7, fontSize: 8, color: 'var(--rust)' }}
            >
              CURVE
            </span>
          </div>
          <TapeHarmonics
            driveDb={tp.driveDb}
            mode={tp.mode}
            getLevel={() => b.host?.getChannelLevel(p.stemId) ?? 0}
          />
        </div>
        <div
          style={{ display: 'flex', flexDirection: 'column', gap: 14, justifyContent: 'center' }}
        >
          <Segmented
            options={[
              { value: 'TAPE', label: 'TAPE' },
              { value: 'TUBE', label: 'TUBE' },
              { value: 'TRANS', label: 'TRANS' },
            ]}
            value={tp.mode}
            accent="rust"
            onChange={(v) => b.onTapeMode(p.stemId, v as 'TAPE' | 'TUBE' | 'TRANS')}
          />
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: 14,
              justifyItems: 'center',
            }}
          >
            <Knob
              size={44}
              label="DRIVE"
              value={tp.driveDb}
              min={0}
              max={24}
              defaultValue={0}
              accent="rust"
              display={tp.driveDb.toFixed(0)}
              unit="dB"
              ariaLabel="tape drive"
              onChange={(val) => b.onTape(p.stemId, 'driveDb', val)}
            />
            <Knob
              size={44}
              label="TONE"
              value={tone}
              min={-100}
              max={100}
              bipolar
              defaultValue={0}
              accent="rust"
              display={(tone > 0 ? '+' : '') + tone}
              ariaLabel="tape tone"
              onChange={(val) => b.onTape(p.stemId, 'tone', val / 100)}
            />
            <Knob
              size={44}
              label="BIAS"
              value={tp.bias}
              min={-50}
              max={50}
              bipolar
              defaultValue={0}
              accent="rust"
              display={tp.bias.toFixed(0)}
              ariaLabel="tape bias"
              onChange={(val) => b.onTape(p.stemId, 'bias', val)}
            />
            <Knob
              size={44}
              label="MIX"
              value={mix}
              min={0}
              max={100}
              defaultValue={100}
              accent="gold"
              display={mix === 0 ? 'dry' : `${mix}`}
              ariaLabel="tape mix"
              onChange={(val) => b.onTape(p.stemId, 'mix', val / 100)}
            />
          </div>
        </div>
      </div>
    </WindowFrame>
  );
}

/* ============================================================
   Stereo Imager — animated goniometer + correlation
   ============================================================ */
const GONIO = 160;

// Plots the real L/R signal: each sample is a dot, rotated 45° so a mono
// signal (L=R) traces the vertical (mid) axis and out-of-phase content spreads
// horizontally. `getStereo` fills the L/R buffers from the engine each frame.
function Goniometer({
  getStereo,
}: { getStereo: (l: Float32Array<ArrayBuffer>, r: Float32Array<ArrayBuffer>) => boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const fn = useRef(getStereo);
  fn.current = getStereo;
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    const S = GONIO;
    cv.width = S * dpr;
    cv.height = S * dpr;
    const N = 1024;
    const l = new Float32Array(N);
    const r = new Float32Array(N);
    const scale = (S / 2 - 8) * 0.95; // full-scale sample → near the rim
    let raf = 0;
    const draw = () => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, S, S);
      ctx.save();
      ctx.translate(S / 2, S / 2);
      ctx.strokeStyle = 'rgba(255,240,210,0.06)';
      ctx.beginPath();
      ctx.arc(0, 0, S / 2 - 6, 0, 7);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, -S / 2);
      ctx.lineTo(0, S / 2);
      ctx.moveTo(-S / 2, 0);
      ctx.lineTo(S / 2, 0);
      ctx.stroke();
      if (fn.current(l, r)) {
        ctx.fillStyle = 'rgba(178,133,172,0.7)';
        for (let i = 0; i < N; i++) {
          const li = l[i] ?? 0;
          const ri = r[i] ?? 0;
          // 45° rotation: mid = (L+R) up, side = (L−R) across.
          const x = (li - ri) * Math.SQRT1_2 * scale;
          const y = -(li + ri) * Math.SQRT1_2 * scale;
          ctx.fillRect(x, y, 1.3, 1.3);
        }
      }
      ctx.restore();
      raf = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, []);
  return <canvas ref={ref} style={{ width: GONIO, height: GONIO }} />;
}

// Live phase-correlation readout + bar (−1 out-of-phase … +1 mono).
function CorrelationMeter({ getCorrelation }: { getCorrelation: () => number }) {
  const numRef = useRef<HTMLSpanElement>(null);
  const markRef = useRef<HTMLDivElement>(null);
  const fn = useRef(getCorrelation);
  fn.current = getCorrelation;
  useEffect(() => {
    let raf = 0;
    let smooth = 1;
    const tick = () => {
      smooth += (clamp(fn.current(), -1, 1) - smooth) * 0.2;
      const col = smooth < 0 ? 'var(--red)' : 'var(--mauve)';
      if (numRef.current) {
        numRef.current.textContent = smooth.toFixed(2);
        numRef.current.style.color = col;
      }
      if (markRef.current) {
        markRef.current.style.left = `${50 + smooth * 50}%`;
        markRef.current.style.background = col;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
        <span className="lbl" style={{ fontSize: 8 }}>
          CORRELATION
        </span>
        <span ref={numRef} className="val" style={{ fontSize: 10, color: 'var(--mauve)' }}>
          +1.00
        </span>
      </div>
      <div
        style={{
          position: 'relative',
          height: 10,
          background: 'var(--inset)',
          borderRadius: 3,
          boxShadow: 'inset 0 0 0 1px var(--line)',
        }}
      >
        <div
          style={{
            position: 'absolute',
            left: '50%',
            top: 0,
            bottom: 0,
            width: 1,
            background: 'var(--line-2)',
          }}
        />
        <div
          ref={markRef}
          style={{
            position: 'absolute',
            left: '100%',
            top: -2,
            width: 3,
            height: 14,
            background: 'var(--mauve)',
            borderRadius: 2,
          }}
        />
      </div>
    </div>
  );
}

function ImagerWindow({
  b,
  p,
  z,
  onClose,
  onFocus,
}: { b: HostBundle; p: OpenPlugin; z: number; onClose: () => void; onFocus: () => void }) {
  const ch = b.channelState[p.stemId];
  if (!ch) return null;
  const im = ch.imager;
  return (
    <WindowFrame
      title="STEREO IMAGER"
      sub={`WIDTH · ${b.stemName(p.stemId)}`}
      accent="mauve"
      width={420}
      z={z}
      initial={{ x: 400, y: 150 }}
      onClose={onClose}
      onFocus={onFocus}
      bypass={im.bypassed}
      onBypass={() => b.onImagerBypass(p.stemId)}
    >
      <div style={{ display: 'flex', gap: 14, padding: 14 }}>
        <div
          style={{
            width: GONIO,
            height: GONIO,
            flexShrink: 0,
            background: 'var(--inset)',
            borderRadius: 'var(--r-md)',
            border: '1px solid var(--line)',
            overflow: 'hidden',
          }}
        >
          <Goniometer getStereo={(l, r) => b.host?.getChannelStereo(p.stemId, l, r) ?? false} />
        </div>
        <div
          style={{ display: 'flex', flexDirection: 'column', gap: 16, justifyContent: 'center' }}
        >
          <div style={{ display: 'flex', gap: 16 }}>
            <Knob
              size={48}
              label="WIDTH"
              value={im.width}
              min={0}
              max={2}
              defaultValue={1}
              accent="mauve"
              display={im.width.toFixed(2)}
              ariaLabel="imager width"
              onChange={(val) => b.onImager(p.stemId, val)}
            />
            <Knob
              size={48}
              label="BALANCE"
              value={im.balance}
              min={-1}
              max={1}
              bipolar
              defaultValue={0}
              accent="mauve"
              display={
                im.balance === 0
                  ? 'C'
                  : (im.balance > 0 ? 'R' : 'L') + Math.abs(im.balance * 100).toFixed(0)
              }
              ariaLabel="imager balance"
              onChange={(val) => b.onImagerBalance(p.stemId, val)}
            />
          </div>
          <CorrelationMeter getCorrelation={() => b.host?.getChannelCorrelation(p.stemId) ?? 1} />
          <Segmented
            options={[
              { value: 'STEREO', label: 'STEREO' },
              { value: 'MS', label: 'M/S' },
            ]}
            value={im.mode}
            accent="mauve"
            onChange={(val) => b.onImagerMode(p.stemId, val as 'STEREO' | 'MS')}
          />
        </div>
      </div>
    </WindowFrame>
  );
}

/* ============================================================
   Master Limiter — ceiling / gain / release + voicing + GR
   ============================================================ */
// Live LUFS / true-peak / overs from the master BS.1770 meter, polled ~10 Hz.
function MasterLoudnessReadouts({ getLoudness }: { getLoudness: () => Loudness | null }) {
  const [m, setM] = useState({ lufs: '—', tp: '—', overs: '0' });
  const fn = useRef(getLoudness);
  fn.current = getLoudness;
  useEffect(() => {
    const id = setInterval(() => {
      const ld = fn.current();
      if (!ld) {
        setM({ lufs: '—', tp: '—', overs: '0' });
        return;
      }
      // Show integrated once it's gated past silence; fall back to momentary.
      const lufs = ld.integrated > -70 ? ld.integrated : ld.momentary;
      setM({
        lufs: lufs <= -120 ? '—' : lufs.toFixed(1),
        tp: ld.truePeakDb <= -120 ? '—' : ld.truePeakDb.toFixed(1),
        overs: String(ld.overs),
      });
    }, 100);
    return () => clearInterval(id);
  }, []);
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
      <Readout label="TRUE PK" value={m.tp} unit="dB" accent="red" />
      <Readout label="LUFS" value={m.lufs} accent="gold" />
      <Readout label="OVERS" value={m.overs} accent={m.overs === '0' ? 'green' : 'red'} />
    </div>
  );
}

function LimiterWindow({
  b,
  z,
  onClose,
  onFocus,
}: { b: HostBundle; z: number; onClose: () => void; onFocus: () => void }) {
  const lim = b.limiter;
  // Live gain-reduction straight off the master limiter worklet.
  const getGr = () => b.host?.getMasterLimiterGr() ?? 0;
  return (
    <WindowFrame
      title="MASTER LIMITER"
      sub="TRUE PEAK · MASTER"
      accent="red"
      width={404}
      z={z}
      initial={{ x: 420, y: 150 }}
      onClose={onClose}
      onFocus={onFocus}
      bypass={lim.bypassed}
      onBypass={b.onLimiterBypass}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: 14 }}>
        <div style={{ display: 'flex', justifyContent: 'space-around' }}>
          <Knob
            size={48}
            label="CEILING"
            value={lim.thresholdDb}
            min={-12}
            max={0}
            defaultValue={-1}
            accent="red"
            display={lim.thresholdDb.toFixed(1)}
            unit="dB"
            ariaLabel="ceiling"
            onChange={(v) => b.onLimiter('thresholdDb', v)}
          />
          <Knob
            size={48}
            label="GAIN"
            value={lim.makeupDb}
            min={0}
            max={18}
            defaultValue={0}
            accent="gold"
            display={`+${lim.makeupDb.toFixed(1)}`}
            ariaLabel="gain"
            onChange={(v) => b.onLimiter('makeupDb', v)}
          />
          <Knob
            size={48}
            label="RELEASE"
            value={lim.releaseMs}
            min={5}
            max={500}
            defaultValue={100}
            accent="red"
            display={lim.releaseMs.toFixed(0)}
            unit="ms"
            ariaLabel="release"
            onChange={(v) => b.onLimiter('releaseMs', v)}
          />
        </div>
        <Segmented
          options={[
            { value: 'CLEAR', label: 'CLEAR' },
            { value: 'PUNCH', label: 'PUNCH' },
            { value: 'GLUE', label: 'GLUE' },
            { value: 'SAFE', label: 'SAFE' },
          ]}
          value={lim.style}
          accent="red"
          onChange={(v) => b.onLimiterStyle(v as 'CLEAR' | 'PUNCH' | 'GLUE' | 'SAFE')}
        />
        <GrMeterH getGr={getGr} max={12} width={376} />
        <MasterLoudnessReadouts getLoudness={() => b.host?.getMasterLoudness() ?? null} />
      </div>
    </WindowFrame>
  );
}

/* ============================================================
   Pitch corrector — animated scale grid + raw/corrected trace
   (visual placeholder — no pitch DSP yet)
   ============================================================ */
const PITCH_NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const PITCH_SCALES: Record<string, number[]> = {
  Major: [0, 2, 4, 5, 7, 9, 11],
  Minor: [0, 2, 3, 5, 7, 8, 10],
  Chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  Pentatonic: [0, 2, 4, 7, 9],
};
const PITCH_SELECT: React.CSSProperties = {
  background: 'var(--inset)',
  border: '1px solid var(--line-2)',
  borderRadius: 'var(--r-sm)',
  color: 'var(--violet)',
  fontFamily: 'var(--mono)',
  fontSize: 12,
  padding: '5px 8px',
  fontWeight: 600,
};

/** Nearest integer MIDI note (to a continuous `midi`) in the key+scale. */
function snapMidiToScale(midi: number, keyRoot: number, scaleNotes: number[]): number {
  const base = Math.round(midi);
  let best = base;
  let bestD = Number.POSITIVE_INFINITY;
  for (let c = base - 6; c <= base + 6; c++) {
    const pc = (((c - keyRoot) % 12) + 12) % 12;
    if (scaleNotes.includes(pc)) {
      const d = Math.abs(c - midi);
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
  }
  return best;
}

/** Live pitch graph driven by the engine's detected f0. The mauve line is the
 *  detected pitch; the glowing violet line is where the corrector snaps it
 *  (nearest in-scale note). A scale-note grid auto-centres on the voice; gaps
 *  appear when unvoiced/bypassed. */
function PitchGraph({ pkey, scale, getHz }: { pkey: string; scale: string; getHz: () => number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const v = useRef({ pkey, scale });
  v.current = { pkey, scale };
  const hzFn = useRef(getHz);
  hzFn.current = getHz;
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    const rows = 14;
    const hist: ({ raw: number; corr: number } | null)[] = [];
    let center = 60; // C4 until the first voiced frame
    let haveCenter = false;
    let raf = 0;
    const draw = () => {
      const W = cv.clientWidth;
      const H = cv.clientHeight;
      cv.width = W * dpr;
      cv.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);

      const keyRoot = Math.max(0, PITCH_NOTES.indexOf(v.current.pkey));
      const scaleNotes = PITCH_SCALES[v.current.scale] ?? PITCH_SCALES.Chromatic ?? [];
      const inScale = (m: number) =>
        scaleNotes.includes((((Math.round(m) - keyRoot) % 12) + 12) % 12);

      const hz = hzFn.current();
      const voiced = hz > 0;
      const midi = voiced ? 69 + 12 * Math.log2(hz / 440) : Number.NaN;
      if (voiced) {
        if (haveCenter) center += 0.04 * (midi - center);
        else {
          center = midi;
          haveCenter = true;
        }
      }

      const rowH = H / rows;
      const winLo = center - rows / 2;
      const yOf = (m: number) => H - ((m - winLo) / rows) * H;

      // Scale-note grid (auto-centred on the voice).
      ctx.font = '9px IBM Plex Mono';
      for (let m = Math.ceil(winLo); m <= Math.floor(winLo + rows); m++) {
        const y = yOf(m);
        if (inScale(m)) {
          ctx.fillStyle = 'rgba(143,127,214,0.07)';
          ctx.fillRect(0, y - rowH / 2, W, rowH);
        }
        ctx.strokeStyle = 'rgba(255,240,210,0.04)';
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(W, y);
        ctx.stroke();
        ctx.fillStyle = inScale(m) ? '#8f7fd6' : '#564b39';
        ctx.fillText(PITCH_NOTES[((m % 12) + 12) % 12] ?? '', 4, y - 3);
      }

      // Append the current frame (null = a gap while unvoiced/bypassed).
      hist.push(voiced ? { raw: midi, corr: snapMidiToScale(midi, keyRoot, scaleNotes) } : null);
      if (hist.length > W / 2) hist.shift();

      const drawLine = (key: 'raw' | 'corr', style: string, lw: number, glow: boolean) => {
        ctx.strokeStyle = style;
        ctx.lineWidth = lw;
        if (glow) {
          ctx.shadowColor = style;
          ctx.shadowBlur = 6;
        }
        ctx.beginPath();
        let pen = false;
        hist.forEach((h, i) => {
          if (!h) {
            pen = false;
            return;
          }
          const x = i * 2;
          const y = yOf(h[key]);
          if (pen) ctx.lineTo(x, y);
          else {
            ctx.moveTo(x, y);
            pen = true;
          }
        });
        ctx.stroke();
        ctx.shadowBlur = 0;
      };
      drawLine('raw', 'rgba(178,133,172,0.55)', 1.5, false);
      drawLine('corr', '#8f7fd6', 2.5, true);

      const last = hist[hist.length - 1];
      if (last) {
        ctx.fillStyle = '#8f7fd6';
        ctx.beginPath();
        ctx.arc((hist.length - 1) * 2, yOf(last.corr), 4, 0, 7);
        ctx.fill();
      }
      raf = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, []);
  return <canvas ref={ref} style={{ width: '100%', height: '100%', display: 'block' }} />;
}

function PitchWindow({
  b,
  p,
  z,
  onClose,
  onFocus,
}: { b: HostBundle; p: OpenPlugin; z: number; onClose: () => void; onFocus: () => void }) {
  const ch = b.channelState[p.stemId];
  if (!ch) return null;
  const pt = ch.pitch;
  return (
    <WindowFrame
      title="PITCH"
      sub={`CORRECTOR · ${b.stemName(p.stemId)}`}
      accent="violet"
      width={484}
      z={z}
      initial={{ x: 360, y: 110 }}
      onClose={onClose}
      onFocus={onFocus}
      bypass={pt.bypassed}
      onBypass={() => b.onPitchBypass(p.stemId)}
    >
      <div style={{ padding: 12, width: 460 }}>
        <div
          style={{
            height: 180,
            background: 'var(--inset)',
            borderRadius: 'var(--r-md)',
            border: '1px solid var(--line)',
            overflow: 'hidden',
          }}
        >
          <PitchGraph
            pkey={pt.key}
            scale={pt.scale}
            getHz={() => b.host?.getChannelPitchHz(p.stemId) ?? 0}
          />
        </div>
        <div style={{ display: 'flex', gap: 12, marginTop: 12, alignItems: 'center' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span className="lbl" style={{ fontSize: 8 }}>
              KEY
            </span>
            <select
              value={pt.key}
              onChange={(e) => b.onPitchKey(p.stemId, e.target.value as PitchKey)}
              style={PITCH_SELECT}
            >
              {PITCH_NOTES.map((n) => (
                <option key={n}>{n}</option>
              ))}
            </select>
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span className="lbl" style={{ fontSize: 8 }}>
              SCALE
            </span>
            <select
              value={pt.scale}
              onChange={(e) => b.onPitchScale(p.stemId, e.target.value as PitchScale)}
              style={PITCH_SELECT}
            >
              {Object.keys(PITCH_SCALES).map((n) => (
                <option key={n}>{n}</option>
              ))}
            </select>
          </label>
          <div style={{ width: 1, height: 50, background: 'var(--line)' }} />
          <div style={{ display: 'flex', gap: 16, flex: 1, justifyContent: 'space-around' }}>
            <Knob
              size={44}
              label="RETUNE"
              value={pt.speed}
              min={0}
              max={100}
              defaultValue={40}
              accent="violet"
              display={pt.speed.toFixed(0)}
              ariaLabel="retune speed"
              onChange={(val) => b.onPitch(p.stemId, 'speed', val)}
            />
            <Knob
              size={44}
              label="AMOUNT"
              value={pt.amount}
              min={0}
              max={100}
              defaultValue={100}
              accent="violet"
              display={pt.amount.toFixed(0)}
              ariaLabel="correction amount"
              onChange={(val) => b.onPitch(p.stemId, 'amount', val)}
            />
            <Knob
              size={44}
              label="HUMANIZE"
              value={pt.human}
              min={0}
              max={100}
              defaultValue={20}
              accent="violet"
              display={pt.human.toFixed(0)}
              ariaLabel="humanize"
              onChange={(val) => b.onPitch(p.stemId, 'human', val)}
            />
            <Knob
              size={44}
              label="FORMANT"
              value={pt.formant}
              min={-100}
              max={100}
              bipolar
              defaultValue={0}
              accent="violet"
              display={(pt.formant > 0 ? '+' : '') + pt.formant.toFixed(0)}
              ariaLabel="formant"
              onChange={(val) => b.onPitch(p.stemId, 'formant', val)}
            />
          </div>
        </div>
      </div>
    </WindowFrame>
  );
}

export function PluginWindows({
  windows,
  onClose,
  onFocus,
  bundle,
}: {
  windows: OpenPlugin[];
  onClose: (i: number) => void;
  onFocus: (i: number) => void;
  bundle: HostBundle;
}) {
  return (
    <>
      {windows.map((p, i) => {
        const key = `${p.type}:${p.stemId}`;
        const z = 60 + i;
        const props = {
          b: bundle,
          p,
          z,
          onClose: () => onClose(i),
          onFocus: () => onFocus(i),
        };
        if (p.type === 'eq') return <EqWindow key={key} {...props} />;
        if (p.type === 'trans') return <TransWindow key={key} {...props} />;
        if (p.type === 'tape') return <TapeWindow key={key} {...props} />;
        if (p.type === 'img') return <ImagerWindow key={key} {...props} />;
        if (p.type === 'pitch') return <PitchWindow key={key} {...props} />;
        if (p.type === 'limiter')
          return (
            <LimiterWindow
              key={key}
              b={bundle}
              z={z}
              onClose={() => onClose(i)}
              onFocus={() => onFocus(i)}
            />
          );
        return <CompWindow key={key} {...props} />;
      })}
    </>
  );
}
