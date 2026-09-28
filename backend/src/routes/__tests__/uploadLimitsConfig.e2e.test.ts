/**
 * The upload limits a self-hoster can see.
 *
 * Three places report the limits: the startup log, the public /api/config the
 * upload dialog reads, and the admin-only /api/admin/config behind the admin
 * panel's "Upload Size Limits" table. The admin route used to list the four
 * original types by hand, so a fifth (DOCUMENT) could be enforced without ever
 * being shown, and DEPLOYMENT.md's "the admin panel shows the same numbers"
 * stopped being true the day the type was added. They must all report the same
 * set: every type with a MAX_<TYPE>_SIZE_MB variable, and nothing else. OTHER
 * has no upload path and no variable, so it does not belong in any of them.
 *
 * Requires PostgreSQL at DATABASE_URL.
 */

import request from 'supertest';
import { PlatformRole } from '@prisma/client';
import { createTestApp } from '../../__tests__/helpers/test-app';
import { prisma, createTestUser, cleanupUsers, TEST_PASSWORD } from '../../__tests__/helpers/db';
import { UPLOAD_LIMITS } from '../../utils/fileUtils';

const app = createTestApp();
const EXPECTED_TYPES = ['MAP', 'TOKEN', 'AUDIO', 'AVATAR', 'DOCUMENT'].sort();

let adminId: string;
let adminCookie: string;

async function login(email: string): Promise<string> {
  const res = await request(app).post('/api/auth/login').send({ email, password: TEST_PASSWORD });
  expect(res.status).toBe(200);
  return res.headers['set-cookie'][0].split(';')[0];
}

beforeAll(async () => {
  const admin = await createTestUser({ role: PlatformRole.ADMIN, displayName: 'Limits Admin' });
  adminId = admin.id;
  adminCookie = await login(admin.email);
});

afterAll(async () => {
  await cleanupUsers([adminId]);
  await prisma.$disconnect();
});

describe('UPLOAD_LIMITS', () => {
  it('lists exactly the configurable types, DOCUMENT included and OTHER excluded', () => {
    expect(Object.keys(UPLOAD_LIMITS).sort()).toEqual(EXPECTED_TYPES);
    expect(UPLOAD_LIMITS.DOCUMENT).toBe(50 * 1024 * 1024);
  });
});

describe('GET /api/config', () => {
  it('reports the document limit and no OTHER entry', async () => {
    const res = await request(app).get('/api/config');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.uploadLimits).sort()).toEqual(EXPECTED_TYPES);
    expect(res.body.uploadLimits.DOCUMENT).toBe(UPLOAD_LIMITS.DOCUMENT);
  });
});

describe('GET /api/admin/config', () => {
  it('reports the same set as the public endpoint', async () => {
    const res = await request(app).get('/api/admin/config').set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.uploadLimits).sort()).toEqual(EXPECTED_TYPES);
    expect(res.body.uploadLimits).toEqual(UPLOAD_LIMITS);
  });
});
