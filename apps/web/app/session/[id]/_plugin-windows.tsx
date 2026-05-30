'use client';

/**
 * Floating plugin windows (warm-analog redesign, phase 5). A lightweight
 * manager renders the open windows over the mixer; each is wired to the real
 * audio engine for the focused channel. EQ shows a live response curve over
 * the channel's real spectrum; Compressor shows a transfer curve + real
 * gain-reduction meter. More modules follow the same pattern.
 */

import type { AudioHost } from '@aux/audio-engine';
import { Knob, Meter, Module, Segmented, Spectrum, WindowFrame } from '@aux/ui';
import { useEffect, useRef } from 'react';
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
  onComp: (stemId: string, field: 'threshold' | 'ratio', value: number) => void;
  onCompType: (stemId: string, type: 'clean' | 'color') => void;
}

const EQ_MIN = -24;
const EQ_MAX = 24;

/* ---- EQ response curve over the live spectrum ---- */
function EqCurve({
  lo,
  mid,
  hi,
  spectrum,
}: { lo: number; mid: number; hi: number; spectrum: (out: Float32Array) => boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const specRef = useRef<Float32Array>(new Float32Array(96));
  const vals = useRef({ lo, mid, hi });
  vals.current = { lo, mid, hi };
  const specFn = useRef(spectrum);
  specFn.current = spectrum;

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    let raf = 0;
    const draw = () => {
      cv.width = cv.clientWidth * dpr;
      cv.height = cv.clientHeight * dpr;
      const W = cv.width;
      const H = cv.height;
      ctx.clearRect(0, 0, W, H);
      // real spectrum behind
      const ok = specFn.current(specRef.current);
      if (ok) {
        ctx.beginPath();
        ctx.moveTo(0, H);
        const s = specRef.current;
        for (let i = 0; i < s.length; i++)
          ctx.lineTo((i / (s.length - 1)) * W, H - (s[i] ?? 0) * H * 0.66);
        ctx.lineTo(W, H);
        ctx.fillStyle = 'rgba(231,169,72,0.10)';
        ctx.fill();
      }
      // grid 0dB line
      ctx.strokeStyle = 'rgba(255,240,210,0.08)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, H / 2);
      ctx.lineTo(W, H / 2);
      ctx.stroke();
      // EQ response: low-shelf + mid bell + high-shelf, magnitude in dB
      const { lo: L, mid: M, hi: Hg } = vals.current;
      const magAt = (f01: number) => {
        const lowW = 1 - smooth(f01, 0.05, 0.42);
        const hiW = smooth(f01, 0.55, 0.95);
        const midW = Math.exp(-(((f01 - 0.5) / 0.18) ** 2));
        return L * lowW + Hg * hiW + M * midW;
      };
      ctx.strokeStyle = '#e7a948';
      ctx.lineWidth = 2 * dpr;
      ctx.shadowColor = '#e7a948';
      ctx.shadowBlur = 4 * dpr;
      ctx.beginPath();
      for (let x = 0; x <= W; x += 2) {
        const f01 = x / W;
        const db = magAt(f01);
        const y = H / 2 - (db / (EQ_MAX - EQ_MIN)) * H;
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.shadowBlur = 0;
      raf = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, []);
  return <canvas ref={ref} style={{ width: '100%', height: 160, display: 'block' }} />;
}

function smooth(x: number, a: number, b: number) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

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

function EqWindow({
  b,
  p,
  z,
  onClose,
  onFocus,
}: { b: HostBundle; p: OpenPlugin; z: number; onClose: () => void; onFocus: () => void }) {
  const ch = b.channelState[p.stemId];
  if (!ch) return null;
  return (
    <WindowFrame
      title="PARAMETRIC EQ"
      sub={b.stemName(p.stemId)}
      accent="gold"
      width={420}
      z={z}
      initial={{ x: 360, y: 110 }}
      onClose={onClose}
      onFocus={onFocus}
    >
      <div style={{ padding: 12 }}>
        <div
          style={{
            border: '1px solid var(--line)',
            borderRadius: 'var(--r-md)',
            background: 'var(--inset)',
            overflow: 'hidden',
            marginBottom: 12,
          }}
        >
          <EqCurve
            lo={ch.eq.lo}
            mid={ch.eq.mid}
            hi={ch.eq.hi}
            spectrum={(out) => b.host?.getChannelFrequencyData(p.stemId, out) ?? false}
          />
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-around' }}>
          <Knob
            value={ch.eq.lo}
            min={EQ_MIN}
            max={EQ_MAX}
            defaultValue={0}
            bipolar
            accent="gold"
            label="LOW"
            display={ch.eq.lo.toFixed(1)}
            unit="dB"
            ariaLabel="EQ low"
            onChange={(v) => b.onEq(p.stemId, 'lo', v)}
          />
          <Knob
            value={ch.eq.mid}
            min={EQ_MIN}
            max={EQ_MAX}
            defaultValue={0}
            bipolar
            accent="gold"
            label="MID"
            display={ch.eq.mid.toFixed(1)}
            unit="dB"
            ariaLabel="EQ mid"
            onChange={(v) => b.onEq(p.stemId, 'mid', v)}
          />
          <Knob
            value={ch.eq.hi}
            min={EQ_MIN}
            max={EQ_MAX}
            defaultValue={0}
            bipolar
            accent="gold"
            label="HIGH"
            display={ch.eq.hi.toFixed(1)}
            unit="dB"
            ariaLabel="EQ high"
            onChange={(v) => b.onEq(p.stemId, 'hi', v)}
          />
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
