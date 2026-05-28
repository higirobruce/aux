'use client';

import type { StemWithUrl } from '@/lib/types';
import { AudioHost } from '@aux/audio-engine';
import { Button } from '@aux/ui';
import { useEffect, useRef, useState } from 'react';

interface Props {
  sessionId: string;
}

type TransportState = 'idle' | 'loading' | 'playing';

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function Transport({ sessionId }: Props) {
  const hostRef = useRef<AudioHost | null>(null);
  const playStartedAtRef = useRef<number | null>(null);
  const [state, setState] = useState<TransportState>('idle');
  const [stemCount, setStemCount] = useState(0);
  const [duration, setDuration] = useState(0);
  const [position, setPosition] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // Tear down on unmount.
  useEffect(() => {
    return () => {
      const host = hostRef.current;
      if (host) {
        void host.stop();
      }
    };
  }, []);

  // Position ticker while playing.
  useEffect(() => {
    if (state !== 'playing') return;
    let raf = 0;
    const tick = () => {
      const host = hostRef.current;
      const startedAt = playStartedAtRef.current;
      if (host && startedAt !== null) {
        const elapsed = host.currentTime - startedAt;
        if (elapsed >= duration) {
          handleStop();
          return;
        }
        setPosition(elapsed);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, duration]);

  async function ensureHost(): Promise<AudioHost> {
    if (hostRef.current) return hostRef.current;
    const host = new AudioHost({ workletUrl: '/aux-worklet.js' });
    await host.start();
    hostRef.current = host;
    return host;
  }

  async function loadStems(): Promise<void> {
    const res = await fetch(`/api/sessions/${sessionId}/stems`, { credentials: 'include' });
    if (!res.ok) throw new Error(`load failed (${res.status})`);
    const stems = (await res.json()) as StemWithUrl[];

    const host = await ensureHost();
    const downloadable = stems.filter((s) => s.downloadUrl);

    await Promise.all(
      downloadable.map(async (stem) => {
        if (host.isLoaded(stem.id) || !stem.downloadUrl) return;
        const audioRes = await fetch(stem.downloadUrl);
        if (!audioRes.ok) throw new Error(`fetch ${stem.name} failed`);
        const buffer = await audioRes.arrayBuffer();
        await host.loadStem(stem.id, buffer);
      })
    );

    setStemCount(downloadable.length);
    setDuration(host.durationSeconds);
  }

  async function handlePlay() {
    setError(null);
    try {
      setState('loading');
      await loadStems();
      const host = hostRef.current;
      if (!host) throw new Error('host missing');
      host.playAll(position);
      playStartedAtRef.current = host.currentTime - position;
      setState('playing');
    } catch (err) {
      setState('idle');
      setError(err instanceof Error ? err.message : 'playback failed');
    }
  }

  function handleStop() {
    const host = hostRef.current;
    if (host) host.stopAll();
    playStartedAtRef.current = null;
    setPosition(0);
    setState('idle');
  }

  return (
    <div className="sticky top-0 z-10 -mx-6 px-6 py-3 mb-8 bg-paper/95 backdrop-blur border-b border-line">
      <div className="flex items-center gap-4">
        {state === 'playing' ? (
          <Button onClick={handleStop} size="sm">
            ■ Stop
          </Button>
        ) : (
          <Button onClick={handlePlay} size="sm" disabled={state === 'loading'}>
            {state === 'loading' ? 'Loading…' : '▶ Play'}
          </Button>
        )}

        <span className="font-mono text-sm text-ink-2 tabular-nums">
          {formatTime(position)} / {formatTime(duration)}
        </span>

        {stemCount > 0 && (
          <span className="font-mono text-xs text-ink-3">
            {stemCount} stem{stemCount === 1 ? '' : 's'} loaded
          </span>
        )}

        {state === 'playing' && <span className="font-mono text-xs text-ink-3">● playing</span>}

        {error && <span className="text-xs text-red-700 font-mono ml-auto">{error}</span>}
      </div>
    </div>
  );
}
