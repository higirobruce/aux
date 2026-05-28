import type { SessionDoc } from './schema.js';

/**
 * Atom-path helpers — read/write parameters via dot-notation paths.
 *
 * "trk_kick.volume" → session.tracks.trk_kick.params.volume
 * "fx_eq_1.bands.3.gain" → session.fx.fx_eq_1.state.bands[3].gain
 *
 * Per docs/implementation.html §02 — these paths are the addressing
 * scheme used everywhere: undo, diff, automation, future Yjs collab.
 *
 * The dynamic traversal uses `unknown` with structural narrowing rather
 * than `any`; the cost is one safe-cast at the lookup site.
 */

export type AtomPath = string;

type Indexable = Record<string | number, unknown> | unknown[];

function isIndexable(value: unknown): value is Indexable {
  return typeof value === 'object' && value !== null;
}

function toKey(segment: string): string | number {
  return /^\d+$/.test(segment) ? Number(segment) : segment;
}

export function readAtom(doc: SessionDoc, path: AtomPath): unknown {
  const parts = path.split('.');
  let cur: unknown = doc;
  for (const part of parts) {
    if (!isIndexable(cur)) return undefined;
    const key = toKey(part);
    cur = (cur as Record<string | number, unknown>)[key];
  }
  return cur;
}

export function writeAtom(doc: SessionDoc, path: AtomPath, value: unknown): SessionDoc {
  const parts = path.split('.');
  if (parts.length === 0) return doc;

  // SessionDoc is JSON-safe (primitives + plain objects + arrays), so a
  // JSON clone is enough and avoids depending on structuredClone being in
  // the consumer's lib at compile time.
  const next = JSON.parse(JSON.stringify(doc)) as SessionDoc;
  let cur: unknown = next;

  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (part === undefined) continue;
    if (!isIndexable(cur)) throw new Error(`atom path not found: ${path}`);
    const key = toKey(part);
    cur = (cur as Record<string | number, unknown>)[key];
  }

  const last = parts[parts.length - 1];
  if (last === undefined || !isIndexable(cur)) return doc;
  (cur as Record<string | number, unknown>)[toKey(last)] = value;
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
