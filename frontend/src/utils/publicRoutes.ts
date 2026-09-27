/**
 * publicRoutes.ts
 * Which paths a signed-out visitor is allowed to sit on.
 *
 * The API client's 401 interceptor uses this to decide whether an unauthorized
 * response means "you got logged out, go to the login page" or "of course you
 * are not authenticated, you have not signed in yet".
 *
 * Getting this wrong is worse than a stray redirect. The interceptor navigates
 * with `window.location.href`, which discards the query string — so a public
 * page missing from this list loses any one-time token in its URL, and the link
 * that brought the visitor there cannot be retried. That is precisely how every
 * invitation email ended up at the login screen: `/accept-invite` was added to
 * the router but never added here.
 *
 * Keep in step with the public routes in App.tsx — publicRoutes.test.ts reads
 * that file and fails if the two drift apart.
 */

/** Paths reachable without a session. Prefix entries cover their children. */
export const PUBLIC_PATH_PREFIXES = ['/auth'] as const;

export const PUBLIC_PATHS = [
  '/',
  '/setup',
  '/reset-password',
  '/accept-invite',
] as const;

/** True when a 401 on this path is expected rather than a lost session. */
export function isPublicPath(pathname: string): boolean {
  if (PUBLIC_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return true;
  return (PUBLIC_PATHS as readonly string[]).includes(pathname);
}
