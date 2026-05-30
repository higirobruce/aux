'use client';

import { isLocalKey, resolveStemStore } from '@/lib/stem-store';
import type { Stem, StemWithUrl } from '@/lib/types';
import {
  AudioHost,
  Eq8BandType,
  MASTER_BUS_ID,
  type ReferenceRoomPreset,
  type ReverbKind,
} from '@aux/audio-engine';
import {
  type BusState,
  COMP_COLOR_DEFAULTS,
  COMP_DEFAULTS,
  type ChannelEqFull,
  type CompType,
  DEFAULT_CHANNEL_COMP,
  DEFAULT_CHANNEL_CONSOLE,
  DEFAULT_CHANNEL_DEESS,
  DEFAULT_CHANNEL_EQ,
  DEFAULT_CHANNEL_IMAGER,
  DEFAULT_CHANNEL_MBCOMP,
  DEFAULT_CHANNEL_TAPE,
  DEFAULT_CHANNEL_TRANSIENT,
  DEFAULT_COMP_TYPE,
  DEFAULT_LIMITER_STATE,
  DEFAULT_MASTER_BUS,
  DEFAULT_MASTER_CHAIN,
  DEFAULT_STEM_CLIPS,
  EQ_QUICK_BAND_IDS,
  type EqFullBand,
  type EqFullBandType,
  type LimiterState,
  MIX_STATE_VERSION,
  type MasterChain,
  MixStateSchema,
  type ReverbState,
  type StemClip,
  defaultReverb,
  eqFullFromQuick,
  quickFromEqFull,
} from '@aux/session-doc';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BusStrip } from './_bus-strip';
import { ChannelStrip } from './_channel-strip';
import { type OpenPlugin, type PluginType, PluginWindows } from './_plugin-windows';
import { StemDropZone } from './_stem-drop-zone';
import { type StemPeaks, StemTimeline } from './_stem-timeline';
import './mixer.css';

interface Props {
  sessionId: string;
  sessionName: string;
  storageMode: 'cloud' | 'local';
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
  eq: { lo: number; mid: number; hi: number; bypassed: boolean }; // dB, ±24 (quick knobs)
  /** Full 5-band parametric EQ — source of truth; eq.{lo,mid,hi} mirror bands 1/2/4. */
  eqFull: ChannelEqFull;
  comp: {
    threshold: number; // dB
    ratio: number; // n:1
    bypassed: boolean;
    attackMs: number;
    releaseMs: number;
    makeupDb: number;
    knee: number; // UI/curve only
  };
  compType: CompType; // 'clean' (VCA) or 'color' (FET)
  outputBusId: string;
  /** Post-fader aux sends keyed by destination bus id (linear 0..2). */
  sends: Record<string, number>;
  /** Transient designer — both knobs ∈ [-1, 1]. */
  transient: { attack: number; sustain: number; bypassed: boolean };
  /** DeEss — split-band sibilance tamer. */
  deess: { freq: number; amount: number; bypassed: boolean };
  /** Imager — M/S stereo width. */
  imager: { width: number; bypassed: boolean };
  /** Tape — single-stage saturation. */
  tape: { driveDb: number; tone: number; mix: number; bypassed: boolean };
  /** Console — asymmetric channel-strip saturation. */
  console: { driveDb: number; character: number; mix: number; bypassed: boolean };
  /** MB-Comp — 3-band multiband compressor (per-band thresholds + shared ratio). */
  mbcomp: {
    loThreshDb: number;
    midThreshDb: number;
    hiThreshDb: number;
    ratio: number;
    bypassed: boolean;
  };
  /** Timeline regions for this stem. Always concrete in memory (hydration
   *  normalises absent/optional to []); empty = whole buffer at t=0. */
  clips: StemClip[];
}

const DEFAULT_CHANNEL: ChannelState = {
  volume: 1,
  pan: 0,
  muted: false,
  soloed: false,
  eq: { ...DEFAULT_CHANNEL_EQ },
  eqFull: eqFullFromQuick(DEFAULT_CHANNEL_EQ),
  comp: { ...DEFAULT_CHANNEL_COMP },
  compType: DEFAULT_COMP_TYPE,
  outputBusId: MASTER_BUS_ID,
  sends: {},
  transient: { ...DEFAULT_CHANNEL_TRANSIENT },
  deess: { ...DEFAULT_CHANNEL_DEESS },
  imager: { ...DEFAULT_CHANNEL_IMAGER },
  tape: { ...DEFAULT_CHANNEL_TAPE },
  console: { ...DEFAULT_CHANNEL_CONSOLE },
  mbcomp: { ...DEFAULT_CHANNEL_MBCOMP },
  clips: [...DEFAULT_STEM_CLIPS],
};
const AUTOSAVE_DEBOUNCE_MS = 600;

/**
 * EQ band layout — three knobs on the strip map to three of the eight
 * EQ-8 bands. The remaining five (HP, two peaks, HS, LP) wait for the
 * v0.3 full-EQ panel.
 */
const EQ_BANDS = {
  lo: { idx: 1, type: Eq8BandType.LowShelf, freq: 100, q: Math.SQRT1_2 },
  mid: { idx: 3, type: Eq8BandType.Peak, freq: 1000, q: 1.0 },
  hi: { idx: 6, type: Eq8BandType.HighShelf, freq: 8000, q: Math.SQRT1_2 },
} as const;
export type EqBand = keyof typeof EQ_BANDS;

/** Editable compressor fields (strip sends threshold/ratio; window sends all). */
export type CompField = 'threshold' | 'ratio' | 'attackMs' | 'releaseMs' | 'makeupDb' | 'knee';

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

interface HydratedMix {
  channels: Record<string, ChannelState>;
  buses: Record<string, BusState>;
  masterChain: MasterChain;
}

/**
 * Parse the server-provided mix state. Tolerates missing / malformed data —
 * an unknown schema or invalid payload yields the empty default.
 *
 * Backcompat: older docs (v1 pre-EQ, v2 pre-comp, v3 pre-comp-type, v4
 * pre-buses) are upgraded in memory by filling in defaults for the missing
 * sections. The next autosave promotes the doc to the current version.
 */
