'use client';

import type { Stem, StemWithUrl } from '@/lib/types';
import { AudioHost } from '@aux/audio-engine';
import { Button } from '@aux/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChannelStrip } from './_channel-strip';
import './mixer.css';

interface Props {
  sessionId: string;
  initialStems: Stem[];
}

type TransportState = 'idle' | 'loading' | 'playing';

export interface ChannelState {
  volume: number; // 0..2, 1 = unity
  pan: number; // -1..1
  muted: boolean;
  soloed: boolean;
}

const DEFAULT_CHANNEL: ChannelState = { volume: 1, pan: 0, muted: false, soloed: false };

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function MixerShell({ sessionId, initialStems }: Props) {
  const hostRef = useRef<AudioHost | null>(null);
  const playStartedAtRef = useRef<number | null>(null);

  const [stems, setStems] = useState<Stem[]>(initialStems);
  const [transport, setTransport] = useState<TransportState>('idle');
  const [duration, setDuration] = useState(0);
  const [position, setPosition] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [channelState, setChannelState] = useState<Record<string, ChannelState>>({});
  const [loadedIds, setLoadedIds] = useState<Set<string>>(new Set());

  // Tear down on unmount.
  useEffect(() => {
    return () => {
      const host = hostRef.current;
      if (host) void host.stop();
    };
  }, []);

  // Position ticker.
  useEffect(() => {
    if (transport !== 'playing') return;
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
  }, [transport, duration]);

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
    const fetched = (await res.json()) as StemWithUrl[];

    const host = await ensureHost();
    const downloadable = fetched.filter((s) => s.downloadUrl);

    await Promise.all(
      downloadable.map(async (stem) => {
        if (host.isLoaded(stem.id) || !stem.downloadUrl) return;
        const audioRes = await fetch(stem.downloadUrl);
        if (!audioRes.ok) throw new Error(`fetch ${stem.name} failed`);
        const audioData = await audioRes.arrayBuffer();
        await host.loadStem(stem.id, audioData);
      })
    );

    setStems(fetched);
    setLoadedIds(new Set(downloadable.map((s) => s.id)));
    setDuration(host.durationSeconds);

    // Initialize channel state for any stems we haven't seen yet.
    setChannelState((prev) => {
      const next = { ...prev };
      for (const stem of downloadable) {
        if (!next[stem.id]) next[stem.id] = { ...DEFAULT_CHANNEL };
      }
      return next;
    });
  }

  async function handlePlay() {
    setError(null);
    try {
      setTransport('loading');
      await loadStems();
      const host = hostRef.current;
      if (!host) throw new Error('host missing');
      host.playAll(position);
      playStartedAtRef.current = host.currentTime - position;
      setTransport('playing');
    } catch (err) {
      setTransport('idle');
      setError(err instanceof Error ? err.message : 'playback failed');
    }
  }

  function handleStop() {
    const host = hostRef.current;
    if (host) host.stopAll();
    playStartedAtRef.current = null;
    setPosition(0);
    setTransport('idle');
  }

  const setVolume = useCallback((stemId: string, volume: number) => {
    hostRef.current?.setChannelVolume(stemId, volume);
    setChannelState((prev) => ({
      ...prev,
      [stemId]: { ...(prev[stemId] ?? DEFAULT_CHANNEL), volume },
    }));
  }, []);

  const setPan = useCallback((stemId: string, pan: number) => {
    hostRef.current?.setChannelPan(stemId, pan);
    setChannelState((prev) => ({
      ...prev,
      [stemId]: { ...(prev[stemId] ?? DEFAULT_CHANNEL), pan },
    }));
  }, []);

  const toggleMute = useCallback((stemId: string) => {
    setChannelState((prev) => {
      const current = prev[stemId] ?? DEFAULT_CHANNEL;
      const muted = !current.muted;
      hostRef.current?.setChannelMute(stemId, muted);
      return { ...prev, [stemId]: { ...current, muted } };
    });
  }, []);

  const toggleSolo = useCallback((stemId: string) => {
    setChannelState((prev) => {
      const current = prev[stemId] ?? DEFAULT_CHANNEL;
      const soloed = !current.soloed;
      hostRef.current?.setChannelSolo(stemId, soloed);
      return { ...prev, [stemId]: { ...current, soloed } };
    });
  }, []);

  // Stems are exposed so the drop zone (sibling) can refresh the list.
  const onStemAdded = useCallback((stem: Stem) => {
    setStems((prev) => (prev.some((s) => s.id === stem.id) ? prev : [...prev, stem]));
  }, []);

  const onStemRemoved = useCallback((stemId: string) => {
    hostRef.current?.removeChannel(stemId);
    setStems((prev) => prev.filter((s) => s.id !== stemId));
    setChannelState((prev) => {
      const next = { ...prev };
      delete next[stemId];
      return next;
    });
    setLoadedIds((prev) => {
      const next = new Set(prev);
      next.delete(stemId);
      return next;
    });
  }, []);

  const anySoloed = useMemo(
    () => Object.values(channelState).some((c) => c.soloed),
    [channelState]
  );

  return (
    <>
      <div className="sticky top-0 z-10 -mx-6 px-6 py-3 mb-6 bg-paper/95 backdrop-blur border-b border-line">
        <div className="flex items-center gap-4">
          {transport === 'playing' ? (
            <Button onClick={handleStop} size="sm">
              ■ Stop
            </Button>
          ) : (
            <Button onClick={handlePlay} size="sm" disabled={transport === 'loading'}>
              {transport === 'loading' ? 'Loading…' : '▶ Play'}
            </Button>
          )}

          <span className="font-mono text-sm text-ink-2 tabular-nums">
            {formatTime(position)} / {formatTime(duration)}
          </span>

          {loadedIds.size > 0 && (
            <span className="font-mono text-xs text-ink-3">{loadedIds.size} loaded</span>
          )}

          {transport === 'playing' && (
            <span className="font-mono text-xs text-ink-3">● playing</span>
          )}

          {error && <span className="text-xs text-red-700 font-mono ml-auto">{error}</span>}
        </div>
      </div>

      {stems.length > 0 && (
        <section className="mb-10">
          <p className="font-mono text-xs tracking-widest uppercase text-ink-3 mb-3">Mixer</p>
          <div className="mixer">
            <div className="mixer-console">
              {stems.map((stem) => {
                const state = channelState[stem.id] ?? DEFAULT_CHANNEL;
                return (
                  <ChannelStrip
                    key={stem.id}
                    stem={stem}
                    state={state}
                    loaded={loadedIds.has(stem.id)}
                    anySoloed={anySoloed}
                    host={hostRef.current}
                    active={transport === 'playing'}
                    onVolume={(v) => setVolume(stem.id, v)}
                    onPan={(p) => setPan(stem.id, p)}
                    onMute={() => toggleMute(stem.id)}
                    onSolo={() => toggleSolo(stem.id)}
                  />
                );
              })}
            </div>
          </div>
        </section>
      )}

      {/* Exposed so the drop zone can update the parent's view. */}
      <StemEvents onStemAdded={onStemAdded} onStemRemoved={onStemRemoved} />
    </>
  );
}

// Stable callback bridge that StemDropZone can dispatch into via context-free
// custom events. Keeps StemDropZone unchanged.
function StemEvents({
  onStemAdded,
  onStemRemoved,
}: {
  onStemAdded: (s: Stem) => void;
  onStemRemoved: (id: string) => void;
}) {
  useEffect(() => {
    function handleAdded(e: Event) {
      const stem = (e as CustomEvent<Stem>).detail;
      if (stem) onStemAdded(stem);
    }
    function handleRemoved(e: Event) {
      const id = (e as CustomEvent<string>).detail;
      if (id) onStemRemoved(id);
    }
    window.addEventListener('aux:stem-added', handleAdded);
    window.addEventListener('aux:stem-removed', handleRemoved);
    return () => {
      window.removeEventListener('aux:stem-added', handleAdded);
      window.removeEventListener('aux:stem-removed', handleRemoved);
    };
  }, [onStemAdded, onStemRemoved]);
  return null;
}
