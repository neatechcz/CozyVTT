jest.mock('express-rate-limit', () => {
  return () => (_req: unknown, _res: unknown, next: () => void) => next();
});

import request from 'supertest';
import { CampaignRole, PlatformRole } from '@prisma/client';
import { createTestApp } from '../../__tests__/helpers/test-app';
import {
  TEST_PASSWORD,
  cleanupCampaigns,
  cleanupUsers,
  createTestCampaign,
  createTestUser,
  prisma,
  testEmail,
} from '../../__tests__/helpers/db';

const app = createTestApp();

async function loginAs(email: string) {
  const agent = request.agent(app);
  const response = await agent.post('/api/auth/login').send({
    email,
    password: TEST_PASSWORD,
  });
  expect(response.status).toBe(200);
  return agent;
}

describe('campaign member management', () => {
  let campaignId: string;
  let ownerId: string;
  let coDmId: string;
  let otherDmId: string;
  let playerId: string;
  let otherPlayerId: string;
  let adminId: string;
  let protectedDmId: string;

  let ownerAgent: request.Agent;
  let coDmAgent: request.Agent;
  let playerAgent: request.Agent;
  let adminAgent: request.Agent;

  beforeAll(async () => {
    const [owner, coDm, otherDm, player, otherPlayer, admin, protectedDm] = await Promise.all([
      createTestUser({
        email: testEmail('campaign-owner'),
        displayName: 'Campaign Owner',
      }),
      createTestUser({
        email: testEmail('campaign-co-dm'),
        displayName: 'Campaign Co-DM',
      }),
      createTestUser({
        email: testEmail('campaign-other-dm'),
        displayName: 'Campaign Other DM',
      }),
      createTestUser({
        email: testEmail('campaign-player'),
        displayName: 'Campaign Player',
      }),
      createTestUser({
        email: testEmail('campaign-other-player'),
        displayName: 'Campaign Other Player',
      }),
      createTestUser({
        email: testEmail('campaign-platform-admin'),
        displayName: 'Platform Admin',
        role: PlatformRole.ADMIN,
      }),
      createTestUser({ email: 'codex-mcp@neatech.cz', displayName: 'MCP Service' }),
    ]);

    ownerId = owner.id;
    coDmId = coDm.id;
    otherDmId = otherDm.id;
    playerId = player.id;
    otherPlayerId = otherPlayer.id;
    adminId = admin.id;
    protectedDmId = protectedDm.id;

    const campaign = await createTestCampaign(ownerId, {
      name: 'Multiple DM Policy Test',
    });
    campaignId = campaign.id;

    await prisma.campaignMembership.createMany({
      data: [
        { campaignId, userId: ownerId, role: CampaignRole.DM, characterIds: [] },
        { campaignId, userId: coDmId, role: CampaignRole.DM, characterIds: [] },
        { campaignId, userId: otherDmId, role: CampaignRole.DM, characterIds: [] },
        { campaignId, userId: playerId, role: CampaignRole.PLAYER, characterIds: [] },
        { campaignId, userId: otherPlayerId, role: CampaignRole.PLAYER, characterIds: [] },
        { campaignId, userId: protectedDmId, role: CampaignRole.DM, characterIds: [] },
      ],
    });

    [ownerAgent, coDmAgent, playerAgent, adminAgent] = await Promise.all([
      loginAs(owner.email),
      loginAs(coDm.email),
      loginAs(player.email),
      loginAs(admin.email),
    ]);
  });

  beforeEach(async () => {
    await Promise.all([
      prisma.campaignMembership.upsert({
        where: { userId_campaignId: { userId: ownerId, campaignId } },
        create: { campaignId, userId: ownerId, role: CampaignRole.DM, characterIds: [] },
        update: { role: CampaignRole.DM },
      }),
      prisma.campaignMembership.upsert({
        where: { userId_campaignId: { userId: coDmId, campaignId } },
        create: { campaignId, userId: coDmId, role: CampaignRole.DM, characterIds: [] },
        update: { role: CampaignRole.DM },
      }),
      prisma.campaignMembership.upsert({
        where: { userId_campaignId: { userId: otherDmId, campaignId } },
        create: { campaignId, userId: otherDmId, role: CampaignRole.DM, characterIds: [] },
        update: { role: CampaignRole.DM },
      }),
      prisma.campaignMembership.upsert({
        where: { userId_campaignId: { userId: playerId, campaignId } },
        create: { campaignId, userId: playerId, role: CampaignRole.PLAYER, characterIds: [] },
        update: { role: CampaignRole.PLAYER },
      }),
      prisma.campaignMembership.upsert({
        where: { userId_campaignId: { userId: otherPlayerId, campaignId } },
        create: { campaignId, userId: otherPlayerId, role: CampaignRole.PLAYER, characterIds: [] },
        update: { role: CampaignRole.PLAYER },
      }),
      prisma.campaignMembership.upsert({
        where: { userId_campaignId: { userId: protectedDmId, campaignId } },
        create: { campaignId, userId: protectedDmId, role: CampaignRole.DM, characterIds: [] },
        update: { role: CampaignRole.DM },
      }),
    ]);
  });

  afterAll(async () => {
    await cleanupCampaigns([campaignId]);
    await cleanupUsers([
      ownerId,
      coDmId,
      otherDmId,
      playerId,
      otherPlayerId,
      adminId,
      protectedDmId,
    ]);
  });

  it('lets the owner promote a player to DM without exposing email', async () => {
    const response = await ownerAgent
      .put(`/api/campaigns/${campaignId}/members/${playerId}/role`)
      .send({ role: CampaignRole.DM });

    expect(response.status).toBe(200);
    expect(response.body.membership).toMatchObject({
      campaignId,
      userId: playerId,
      role: CampaignRole.DM,
    });
    expect(response.body.membership.user.email).toBeUndefined();
  });

  it('does not let a co-DM demote the owner', async () => {
    const response = await coDmAgent
      .put(`/api/campaigns/${campaignId}/members/${ownerId}/role`)
      .send({ role: CampaignRole.PLAYER });

    expect(response.status).toBe(403);
  });

  it('does not let a co-DM change another DM role', async () => {
    const response = await coDmAgent
      .put(`/api/campaigns/${campaignId}/members/${otherDmId}/role`)
      .send({ role: CampaignRole.PLAYER });

    expect(response.status).toBe(403);
  });

  it('lets the owner demote a co-DM', async () => {
    const response = await ownerAgent
      .put(`/api/campaigns/${campaignId}/members/${coDmId}/role`)
      .send({ role: CampaignRole.PLAYER });

    expect(response.status).toBe(200);
    expect(response.body.membership.role).toBe(CampaignRole.PLAYER);
  });

  it('refuses to demote the protected MCP DM even for the owner', async () => {
    const response = await ownerAgent
      .put(`/api/campaigns/${campaignId}/members/${protectedDmId}/role`)
      .send({ role: CampaignRole.PLAYER });
    expect(response.status).toBe(409);
    expect((await prisma.campaignMembership.findUnique({ where: {
      userId_campaignId: { userId: protectedDmId, campaignId },
    } }))?.role).toBe(CampaignRole.DM);
  });

  it('marks a protected DM without exposing the email in campaign details', async () => {
    const response = await ownerAgent.get(`/api/campaigns/${campaignId}`);
    expect(response.status).toBe(200);
    const member = response.body.campaign.memberships.find((entry: { userId: string }) => entry.userId === protectedDmId);
    expect(member.isProtectedDm).toBe(true);
    expect(member.user.email).toBeUndefined();
  });

  it('lets a platform admin recover DM membership without joining the campaign', async () => {
    const response = await adminAgent
      .put(`/api/campaigns/${campaignId}/members/${playerId}/role`)
      .send({ role: CampaignRole.DM });

    expect(response.status).toBe(200);
    expect(response.body.membership.role).toBe(CampaignRole.DM);
  });

  it('lets an ordinary DM change a player to spectator', async () => {
    const response = await coDmAgent
      .put(`/api/campaigns/${campaignId}/members/${playerId}/role`)
      .send({ role: CampaignRole.SPECTATOR });

    expect(response.status).toBe(200);
    expect(response.body.membership.role).toBe(CampaignRole.SPECTATOR);
  });

  it('does not let a player change another member role', async () => {
    const response = await playerAgent
      .put(`/api/campaigns/${campaignId}/members/${otherPlayerId}/role`)
      .send({ role: CampaignRole.SPECTATOR });

    expect(response.status).toBe(403);
  });

  it('does not let the owner membership be removed', async () => {
    const response = await adminAgent.delete(
      `/api/campaigns/${campaignId}/members/${ownerId}`,
    );

    expect(response.status).toBe(400);
  });

  it('does not let a co-DM remove another DM', async () => {
    const response = await coDmAgent.delete(
      `/api/campaigns/${campaignId}/members/${otherDmId}`,
    );

    expect(response.status).toBe(403);
  });

  it('lets the owner remove a co-DM', async () => {
    const response = await ownerAgent.delete(
      `/api/campaigns/${campaignId}/members/${coDmId}`,
    );

    expect(response.status).toBe(200);
  });

  it('lets a platform admin remove a co-DM without joining the campaign', async () => {
    const response = await adminAgent.delete(
      `/api/campaigns/${campaignId}/members/${coDmId}`,
    );

    expect(response.status).toBe(200);
  });

  it('refuses to remove the protected MCP DM even for a platform admin', async () => {
    const response = await adminAgent.delete(`/api/campaigns/${campaignId}/members/${protectedDmId}`);
    expect(response.status).toBe(409);
    expect(await prisma.campaignMembership.findUnique({ where: {
      userId_campaignId: { userId: protectedDmId, campaignId },
    } })).not.toBeNull();
  });
});
