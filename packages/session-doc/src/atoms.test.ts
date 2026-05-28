import { describe, expect, it } from 'vitest';
import { readAtom, writeAtom } from './atoms.js';
import { type SessionDoc, SessionDocSchema } from './schema.js';

function makeDoc(): SessionDoc {
  return SessionDocSchema.parse({
    id: 'ses_test',
    version: 1,
    name: 'Smoke Session',
    storageMode: 'cloud',
    tracks: {
      trk_kick: {
        name: 'Kick',
        clips: [{ id: 'clp_1', start: 0, length: 222720, src: 'stem_kick' }],
        chain: [],
        params: {
          volume: { value: -2.3 },
          pan: { value: 0 },
        },
      },
    },
  });
}

describe('SessionDocSchema', () => {
  it('parses a minimal session', () => {
    const doc = makeDoc();
    expect(doc.id).toBe('ses_test');
    expect(doc.tracks.trk_kick?.name).toBe('Kick');
  });

  it('rejects an unknown storage mode', () => {
    expect(() =>
      SessionDocSchema.parse({
        id: 'x',
        version: 1,
        name: 'x',
        storageMode: 'hybrid', // explicitly removed in v1 per §16.06
        tracks: {},
      })
    ).toThrow();
  });
});

describe('readAtom', () => {
  it('reads a nested numeric path', () => {
    const doc = makeDoc();
    expect(readAtom(doc, 'tracks.trk_kick.params.volume.value')).toBe(-2.3);
  });
  it('returns undefined for a missing path', () => {
    const doc = makeDoc();
    expect(readAtom(doc, 'tracks.trk_missing.volume')).toBeUndefined();
  });
  it('walks into arrays via numeric segments', () => {
    const doc = makeDoc();
    expect(readAtom(doc, 'tracks.trk_kick.clips.0.id')).toBe('clp_1');
  });
});

describe('writeAtom', () => {
  it('does not mutate the source doc', () => {
    const doc = makeDoc();
    const next = writeAtom(doc, 'tracks.trk_kick.params.volume.value', -3.5);
    expect(readAtom(doc, 'tracks.trk_kick.params.volume.value')).toBe(-2.3);
    expect(readAtom(next, 'tracks.trk_kick.params.volume.value')).toBe(-3.5);
  });
  it('returns a different object identity', () => {
    const doc = makeDoc();
    const next = writeAtom(doc, 'tracks.trk_kick.params.pan.value', 0.5);
    expect(next).not.toBe(doc);
    expect(readAtom(next, 'tracks.trk_kick.params.pan.value')).toBe(0.5);
  });
});
