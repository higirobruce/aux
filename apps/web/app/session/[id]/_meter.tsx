'use client';

import type { AudioHost } from '@aux/audio-engine';
import { useEffect, useRef } from 'react';

interface Props {
  host: AudioHost | null;
  /** Either a stem id (variant 'channel', default) or a bus id ('bus'). */
  stemId: string;
  /** Whether audio is currently playing — drives the RAF loop. */
  active: boolean;
  /** Selects which AudioHost peak-level getter to poll. */
  variant?: 'channel' | 'bus';
}

/**
 * Stereo-ish peak meter for one channel or bus. The AnalyserNode is mono
 * after the StereoPannerNode summing; we drive both bars off the same
 * peak. Real L/R metering comes when the audio engine grows a proper
 * meter probe with split tap points.
 */
export function Meter({ host, stemId, active, variant = 'channel' }: Props) {
  const leftRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  const peakRef = useRef(0);

  useEffect(() => {
    if (!host || !active) {
      // Drain the meter when not playing.
      if (leftRef.current) leftRef.current.style.height = '0%';
      if (rightRef.current) rightRef.current.style.height = '0%';
      peakRef.current = 0;
      return;
    }

    let raf = 0;
    const tick = () => {
      const linear = variant === 'bus' ? host.getBusLevel(stemId) : host.getChannelLevel(stemId);
      // Smoothed release — fast attack, slow release. Avoids ugly meter chatter.
      const prev = peakRef.current;
      const next = linear > prev ? linear : prev * 0.85 + linear * 0.15;
      peakRef.current = next;

      // Map 0..1 linear amplitude to 0..100% height, with a soft compression
      // so the bar uses more of its range for quiet signals.
      const display = Math.min(1, next ** 0.4);
      const pct = `${(display * 100).toFixed(1)}%`;
      if (leftRef.current) leftRef.current.style.height = pct;
      if (rightRef.current) rightRef.current.style.height = pct;

      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [host, stemId, active, variant]);

  return (
    <div className="ch-meter">
      <div className="meter-channel">
        <div ref={leftRef} className="meter-fill" />
      </div>
      <div className="meter-channel">
        <div ref={rightRef} className="meter-fill" />
      </div>
    </div>
  );
}
