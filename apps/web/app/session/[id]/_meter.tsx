'use client';

import type { AudioHost } from '@aux/audio-engine';
import { useEffect, useRef } from 'react';

interface Props {
  host: AudioHost | null;
  stemId: string;
  /** Whether audio is currently playing — drives the RAF loop. */
  active: boolean;
}

/**
 * Stereo-ish peak meter for one channel. The AnalyserNode is mono after
 * the StereoPannerNode summing; for v0.2 we drive both bars off the same
 * peak. Real L/R metering comes when the audio engine grows a proper
 * meter probe (post-v0.2).
 */
export function Meter({ host, stemId, active }: Props) {
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
      const linear = host.getChannelLevel(stemId);
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
  }, [host, stemId, active]);

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
