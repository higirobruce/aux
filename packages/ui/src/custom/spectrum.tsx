'use client';

import { useEffect, useRef } from 'react';
import { type Accent, clamp } from './accent';

interface SpectrumProps {
  active?: boolean;
  accent?: Accent;
  height?: number;
  bins?: number;
  fill?: boolean;
  /**
   * Optional real-data feed: fills `out` (length = bins) with 0..1 magnitudes
   * and returns true if real data was written. When absent/returns false, a
   * plausible synthetic spectrum animates instead.
   */
  getData?: (out: Float32Array) => boolean;
}

/** Animated FFT-style analyzer (canvas). Real data via getData, else synthetic. */
export function Spectrum({
  active = true,
  accent = 'gold',
  height = 120,
  bins = 96,
  fill = true,
  getData,
}: SpectrumProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  const dataRef = useRef<Float32Array>(new Float32Array(bins));
  const realRef = useRef<Float32Array>(new Float32Array(bins));
  const getDataRef = useRef(getData);
  getDataRef.current = getData;

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    const resize = () => {
      cv.width = cv.clientWidth * dpr;
      cv.height = cv.clientHeight * dpr;
    };
    resize();
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    const col =
      getComputedStyle(document.documentElement).getPropertyValue(`--${accent}`).trim() ||
      '#e7a948';
    let raf = 0;
    let t = 0;
    const draw = () => {
      t += 0.016;
      const W = cv.width;
      const H = cv.height;
      ctx.clearRect(0, 0, W, H);
      const d = dataRef.current;
      const hasReal = getDataRef.current?.(realRef.current) ?? false;
      for (let i = 0; i < bins; i++) {
        let target: number;
        if (hasReal) {
          target = active ? (realRef.current[i] ?? 0) : 0.02;
        } else {
          const f = i / bins;
          const tilt = (1 - f) ** 1.7;
          const wob = 0.5 + 0.5 * Math.sin(t * 1.3 + i * 0.4) * Math.sin(t * 0.7 + i * 0.13);
          const peak1 = Math.exp(-(((f - 0.12) / 0.05) ** 2)) * (0.7 + 0.3 * Math.sin(t * 2));
          const peak2 =
            Math.exp(-(((f - 0.34) / 0.08) ** 2)) * 0.5 * (0.6 + 0.4 * Math.sin(t * 1.5 + 1));
          target = active
            ? clamp(tilt * (0.4 + 0.45 * wob) + peak1 * 0.3 + peak2 * 0.25, 0, 1)
            : 0.02;
        }
        const cur = d[i] ?? 0;
        d[i] = cur + (target - cur) * (target > cur ? 0.4 : 0.08);
      }
      if (fill) {
        ctx.beginPath();
        ctx.moveTo(0, H);
        for (let i = 0; i < bins; i++) {
          ctx.lineTo((i / (bins - 1)) * W, H - (d[i] ?? 0) * H * 0.74 - 2);
        }
        ctx.lineTo(W, H);
        const g = ctx.createLinearGradient(0, 0, 0, H);
        g.addColorStop(0, `${col}55`);
        g.addColorStop(1, `${col}00`);
        ctx.fillStyle = g;
        ctx.fill();
      }
      ctx.beginPath();
      for (let i = 0; i < bins; i++) {
        const x = (i / (bins - 1)) * W;
        const y = H - (d[i] ?? 0) * H * 0.74 - 2;
        if (i) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
      }
      ctx.strokeStyle = col;
      ctx.lineWidth = 1.25 * dpr;
      ctx.shadowColor = col;
      ctx.shadowBlur = 3 * dpr;
      ctx.stroke();
      ctx.shadowBlur = 0;
      raf = requestAnimationFrame(draw);
    };
    draw();
    window.addEventListener('resize', resize);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
    };
  }, [accent, bins, active, fill]);

  return <canvas ref={ref} style={{ width: '100%', height, display: 'block' }} />;
}
