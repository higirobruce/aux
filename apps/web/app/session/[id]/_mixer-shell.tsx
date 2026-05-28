'use client';

import type { Stem, StemWithUrl } from '@/lib/types';
import { AudioHost } from '@aux/audio-engine';
import { MIX_STATE_VERSION, MixStateSchema } from '@aux/session-doc';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChannelStrip } from './_channel-strip';
import { StemDropZone } from './_stem-drop-zone';
import './mixer.css';

interface Props {
  sessionId: string;
  sessionName: string;
  storageMode: string;
  initialStems: Stem[];
  initialMixState: unknown;
}

type TransportState = 'idle' | 'loading' | 'playing';
type SaveStatus = 'idle' | 'saving' | 'saved' | 'failed';

export interface ChannelState {
  volume: number; // 0..2, 1 = unity
  pan: number; // -1..1
  muted: boolean;
  soloed: boolean;
}

const DEFAULT_CHANNEL: ChannelState = { volume: 1, pan: 0, muted: false, soloed: false };
const AUTOSAVE_DEBOUNCE_MS = 600;

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/**
 * Parse the server-provided mix state. Tolerates missing / malformed data —
 * an unknown schema or invalid payload just yields an empty channel map.
 */
function hydrateChannelState(raw: unknown): Record<string, ChannelState> {
  if (raw == null) return {};
  const parsed = MixStateSchema.safeParse(raw);
  if (!parsed.success) return {};
  return parsed.data.channels;
}

