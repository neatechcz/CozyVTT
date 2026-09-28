/**
 * Where instance branding may point.
 *
 * The logo, mascot and favicon are replaced by swapping the files in
 * `frontend/public/` and rebuilding. The settings route accepted any string
 * for them, so an operator could point one at another website instead, and
 * nothing said no.
 *
 * That is not a supported way to brand an instance and it should not look like
 * one. It also has two costs an operator would not expect: every visitor's
 * browser contacts that third party before anyone has even signed in, handing
 * over an IP address and a visit time; and allowing images from anywhere would
 * mean widening the app page's Content-Security-Policy, which is what stops a
 * future injection quietly posting data out through an image URL.
 *
 * Same-origin paths are what the app writes itself and stay accepted.
 *
 * Requires PostgreSQL at DATABASE_URL.
 */

import request from 'supertest';
import { PlatformRole } from '@prisma/client';
import { createTestApp } from '../../__tests__/helpers/test-app';
import { prisma, createTestUser, cleanupUsers, TEST_PASSWORD } from '../../__tests__/helpers/db';

const app = createTestApp();

let adminId: string;
let admin: ReturnType<typeof request.agent>;

async function login(email: string) {
  const agent = request.agent(app);
  const res = await agent.post('/api/auth/login').send({ email, password: TEST_PASSWORD });
  expect(res.status).toBe(200);
  return agent;
}

const setBranding = (body: Record<string, unknown>) => admin.put('/api/admin/settings').send(body);

beforeAll(async () => {
  const user = await createTestUser({
    email: `branding-admin-${Date.now()}@test.cozyvtt.local`,
    displayName: 'Branding Admin',
    role: PlatformRole.ADMIN,
  });
  adminId = user.id;
  admin = await login(user.email);
});

afterAll(async () => {
  await cleanupUsers([adminId]);
  await prisma.$disconnect();
});

describe('instance branding URLs', () => {
  it('accepts a path served by this instance', async () => {
    const res = await setBranding({ customLogoUrl: '/default-logo.png' });
    expect(res.status).toBe(200);
    expect(res.body.settings.customLogoUrl).toBe('/default-logo.png');
  });

  it('accepts an uploaded asset path', async () => {
    const res = await setBranding({ customMascotUrl: '/api/assets/maps/2f1c9d3e-0000-4000-8000-000000000001' });
    expect(res.status).toBe(200);
  });

  it('accepts clearing one', async () => {
    expect((await setBranding({ customLogoUrl: null })).status).toBe(200);
  });

  describe('refuses anything that leaves this instance', () => {
    it.each([
      ['another website', 'https://cdn.example.com/logo.png'],
      ['plain http', 'http://example.com/logo.png'],
      ['a protocol-relative address', '//example.com/logo.png'],
      ['a javascript: URL', 'javascript:alert(1)'],
      ['a data: URL', 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='],
      ['a bare host', 'example.com/logo.png'],
    ])('%s', async (_label, value) => {
      const res = await setBranding({ customLogoUrl: value });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/instance/i);
    });

    it('checks the favicon and mascot too, not only the logo', async () => {
      expect((await setBranding({ customFaviconUrl: 'https://example.com/f.png' })).status).toBe(400);
      expect((await setBranding({ customMascotUrl: 'https://example.com/m.png' })).status).toBe(400);
    });

    it('leaves the stored value alone when it refuses', async () => {
      await setBranding({ customLogoUrl: '/default-logo.png' });
      await setBranding({ customLogoUrl: 'https://example.com/logo.png' });
      const res = await admin.get('/api/admin/settings');
      expect(res.body.settings.customLogoUrl).toBe('/default-logo.png');
    });
  });
});