function hydrateMixState(raw: unknown): HydratedMix {
  const empty: HydratedMix = {
    channels: {},
    buses: { [MASTER_BUS_ID]: { ...DEFAULT_MASTER_BUS } },
    masterChain: {
      limiter: { ...DEFAULT_LIMITER_STATE },
      referenceRoom: { preset: 'off' },
    },
  };

  if (raw == null) return empty;

  const current = MixStateSchema.safeParse(raw);
  if (current.success) {
    // Ensure Master exists even if a malformed v7 doc dropped it.
    const buses = { ...current.data.buses };
    if (!buses[MASTER_BUS_ID]) buses[MASTER_BUS_ID] = { ...DEFAULT_MASTER_BUS };
    // Normalise optional `clips` (absent on v15 docs) to a concrete [] so the
    // engine + timeline can treat "no clips" uniformly as a whole-buffer clip.
    const channels: Record<string, ChannelState> = {};
    for (const [id, ch] of Object.entries(current.data.channels)) {
      const eqFull = ch.eqFull ?? eqFullFromQuick(ch.eq);
      channels[id] = {
        ...ch,
        clips: ch.clips ?? [],
        eqFull,
        eq: { ...ch.eq, ...quickFromEqFull(eqFull) },
      };
    }
    return {
      channels,
      buses,
      masterChain: current.data.masterChain,
    };
  }

  if (typeof raw !== 'object' || raw === null || !('version' in raw) || !('channels' in raw)) {
    return empty;
  }
  const ver = (raw as { version: unknown }).version;
  if (typeof ver !== 'number' || ver < 1 || ver >= MIX_STATE_VERSION) return empty;

  const channels = (raw as { channels: Record<string, unknown> }).channels;
  const upgradedChannels: Record<string, ChannelState> = {};
  for (const [id, ch] of Object.entries(channels)) {
    if (!ch || typeof ch !== 'object') continue;
    const c = ch as Partial<ChannelState>;
    if (
      typeof c.volume !== 'number' ||
      typeof c.pan !== 'number' ||
      typeof c.muted !== 'boolean' ||
      typeof c.soloed !== 'boolean'
    ) {
      continue;
    }
    upgradedChannels[id] = {
      volume: c.volume,
      pan: c.pan,
      muted: c.muted,
      soloed: c.soloed,
      eq: {
        ...DEFAULT_CHANNEL_EQ,
        ...c.eq,
        bypassed: c.eq?.bypassed ?? false,
        ...quickFromEqFull(c.eqFull ?? eqFullFromQuick({ ...DEFAULT_CHANNEL_EQ, ...c.eq })),
      },
      eqFull: c.eqFull ?? eqFullFromQuick({ ...DEFAULT_CHANNEL_EQ, ...c.eq }),
      comp: { ...DEFAULT_CHANNEL_COMP, ...c.comp, bypassed: c.comp?.bypassed ?? false },
      compType: c.compType ?? DEFAULT_COMP_TYPE,
      outputBusId: c.outputBusId ?? MASTER_BUS_ID,
      sends: c.sends ?? {},
      transient: c.transient ?? { ...DEFAULT_CHANNEL_TRANSIENT },
      deess: c.deess ?? { ...DEFAULT_CHANNEL_DEESS },
      imager: c.imager ?? { ...DEFAULT_CHANNEL_IMAGER },
      tape: c.tape ?? { ...DEFAULT_CHANNEL_TAPE },
      console: c.console ?? { ...DEFAULT_CHANNEL_CONSOLE },
      mbcomp: c.mbcomp ?? { ...DEFAULT_CHANNEL_MBCOMP },
      clips: c.clips ?? [],
    };
  }
  // Bus migration. v5+ docs already have a `buses` field; older docs don't.
  // We also need to translate v8's `bus.plate` into v9's
  // `bus.reverb: { kind: 'plate', ... }`.
  const upgradedBuses: Record<string, BusState> = {
    [MASTER_BUS_ID]: { ...DEFAULT_MASTER_BUS },
  };
  const rawBuses = (raw as { buses?: unknown }).buses;
  if (rawBuses && typeof rawBuses === 'object') {
    for (const [id, b] of Object.entries(rawBuses as Record<string, unknown>)) {
      if (!b || typeof b !== 'object') continue;
      const src = b as Partial<BusState> & { plate?: Partial<ReverbState> };
      if (
        typeof src.id !== 'string' ||
        typeof src.name !== 'string' ||
        typeof src.gain !== 'number' ||
        typeof src.muted !== 'boolean'
      ) {
        continue;
      }
      const base: BusState = {
        id: src.id,
        name: src.name,
        gain: src.gain,
        muted: src.muted,
      };
      // v8 → v9: promote `plate` to `reverb` with kind = 'plate'.
      if (src.plate && typeof src.plate === 'object') {
        base.reverb = { ...defaultReverb('plate'), ...src.plate, kind: 'plate' };
      } else if (src.reverb && typeof src.reverb === 'object') {
        base.reverb = { ...defaultReverb('plate'), ...src.reverb };
      }
      upgradedBuses[id] = base;
    }
  }

  // Preserve the older doc's limiter if it has well-shaped values — the
  // upgrade path was previously wiping it back to defaults whenever the
  // version bumped, which surprised users who had tuned the master limiter.
  const rawMaster = (raw as { masterChain?: { limiter?: Partial<LimiterState> } }).masterChain;
  const oldLim = rawMaster?.limiter;
  const preservedLimiter: LimiterState =
    oldLim &&
    typeof oldLim.thresholdDb === 'number' &&
    typeof oldLim.releaseMs === 'number' &&
    typeof oldLim.makeupDb === 'number' &&
    typeof oldLim.bypassed === 'boolean'
      ? {
          thresholdDb: oldLim.thresholdDb,
          releaseMs: oldLim.releaseMs,
          makeupDb: oldLim.makeupDb,
          bypassed: oldLim.bypassed,
        }
      : { ...DEFAULT_LIMITER_STATE };

  return {
    channels: upgradedChannels,
    buses: upgradedBuses,
    masterChain: {
      ...DEFAULT_MASTER_CHAIN,
      limiter: preservedLimiter,
    },
  };
}

/**
 * Push the two-knob (threshold + ratio) state into whichever comp flavour
 * is currently selected and bypass the other one. Drive is fixed (per
 * COMP_COLOR_DEFAULTS) until the deep-edit panel exposes it.
 *
 * Module-level (not closed over component state) so it can be referenced
 * from useCallback bodies without joining their dep arrays.
 */
/** Design band type → engine Eq8 numeric band type. */
const EQ_TYPE_TO_ENGINE: Record<EqFullBandType, Eq8BandType> = {
  hp: Eq8BandType.HighPass,
  lowshelf: Eq8BandType.LowShelf,
  peak: Eq8BandType.Peak,
  highshelf: Eq8BandType.HighShelf,
  lp: Eq8BandType.LowPass,
};

/** Push one full-EQ band to the engine. A disabled band parks its slot as
 *  Bypass so it passes through without disturbing the others. */
function applyEqBandToHost(host: AudioHost, stemId: string, band: EqFullBand): void {
  const type = band.on ? EQ_TYPE_TO_ENGINE[band.type] : Eq8BandType.Bypass;
  host.setChannelEqBand(stemId, band.id, type, band.freq, band.gain, band.q);
}

/** Push the whole 5-band EQ to the engine (used on load + flavour changes). */
function applyEqFullToHost(host: AudioHost, stemId: string, eqFull: ChannelEqFull): void {
  for (const band of eqFull.bands) applyEqBandToHost(host, stemId, band);
}

type CompParams = ChannelState['comp'];

