import { describe, it, expect } from 'vitest';
import { isPublicPath } from '../publicRoutes';

// Read App.tsx as text the same way themeTokens.test.ts reads the component
// tree — a Vite raw import, so no Node filesystem types are involved.
const APP_SOURCE = Object.values(
  import.meta.glob('/src/App.tsx', { query: '?raw', import: 'default', eager: true })
)[0] as string;

/**
 * The bug this pins: `/accept-invite` was added to the router but never added
 * to the 401 interceptor's public-page list, so every invitation email landed
 * on the login screen. The redirect uses `window.location.href`, which drops
 * the query string, so the invitation token was destroyed and the link could
 * not be retried.
 *
 * A hand-written list of paths would not have caught it — the whole failure was
 * that someone added a route and forgot the list. So this reads App.tsx and
 * checks the two agree.
 */
describe('isPublicPath', () => {
  it('treats a signed-out visitor on the welcome, setup and auth pages as expected', () => {
    expect(isPublicPath('/')).toBe(true);
    expect(isPublicPath('/setup')).toBe(true);
    expect(isPublicPath('/auth/login')).toBe(true);
    expect(isPublicPath('/auth/register')).toBe(true);
    expect(isPublicPath('/auth/forgot-password')).toBe(true);
  });

  // The two token-bearing routes. Both must be public or their token is lost.
  it('covers the routes that carry a one-time token in the URL', () => {
    expect(isPublicPath('/reset-password')).toBe(true);
    expect(isPublicPath('/accept-invite')).toBe(true);
  });

  it('still redirects from protected pages', () => {
    expect(isPublicPath('/dashboard')).toBe(false);
    expect(isPublicPath('/characters')).toBe(false);
    expect(isPublicPath('/character-templates')).toBe(false);
    expect(isPublicPath('/campaigns/abc-123')).toBe(false);
    expect(isPublicPath('/admin')).toBe(false);
  });

  it('does not treat a protected path as public just because one starts with it', () => {
    // Guards against a careless prefix match — /authors is not an auth page.
    expect(isPublicPath('/dashboard/auth')).toBe(false);
  });
});

describe('agreement with the router', () => {
  it('marks every public route in App.tsx as public', () => {
    const app = APP_SOURCE;

    // The public routes are the block between these two markers. Reading the
    // file rather than restating the list is the point: a route added to the
    // router without a matching entry has to fail here.
    const start = app.indexOf('{/* Public Routes */}');
    const end = app.indexOf('{/* Protected Routes');
    expect(start, 'Public Routes marker missing from App.tsx').toBeGreaterThan(-1);
    expect(end, 'Protected Routes marker missing from App.tsx').toBeGreaterThan(start);

    const block = app.slice(start, end);
    const paths = [...block.matchAll(/path="([^"]+)"/g)].map((m) => m[1]);

    expect(paths.length, 'no public routes parsed — did the markers change?').toBeGreaterThan(4);

    const missing = paths.filter((p) => !isPublicPath(p));
    expect(
      missing,
      `public route(s) in App.tsx missing from publicRoutes.ts: ${missing.join(', ')}. ` +
        'A 401 on these paths would redirect to /auth/login and discard the query string.'
    ).toEqual([]);
  });
});