export function MixerShell({
  sessionId,
  sessionName,
  storageMode,
  initialStems,
  initialMixState,
}: Props) {
  const hostRef = useRef<AudioHost | null>(null);
  const playStartedAtRef = useRef<number | null>(null);

  const [stems, setStems] = useState<Stem[]>(initialStems);
  const [transport, setTransport] = useState<TransportState>('idle');
  const [duration, setDuration] = useState(0);
  const [position, setPosition] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [channelState, setChannelState] = useState<Record<string, ChannelState>>(() =>
    hydrateChannelState(initialMixState)
  );
  const [loadedIds, setLoadedIds] = useState<Set<string>>(new Set());
  const [stemsOpen, setStemsOpen] = useState(initialStems.length === 0);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  // First render is hydration; suppress that as an autosave trigger.
  const hasMounted = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlightSave = useRef<AbortController | null>(null);

  const handleStop = useCallback(() => {
    const host = hostRef.current;
    if (host) host.stopAll();
    playStartedAtRef.current = null;
    setPosition(0);
    setTransport('idle');
  }, []);

  // Keep a live ref to channelState so async helpers (loadStems, the autosave
  // flush) read the current value without re-binding.
  const channelStateRef = useRef(channelState);
  useEffect(() => {
    channelStateRef.current = channelState;
  }, [channelState]);

  // Tear down on unmount.
  useEffect(() => {
    return () => {
      const host = hostRef.current;
      if (host) void host.stop();
      if (saveTimer.current) clearTimeout(saveTimer.current);
      if (inFlightSave.current) inFlightSave.current.abort();
    };
  }, []);

  // Debounced autosave. Every channel-state change schedules a PUT
  // /api/sessions/:id/mix after AUTOSAVE_DEBOUNCE_MS of idle. The effect body
  // reads channelStateRef.current at flush time — channelState only sits in
  // the dep list to trigger the rerun on each change.
  // biome-ignore lint/correctness/useExhaustiveDependencies: trigger-only dep
  useEffect(() => {
    if (!hasMounted.current) {
      hasMounted.current = true;
      return;
    }

    if (saveTimer.current) clearTimeout(saveTimer.current);

    saveTimer.current = setTimeout(async () => {
      // Cancel any save still in flight — newest wins.
      if (inFlightSave.current) inFlightSave.current.abort();
      const controller = new AbortController();
      inFlightSave.current = controller;

      setSaveStatus('saving');
      try {
        const res = await fetch(`/api/sessions/${sessionId}/mix`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          signal: controller.signal,
          // keepalive so the request survives if the tab unloads mid-flight.
          keepalive: true,
          body: JSON.stringify({
            version: MIX_STATE_VERSION,
            channels: channelStateRef.current,
          }),
        });
        if (!res.ok) throw new Error(`save failed (${res.status})`);
        setSaveStatus('saved');
      } catch (err) {
        if ((err as { name?: string })?.name === 'AbortError') return;
        setSaveStatus('failed');
      }
    }, AUTOSAVE_DEBOUNCE_MS);

    return () => {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
    };
  }, [channelState, sessionId]);

  // Flush any pending debounced save before the page unloads. `pagehide` is
  // more reliable than `beforeunload` (especially on Safari / mobile). The
  // keepalive flag tells the browser to let the request complete after the
  // page is gone. Already-in-flight saves above also use keepalive so they
  // survive on their own — this handler only covers the queued-but-not-yet-
  // fired case.
  useEffect(() => {
    const flush = () => {
      if (saveTimer.current === null) return;
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
      try {
        void fetch(`/api/sessions/${sessionId}/mix`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          keepalive: true,
          body: JSON.stringify({
            version: MIX_STATE_VERSION,
            channels: channelStateRef.current,
          }),
        });
      } catch {
        // Can't surface errors from an unload handler.
      }
    };
    window.addEventListener('pagehide', flush);
    return () => window.removeEventListener('pagehide', flush);
  }, [sessionId]);

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
  }, [transport, duration, handleStop]);

  // Esc closes the drawer.
  useEffect(() => {
    if (!stemsOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setStemsOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [stemsOpen]);

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

    setChannelState((prev) => {
      const next = { ...prev };
      for (const stem of downloadable) {
        if (!next[stem.id]) next[stem.id] = { ...DEFAULT_CHANNEL };
      }
      return next;
    });

    // Apply the (possibly hydrated) channel state to the audio graph. Without
    // this, the host's GainNode + StereoPannerNode start at defaults even when
    // we just restored a mix from autosave.
    const latest = channelStateRef.current;
    for (const stem of downloadable) {
      const ch = latest[stem.id];
      if (!ch) continue;
      host.setChannelVolume(stem.id, ch.volume, 0);
      host.setChannelPan(stem.id, ch.pan, 0);
      host.setChannelMute(stem.id, ch.muted);
      host.setChannelSolo(stem.id, ch.soloed);
    }
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
      <div className="mixer mixer-fullscreen">
        <div className="mixer-transport">
          <Link
            href="/"
            className="transport-btn"
            title="Back to sessions"
            aria-label="Back to sessions"
          >
            ←
          </Link>
          {transport === 'playing' ? (
            <button
              type="button"
              className="transport-btn on"
              onClick={handleStop}
              title="Stop"
              aria-label="Stop"
            >
              ■
            </button>
          ) : (
            <button
              type="button"
              className="transport-btn"
              onClick={handlePlay}
              disabled={transport === 'loading' || stems.length === 0}
              title={stems.length === 0 ? 'Add stems first' : 'Play'}
              aria-label="Play"
            >
              {transport === 'loading' ? '…' : '▶'}
            </button>
          )}

          <div className="transport-time" aria-live="off">
            {formatTime(position)} / {formatTime(duration)}
          </div>

          <div className="transport-info">
            <span className="name" title={sessionName}>
              {sessionName}
            </span>
            <span className="muted">{storageMode}</span>
            {loadedIds.size > 0 && <span className="muted">{loadedIds.size} loaded</span>}
            {transport === 'playing' && <span className="playing">● playing</span>}
            {saveStatus === 'saving' && <span className="muted">saving…</span>}
            {saveStatus === 'saved' && <span className="muted">saved</span>}
            {saveStatus === 'failed' && <span className="err">save failed</span>}
            {error && <span className="err">{error}</span>}
          </div>

          <button
            type="button"
            className="transport-stems-btn"
            onClick={() => setStemsOpen(true)}
            aria-label="Open stems panel"
          >
            Stems
            <span className="count">{stems.length}</span>
          </button>
        </div>

        <div className="mixer-body">
          <div className="mixer-console">
            {stems.length > 0 ? (
              stems.map((stem) => {
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
              })
            ) : (
              <div className="mixer-empty">
                <p>No stems in this session yet.</p>
                <button
                  type="button"
                  className="mixer-empty-cta"
                  onClick={() => setStemsOpen(true)}
                >
                  Add stems →
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      <button
        type="button"
        aria-label="Close stems panel"
        aria-hidden={!stemsOpen}
        tabIndex={stemsOpen ? 0 : -1}
        className={`stems-backdrop ${stemsOpen ? '' : 'closed'}`}
        onClick={() => setStemsOpen(false)}
      />
      <aside
        className={`stems-drawer ${stemsOpen ? '' : 'closed'}`}
        aria-label="Stems"
        aria-hidden={!stemsOpen}
      >
        <div className="stems-drawer-header">
          <span className="stems-drawer-title">Stems</span>
          <button
            type="button"
            className="stems-drawer-close"
            onClick={() => setStemsOpen(false)}
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <div className="stems-drawer-body">
          <StemDropZone sessionId={sessionId} initialStems={initialStems} />
        </div>
      </aside>

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
