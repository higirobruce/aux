'use client';

/**
 * Floating plugin windows (warm-analog redesign, phase 5). A lightweight
 * manager renders the open windows over the mixer; each is wired to the real
 * audio engine for the focused channel. EQ shows a live response curve over
 * the channel's real spectrum; Compressor shows a transfer curve + real
 * gain-reduction meter. More modules follow the same pattern.
 */

import type { AudioHost } from '@aux/audio-engine';
import type { EqFullBand } from '@aux/session-doc';
import { Knob, Readout, Segmented, Spectrum, Toggle, WindowFrame, clamp } from '@aux/ui';
import { useEffect, useRef, useState } from 'react';
import type { ChannelState, CompField, EqBand } from './_mixer-shell';

export type PluginType = 'eq' | 'comp' | 'trans';
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

function CompGraph({ shape }: { shape: CompShape }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const s = useRef(shape);
  s.current = shape;
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
      // moving input dot (simulated programme level, like the design)
      const t = Date.now() / 1000;
      const inDb = -22 + 18 * Math.abs(Math.sin(t * 2.2)) * (0.6 + 0.4 * Math.sin(t * 0.7));
      const outDb = compTransfer(inDb, sh) + sh.makeup;
      ctx.fillStyle = '#e7a948';
      ctx.shadowColor = '#e7a948';
      ctx.shadowBlur = 6;
      ctx.beginPath();
      ctx.arc(toX(inDb), toY(outDb), 4, 0, 7);
      ctx.fill();
      ctx.shadowBlur = 0;
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

function TransGraph({ attack, sustain }: { attack: number; sustain: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const v = useRef({ attack, sustain });
  v.current = { attack, sustain };
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    let raf = 0;
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
      const pts: [number, number][] = [];
      for (let x = 0; x <= W; x += 2) {
        const hit = ((x / W) * 4) % 1;
        const att = Math.exp(-hit * 30) * aBoost;
        const sus = Math.exp(-hit * 3) * 0.5 * sBoost;
        const val = clamp(Math.max(att, sus), 0, 1.6);
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
          <TransGraph attack={tr.attack} sustain={tr.sustain} />
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
        return <CompWindow key={key} {...props} />;
      })}
    </>
  );
}
