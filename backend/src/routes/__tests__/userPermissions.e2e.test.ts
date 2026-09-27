/**
 * Platform permission grant/revoke — End-to-End Tests
 *
 * Covers `PUT /api/users/:id` for the two boolean platform permissions:
 * `globalAssetManager` and the new `templateEditor`.
 *
 * Worth noting: `globalAssetManager` had no behavioural test at all before
 * this file. Adding its coverage alongside the new permission costs one extra
 * case per assertion and closes a real gap — these flags decide who can write
 * instance-wide content, so "only an admin may grant them" ought to be pinned.
 *
 * Requires PostgreSQL at DATABASE_URL.
 */

import request from 'supertest';
import { createTestApp } from '../../__tests__/helpers/test-app';
import { prisma, createTestUser, cleanupUsers, TEST_PASSWORD } from '../../__tests__/helpers/db';

const app = createTestApp();

/** The two boolean permissions, so each assertion runs against both. */
const PERMISSIONS = ['globalAssetManager', 'templateEditor'] as const;

describe('Platform permission grants', () => {
  let adminId: string;
  let userId: string;
  let otherId: string;

  let adminAgent: ReturnType<typeof request.agent>;
  let userAgent: ReturnType<typeof request.agent>;

  async function login(email: string) {
    const agent = request.agent(app);
    const res = await agent.post('/api/auth/login').send({ email, password: TEST_PASSWORD });
    expect(res.status).toBe(200);
    return agent;
  }

  beforeAll(async () => {
    const stamp = Date.now();
    const admin = await createTestUser({
      email: `perm_admin_${stamp}@test.invalid`,
      isApproved: true,
      role: 'ADMIN',
    });
    const user = await createTestUser({ email: `perm_user_${stamp}@test.invalid`, isApproved: true });
    const other = await createTestUser({ email: `perm_other_${stamp}@test.invalid`, isApproved: true });

    adminId = admin.id;
    userId = user.id;
    otherId = other.id;

    adminAgent = await login(`perm_admin_${stamp}@test.invalid`);
    userAgent = await login(`perm_user_${stamp}@test.invalid`);
  });

  afterEach(async () => {
    await prisma.user.updateMany({
      where: { id: { in: [userId, otherId] } },
      data: { globalAssetManager: false, templateEditor: false },
    });
  });

  afterAll(async () => {
    await cleanupUsers([adminId, userId, otherId]);
    await prisma.$disconnect();
  });

  describe.each(PERMISSIONS)('%s', (permission) => {
    it('starts off for a new user', async () => {
      const row = await prisma.user.findUnique({ where: { id: userId } });
      expect(row?.[permission]).toBe(false);
    });

    it('an admin can grant it', async () => {
      const res = await adminAgent.put(`/api/users/${userId}`).send({ [permission]: true });

      expect(res.status).toBe(200);
      expect(res.body.user[permission]).toBe(true);

      const row = await prisma.user.findUnique({ where: { id: userId } });
      expect(row?.[permission]).toBe(true);
    });

    it('an admin can revoke it', async () => {
      await adminAgent.put(`/api/users/${userId}`).send({ [permission]: true });
      const res = await adminAgent.put(`/api/users/${userId}`).send({ [permission]: false });

      expect(res.status).toBe(200);
      expect(res.body.user[permission]).toBe(false);
    });

    // The important one: a user must not be able to promote themselves, even
    // though PUT /api/users/:id otherwise lets you edit your own profile.
    it('a non-admin cannot grant it to themselves', async () => {
      const res = await userAgent.put(`/api/users/${userId}`).send({ [permission]: true });

      expect(res.status).toBe(403);

      const row = await prisma.user.findUnique({ where: { id: userId } });
      expect(row?.[permission]).toBe(false);
    });

    it('a non-admin cannot grant it to someone else', async () => {
      const res = await userAgent.put(`/api/users/${otherId}`).send({ [permission]: true });

      expect([403]).toContain(res.status);

      const row = await prisma.user.findUnique({ where: { id: otherId } });
      expect(row?.[permission]).toBe(false);
    });

    it('rejects a non-boolean value', async () => {
      const res = await adminAgent.put(`/api/users/${userId}`).send({ [permission]: 'yes' });
      expect(res.status).toBe(400);
    });

    it('is never returned with the password hash', async () => {
      const res = await adminAgent.put(`/api/users/${userId}`).send({ [permission]: true });

      expect(res.body.user.passwordHash).toBeUndefined();
      expect(res.body.user.mfaSecret).toBeUndefined();
      expect(res.body.user[permission]).toBe(true);
    });
  });

  it('grants the two permissions independently', async () => {
    await adminAgent.put(`/api/users/${userId}`).send({ templateEditor: true });

    const row = await prisma.user.findUnique({ where: { id: userId } });
    expect(row?.templateEditor).toBe(true);
    expect(row?.globalAssetManager).toBe(false);
  });
});
