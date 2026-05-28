import { apiFetch } from '@/lib/api';
import type { AuthSession, SessionSummary } from '@/lib/types';
import { Button } from '@aux/ui';
import Link from 'next/link';
import { NewSessionDialog } from './_components/new-session-dialog';

function formatRelativeTime(iso: string | null): string {
  if (!iso) return 'never';
  const ms = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export default async function DashboardPage() {
  const session = await apiFetch<AuthSession>('/api/auth/get-session');
  const sessions = (await apiFetch<SessionSummary[]>('/api/sessions')) ?? [];

  return (
    <main className="min-h-screen px-6 py-12 max-w-5xl mx-auto">
      <header className="flex items-center justify-between mb-10">
        <div>
          <p className="font-mono text-xs tracking-widest uppercase text-ink-3 mb-1">aux</p>
          <h1 className="font-display text-4xl tracking-tight">Sessions</h1>
        </div>
        <div className="flex items-center gap-3">
          {session?.user ? (
            <span className="font-mono text-xs text-ink-3">{session.user.email}</span>
          ) : null}
          <form action="/api/auth/sign-out" method="POST">
            <Button type="submit" variant="ghost" size="sm">
              Sign out
            </Button>
          </form>
          <NewSessionDialog />
        </div>
      </header>

      {sessions.length === 0 ? (
        <div className="border border-dashed border-line rounded-md p-12 text-center">
          <p className="font-mono text-xs tracking-widest uppercase text-ink-3 mb-2">
            No sessions yet
          </p>
          <p className="text-ink-2 mb-6">
            Create your first session, drop a folder of stems, start mixing.
          </p>
          <NewSessionDialog />
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {sessions.map((s) => (
            <Link
              key={s.id}
              href={`/session/${s.id}`}
              className="block border border-line rounded-md p-5 bg-paper hover:border-ink transition-colors"
            >
              <h3 className="font-medium text-ink mb-1 truncate">{s.name}</h3>
              <div className="flex items-center gap-2 mb-3">
                <span className="font-mono text-xs uppercase tracking-widest text-ink-3">
                  {s.storageMode}
                </span>
              </div>
              <p className="font-mono text-xs text-ink-3">
                opened {formatRelativeTime(s.lastOpenedAt)}
              </p>
            </Link>
          ))}
        </div>
      )}
    </main>
  );
}
