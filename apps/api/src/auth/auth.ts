import { getPrismaClient } from '@aux/db';
import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { magicLink } from 'better-auth/plugins';

/**
 * Narrow surface of the better-auth instance that this app uses.
 *
 * better-auth's full inferred type leaks zod v4 internals (TS2742). We use
 * this hand-written interface for the public API surface and `unknown` for
 * the internals — the auth.handler / auth.api shape is stable across versions.
 */
export interface Auth {
  handler: (req: Request) => Promise<Response>;
  api: {
    getSession: (opts: {
      headers: Headers;
    }) => Promise<{ session: { id: string }; user: { id: string; email: string } } | null>;
  };
}

/**
 * better-auth instance. Mounted via the auth.controller catch-all at /api/auth/*.
 *
 * Magic-link UX:
 *  - dev:  the link is logged to stdout (so `pnpm dev` prints it)
 *  - prod: Resend (wired when RESEND_API_KEY is set)
 */
export function createAuth(): Auth {
  const db = getPrismaClient();

  // Cast to our narrow Auth interface — the full inferred type carries
  // zod v4 internals that TS can't portably name.
  return betterAuth({
    database: prismaAdapter(db, { provider: 'postgresql' }),

    // Map model names so better-auth uses our renamed tables.
    session: { modelName: 'authSession' },
    account: { modelName: 'account' },
    verification: { modelName: 'verification' },

    secret: process.env.AUTH_SECRET ?? 'dev-only-not-for-prod-replace-me',
    // baseURL is the URL the BROWSER sees — magic-link URLs are minted with
    // this prefix. We route /api/* through Next.js so cookies end up scoped
    // to the web origin (cross-origin SameSite=Lax wouldn't be sent on fetch).
    baseURL: process.env.PUBLIC_BASE_URL ?? 'http://localhost:3100',

    trustedOrigins: [process.env.WEB_ORIGIN ?? 'http://localhost:3100'],

    advanced: {
      defaultCookieAttributes: {
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
      },
    },

    plugins: [
      magicLink({
        async sendMagicLink({ email, url, token }) {
          if (process.env.RESEND_API_KEY) {
            // TODO: wire Resend in production
            console.log(`[auth] (resend stub) magic link for ${email}: ${url}`);
            return;
          }
          // Dev: just log it. Token included so curl-based smoke tests can grab it.
          console.log(`[auth] magic link for ${email}`);
          console.log(`[auth]   url:   ${url}`);
          console.log(`[auth]   token: ${token}`);
        },
        expiresIn: Number(process.env.MAGIC_LINK_TTL_SECONDS ?? 600),
      }),
    ],
  }) as unknown as Auth;
}

// Singleton, lazily initialized so module load is cheap.
let cached: Auth | null = null;
export function getAuth(): Auth {
  if (cached) return cached;
  cached = createAuth();
  return cached;
}
