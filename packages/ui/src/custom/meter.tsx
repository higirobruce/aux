'use client';

import { useEffect, useRef } from 'react';

interface MeterProps {
  /** Returns [left, right] levels in 0..1. Polled each animation frame. */
  getLevel: () => [number, number];
  width?: number;
  height?: number;
  stereo?: boolean;
}

/**
 * Vertical level meter (canvas) with warm green→sage→gold→red ballistics and
 * a falling peak-hold tick. Driven by a getLevel() poll so it can read the
 * engine's analyser without re-rendering React.
 */
export function Meter({ getLevel, width = 6, height = 200, stereo = false }: MeterProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  const getLevelRef = useRef(getLevel);
  getLevelRef.current = getLevel;

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = width * dpr;
    cv.height = height * dpr;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    let peakL = 0;
    let peakR = 0;
    let holdL = 0;
    let holdR = 0;
    let raf = 0;
    const draw = () => {
      const [l, r] = getLevelRef.current();
      peakL = Math.max(l, peakL * 0.86);
      peakR = Math.max(r, peakR * 0.86);
      holdL = l > holdL ? l : holdL * 0.995;
      holdR = r > holdR ? r : holdR * 0.995;
      ctx.clearRect(0, 0, width, height);
      const bw = stereo ? (width - 1) / 2 : width;
      const drawBar = (x: number, lvl: number, hold: number) => {
        ctx.fillStyle = '#0b0906';
        ctx.fillRect(x, 0, bw, height);
        const h = lvl * height;
        const grad = ctx.createLinearGradient(0, height, 0, 0);
        grad.addColorStop(0, '#6fae6a');
        grad.addColorStop(0.7, '#9aa85e');
        grad.addColorStop(0.88, '#e7a948');
        grad.addColorStop(1, '#db5642');
        ctx.fillStyle = grad;
        ctx.fillRect(x, height - h, bw, h);
        const hy = height - hold * height;
        ctx.fillStyle = hold > 0.95 ? '#db5642' : '#f2c071';
        ctx.fillRect(x, hy - 1, bw, 1.5);
      };
      if (stereo) {
        drawBar(0, peakL, holdL);
        drawBar(bw + 1, peakR, holdR);
      } else {
        drawBar(0, peakL, holdL);
      }
      raf = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [width, height, stereo]);

  return (
    <canvas
      ref={ref}
      style={{ width, height, borderRadius: 2, boxShadow: 'inset 0 0 0 1px var(--line)' }}
    />
  );
}
