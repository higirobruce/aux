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
import { Knob, Meter, Readout, Segmented, Spectrum, Toggle, WindowFrame, clamp } from '@aux/ui';
import { useEffect, useRef, useState } from 'react';
import type { ChannelState, EqBand } from './_mixer-shell';

export type PluginType = 'eq' | 'comp';
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
  onComp: (stemId: string, field: 'threshold' | 'ratio', value: number) => void;
  onCompType: (stemId: string, type: 'clean' | 'color') => void;
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

/* ---- Compressor transfer curve ---- */
function CompCurve({ threshold, ratio }: { threshold: number; ratio: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const v = useRef({ threshold, ratio });
  v.current = { threshold, ratio };
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    const draw = () => {
      cv.width = cv.clientWidth * dpr;
      cv.height = cv.clientHeight * dpr;
      const W = cv.width;
      const H = cv.height;
      ctx.clearRect(0, 0, W, H);
      const { threshold: th, ratio: r } = v.current;
      const toX = (db: number) => ((db + 60) / 60) * W;
      const toY = (db: number) => H - ((db + 60) / 60) * H;
      // unity reference
      ctx.strokeStyle = 'rgba(255,240,210,0.10)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(toX(-60), toY(-60));
      ctx.lineTo(toX(0), toY(0));
      ctx.stroke();
      // transfer
      ctx.strokeStyle = '#9aa85e';
      ctx.lineWidth = 2 * dpr;
      ctx.beginPath();
      for (let db = -60; db <= 0; db += 1) {
        const out = db <= th ? db : th + (db - th) / r;
        const x = toX(db);
        const y = toY(out);
        if (db === -60) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      // threshold marker
      ctx.strokeStyle = 'rgba(231,169,72,0.5)';
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(toX(th), 0);
      ctx.lineTo(toX(th), H);
      ctx.stroke();
      ctx.setLineDash([]);
    };
    draw();
    const id = setInterval(draw, 80);
    return () => clearInterval(id);
  }, []);
  return <canvas ref={ref} style={{ width: '100%', height: 150, display: 'block' }} />;
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
  const grLevel = (): [number, number] => {
    const gr = b.host
      ? ch.compType === 'color'
        ? b.host.getChannelCompColorGr(p.stemId)
        : b.host.getChannelCompGr(p.stemId)
      : 0;
    const n = Math.min(1, gr / 18);
    return [n, n];
  };
  return (
    <WindowFrame
      title="COMPRESSOR"
      sub={b.stemName(p.stemId)}
      accent="sage"
      width={420}
      z={z}
      initial={{ x: 400, y: 150 }}
      onClose={onClose}
      onFocus={onFocus}
    >
      <div style={{ padding: 12, display: 'flex', gap: 12 }}>
        <div style={{ flex: 1 }}>
          <div
            style={{
              border: '1px solid var(--line)',
              borderRadius: 'var(--r-md)',
              background: 'var(--inset)',
              overflow: 'hidden',
              marginBottom: 10,
            }}
          >
            <CompCurve threshold={ch.comp.threshold} ratio={ch.comp.ratio} />
          </div>
          <div style={{ marginBottom: 10 }}>
            <Segmented
              options={[
                { value: 'clean', label: 'CLEAN' },
                { value: 'color', label: 'COLOR' },
              ]}
              value={ch.compType}
              accent="sage"
              onChange={(v) => b.onCompType(p.stemId, v as 'clean' | 'color')}
            />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-around' }}>
            <Knob
              value={ch.comp.threshold}
              min={-60}
              max={0}
              defaultValue={0}
              accent="sage"
              label="THRESH"
              display={ch.comp.threshold.toFixed(0)}
              unit="dB"
              ariaLabel="threshold"
              onChange={(v) => b.onComp(p.stemId, 'threshold', v)}
            />
            <Knob
              value={ch.comp.ratio}
              min={1}
              max={20}
              defaultValue={1}
              accent="sage"
              label="RATIO"
              display={`${ch.comp.ratio.toFixed(1)}:1`}
              ariaLabel="ratio"
              onChange={(v) => b.onComp(p.stemId, 'ratio', v)}
            />
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
          <span className="lbl" style={{ fontSize: 8 }}>
            GR
          </span>
          <Meter getLevel={grLevel} width={8} height={140} />
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
        if (p.type === 'eq')
          return (
            <EqWindow
              key={key}
              b={bundle}
              p={p}
              z={z}
              onClose={() => onClose(i)}
              onFocus={() => onFocus(i)}
            />
          );
        return (
          <CompWindow
            key={key}
            b={bundle}
            p={p}
            z={z}
            onClose={() => onClose(i)}
            onFocus={() => onFocus(i)}
          />
        );
      })}
    </>
  );
}
