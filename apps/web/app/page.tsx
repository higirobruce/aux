import { Button } from '@aux/ui';
import { cookies, headers } from 'next/headers';
import Link from 'next/link';

interface AuthSession {
  session: { id: string; userId: string };
  user: { id: string; email: string; name?: string | null };
}

async function getServerSession(): Promise<AuthSession | null> {
  // We're already inside Next.js — call the proxied /api on this same origin.
  const h = await headers();
  const host = h.get('host') ?? 'localhost:3100';
  const proto = h.get('x-forwarded-proto') ?? 'http';

  const cookieStr = (await cookies())
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');

  const res = await fetch(`${proto}://${host}/api/auth/get-session`, {
    headers: { cookie: cookieStr },
    cache: 'no-store',
  });

  if (!res.ok) return null;
  const data = (await res.json()) as AuthSession | null;
  return data?.user ? data : null;
}

export default async function MixerPage() {
  const session = await getServerSession();

  return (
    <main className="min-h-screen flex items-center justify-center px-6">
      <div className="text-center max-w-xl">
        <p className="font-mono text-xs tracking-widest uppercase text-ink-3 mb-3">
          aux · v0.1 · skeleton
        </p>
        <h1 className="font-display text-6xl tracking-tight mb-4">Mixer.</h1>
        <p className="text-ink-2 leading-relaxed mb-6">
          The session lives here. This route will host the mixer console once the audio engine,
          channel strips, and session document are wired up.
        </p>

        {session ? (
          <div className="inline-flex items-center gap-3 rounded-md border border-line bg-paper-2 px-4 py-2 mb-6">
            <span className="font-mono text-xs tracking-widest uppercase text-ink-3">
              Signed in
            </span>
            <span className="text-ink text-sm">{session.user.email}</span>
            <form action="/api/auth/sign-out" method="POST">
              <Button type="submit" variant="ghost" size="sm">
                Sign out
              </Button>
            </form>
          </div>
        ) : null}

        <div className="flex flex-wrap gap-3 justify-center">
          <Button asChild variant="outline">
            <Link href="http://localhost:3101">← Landing</Link>
          </Button>
        </div>
      </div>
    </main>
  );
}
