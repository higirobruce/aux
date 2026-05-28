/**
 * Dev-only stand-in for the authenticated user.
 *
 * Used by endpoints that haven't been wired into the auth middleware yet.
 * Throws hard in production so this can never silently ship to a deployed
 * environment — per the security note in docs/implementation.html §18.
 *
 * Delete every call site once better-auth lands (next phase per the plan).
 */
export function requireDevUser(): string {
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'requireDevUser() called in production — auth must be wired before deploying'
    );
  }
  return 'dev-user-placeholder';
}
