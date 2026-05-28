'use client';

import { Button, Input, Label } from '@aux/ui';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

export function NewSessionDialog() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [storageMode, setStorageMode] = useState<'cloud' | 'local'>('cloud');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, storageMode }),
        credentials: 'include',
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.message ?? `Failed (HTTP ${res.status})`);
      }
      const created: { id: string } = await res.json();
      router.push(`/session/${created.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create session');
      setSubmitting(false);
    }
  }

  if (!open) {
    return <Button onClick={() => setOpen(true)}>+ New session</Button>;
  }

  return (
    // biome-ignore lint/a11y/useSemanticElements: native <dialog> needs showModal() lifecycle which clashes with our open-state pattern; role="dialog" is the established workaround
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="new-session-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-6"
    >
      <button
        type="button"
        aria-label="Close dialog"
        onClick={() => !submitting && setOpen(false)}
        disabled={submitting}
        className="absolute inset-0 bg-ink/40 cursor-default disabled:cursor-not-allowed"
      />
      <div className="relative bg-paper border border-line rounded-md w-full max-w-md p-6 shadow-xl">
        <p
          id="new-session-title"
          className="font-mono text-xs tracking-widest uppercase text-ink-3 mb-1"
        >
          New session
        </p>
        <h2 className="font-display text-2xl tracking-tight mb-4">Start a mix.</h2>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="name">Name</Label>
            <Input
              id="name"
              required
              autoFocus
              maxLength={120}
              placeholder="e.g. Midnight Run"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={submitting}
            />
          </div>

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium mb-1">Storage</legend>
            <label className="flex items-start gap-3 p-3 border border-line rounded-md cursor-pointer hover:border-ink-3">
              <input
                type="radio"
                name="storage"
                value="cloud"
                checked={storageMode === 'cloud'}
                onChange={() => setStorageMode('cloud')}
                disabled={submitting}
                className="mt-1"
              />
              <span className="text-sm">
                <strong className="block">Cloud</strong>
                <span className="text-ink-3">
                  Stems in our object store. Share-link enabled. Default.
                </span>
              </span>
            </label>
            <label className="flex items-start gap-3 p-3 border border-line rounded-md cursor-pointer hover:border-ink-3 opacity-60">
              <input
                type="radio"
                name="storage"
                value="local"
                checked={storageMode === 'local'}
                onChange={() => setStorageMode('local')}
                disabled={true}
                className="mt-1"
              />
              <span className="text-sm">
                <strong className="block">Local (coming)</strong>
                <span className="text-ink-3">
                  Stems on this device via File System Access — v0.2.
                </span>
              </span>
            </label>
          </fieldset>

          {error && (
            <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">
              {error}
            </p>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => setOpen(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={submitting || !name.trim()}>
              {submitting ? 'Creating…' : 'Create session'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
