/**
 * Server-side fetch helpers — preserve the incoming session cookie when
 * Next.js Server Components call the proxied API.
 */
import { cookies, headers } from 'next/headers';

interface FetchOptions extends RequestInit {
  next?: { revalidate?: number | false };
}

async function originAndCookies() {
  const h = await headers();
  const host = h.get('host') ?? 'localhost:3100';
  const proto = h.get('x-forwarded-proto') ?? 'http';

  const cookieStr = (await cookies())
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');

  return { base: `${proto}://${host}`, cookie: cookieStr };
}

/** Server-only API fetch. Forwards the user's cookies. */
export async function apiFetch<T = unknown>(
  path: string,
  options: FetchOptions = {}
): Promise<T | null> {
  const { base, cookie } = await originAndCookies();
  const res = await fetch(`${base}${path}`, {
    cache: 'no-store',
    ...options,
    headers: {
      cookie,
      ...(options.headers as Record<string, string> | undefined),
    },
  });
  if (!res.ok) return null;
  if (res.status === 204) return null as T;
  return (await res.json()) as T;
}
