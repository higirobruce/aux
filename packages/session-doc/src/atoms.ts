import type { SessionDoc } from './schema.js';

/**
 * Atom-path helpers — read/write parameters via dot-notation paths.
 *
 * "trk_kick.volume" → session.tracks.trk_kick.params.volume
 * "fx_eq_1.bands.3.gain" → session.fx.fx_eq_1.state.bands[3].gain
 *
 * Per docs/implementation.html §02 — these paths are the addressing
 * scheme used everywhere: undo, diff, automation, future Yjs collab.
 */

type AtomPath = string;

export function readAtom(doc: SessionDoc, path: AtomPath): unknown {
  const parts = path.split('.');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let cur: any = doc;
  for (const part of parts) {
    if (cur == null) return undefined;
    // numeric segment → array index
    const idx = /^\d+$/.test(part) ? Number(part) : part;
    cur = cur[idx];
  }
  return cur;
}

export function writeAtom(doc: SessionDoc, path: AtomPath, value: unknown): SessionDoc {
  const parts = path.split('.');
  if (parts.length === 0) return doc;
  const next = structuredClone(doc);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let cur: any = next;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (part === undefined) continue;
    const idx = /^\d+$/.test(part) ? Number(part) : part;
    cur = cur[idx];
    if (cur == null) throw new Error(`atom path not found: ${path}`);
  }
  const last = parts[parts.length - 1];
  if (last === undefined) return doc;
  const idx = /^\d+$/.test(last) ? Number(last) : last;
  cur[idx] = value;
  return next;
}

export interface AtomDelta {
  path: AtomPath;
  before: unknown;
  after: unknown;
  /** Clock — for ordering in v2 collab. */
  clock: number;
}

/** Compute the atomic diff between two snapshots. */
export function diffAtoms(_a: SessionDoc, _b: SessionDoc): AtomDelta[] {
  // TODO: structural diff. Placeholder for now.
  return [];
}
