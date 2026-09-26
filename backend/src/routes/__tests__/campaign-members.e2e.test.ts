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

  let ownerAgent: request.Agent;
  let coDmAgent: request.Agent;
  let playerAgent: request.Agent;
  let adminAgent: request.Agent;

  beforeAll(async () => {
    const [owner, coDm, otherDm, player, otherPlayer, admin] = await Promise.all([
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
    ]);

    ownerId = owner.id;
    coDmId = coDm.id;
    otherDmId = otherDm.id;
    playerId = player.id;
    otherPlayerId = otherPlayer.id;
    adminId = admin.id;

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
});
