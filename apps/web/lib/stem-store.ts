/**
 * StemStore — abstract over where stem audio lives.
 *
 * Per docs/implementation.html §06. Cloud mode lives in R2 (presigned URLs
 * via the API). Local mode lives on the user's machine via the File System
 * Access API or its sandboxed cousin, OPFS.
 *
 * v0.2 ships OPFS only. FSA's showDirectoryPicker() needs a permission
 * round-trip + handle-persistence-in-IndexedDB pattern that adds UI work
 * without earning much in v0.2 (OPFS works in every modern browser without
 * the prompt). The FSA variant comes in a later slice.
 *
 * Keys are polymorphic strings stored verbatim in `stems.s3_key`:
 *
 *   - `opfs:sessions/<sessionId>/<uuid>`  — local file in OPFS
 *   - anything else                       — S3 / R2 object key
 *
 * The server uses session.storageMode to decide whether to sign a URL
 * for a stem's key; the client uses the same field to decide whether to
 * fetch via HTTP or read via OPFS.
 */

/** Marker prefix for keys that live in OPFS rather than S3. */
export const OPFS_KEY_PREFIX = 'opfs:';

export interface StemStore {
  /** Write a file. Returns the stable key to record on the stem row. */
  putStem(sessionId: string, file: File): Promise<string>;
  /** Read a previously-stored file. */
  getStem(key: string): Promise<File>;
  /** Best-effort delete. Tolerant of already-removed keys. */
  deleteStem(key: string): Promise<void>;
}

/** True if the browser supports the OPFS APIs we need. */
export function hasOpfs(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.storage?.getDirectory === 'function';
}

class OpfsStemStore implements StemStore {
  private async sessionDir(sessionId: string): Promise<FileSystemDirectoryHandle> {
    const root = await navigator.storage.getDirectory();
    const sessions = await root.getDirectoryHandle('sessions', { create: true });
    return sessions.getDirectoryHandle(sessionId, { create: true });
  }

  async putStem(sessionId: string, file: File): Promise<string> {
    const id = crypto.randomUUID();
    const dir = await this.sessionDir(sessionId);
    const handle = await dir.getFileHandle(id, { create: true });
    // FileSystemFileHandle.createWritable() truncates by default — fine for
    // fresh uploads; swap-source also wants overwrite semantics.
    const writable = await handle.createWritable();
    await writable.write(file);
    await writable.close();
    return `${OPFS_KEY_PREFIX}sessions/${sessionId}/${id}`;
  }

  async getStem(key: string): Promise<File> {
    const parsed = parseOpfsKey(key);
    if (!parsed) throw new Error(`bad opfs key: ${key}`);
    const dir = await this.sessionDir(parsed.sessionId);
    const handle = await dir.getFileHandle(parsed.fileId);
    return handle.getFile();
  }

  async deleteStem(key: string): Promise<void> {
    const parsed = parseOpfsKey(key);
    if (!parsed) return;
    try {
      const dir = await this.sessionDir(parsed.sessionId);
      await dir.removeEntry(parsed.fileId);
    } catch {
      // Already gone, or the directory is missing — either way nothing to do.
    }
  }
}

function parseOpfsKey(key: string): { sessionId: string; fileId: string } | null {
  if (!key.startsWith(OPFS_KEY_PREFIX)) return null;
  const path = key.slice(OPFS_KEY_PREFIX.length);
  const m = path.match(/^sessions\/([^/]+)\/([^/]+)$/);
  if (!m) return null;
  const [, sessionId, fileId] = m;
  if (!sessionId || !fileId) return null;
  return { sessionId, fileId };
}

let opfsSingleton: OpfsStemStore | null = null;

/**
 * Resolve the StemStore implementation for a session's storage mode.
 * Returns null when the requested mode isn't available in this browser
 * (caller falls back to Cloud and surfaces an error message).
 */
export function resolveStemStore(mode: 'cloud' | 'local'): StemStore | null {
  if (mode === 'cloud') return null; // Cloud uses signed URLs over fetch — no client store.
  if (!hasOpfs()) return null;
  opfsSingleton ??= new OpfsStemStore();
  return opfsSingleton;
}

export function isLocalKey(key: string | null | undefined): boolean {
  return !!key && key.startsWith(OPFS_KEY_PREFIX);
}
