'use client';

import { extractMetadata } from '@/lib/audio-metadata';
import { type FileMetadata, MATCH_UNCERTAIN, matchStems } from '@/lib/stem-match';
import type { Stem } from '@/lib/types';
import { Button } from '@aux/ui';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { StemSwapDialog, type SwapDecision } from './_stem-swap-dialog';

interface Props {
  sessionId: string;
  initialStems: Stem[];
}

interface UploadState {
  filename: string;
  status: 'analyzing' | 'uploading' | 'registering' | 'swapping' | 'done' | 'failed';
  error?: string;
  progress?: number;
}

function detectGroup(name: string): string {
  const n = name.toLowerCase();
  if (/(^|[._-])(kick|kk|bd)([._-]|$)/.test(n)) return 'drums';
  if (/(^|[._-])(snare|sn|sd)([._-]|$)/.test(n)) return 'drums';
  if (/(^|[._-])(hat|hh|hi[-_ ]?hat)([._-]|$)/.test(n)) return 'drums';
  if (/(^|[._-])(tom|tm)([._-]|$)/.test(n)) return 'drums';
  if (/(^|[._-])(oh|overhead|room)([._-]|$)/.test(n)) return 'drums';
  if (/(^|[._-])(bass|sub|bs)([._-]|$)/.test(n)) return 'bass';
  if (/(^|[._-])(vox|vocal|lead|bgv|bg|harm)([._-]|$)/.test(n)) return 'vox';
  if (/(^|[._-])(fx|riser|impact|swell)([._-]|$)/.test(n)) return 'fx';
  return 'other';
}

const GROUP_LABELS: Record<string, string> = {
  drums: 'Drums',
  bass: 'Bass',
  vox: 'Vox',
  fx: 'FX',
  other: 'Other',
};

