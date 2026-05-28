'use client';

import type { Stem } from '@/lib/types';
import { Button } from '@aux/ui';
import { useEffect, useMemo, useState } from 'react';
import { MATCH_AUTO, MATCH_UNCERTAIN, type StemMatch } from '../../../lib/stem-match';

interface Props {
  matches: StemMatch[];
  stems: Stem[];
  onConfirm: (decisions: SwapDecision[]) => void;
  onCancel: () => void;
}

/**
 * One decision per dropped file. `targetStemId` null means "add as a new
 * stem" (current upload behaviour). Set to a stem id to perform a swap.
 */
export interface SwapDecision {
  file: File;
  fileLengthMs: number;
  targetStemId: string | null;
}

function formatPct(score: number): string {
  return `${Math.round(score * 100)}%`;
}

/** Stable key per File (same browser session) — name + size + lastModified. */
function fileKey(f: File): string {
  return `${f.name}|${f.size}|${f.lastModified}`;
}

export function StemSwapDialog({ matches, stems, onConfirm, onCancel }: Props) {
  // Per-row decision keyed by file index. Initialized from the matcher's
  // proposal: auto-matched → swap; everything else → add as new.
  const [decisions, setDecisions] = useState<Array<string | null>>(() =>
    matches.map((m) => (m.confidence === 'matched' ? (m.bestStem?.id ?? null) : null))
  );

  // Esc closes (= cancel).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const swapCount = decisions.filter((d) => d !== null).length;
  const newCount = decisions.length - swapCount;

  // Stems already targeted by some decision — used to dim them in other
  // rows' dropdowns so the user doesn't accidentally swap two files into
  // the same channel.
  const claimedStems = useMemo(() => {
    const claimed = new Set<string>();
    for (const d of decisions) if (d) claimed.add(d);
    return claimed;
  }, [decisions]);

  function setDecision(idx: number, targetStemId: string | null) {
    setDecisions((prev) => {
      const next = [...prev];
      // If the user is moving the same target onto a different file,
      // unclaim it from the previous owner.
      if (targetStemId) {
        for (let i = 0; i < next.length; i++) {
          if (i !== idx && next[i] === targetStemId) next[i] = null;
        }
      }
      next[idx] = targetStemId;
      return next;
    });
  }

  function handleConfirm() {
    onConfirm(
      matches.map((m, i) => ({
        file: m.file,
        fileLengthMs: m.fileLengthMs,
        targetStemId: decisions[i] ?? null,
      }))
    );
  }

  return (
    <>
      <button
        type="button"
        aria-label="Close swap dialog"
        className="stems-backdrop"
        onClick={onCancel}
      />
      <dialog open className="swap-dialog" aria-modal="true" aria-label="Stem swap">
        <header className="swap-dialog-header">
          <div>
            <div className="swap-dialog-title">Stem swap</div>
            <div className="swap-dialog-meta">
              {matches.length} new file{matches.length === 1 ? '' : 's'} · {stems.length} existing
              stem{stems.length === 1 ? '' : 's'}
            </div>
          </div>
          <button
            type="button"
            className="stems-drawer-close"
            onClick={onCancel}
            aria-label="Close"
          >
            ×
          </button>
        </header>

        <div className="swap-dialog-body">
          <p className="swap-dialog-help">
            Above {Math.round(MATCH_AUTO * 100)}% confidence the new file replaces the existing stem
            (every channel parameter survives — fader, pan, EQ, comp). Between{' '}
            {Math.round(MATCH_UNCERTAIN * 100)}% and {Math.round(MATCH_AUTO * 100)}% review the
            pairing. Below that, add as a new stem.
          </p>

          <table className="swap-table">
            <thead>
              <tr>
                <th>#</th>
                <th>New file</th>
                <th>Match</th>
                <th>Old stem (swap target)</th>
              </tr>
            </thead>
            <tbody>
              {matches.map((m, i) => {
                const decision = decisions[i] ?? null;
                const rowClass =
                  decision !== null
                    ? m.confidence === 'matched'
                      ? 'matched'
                      : 'uncertain'
                    : 'unmatched';
                return (
                  <tr key={fileKey(m.file)} className={`swap-row ${rowClass}`}>
                    <td className="num">{i + 1}</td>
                    <td className="file-name" title={m.file.name}>
                      {m.file.name}
                    </td>
                    <td className="conf">{m.bestStem ? formatPct(m.score) : '—'}</td>
                    <td>
                      <select
                        value={decision ?? ''}
                        onChange={(e) => setDecision(i, e.target.value || null)}
                        className="swap-select"
                        aria-label={`Target for ${m.file.name}`}
                      >
                        <option value="">add as new stem</option>
                        {m.candidates.map(({ stem, score }) => (
                          <option
                            key={stem.id}
                            value={stem.id}
                            disabled={claimedStems.has(stem.id) && decision !== stem.id}
                          >
                            {stem.name} ({formatPct(score)})
                          </option>
                        ))}
                        {/* Allow targeting any stem, even low-confidence — engineers know best. */}
                        {stems
                          .filter((s) => !m.candidates.some((c) => c.stem.id === s.id))
                          .map((stem) => (
                            <option
                              key={stem.id}
                              value={stem.id}
                              disabled={claimedStems.has(stem.id) && decision !== stem.id}
                            >
                              {stem.name} (override)
                            </option>
                          ))}
                      </select>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <footer className="swap-dialog-footer">
          <span className="swap-summary">
            {swapCount > 0 && (
              <>
                {swapCount} swap{swapCount === 1 ? '' : 's'}
                {newCount > 0 && ' · '}
              </>
            )}
            {newCount > 0 && (
              <>
                {newCount} new stem{newCount === 1 ? '' : 's'}
              </>
            )}
          </span>
          <span className="swap-buttons">
            <Button variant="outline" onClick={onCancel}>
              Cancel
            </Button>
            <Button onClick={handleConfirm}>Confirm</Button>
          </span>
        </footer>
      </dialog>
    </>
  );
}
