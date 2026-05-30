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
  it('accepts a well-formed sample-accurate clip', () => {
    const clip = { id: 'clip_1', sourceIn: 0, sourceOut: 48_000, timelineStart: 0 };
    expect(StemClipSchema.parse(clip)).toEqual(clip);
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

  it('parses a channel carrying clips', () => {
    const clips = [{ id: 'clip_1', sourceIn: 0, sourceOut: 1000, timelineStart: 500 }];
    const parsed = ChannelStateSchema.parse(makeChannel({ clips }));
    expect(parsed.clips).toEqual(clips);
  });
});

describe('MixStateSchema — version transition', () => {
  it('emptyMixState() is the current version (18) and round-trips', () => {
    const doc = emptyMixState();
    expect(doc.version).toBe(18);
    expect(MIX_STATE_VERSION).toBe(18);
    expect(MixStateSchema.parse(doc).version).toBe(18);
  });

  it('accepts v15–v17 docs during the transition window', () => {
    for (const v of [15, 16, 17] as const) {
      expect(MixStateSchema.safeParse({ ...emptyMixState(), version: v }).success).toBe(true);
    }
  });

  it('rejects versions outside the accepted set', () => {
    expect(MixStateSchema.safeParse({ ...emptyMixState(), version: 14 }).success).toBe(false);
    expect(MixStateSchema.safeParse({ ...emptyMixState(), version: 19 }).success).toBe(false);
  });
});