function formatLength(ms: number): string {
  const seconds = Math.round(ms / 1000);
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatDb(db: number): string {
  if (!Number.isFinite(db) || db <= -200) return '−∞ dB';
  const sign = db > 0 ? '+' : db < 0 ? '−' : '';
  return `${sign}${Math.abs(db).toFixed(1)} dB`;
}

export function StemDropZone({ sessionId, initialStems }: Props) {
  const router = useRouter();
  const [stems, setStems] = useState<Stem[]>(initialStems);
  const [uploads, setUploads] = useState<Record<string, UploadState>>({});
  const [dragging, setDragging] = useState(false);
  /** Pending swap proposal — non-null shows the modal. */
  const [pendingSwap, setPendingSwap] = useState<{
    metadatas: FileMetadata[];
    matches: ReturnType<typeof matchStems>;
  } | null>(null);

  type Metadata = Awaited<ReturnType<typeof extractMetadata>>;

  /**
   * Upload a file and either register it as a new stem (no target) or
   * PUT its source onto an existing stem (target = the channel to keep).
   * Returns the resulting Stem row.
   */
  async function uploadOne(
    file: File,
    key: string,
    meta: Metadata,
    targetStemId: string | null
  ): Promise<Stem> {
    const filename = file.name;
    const setStatus = (status: UploadState['status'], error?: string) => {
      setUploads((prev) => ({ ...prev, [key]: { filename, status, error } }));
    };

    try {
      setStatus('uploading');

      const signRes = await fetch('/api/stems/sign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          sessionId,
          filename: file.name,
          contentType: file.type || 'application/octet-stream',
        }),
      });
      if (!signRes.ok) throw new Error(`sign failed (${signRes.status})`);
      const { uploadUrl, key: s3Key } = (await signRes.json()) as {
        uploadUrl: string;
        key: string;
      };

      const putRes = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': file.type || 'application/octet-stream' },
        body: file,
      });
      if (!putRes.ok) throw new Error(`upload failed (${putRes.status})`);

      const audioBody = {
        s3Key,
        lengthMs: meta.lengthMs,
        channels: meta.channels,
        sampleRate: meta.sampleRate,
        peakDb: meta.peakDb,
        lufsI: meta.lufsI,
      };

      if (targetStemId) {
        // Swap: replace the source on the existing stem. Name + id stay.
        setStatus('swapping');
        const swapRes = await fetch(
          `/api/sessions/${sessionId}/stems/${targetStemId}/swap-source`,
          {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify(audioBody),
          }
        );
        if (!swapRes.ok) {
          const data = await swapRes.json().catch(() => ({}));
          throw new Error(data?.message ?? `swap failed (${swapRes.status})`);
        }
        const updated: Stem = await swapRes.json();
        setStems((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
        window.dispatchEvent(new CustomEvent<Stem>('aux:stem-swapped', { detail: updated }));
        setStatus('done');
        return updated;
      }

      setStatus('registering');
      const regRes = await fetch(`/api/sessions/${sessionId}/stems`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ name: file.name, ...audioBody }),
      });
      if (!regRes.ok) {
        const data = await regRes.json().catch(() => ({}));
        throw new Error(data?.message ?? `register failed (${regRes.status})`);
      }
      const created: Stem = await regRes.json();
      setStems((prev) => [...prev, created]);
      window.dispatchEvent(new CustomEvent<Stem>('aux:stem-added', { detail: created }));
      setStatus('done');
      return created;
    } catch (err) {
      setStatus('failed', err instanceof Error ? err.message : 'failed');
      throw err;
    }
  }

  async function processDecisions(
    metadatas: FileMetadata[],
    decisions: SwapDecision[]
  ): Promise<void> {
    const lookup = new Map(metadatas.map((m) => [m.file, m]));
    await Promise.all(
      decisions.map(async (d, i) => {
        const m = lookup.get(d.file);
        if (!m) return;
        const meta = await extractMetadata(d.file);
        await uploadOne(d.file, `${Date.now()}-${i}-${d.file.name}`, meta, d.targetStemId).catch(
          () => {
            /* per-file error is captured in upload state; don't fail the batch */
          }
        );
      })
    );
    router.refresh();
  }

  /**
   * Extract metadata for every file, then decide whether to open the swap
   * modal or upload directly:
   *   - no existing stems → straight to upload
   *   - existing stems but no file scored ≥ MATCH_UNCERTAIN → straight to upload
   *   - otherwise → open the swap dialog, defer the actual uploads to confirm
   */
  async function handleFiles(fileList: FileList | File[]) {
    const files = Array.from(fileList);
    if (files.length === 0) return;

    // Pre-analyze every file so the modal can show length scores. Sets each
    // row's status to 'analyzing'; the per-file key collides with the upload
    // key later, which is fine — uploadOne overrides it.
    const metaResults = await Promise.all(
      files.map(async (file, i) => {
        const key = `${Date.now()}-${i}-${file.name}`;
        setUploads((prev) => ({ ...prev, [key]: { filename: file.name, status: 'analyzing' } }));
        try {
          const meta = await extractMetadata(file);
          return { key, file, meta };
        } catch {
          setUploads((prev) => ({
            ...prev,
            [key]: { filename: file.name, status: 'failed', error: 'decode failed' },
          }));
          return null;
        }
      })
    );

    const metadatas: FileMetadata[] = metaResults
      .filter((r): r is NonNullable<typeof r> => r !== null)
      .map((r) => ({ file: r.file, lengthMs: r.meta.lengthMs }));

    if (stems.length === 0) {
      // Pure new-upload path — bypass the matcher entirely.
      await Promise.all(
        metaResults.map(async (r, i) => {
          if (!r) return;
          await uploadOne(r.file, r.key, r.meta, null).catch(() => {
            /* errors surface in upload state */
            void i;
          });
        })
      );
      router.refresh();
      return;
    }

    const matches = matchStems(stems, metadatas);
    const anyMatch = matches.some((m) => m.score >= MATCH_UNCERTAIN);
    if (!anyMatch) {
      // No plausible match → same as the empty-session path.
      await Promise.all(
        metaResults.map(async (r) => {
          if (!r) return;
          await uploadOne(r.file, r.key, r.meta, null).catch(() => {});
        })
      );
      router.refresh();
      return;
    }

    // Hand off to the modal. The "analyzing" placeholders in `uploads` get
    // replaced when the user confirms (uploadOne writes its own status).
    setPendingSwap({ metadatas, matches });
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files.length) {
      void handleFiles(e.dataTransfer.files);
    }
  }

  async function handleDelete(stemId: string) {
    if (!confirm('Remove this stem?')) return;
    const res = await fetch(`/api/sessions/${sessionId}/stems/${stemId}`, {
      method: 'DELETE',
      credentials: 'include',
    });
    if (res.ok) {
      setStems((prev) => prev.filter((s) => s.id !== stemId));
      window.dispatchEvent(new CustomEvent<string>('aux:stem-removed', { detail: stemId }));
    }
  }

  const activeUploads = Object.entries(uploads).filter(
    ([, u]) => u.status !== 'done' && u.status !== 'failed'
  );
  const failedUploads = Object.entries(uploads).filter(([, u]) => u.status === 'failed');

  // Group stems for the list.
  const grouped = stems.reduce<Record<string, Stem[]>>((acc, stem) => {
    const g = detectGroup(stem.name);
    if (!acc[g]) acc[g] = [];
    acc[g].push(stem);
    return acc;
  }, {});
  const orderedGroups = ['drums', 'bass', 'vox', 'fx', 'other'].filter((g) => grouped[g]);

  return (
    <div>
      {/* Drop zone */}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        className={`border-2 border-dashed rounded-md p-10 text-center transition-colors ${
          dragging ? 'border-azure bg-azure-soft/30' : 'border-line bg-paper-2/40'
        }`}
      >
        <p className="font-mono text-xs tracking-widest uppercase text-ink-3 mb-2">
          Drop stems here
        </p>
        <p className="text-ink-2 mb-4">WAV · AIFF · FLAC · MP3 · M4A. Folders welcome.</p>
        <label>
          <input
            type="file"
            multiple
            accept="audio/*"
            className="hidden"
            onChange={(e) => {
              if (e.target.files?.length) void handleFiles(e.target.files);
              e.target.value = '';
            }}
          />
          <Button asChild variant="outline">
            <span className="cursor-pointer">Or pick files…</span>
          </Button>
        </label>
      </div>

      {/* Active uploads */}
      {(activeUploads.length > 0 || failedUploads.length > 0) && (
        <div className="mt-6 space-y-2">
          {activeUploads.map(([key, u]) => (
            <div
              key={key}
              className="flex items-center gap-3 text-sm text-ink-2 px-3 py-2 bg-paper-2 rounded"
            >
              <span className="font-mono text-xs uppercase tracking-wider text-ink-3">
                {u.status}
              </span>
              <span className="truncate flex-1">{u.filename}</span>
            </div>
          ))}
          {failedUploads.map(([key, u]) => (
            <div
              key={key}
              className="flex items-center gap-3 text-sm px-3 py-2 bg-red-50 border border-red-200 rounded"
            >
              <span className="font-mono text-xs uppercase tracking-wider text-red-700">fail</span>
              <span className="truncate flex-1 text-red-700">
                {u.filename} — {u.error}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Stems list */}
      {stems.length > 0 && (
        <div className="mt-10">
          <p className="font-mono text-xs tracking-widest uppercase text-ink-3 mb-3">Stems</p>
          {orderedGroups.map((group) => (
            <div key={group} className="mb-5">
              <p className="font-mono text-xs uppercase tracking-wider text-ink-3 mb-2 pb-1 border-b border-line">
                {GROUP_LABELS[group]}
              </p>
              <ul className="divide-y divide-line">
                {(grouped[group] ?? []).map((stem) => (
                  <li key={stem.id} className="grid grid-cols-12 gap-2 py-2 text-sm items-center">
                    <span className="col-span-5 truncate font-mono text-ink" title={stem.name}>
                      {stem.name}
                    </span>
                    <span className="col-span-2 font-mono text-xs text-ink-3 text-right">
                      {formatLength(stem.lengthMs)}
                    </span>
                    <span className="col-span-2 font-mono text-xs text-ink-3 text-right">
                      {stem.channels === 1 ? 'mono' : 'stereo'} ·{' '}
                      {Math.round(stem.sampleRate / 1000)}k
                    </span>
                    <span className="col-span-2 font-mono text-xs text-ink-3 text-right">
                      {formatDb(stem.peakDb)}
                    </span>
                    <button
                      type="button"
                      onClick={() => void handleDelete(stem.id)}
                      className="col-span-1 text-xs text-ink-3 hover:text-ink text-right"
                    >
                      remove
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      {pendingSwap && (
        <StemSwapDialog
          matches={pendingSwap.matches}
          stems={stems}
          onCancel={() => {
            // Cancel: drop the analyzing placeholders for these files.
            setUploads((prev) => {
              const next = { ...prev };
              for (const [k, u] of Object.entries(next)) {
                if (u.status === 'analyzing') delete next[k];
              }
              return next;
            });
            setPendingSwap(null);
          }}
          onConfirm={(decisions) => {
            const metadatas = pendingSwap.metadatas;
            setPendingSwap(null);
            void processDecisions(metadatas, decisions);
          }}
        />
      )}
    </div>
  );
}
