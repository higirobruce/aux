'use client';

import { Button, Input, Label } from '@aux/ui';
import { useState } from 'react';

export default function SignInPage() {
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setStatus('sending');
    setErrorMessage(null);

    try {
      const response = await fetch('/api/auth/sign-in/magic-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          callbackURL: '/',
        }),
        credentials: 'include',
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data?.message ?? `Magic link failed (HTTP ${response.status})`);
      }

      setStatus('sent');
    } catch (err) {
      setStatus('error');
      setErrorMessage(err instanceof Error ? err.message : 'Something went wrong');
    }
  }

  return (
    <main className="min-h-screen flex items-center justify-center px-6 py-16">
      <div className="w-full max-w-md">
        <p className="font-mono text-xs tracking-widest uppercase text-ink-3 mb-3">aux</p>
        <h1 className="font-display text-4xl tracking-tight mb-2">Sign in.</h1>
        <p className="text-ink-2 mb-8 leading-relaxed">
          We&apos;ll email you a one-time link. No passwords.
        </p>

        {status === 'sent' ? (
          <div className="rounded-md border border-line bg-paper-2 p-5">
            <p className="font-mono text-xs tracking-widest uppercase text-ink-3 mb-2">
              Check your email
            </p>
            <p className="text-ink leading-relaxed mb-1">
              We sent a link to <strong>{email}</strong>.
            </p>
            <p className="text-ink-3 text-sm">
              Open it from this device to finish signing in. The link expires in 10 minutes.
            </p>
            <button
              type="button"
              className="mt-4 text-sm text-ink-3 underline underline-offset-2 hover:text-ink"
              onClick={() => {
                setStatus('idle');
                setEmail('');
              }}
            >
              Use a different email
            </button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                required
                autoComplete="email"
                placeholder="you@studio.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={status === 'sending'}
              />
            </div>

            {errorMessage && (
              <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">
                {errorMessage}
              </p>
            )}

            <Button type="submit" size="lg" className="w-full" disabled={status === 'sending'}>
              {status === 'sending' ? 'Sending…' : 'Send magic link'}
            </Button>

            <p className="text-xs text-ink-3 pt-2">
              In dev, the link is logged to the API server&apos;s console. Look for{' '}
              <code className="font-mono">[auth] magic link for…</code>.
            </p>
          </form>
        )}
      </div>
    </main>
  );
}
