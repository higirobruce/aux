import { describe, expect, it } from 'vitest';
import {
  ChannelStateSchema,
  DEFAULT_CHANNEL_COMP,
  DEFAULT_CHANNEL_CONSOLE,
  DEFAULT_CHANNEL_DEESS,
  DEFAULT_CHANNEL_EQ,
  DEFAULT_CHANNEL_IMAGER,
  DEFAULT_CHANNEL_MBCOMP,
  DEFAULT_CHANNEL_TAPE,
  DEFAULT_CHANNEL_TRANSIENT,
  DEFAULT_COMP_TYPE,
  MASTER_BUS_ID,
  MIX_STATE_VERSION,
  MixStateSchema,
  StemClipSchema,
  emptyMixState,
} from './mix-state.js';

/** A fully-populated channel (every required field) for schema tests. */
function makeChannel(extra: Record<string, unknown> = {}) {
  return {
    volume: 1,
    pan: 0,
    muted: false,
    soloed: false,
    eq: { ...DEFAULT_CHANNEL_EQ },
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
    ...extra,
  };
}

describe('StemClipSchema', () => {
  it('accepts a well-formed sample-accurate clip (fade/gain default to 0)', () => {
    const clip = { id: 'clip_1', sourceIn: 0, sourceOut: 48_000, timelineStart: 0 };
    expect(StemClipSchema.parse(clip)).toEqual({
      ...clip,
      gainDb: 0,
      fadeInSamples: 0,
      fadeOutSamples: 0,
    });
  });

  it('rejects sourceOut <= sourceIn', () => {
    expect(
      StemClipSchema.safeParse({ id: 'c', sourceIn: 100, sourceOut: 100, timelineStart: 0 }).success
    ).toBe(false);
  });

  it('rejects negative / non-integer positions', () => {
    expect(
      StemClipSchema.safeParse({ id: 'c', sourceIn: -1, sourceOut: 10, timelineStart: 0 }).success
    ).toBe(false);
    expect(
      StemClipSchema.safeParse({ id: 'c', sourceIn: 0, sourceOut: 10.5, timelineStart: 0 }).success
    ).toBe(false);
  });
});

describe('ChannelStateSchema — clips', () => {
  it('parses a channel with no clips (v15 shape — optional field)', () => {
    const parsed = ChannelStateSchema.parse(makeChannel());
    expect(parsed.clips).toBeUndefined();
  });

  it('parses a channel carrying clips (v2 fade/gain default to 0)', () => {
    const clips = [{ id: 'clip_1', sourceIn: 0, sourceOut: 1000, timelineStart: 500 }];
    const parsed = ChannelStateSchema.parse(makeChannel({ clips }));
    expect(parsed.clips).toEqual([{ ...clips[0], gainDb: 0, fadeInSamples: 0, fadeOutSamples: 0 }]);
  });
});

describe('MixStateSchema — version transition', () => {
  it('emptyMixState() is the current version (25) and round-trips', () => {
    const doc = emptyMixState();
    expect(doc.version).toBe(25);
    expect(MIX_STATE_VERSION).toBe(25);
    expect(MixStateSchema.parse(doc).version).toBe(25);
  });

  it('accepts v21–v23 docs during the transition window', () => {
    for (const v of [21, 22, 23] as const) {
      expect(MixStateSchema.safeParse({ ...emptyMixState(), version: v }).success).toBe(true);
    }
  });

  it('rejects versions outside the accepted set', () => {
    expect(MixStateSchema.safeParse({ ...emptyMixState(), version: 20 }).success).toBe(false);
    expect(MixStateSchema.safeParse({ ...emptyMixState(), version: 26 }).success).toBe(false);
  });
});
