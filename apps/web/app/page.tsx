import { apiFetch } from '@/lib/api';
import type { AuthSession, SessionSummary } from '@/lib/types';
import { Launcher } from './_components/launcher';

export default async function DashboardPage() {
  const session = await apiFetch<AuthSession>('/api/auth/get-session');
  const sessions = (await apiFetch<SessionSummary[]>('/api/sessions')) ?? [];

  return (
    <Launcher
      sessions={sessions}
      userEmail={session?.user?.email}
      signOut={
        <form action="/api/auth/sign-out" method="POST">
          <button
            type="submit"
            className="lbl"
            style={{
              width: '100%',
              textAlign: 'left',
              padding: '8px 6px',
              background: 'transparent',
              border: 'none',
              color: 'var(--txt-2)',
              fontSize: 10,
              cursor: 'pointer',
            }}
          >
            Sign out →
          </button>
        </form>
      }
    />
  );
}