function applyCompToHost(
  host: AudioHost,
  stemId: string,
  comp: CompParams,
  compType: CompType
): void {
  // Whole-insert bypass: park both flavours so neither colours the signal.
  if (comp.bypassed) {
    host.setChannelCompBypassed(stemId, true);
    host.setChannelCompColorBypassed(stemId, true);
    return;
  }
  if (compType === 'clean') {
    host.setChannelComp(
      stemId,
      comp.threshold,
      comp.ratio,
      comp.attackMs,
      comp.releaseMs,
      comp.makeupDb,
      COMP_DEFAULTS.mix
    );
    host.setChannelCompBypassed(stemId, false);
    host.setChannelCompColorBypassed(stemId, true);
  } else {
    host.setChannelCompColor(
      stemId,
      comp.threshold,
      comp.ratio,
      comp.attackMs,
      comp.releaseMs,
      comp.makeupDb,
      COMP_DEFAULTS.mix,
      COMP_COLOR_DEFAULTS.driveDb
    );
    host.setChannelCompColorBypassed(stemId, false);
    host.setChannelCompBypassed(stemId, true);
  }
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
  const hydrated = useMemo(() => hydrateMixState(initialMixState), [initialMixState]);
  const [channelState, setChannelState] = useState<Record<string, ChannelState>>(
    () => hydrated.channels
  );
  const [busState, setBusState] = useState<Record<string, BusState>>(() => hydrated.buses);
  const [masterChain, setMasterChain] = useState<MasterChain>(() => hydrated.masterChain);
  const [loadedIds, setLoadedIds] = useState<Set<string>>(new Set());
  const [stemsOpen, setStemsOpen] = useState(initialStems.length === 0);
  const [timelineOpen, setTimelineOpen] = useState(true);
  /** Expand the mixer to fill the viewport (hides the timeline). */
  const [expanded, setExpanded] = useState(false);
  /** Resizable mixer-panel height (px) when not expanded. */
  const [mixerHeight, setMixerHeight] = useState(440);
  const [peaks, setPeaks] = useState<Record<string, StemPeaks | undefined>>({});
  /** Open floating plugin windows. Last entry renders on top (focus). */
  const [openPlugins, setOpenPlugins] = useState<OpenPlugin[]>([]);
  const openPlugin = useCallback((type: PluginType, stemId: string) => {
    setOpenPlugins((prev) => {
      const key = `${type}:${stemId}`;
      return [...prev.filter((p) => `${p.type}:${p.stemId}` !== key), { type, stemId }];
    });
  }, []);
  const closePlugin = useCallback((i: number) => {
    setOpenPlugins((prev) => prev.filter((_, idx) => idx !== i));
  }, []);
  const focusPlugin = useCallback((i: number) => {
    setOpenPlugins((prev) => {
      const p = prev[i];
      if (!p || i === prev.length - 1) return prev;
      return [...prev.filter((_, idx) => idx !== i), p];
    });
  }, []);
  /** Currently-selected timeline clip (for trim/move highlight + delete). */
  const [selectedClip, setSelectedClip] = useState<{ stemId: string; clipId: string } | null>(null);
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

  // Keep live refs to channelState + busState so async helpers (loadStems,
  // the autosave flush) read the current value without re-binding.
  const channelStateRef = useRef(channelState);
  useEffect(() => {
    channelStateRef.current = channelState;
  }, [channelState]);
  const busStateRef = useRef(busState);
  useEffect(() => {
    busStateRef.current = busState;
  }, [busState]);
  const masterChainRef = useRef(masterChain);
  useEffect(() => {
    masterChainRef.current = masterChain;
  }, [masterChain]);

  // Tear down on unmount.
  useEffect(() => {
    return () => {
      const host = hostRef.current;
      if (host) void host.stop();
      if (saveTimer.current) clearTimeout(saveTimer.current);
      if (inFlightSave.current) inFlightSave.current.abort();
    };
  }, []);

  // Pre-decode stems on mount so the timeline can show waveforms without
  // waiting for a Play press. The AudioContext starts in 'suspended' state —
  // we don't need a user gesture to decode, only to actually play. Failures
  // are silent: the worst case is the timeline keeps saying "loading…" until
  // the user hits Play, which is what it did before this effect existed.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await loadStems();
      } catch {
        // Surfaced through the normal play path; nothing to do here.
      }
      if (cancelled) return;
    })();
    return () => {
      cancelled = true;
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
            buses: busStateRef.current,
            masterChain: masterChainRef.current,
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
  }, [channelState, busState, masterChain, sessionId]);

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
            buses: busStateRef.current,
            masterChain: masterChainRef.current,
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
    const host = new AudioHost({
      workletUrl: '/aux-worklet.js',
      eq8WorkletUrl: '/eq8-worklet.js',
      eq8WasmUrl: '/eq8_bg.wasm',
      compCleanWorkletUrl: '/comp-clean-worklet.js',
      compCleanWasmUrl: '/comp_clean_bg.wasm',
      compColorWorkletUrl: '/comp-color-worklet.js',
      compColorWasmUrl: '/comp_color_bg.wasm',
      limiterWorkletUrl: '/limiter-worklet.js',
      limiterWasmUrl: '/limiter_bg.wasm',
      plateWorkletUrl: '/plate-worklet.js',
      plateWasmUrl: '/plate_bg.wasm',
      hallWorkletUrl: '/hall-worklet.js',
      hallWasmUrl: '/hall_bg.wasm',
      transientWorkletUrl: '/transient-worklet.js',
      transientWasmUrl: '/transient_bg.wasm',
      deessWorkletUrl: '/deess-worklet.js',
      deessWasmUrl: '/deess_bg.wasm',
      imagerWorkletUrl: '/imager-worklet.js',
      imagerWasmUrl: '/imager_bg.wasm',
      tapeWorkletUrl: '/tape-worklet.js',
      tapeWasmUrl: '/tape_bg.wasm',
      consoleWorkletUrl: '/console-worklet.js',
      consoleWasmUrl: '/console_bg.wasm',
      mbcompWorkletUrl: '/mbcomp-worklet.js',
      mbcompWasmUrl: '/mbcomp_bg.wasm',
    });
    await host.start();
    hostRef.current = host;
    return host;
  }

  async function loadStems(): Promise<void> {
    const res = await fetch(`/api/sessions/${sessionId}/stems`, { credentials: 'include' });
    if (!res.ok) throw new Error(`load failed (${res.status})`);
    const fetched = (await res.json()) as StemWithUrl[];

    const host = await ensureHost();
    const localStore = storageMode === 'local' ? resolveStemStore('local') : null;

    // A stem is "loadable" if we can reach its audio from this browser:
    //   - cloud: any stem with a downloadUrl
    //   - local: any stem whose s3Key is an opfs:* key (we'll read OPFS)
    const loadable = fetched.filter((s) =>
      storageMode === 'local' ? isLocalKey(s.s3Key) : !!s.downloadUrl
    );

    // Per-stem try/catch so a single missing OPFS file (different browser
    // profile, manual storage cleanup, etc.) doesn't poison the whole
    // batch and leave every lane stuck on "loading…". Successes populate
    // peaks/duration; failures log but don't throw.
    const succeeded: StemWithUrl[] = [];
    await Promise.all(
      loadable.map(async (stem) => {
        try {
          if (host.isLoaded(stem.id)) {
            succeeded.push(stem);
            return;
          }
          let audioData: ArrayBuffer;
          if (localStore && isLocalKey(stem.s3Key)) {
            const file = await localStore.getStem(stem.s3Key as string);
            audioData = await file.arrayBuffer();
          } else if (stem.downloadUrl) {
            const audioRes = await fetch(stem.downloadUrl);
            if (!audioRes.ok) throw new Error(`fetch ${stem.name} failed (${audioRes.status})`);
            audioData = await audioRes.arrayBuffer();
          } else {
            return; // not loadable
          }
          await host.loadStem(stem.id, audioData);
          succeeded.push(stem);
        } catch (err) {
          console.warn(`[mixer] could not load stem ${stem.name}:`, err);
        }
      })
    );

    setStems(fetched);
    setLoadedIds(new Set(succeeded.map((s) => s.id)));
    setDuration(host.durationSeconds);

    // Build / refresh peaks for the read-only timeline. Each stem is at most
    // a few thousand min/max pairs — cheap to compute (linear scan over the
    // already-decoded AudioBuffer) and we only redo it for stems that don't
    // already have peaks (or whose buffer was just swapped).
    setPeaks((prev) => {
      const next: Record<string, StemPeaks | undefined> = { ...prev };
      for (const stem of loadable) {
        if (next[stem.id]) continue;
        const p = host.getStemPeaks(stem.id, 2000);
        if (p) next[stem.id] = p;
      }
      // Drop peaks for stems that no longer exist.
      const live = new Set(loadable.map((s) => s.id));
      for (const id of Object.keys(next)) {
        if (!live.has(id)) delete next[id];
      }
      return next;
    });

    setChannelState((prev) => {
      const next = { ...prev };
      for (const stem of loadable) {
        if (!next[stem.id]) next[stem.id] = { ...DEFAULT_CHANNEL };
      }
      return next;
    });

    // Apply the (possibly hydrated) channel state to the audio graph. Without
    // this, the host's GainNode + StereoPannerNode start at defaults even when
    // we just restored a mix from autosave.
    const latest = channelStateRef.current;
    for (const stem of loadable) {
      const ch = latest[stem.id];
      if (!ch) continue;
      host.setChannelVolume(stem.id, ch.volume, 0);
      host.setChannelPan(stem.id, ch.pan, 0);
      host.setChannelMute(stem.id, ch.muted);
      host.setChannelSolo(stem.id, ch.soloed);
      applyEqFullToHost(host, stem.id, ch.eqFull);
      host.setChannelEqBypassed(stem.id, ch.eq.bypassed);
      applyCompToHost(host, stem.id, ch.comp, ch.compType);
      host.setChannelTransient(stem.id, ch.transient.attack, ch.transient.sustain);
      host.setChannelTransientBypassed(stem.id, ch.transient.bypassed);
      host.setChannelDeEss(stem.id, ch.deess.freq, ch.deess.amount);
      host.setChannelDeEssBypassed(stem.id, ch.deess.bypassed);
      host.setChannelImager(stem.id, ch.imager.width);
      host.setChannelImagerBypassed(stem.id, ch.imager.bypassed);
      host.setChannelTape(stem.id, ch.tape.driveDb, ch.tape.tone, ch.tape.mix);
      host.setChannelTapeBypassed(stem.id, ch.tape.bypassed);
      host.setChannelConsole(stem.id, ch.console.driveDb, ch.console.character, ch.console.mix);
      host.setChannelConsoleBypassed(stem.id, ch.console.bypassed);
      host.setChannelMbComp(
        stem.id,
        ch.mbcomp.loThreshDb,
        ch.mbcomp.midThreshDb,
        ch.mbcomp.hiThreshDb,
        ch.mbcomp.ratio
      );
      host.setChannelMbCompBypassed(stem.id, ch.mbcomp.bypassed);
      host.setChannelClips(stem.id, ch.clips);
    }
    // Clips can extend (or shorten) the effective timeline, so recompute the
    // duration after they're applied — the earlier set used buffer lengths.
    setDuration(host.durationSeconds);

    // Ensure user-defined buses exist on the host (Master is auto-created)
    // and apply gain + mute. addBus is idempotent — safe to call every load.
    for (const bus of Object.values(busStateRef.current)) {
      if (bus.id !== MASTER_BUS_ID) {
        host.addBus({ id: bus.id, name: bus.name, gain: bus.gain });
      }
      host.setBusGain(bus.id, bus.gain, 0);
      host.setBusMute(bus.id, bus.muted, 0);
      // Restore any bus-level reverb insert + its saved params.
      if (bus.reverb && bus.id !== MASTER_BUS_ID) {
        if (host.getBusReverbKind(bus.id) !== bus.reverb.kind) {
          host.addBusReverb(bus.id, bus.reverb.kind);
        }
        host.setBusReverbParams(
          bus.id,
          bus.reverb.decay,
          bus.reverb.damping,
          bus.reverb.preDelayMs,
          bus.reverb.mix
        );
        host.setBusReverbBypassed(bus.id, bus.reverb.bypassed);
      }
    }

    // Master limiter — push saved params + bypass flag.
    const lim = masterChainRef.current.limiter;
    host.setMasterLimiter(lim.thresholdDb, lim.releaseMs, lim.makeupDb);
    host.setMasterLimiterBypassed(lim.bypassed);

    // Reference Room preset — restore the saved monitoring filter.
    host.setMasterReferenceRoom(masterChainRef.current.referenceRoom.preset);

    // Route channels to their saved bus. The host's addChannel defaults to
    // Master, so this only does work for non-Master targets — but it's safe
    // to call across the board (no-op on a same-bus reconnect).
    for (const stem of loadable) {
      const ch = latest[stem.id];
      if (!ch) continue;
      if (ch.outputBusId !== MASTER_BUS_ID) host.setChannelOutput(stem.id, ch.outputBusId);
      // Restore any post-fader aux sends to buses that still exist.
      for (const [busId, level] of Object.entries(ch.sends)) {
        if (busStateRef.current[busId]) {
          host.setChannelSend(stem.id, busId, level, 0);
        }
      }
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

  // Seek from the stem timeline. Always clamps to the loaded duration; if we
  // were playing, restarts every source at the new offset (playAll() also
  // handles the implicit stopAll). Otherwise just updates state — the next
  // play will start from there.
  const handleSeek = useCallback(
    (seconds: number) => {
      const target = Math.max(0, Math.min(seconds, duration));
      setPosition(target);
      setSelectedClip(null); // clicking the timeline to seek clears any selection
      const host = hostRef.current;
      if (host?.isPlaying) {
        host.playAll(target);
        playStartedAtRef.current = host.currentTime - target;
      }
    },
    [duration]
  );

  /** Apply a stem's clips to the engine + state without touching history.
   *  Shared by user edits, undo, and redo. */
  const applyClips = useCallback((stemId: string, clips: StemClip[]) => {
    hostRef.current?.setChannelClips(stemId, clips);
    setChannelState((prev) => ({
      ...prev,
      [stemId]: { ...(prev[stemId] ?? DEFAULT_CHANNEL), clips },
    }));
    const dur = hostRef.current?.durationSeconds;
    if (typeof dur === 'number' && dur > 0) setDuration(dur);
  }, []);

  // Per-stem clip-edit history. One entry per committed gesture (the timeline
  // already coalesces a drag into a single setClips call), scoped to clips so
  // it never tangles with the rest of the mix state.
  const undoStackRef = useRef<{ stemId: string; before: StemClip[]; after: StemClip[] }[]>([]);
  const redoStackRef = useRef<{ stemId: string; before: StemClip[]; after: StemClip[] }[]>([]);

  /** User-facing clip edit: records history, then applies. */
  const setClips = useCallback(
    (stemId: string, clips: StemClip[]) => {
      const before = channelStateRef.current[stemId]?.clips ?? [];
      undoStackRef.current.push({ stemId, before, after: clips });
      redoStackRef.current = [];
      applyClips(stemId, clips);
    },
    [applyClips]
  );

  const undo = useCallback(() => {
    const entry = undoStackRef.current.pop();
    if (!entry) return;
    redoStackRef.current.push(entry);
    setSelectedClip(null);
    applyClips(entry.stemId, entry.before);
  }, [applyClips]);

  const redo = useCallback(() => {
    const entry = redoStackRef.current.pop();
    if (!entry) return;
    undoStackRef.current.push(entry);
    setSelectedClip(null);
    applyClips(entry.stemId, entry.after);
  }, [applyClips]);

  // Cmd/Ctrl+Z undo · Cmd/Ctrl+Shift+Z redo (ignored while typing).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key.toLowerCase() !== 'z' || !(e.metaKey || e.ctrlKey)) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo]);

  // Delete / Backspace removes the selected clip (ignored while typing).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      if (!selectedClip) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      e.preventDefault();
      const { stemId, clipId } = selectedClip;
      const cur = channelStateRef.current[stemId]?.clips ?? [];
      setClips(
        stemId,
        cur.filter((c) => c.id !== clipId)
      );
      setSelectedClip(null);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedClip, setClips]);

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

  // Strip quick knob (Lo/Mid/Hi) → drive the mapped full-EQ band's gain, and
  // keep eq.{lo,mid,hi} as a mirror so the legacy fields persist.
  const setEq = useCallback((stemId: string, band: EqBand, gainDb: number) => {
    const bandId = EQ_QUICK_BAND_IDS[band];
    setChannelState((prev) => {
      const current = prev[stemId] ?? DEFAULT_CHANNEL;
      const bands = current.eqFull.bands.map((b) => (b.id === bandId ? { ...b, gain: gainDb } : b));
      const changed = bands.find((b) => b.id === bandId);
      if (changed && hostRef.current) applyEqBandToHost(hostRef.current, stemId, changed);
      return {
        ...prev,
        [stemId]: {
          ...current,
          eq: { ...current.eq, [band]: gainDb },
          eqFull: { ...current.eqFull, bands },
        },
      };
    });
  }, []);

  // EQ window → edit any band (freq/gain/q/type/on). Mirror gain back into the
  // quick knobs when a mapped band changes so the strip stays in sync.
  const setEqBand = useCallback((stemId: string, bandId: number, patch: Partial<EqFullBand>) => {
    setChannelState((prev) => {
      const current = prev[stemId] ?? DEFAULT_CHANNEL;
      const bands = current.eqFull.bands.map((b) => (b.id === bandId ? { ...b, ...patch } : b));
      const changed = bands.find((b) => b.id === bandId);
      if (changed && hostRef.current) applyEqBandToHost(hostRef.current, stemId, changed);
      const eq = { ...current.eq };
      if (patch.gain !== undefined) {
        if (bandId === EQ_QUICK_BAND_IDS.lo) eq.lo = patch.gain;
        else if (bandId === EQ_QUICK_BAND_IDS.mid) eq.mid = patch.gain;
        else if (bandId === EQ_QUICK_BAND_IDS.hi) eq.hi = patch.gain;
      }
      return { ...prev, [stemId]: { ...current, eq, eqFull: { ...current.eqFull, bands } } };
    });
  }, []);

  const setEqAnalyzer = useCallback((stemId: string, analyzer: boolean) => {
    setChannelState((prev) => {
      const current = prev[stemId] ?? DEFAULT_CHANNEL;
      return { ...prev, [stemId]: { ...current, eqFull: { ...current.eqFull, analyzer } } };
    });
  }, []);

  const setComp = useCallback((stemId: string, field: CompField, value: number) => {
    setChannelState((prev) => {
      const current = prev[stemId] ?? DEFAULT_CHANNEL;
      const nextComp = { ...current.comp, [field]: value };
      // `knee` is curve-only — no engine param — but still re-push the rest.
      const host = hostRef.current;
      if (host) applyCompToHost(host, stemId, nextComp, current.compType);
      return { ...prev, [stemId]: { ...current, comp: nextComp } };
    });
  }, []);

  const setCompType = useCallback((stemId: string, compType: CompType) => {
    setChannelState((prev) => {
      const current = prev[stemId] ?? DEFAULT_CHANNEL;
      const host = hostRef.current;
      if (host) applyCompToHost(host, stemId, current.comp, compType);
      return { ...prev, [stemId]: { ...current, compType } };
    });
  }, []);

  const toggleEqBypass = useCallback((stemId: string) => {
    setChannelState((prev) => {
      const current = prev[stemId] ?? DEFAULT_CHANNEL;
      const bypassed = !current.eq.bypassed;
      hostRef.current?.setChannelEqBypassed(stemId, bypassed);
      return { ...prev, [stemId]: { ...current, eq: { ...current.eq, bypassed } } };
    });
  }, []);

  const toggleCompBypass = useCallback((stemId: string) => {
    setChannelState((prev) => {
      const current = prev[stemId] ?? DEFAULT_CHANNEL;
      const bypassed = !current.comp.bypassed;
      const nextComp = { ...current.comp, bypassed };
      const host = hostRef.current;
      if (host) applyCompToHost(host, stemId, nextComp, current.compType);
      return { ...prev, [stemId]: { ...current, comp: nextComp } };
    });
  }, []);

  const setTransient = useCallback((stemId: string, field: 'attack' | 'sustain', value: number) => {
    setChannelState((prev) => {
      const current = prev[stemId] ?? DEFAULT_CHANNEL;
      const nextTransient = { ...current.transient, [field]: value };
      hostRef.current?.setChannelTransient(stemId, nextTransient.attack, nextTransient.sustain);
      return { ...prev, [stemId]: { ...current, transient: nextTransient } };
    });
  }, []);

  const toggleTransientBypass = useCallback((stemId: string) => {
    setChannelState((prev) => {
      const current = prev[stemId] ?? DEFAULT_CHANNEL;
      const bypassed = !current.transient.bypassed;
      hostRef.current?.setChannelTransientBypassed(stemId, bypassed);
      return {
        ...prev,
        [stemId]: { ...current, transient: { ...current.transient, bypassed } },
      };
    });
  }, []);

  const setDeEss = useCallback((stemId: string, field: 'freq' | 'amount', value: number) => {
    setChannelState((prev) => {
      const current = prev[stemId] ?? DEFAULT_CHANNEL;
      const nextDeEss = { ...current.deess, [field]: value };
      hostRef.current?.setChannelDeEss(stemId, nextDeEss.freq, nextDeEss.amount);
      return { ...prev, [stemId]: { ...current, deess: nextDeEss } };
    });
  }, []);

  const toggleDeEssBypass = useCallback((stemId: string) => {
    setChannelState((prev) => {
      const current = prev[stemId] ?? DEFAULT_CHANNEL;
      const bypassed = !current.deess.bypassed;
      hostRef.current?.setChannelDeEssBypassed(stemId, bypassed);
      return {
        ...prev,
        [stemId]: { ...current, deess: { ...current.deess, bypassed } },
      };
    });
  }, []);

  const setImager = useCallback((stemId: string, width: number) => {
    setChannelState((prev) => {
      const current = prev[stemId] ?? DEFAULT_CHANNEL;
      hostRef.current?.setChannelImager(stemId, width);
      return {
        ...prev,
        [stemId]: { ...current, imager: { ...current.imager, width } },
      };
    });
  }, []);

  const toggleImagerBypass = useCallback((stemId: string) => {
    setChannelState((prev) => {
      const current = prev[stemId] ?? DEFAULT_CHANNEL;
      const bypassed = !current.imager.bypassed;
      hostRef.current?.setChannelImagerBypassed(stemId, bypassed);
      return {
        ...prev,
        [stemId]: { ...current, imager: { ...current.imager, bypassed } },
      };
    });
  }, []);

  const setTape = useCallback(
    (stemId: string, field: 'driveDb' | 'tone' | 'mix', value: number) => {
      setChannelState((prev) => {
        const current = prev[stemId] ?? DEFAULT_CHANNEL;
        const nextTape = { ...current.tape, [field]: value };
        hostRef.current?.setChannelTape(stemId, nextTape.driveDb, nextTape.tone, nextTape.mix);
        return { ...prev, [stemId]: { ...current, tape: nextTape } };
      });
    },
    []
  );

  const toggleTapeBypass = useCallback((stemId: string) => {
    setChannelState((prev) => {
      const current = prev[stemId] ?? DEFAULT_CHANNEL;
      const bypassed = !current.tape.bypassed;
      hostRef.current?.setChannelTapeBypassed(stemId, bypassed);
      return {
        ...prev,
        [stemId]: { ...current, tape: { ...current.tape, bypassed } },
      };
    });
  }, []);

  const setConsole = useCallback(
    (stemId: string, field: 'driveDb' | 'character' | 'mix', value: number) => {
      setChannelState((prev) => {
        const current = prev[stemId] ?? DEFAULT_CHANNEL;
        const nextConsole = { ...current.console, [field]: value };
        hostRef.current?.setChannelConsole(
          stemId,
          nextConsole.driveDb,
          nextConsole.character,
          nextConsole.mix
        );
        return { ...prev, [stemId]: { ...current, console: nextConsole } };
      });
    },
    []
  );

  const toggleConsoleBypass = useCallback((stemId: string) => {
    setChannelState((prev) => {
      const current = prev[stemId] ?? DEFAULT_CHANNEL;
      const bypassed = !current.console.bypassed;
      hostRef.current?.setChannelConsoleBypassed(stemId, bypassed);
      return {
        ...prev,
        [stemId]: { ...current, console: { ...current.console, bypassed } },
      };
    });
  }, []);

  const setMbComp = useCallback(
    (
      stemId: string,
      field: 'loThreshDb' | 'midThreshDb' | 'hiThreshDb' | 'ratio',
      value: number
    ) => {
      setChannelState((prev) => {
        const current = prev[stemId] ?? DEFAULT_CHANNEL;
        const nextMbComp = { ...current.mbcomp, [field]: value };
        hostRef.current?.setChannelMbComp(
          stemId,
          nextMbComp.loThreshDb,
          nextMbComp.midThreshDb,
          nextMbComp.hiThreshDb,
          nextMbComp.ratio
        );
        return { ...prev, [stemId]: { ...current, mbcomp: nextMbComp } };
      });
    },
    []
  );

  const toggleMbCompBypass = useCallback((stemId: string) => {
    setChannelState((prev) => {
      const current = prev[stemId] ?? DEFAULT_CHANNEL;
      const bypassed = !current.mbcomp.bypassed;
      hostRef.current?.setChannelMbCompBypassed(stemId, bypassed);
      return {
        ...prev,
        [stemId]: { ...current, mbcomp: { ...current.mbcomp, bypassed } },
      };
    });
  }, []);

  const setBusGain = useCallback((busId: string, gain: number) => {
    hostRef.current?.setBusGain(busId, gain);
    setBusState((prev) => {
      const current = prev[busId];
      if (!current) return prev;
      return { ...prev, [busId]: { ...current, gain } };
    });
  }, []);

  const toggleBusMute = useCallback((busId: string) => {
    setBusState((prev) => {
      const current = prev[busId];
      if (!current) return prev;
      const muted = !current.muted;
      hostRef.current?.setBusMute(busId, muted);
      return { ...prev, [busId]: { ...current, muted } };
    });
  }, []);

  const setLimiter = useCallback(
    (field: 'thresholdDb' | 'releaseMs' | 'makeupDb', value: number) => {
      setMasterChain((prev) => {
        const next: LimiterState = { ...prev.limiter, [field]: value };
        hostRef.current?.setMasterLimiter(next.thresholdDb, next.releaseMs, next.makeupDb);
        return { ...prev, limiter: next };
      });
    },
    []
  );

  const toggleLimiterBypass = useCallback(() => {
    setMasterChain((prev) => {
      const bypassed = !prev.limiter.bypassed;
      hostRef.current?.setMasterLimiterBypassed(bypassed);
      return { ...prev, limiter: { ...prev.limiter, bypassed } };
    });
  }, []);

  const setReferenceRoom = useCallback((preset: ReferenceRoomPreset) => {
    setMasterChain((prev) => {
      if (prev.referenceRoom.preset === preset) return prev;
      hostRef.current?.setMasterReferenceRoom(preset);
      return { ...prev, referenceRoom: { preset } };
    });
  }, []);

  /**
   * Add (or swap to) a reverb of the given kind on a user bus. If the bus
   * already has a reverb of a different kind, it's swapped out — the
   * params are reset to that kind's defaults rather than preserved, since
   * Hall and Plate "feel" different at the same settings.
   */
  const addBusReverb = useCallback((busId: string, kind: ReverbKind) => {
    if (busId === MASTER_BUS_ID) return;
    setBusState((prev) => {
      const current = prev[busId];
      if (!current) return prev;
      if (current.reverb?.kind === kind) return prev;
      const reverb = defaultReverb(kind);
      const host = hostRef.current;
      if (host) {
        host.addBusReverb(busId, kind);
        host.setBusReverbParams(busId, reverb.decay, reverb.damping, reverb.preDelayMs, reverb.mix);
        host.setBusReverbBypassed(busId, reverb.bypassed);
      }
      return { ...prev, [busId]: { ...current, reverb } };
    });
  }, []);

  const removeBusReverb = useCallback((busId: string) => {
    hostRef.current?.removeBusReverb(busId);
    setBusState((prev) => {
      const current = prev[busId];
      if (!current?.reverb) return prev;
      const { reverb: _, ...rest } = current;
      void _;
      return { ...prev, [busId]: rest };
    });
  }, []);

  const setBusReverb = useCallback(
    (busId: string, field: 'decay' | 'damping' | 'preDelayMs' | 'mix', value: number) => {
      setBusState((prev) => {
        const current = prev[busId];
        if (!current?.reverb) return prev;
        const nextReverb: ReverbState = { ...current.reverb, [field]: value };
        hostRef.current?.setBusReverbParams(
          busId,
          nextReverb.decay,
          nextReverb.damping,
          nextReverb.preDelayMs,
          nextReverb.mix
        );
        return { ...prev, [busId]: { ...current, reverb: nextReverb } };
      });
    },
    []
  );

  const toggleBusReverbBypass = useCallback((busId: string) => {
    setBusState((prev) => {
      const current = prev[busId];
      if (!current?.reverb) return prev;
      const bypassed = !current.reverb.bypassed;
      hostRef.current?.setBusReverbBypassed(busId, bypassed);
      return {
        ...prev,
        [busId]: { ...current, reverb: { ...current.reverb, bypassed } },
      };
    });
  }, []);

  const createBus = useCallback(() => {
    const id = crypto.randomUUID();
    setBusState((prev) => {
      // Auto-name: "Bus 1", "Bus 2", ... — counts only the non-Master buses
      // that are already in state, so naming is stable across renames later.
      const userCount = Object.values(prev).filter((b) => b.id !== MASTER_BUS_ID).length;
      const next: BusState = {
        id,
        name: `Bus ${userCount + 1}`,
        gain: 1,
        muted: false,
      };
      hostRef.current?.addBus({ id: next.id, name: next.name, gain: next.gain });
      return { ...prev, [id]: next };
    });
  }, []);

  const deleteBus = useCallback((busId: string) => {
    if (busId === MASTER_BUS_ID) return;
    hostRef.current?.removeBus(busId);
    setBusState((prev) => {
      const next = { ...prev };
      delete next[busId];
      return next;
    });
    // Any channels routed to this bus fall back to Master in the host's
    // removeBus(); any channel sending to this bus has its send dropped.
    // Mirror both in React state so autosave reflects the cleanup.
    setChannelState((prev) => {
      let dirty = false;
      const next = { ...prev };
      for (const [stemId, ch] of Object.entries(next)) {
        let updated: ChannelState | null = null;
        if (ch.outputBusId === busId) {
          updated = { ...ch, outputBusId: MASTER_BUS_ID };
        }
        if (ch.sends[busId] !== undefined) {
          const sends = { ...(updated ?? ch).sends };
          delete sends[busId];
          updated = { ...(updated ?? ch), sends };
        }
        if (updated) {
          next[stemId] = updated;
          dirty = true;
        }
      }
      return dirty ? next : prev;
    });
  }, []);

  const renameBus = useCallback((busId: string, name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusState((prev) => {
      const current = prev[busId];
      if (!current || current.name === trimmed) return prev;
      return { ...prev, [busId]: { ...current, name: trimmed } };
    });
  }, []);

  const setChannelOutput = useCallback((stemId: string, busId: string) => {
    hostRef.current?.setChannelOutput(stemId, busId);
    setChannelState((prev) => {
      const current = prev[stemId] ?? DEFAULT_CHANNEL;
      if (current.outputBusId === busId) return prev;
      return { ...prev, [stemId]: { ...current, outputBusId: busId } };
    });
  }, []);

  const setChannelSend = useCallback((stemId: string, busId: string, level: number) => {
    hostRef.current?.setChannelSend(stemId, busId, level);
    setChannelState((prev) => {
      const current = prev[stemId] ?? DEFAULT_CHANNEL;
      return {
        ...prev,
        [stemId]: { ...current, sends: { ...current.sends, [busId]: level } },
      };
    });
  }, []);

  const removeChannelSend = useCallback((stemId: string, busId: string) => {
    hostRef.current?.removeChannelSend(stemId, busId);
    setChannelState((prev) => {
      const current = prev[stemId] ?? DEFAULT_CHANNEL;
      if (current.sends[busId] === undefined) return prev;
      const sends = { ...current.sends };
      delete sends[busId];
      return { ...prev, [stemId]: { ...current, sends } };
    });
  }, []);

  // loadStems is a per-render closure but uses only refs + stable setters
  // so the first-render copy works fine across all calls.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see comment above
  const onStemAdded = useCallback((stem: Stem) => {
    setStems((prev) => (prev.some((s) => s.id === stem.id) ? prev : [...prev, stem]));
    // Decode the new stem into the host + populate peaks so the timeline
    // lane paints. loadStems re-fetches the full /stems list, decodes the
    // missing audio, and incrementally updates peaks — already-loaded
    // stems are skipped, so this is cheap.
    void loadStems().catch(() => {
      // errors surface through the normal play path
    });
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
    setPeaks((prev) => {
      if (!(stemId in prev)) return prev;
      const next = { ...prev };
      delete next[stemId];
      return next;
    });
  }, []);

  /**
   * A swap replaces the audio behind an existing stem without changing its
   * id. The React channelState (volume/pan/EQ/comp) stays attached. We:
   *  - update the Stem object in `stems` so the strip displays the new
   *    sample rate / length / channels
   *  - drop the audio-engine channel for this stem so the next Play
   *    re-decodes fresh audio (replaying the saved params via loadStems)
   *  - clear the loaded flag for that channel
   */
  const onStemSwapped = useCallback(
    (stem: Stem) => {
      hostRef.current?.removeChannel(stem.id);
      setStems((prev) => prev.map((s) => (s.id === stem.id ? stem : s)));
      setLoadedIds((prev) => {
        const next = new Set(prev);
        next.delete(stem.id);
        return next;
      });
      // Drop the swapped stem's peaks — they'll be re-derived from the new
      // buffer on the next loadStems().
      setPeaks((prev) => {
        if (!(stem.id in prev)) return prev;
        const next = { ...prev };
        delete next[stem.id];
        return next;
      });
      if (transport === 'playing') handleStop();
    },
    [transport, handleStop]
  );

  const anySoloed = useMemo(
    () => Object.values(channelState).some((c) => c.soloed),
    [channelState]
  );

  return (
    <>
      <div
        className={`mixer mixer-fullscreen ${timelineOpen && !expanded ? '' : 'timeline-closed'} ${
          expanded ? 'mixer-expanded' : ''
        }`}
      >
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
            className={`transport-timeline-btn ${timelineOpen ? 'on' : ''}`}
            onClick={() => setTimelineOpen((v) => !v)}
            aria-pressed={timelineOpen}
            aria-label={timelineOpen ? 'Hide timeline' : 'Show timeline'}
            title={timelineOpen ? 'Hide timeline' : 'Show timeline'}
          >
            Timeline
          </button>

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

        <StemTimeline
          stems={stems}
          peaks={peaks}
          laneState={channelState}
          anySoloed={anySoloed}
          duration={duration}
          position={position}
          playing={transport === 'playing'}
          selectedClip={selectedClip}
          onMute={toggleMute}
          onSolo={toggleSolo}
          onSeek={handleSeek}
          onClipsChange={setClips}
          onSelectClip={setSelectedClip}
        />

        {/* Resize divider — drag to set the mixer height (design app.jsx). */}
        {!expanded && (
          <button
            type="button"
            className="mixer-resize"
            aria-label="Drag to resize mixer"
            onPointerDown={(e) => {
              const sy = e.clientY;
              const sh = mixerHeight;
              const move = (ev: PointerEvent) =>
                setMixerHeight(
                  Math.max(240, Math.min(window.innerHeight - 200, sh + (sy - ev.clientY)))
                );
              const up = () => {
                window.removeEventListener('pointermove', move);
                window.removeEventListener('pointerup', up);
                document.body.style.cursor = '';
              };
              window.addEventListener('pointermove', move);
              window.addEventListener('pointerup', up);
              document.body.style.cursor = 'ns-resize';
            }}
          >
            <span className="mixer-resize-grip" />
          </button>
        )}

        {/* Mixer panel header — channel count + EXPAND/RESTORE (design app.jsx). */}
        <div className="mixer-panel-head">
          <span className="mixer-panel-title">MIXER</span>
          <span className="mixer-panel-sub">· {stems.length} CHANNELS · FIXED CHAIN</span>
          <span style={{ flex: 1 }} />
          <button
            type="button"
            className="mixer-expand-btn"
            onClick={() => setExpanded((v) => !v)}
            aria-pressed={expanded}
            title={expanded ? 'Restore' : 'Expand mixer'}
          >
            {expanded ? '↙ Restore' : '↗ Expand'}
          </button>
        </div>

        <div
          className="mixer-body"
          style={
            expanded
              ? { flex: '1 1 auto', minHeight: 0 }
              : { flex: '0 0 auto', height: mixerHeight, minHeight: 0 }
          }
        >
          {/* Two-row layout: controls on top scroll vertically inside their
              own container, while the names row below sits OUTSIDE the
              vertical scroll so it stays planted. Both rows share the same
              horizontal scrollbar via .mixer-console-h-scroll so they
              always stay column-aligned. */}
          <div className="mixer-console-area">
            <div className="mixer-console-h-scroll">
              <div className="mixer-console-stack">
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
                          onEq={(band, db) => setEq(stem.id, band, db)}
                          onEqBypass={() => toggleEqBypass(stem.id)}
                          onComp={(field, value) => setComp(stem.id, field, value)}
                          onCompType={(type) => setCompType(stem.id, type)}
                          onCompBypass={() => toggleCompBypass(stem.id)}
                          onOpenPlugin={(type) => openPlugin(type, stem.id)}
                          buses={busState}
                          onOutput={(busId) => setChannelOutput(stem.id, busId)}
                          onSend={(busId, level) => setChannelSend(stem.id, busId, level)}
                          onRemoveSend={(busId) => removeChannelSend(stem.id, busId)}
                          onTransient={(field, value) => setTransient(stem.id, field, value)}
                          onTransientBypass={() => toggleTransientBypass(stem.id)}
                          onDeEss={(field, value) => setDeEss(stem.id, field, value)}
                          onDeEssBypass={() => toggleDeEssBypass(stem.id)}
                          onImager={(width) => setImager(stem.id, width)}
                          onImagerBypass={() => toggleImagerBypass(stem.id)}
                          onTape={(field, value) => setTape(stem.id, field, value)}
                          onTapeBypass={() => toggleTapeBypass(stem.id)}
                          onConsole={(field, value) => setConsole(stem.id, field, value)}
                          onConsoleBypass={() => toggleConsoleBypass(stem.id)}
                          onMbComp={(field, value) => setMbComp(stem.id, field, value)}
                          onMbCompBypass={() => toggleMbCompBypass(stem.id)}
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
          </div>
          {/* Buses on the right of the console — separated by a thin divider.
              User-created buses live to the left of Master so Master always
              sits last in the chain. */}
          <div className="mixer-buses">
            {Object.values(busState)
              .filter((b) => b.id !== MASTER_BUS_ID)
              .map((bus) => (
                <BusStrip
                  key={bus.id}
                  bus={bus}
                  host={hostRef.current}
                  active={transport === 'playing'}
                  onGain={(v) => setBusGain(bus.id, v)}
                  onMute={() => toggleBusMute(bus.id)}
                  onDelete={() => deleteBus(bus.id)}
                  onRename={(name) => renameBus(bus.id, name)}
                  reverb={bus.reverb}
                  onAddReverb={(kind) => addBusReverb(bus.id, kind)}
                  onRemoveReverb={() => removeBusReverb(bus.id)}
                  onReverb={(field, value) => setBusReverb(bus.id, field, value)}
                  onReverbBypass={() => toggleBusReverbBypass(bus.id)}
                />
              ))}
            <button
              type="button"
              className="bus-add-btn"
              onClick={createBus}
              aria-label="Add bus"
              title="Add bus"
            >
              +
            </button>
            {busState[MASTER_BUS_ID] && (
              <BusStrip
                bus={busState[MASTER_BUS_ID]}
                host={hostRef.current}
                active={transport === 'playing'}
                onGain={(v) => setBusGain(MASTER_BUS_ID, v)}
                onMute={() => toggleBusMute(MASTER_BUS_ID)}
                limiter={masterChain.limiter}
                onLimiter={setLimiter}
                onLimiterBypass={toggleLimiterBypass}
                referenceRoom={masterChain.referenceRoom.preset}
                onReferenceRoom={setReferenceRoom}
              />
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
          <StemDropZone
            sessionId={sessionId}
            storageMode={storageMode}
            initialStems={initialStems}
          />
        </div>
      </aside>

      <StemEvents
        onStemAdded={onStemAdded}
        onStemRemoved={onStemRemoved}
        onStemSwapped={onStemSwapped}
      />

      <PluginWindows
        windows={openPlugins}
        onClose={closePlugin}
        onFocus={focusPlugin}
        bundle={{
          host: hostRef.current,
          channelState,
          stemName: (id) => stems.find((s) => s.id === id)?.name ?? id,
          onEq: setEq,
          onEqBand: setEqBand,
          onEqAnalyzer: setEqAnalyzer,
          onEqBypass: toggleEqBypass,
          onComp: setComp,
          onCompType: setCompType,
          onCompBypass: toggleCompBypass,
        }}
      />
    </>
  );
}

// Stable callback bridge that StemDropZone can dispatch into via context-free
// custom events. Keeps StemDropZone unchanged.
function StemEvents({
  onStemAdded,
  onStemRemoved,
  onStemSwapped,
}: {
  onStemAdded: (s: Stem) => void;
  onStemRemoved: (id: string) => void;
  onStemSwapped: (s: Stem) => void;
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
    function handleSwapped(e: Event) {
      const stem = (e as CustomEvent<Stem>).detail;
      if (stem) onStemSwapped(stem);
    }
    window.addEventListener('aux:stem-added', handleAdded);
    window.addEventListener('aux:stem-removed', handleRemoved);
    window.addEventListener('aux:stem-swapped', handleSwapped);
    return () => {
      window.removeEventListener('aux:stem-added', handleAdded);
      window.removeEventListener('aux:stem-removed', handleRemoved);
      window.removeEventListener('aux:stem-swapped', handleSwapped);
    };
  }, [onStemAdded, onStemRemoved, onStemSwapped]);
  return null;
}
