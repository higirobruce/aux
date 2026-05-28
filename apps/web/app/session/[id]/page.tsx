import { apiFetch } from '@/lib/api';
import type { SessionDetail } from '@/lib/types';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { StemDropZone } from './_stem-drop-zone';
import { Transport } from './_transport';

export default async function SessionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await apiFetch<SessionDetail>(`/api/sessions/${id}`);
  if (!session) notFound();

  return (
    <main className="min-h-screen px-6 py-10 max-w-5xl mx-auto">
      <nav className="mb-6">
        <Link
          href="/"
          className="font-mono text-xs tracking-widest uppercase text-ink-3 hover:text-ink"
        >
          ← Sessions
        </Link>
      </nav>

      <header className="mb-8">
        <p className="font-mono text-xs tracking-widest uppercase text-ink-3 mb-1">
          Session · {session.storageMode}
        </p>
        <h1 className="font-display text-4xl tracking-tight mb-2">{session.name}</h1>
        <p className="font-mono text-xs text-ink-3">
          {session.stems.length} stem{session.stems.length === 1 ? '' : 's'} ·{' '}
          {new Date(session.createdAt).toLocaleString()}
        </p>
      </header>

      <Transport sessionId={session.id} />

      <StemDropZone sessionId={session.id} initialStems={session.stems} />

      <div className="mt-12 border-t border-line pt-6 text-ink-3 text-sm">
        <p>
          Mixer surface (channel strips, EQ, master) wires up in the next phase per{' '}
          <code className="text-ink">docs/implementation.html §11 v0.2</code>.
        </p>
      </div>
    </main>
  );
}
