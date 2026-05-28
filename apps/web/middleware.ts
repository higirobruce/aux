import { type NextRequest, NextResponse } from 'next/server';

/**
 * Auth gate.
 *
 * Presence check on the better-auth.session_token cookie. The cookie is
 * scoped to this origin because we proxy /api/* through Next.js (see
 * next.config.mjs). The API still enforces real session validation; this
 * is just to avoid rendering protected pages for users with no cookie.
 */
const AUTH_COOKIE = 'better-auth.session_token';
const PUBLIC_PATHS = [
  '/sign-in',
  '/aux-worklet.js',
  '/eq8-worklet.js',
  '/eq8.js',
  '/eq8_bg.wasm',
  '/comp-clean-worklet.js',
  '/comp_clean_bg.wasm',
];

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Allow public paths + Next.js internals + /api/* (proxied to the API which
  // does its own auth checks).
  if (
    PUBLIC_PATHS.some((p) => pathname.startsWith(p)) ||
    pathname.startsWith('/_next') ||
    pathname.startsWith('/api')
  ) {
    return NextResponse.next();
  }

  const hasSession = req.cookies.has(AUTH_COOKIE);
  if (!hasSession) {
    const signIn = new URL('/sign-in', req.url);
    signIn.searchParams.set('next', pathname);
    return NextResponse.redirect(signIn);
  }

  return NextResponse.next();
}

export const config = {
  // Run on everything except static files.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
