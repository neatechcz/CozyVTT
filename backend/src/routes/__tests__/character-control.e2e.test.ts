jest.mock('express-rate-limit', () => () => (_req: unknown, _res: unknown, next: () => void) => next());

import request from 'supertest';
import { CampaignRole } from '@prisma/client';
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

async function login(email: string) {
  const agent = request.agent(app);
  expect((await agent.post('/api/auth/login').send({ email, password: TEST_PASSWORD })).status).toBe(200);
  return agent;
}

describe('delegated character control', () => {
  let campaignId: string;
  let characterId: string;
  let otherCharacterId: string;
  let mapId: string;
  let ownerId: string;
  let dmId: string;
  let playerId: string;
  let otherPlayerId: string;
  let dmAgent: request.Agent;
  let playerAgent: request.Agent;
  let otherPlayerAgent: request.Agent;

  beforeAll(async () => {
    const [owner, dm, player, otherPlayer] = await Promise.all([
      createTestUser({ email: testEmail('char-owner') }),
      createTestUser({ email: testEmail('char-dm') }),
      createTestUser({ email: testEmail('char-player') }),
      createTestUser({ email: testEmail('char-other-player') }),
    ]);
    ownerId = owner.id;
    dmId = dm.id;
    playerId = player.id;
    otherPlayerId = otherPlayer.id;
    const campaign = await createTestCampaign(ownerId);
    campaignId = campaign.id;
    const character = await prisma.character.create({
      data: { userId: ownerId, campaignId, name: 'Mich', data: { notes: 'original' } },
    });
    characterId = character.id;
    const otherCharacter = await prisma.character.create({
      data: { userId: ownerId, campaignId, name: 'Tomin', data: { notes: 'private to other player' } },
    });
    otherCharacterId = otherCharacter.id;
    const map = await prisma.map.create({ data: {
      campaignId,
      name: 'Test Map',
      imageUrl: '/api/assets/maps/test',
      baseLayerUrl: '/api/assets/maps/test',
      width: 20,
      height: 20,
      gridSize: 50,
      tokens: [{ id: 'mich-token', characterId, controlledBy: ownerId, name: 'Mich', position: { x: 1, y: 1 } }],
      annotations: [],
    } });
    mapId = map.id;
    await prisma.campaignMembership.createMany({ data: [
      { userId: ownerId, campaignId, role: CampaignRole.DM, characterIds: [characterId, otherCharacterId] },
      { userId: dmId, campaignId, role: CampaignRole.DM, characterIds: [characterId, otherCharacterId] },
      { userId: playerId, campaignId, role: CampaignRole.PLAYER, characterIds: [] },
      { userId: otherPlayerId, campaignId, role: CampaignRole.PLAYER, characterIds: [] },
    ] });
    [dmAgent, playerAgent, otherPlayerAgent] = await Promise.all([
      login(dm.email), login(player.email), login(otherPlayer.email),
    ]);
  });

  afterAll(async () => {
    await cleanupCampaigns([campaignId]);
    await cleanupUsers([ownerId, dmId, playerId, otherPlayerId]);
  });

  beforeEach(async () => {
    await prisma.campaignMembership.updateMany({
      where: { campaignId, role: CampaignRole.PLAYER },
      data: { characterIds: [] },
    });
    await prisma.character.update({ where: { id: characterId }, data: { data: { notes: 'original' } } });
    await prisma.map.update({ where: { id: mapId }, data: {
      tokens: [{ id: 'mich-token', characterId, controlledBy: ownerId, name: 'Mich', position: { x: 1, y: 1 } }],
    } });
  });

  it('lets a DM delegate an MCP-owned character to a player without changing ownership or DM access', async () => {
    const response = await dmAgent
      .put(`/api/campaigns/${campaignId}/characters/${characterId}/controller`)
      .send({ userId: playerId });
    expect(response.status).toBe(200);

    const [character, memberships] = await Promise.all([
      prisma.character.findUniqueOrThrow({ where: { id: characterId } }),
      prisma.campaignMembership.findMany({ where: { campaignId } }),
    ]);
    expect(character.userId).toBe(ownerId);
    expect(memberships.find((m) => m.userId === playerId)?.characterIds).toContain(characterId);
    expect(memberships.find((m) => m.userId === dmId)?.characterIds).toContain(characterId);
    expect(memberships.find((m) => m.userId === ownerId)?.characterIds).toContain(characterId);
    const map = await prisma.map.findUniqueOrThrow({ where: { id: mapId } });
    expect((map.tokens as Array<{ controlledBy: string }>)[0].controlledBy).toBe(playerId);
    const rosterResponse = await playerAgent.get(`/api/campaigns/${campaignId}/characters`);
    const roster = rosterResponse.body.roster as Array<{ userId: string; characters: Array<{ id: string }> }>;
    expect(roster.find((member) => member.userId === playerId)?.characters.map((char) => char.id)).toContain(characterId);
    expect(roster.filter((member) => member.userId === ownerId || member.userId === dmId)
      .every((member) => !member.characters.some((char) => char.id === characterId))).toBe(true);
  });

  it('lets only the assigned player edit the existing character sheet', async () => {
    await prisma.campaignMembership.update({
      where: { userId_campaignId: { userId: playerId, campaignId } },
      data: { characterIds: [characterId] },
    });
    const assigned = await playerAgent.put(`/api/characters/${characterId}`).send({ data: { notes: 'player edit' } });
    const other = await otherPlayerAgent.put(`/api/characters/${characterId}`).send({ data: { notes: 'wrong edit' } });
    expect(assigned.status).toBe(200);
    expect(other.status).toBe(403);
  });

  it('shows each player only their assigned character across lists, campaign, roster, and sheet URLs', async () => {
    await prisma.campaignMembership.update({
      where: { userId_campaignId: { userId: playerId, campaignId } },
      data: { characterIds: [characterId] },
    });
    await prisma.campaignMembership.update({
      where: { userId_campaignId: { userId: otherPlayerId, campaignId } },
      data: { characterIds: [otherCharacterId] },
    });

    const [myList, otherList, mySheet, forbiddenSheet, otherSheet, otherForbiddenSheet, dmSheet, myCampaign, myCampaigns, myRoster, dmRoster] = await Promise.all([
      playerAgent.get('/api/characters'),
      otherPlayerAgent.get('/api/characters'),
      playerAgent.get(`/api/characters/${characterId}`),
      playerAgent.get(`/api/characters/${otherCharacterId}`),
      otherPlayerAgent.get(`/api/characters/${otherCharacterId}`),
      otherPlayerAgent.get(`/api/characters/${characterId}`),
      dmAgent.get(`/api/characters/${otherCharacterId}`),
      playerAgent.get(`/api/campaigns/${campaignId}`),
      playerAgent.get('/api/campaigns'),
      playerAgent.get(`/api/campaigns/${campaignId}/characters`),
      dmAgent.get(`/api/campaigns/${campaignId}/characters`),
    ]);

    expect(myList.body.characters.map((char: { id: string }) => char.id)).toEqual([characterId]);
    expect(otherList.body.characters.map((char: { id: string }) => char.id)).toEqual([otherCharacterId]);
    expect(mySheet.status).toBe(200);
    expect(forbiddenSheet.status).toBe(403);
    expect(otherSheet.status).toBe(200);
    expect(otherForbiddenSheet.status).toBe(403);
    expect(dmSheet.status).toBe(200);
    expect(myCampaign.body.campaign.characters.map((char: { id: string }) => char.id)).toEqual([characterId]);
    expect(myCampaign.body.campaign.memberships.find((m: { userId: string }) => m.userId === playerId).characterIds).toEqual([characterId]);
    expect(myCampaign.body.campaign.memberships.filter((m: { userId: string }) => m.userId !== playerId)
      .every((m: { characterIds: string[] }) => m.characterIds.length === 0)).toBe(true);
    expect(myCampaigns.body.campaigns[0].memberships.filter((m: { userId: string }) => m.userId !== playerId)
      .every((m: { characterIds: string[] }) => m.characterIds.length === 0)).toBe(true);
    expect(myRoster.body.roster.flatMap((m: { characters: Array<{ id: string }> }) => m.characters.map((c) => c.id))).toEqual([characterId]);
    expect(dmRoster.body.roster.flatMap((m: { characters: Array<{ id: string }> }) => m.characters.map((c) => c.id))).toEqual(expect.arrayContaining([characterId, otherCharacterId]));
  });

  it('rejects assignment by a player', async () => {
    const response = await playerAgent
      .put(`/api/campaigns/${campaignId}/characters/${characterId}/controller`)
      .send({ userId: otherPlayerId });
    expect(response.status).toBe(403);
  });

  it('moves control between players and can clear it', async () => {
    await dmAgent.put(`/api/campaigns/${campaignId}/characters/${characterId}/controller`).send({ userId: playerId });
    const moved = await dmAgent.put(`/api/campaigns/${campaignId}/characters/${characterId}/controller`).send({ userId: otherPlayerId });
    expect(moved.status).toBe(200);
    let memberships = await prisma.campaignMembership.findMany({ where: { campaignId } });
    expect(memberships.find((m) => m.userId === playerId)?.characterIds).not.toContain(characterId);
    expect(memberships.find((m) => m.userId === otherPlayerId)?.characterIds).toContain(characterId);

    const cleared = await dmAgent.put(`/api/campaigns/${campaignId}/characters/${characterId}/controller`).send({ userId: null });
    expect(cleared.status).toBe(200);
    memberships = await prisma.campaignMembership.findMany({ where: { campaignId } });
    expect(memberships.filter((m) => m.role === CampaignRole.PLAYER).every((m) => !m.characterIds.includes(characterId))).toBe(true);
    expect(memberships.filter((m) => m.role === CampaignRole.DM).every((m) => m.characterIds.includes(characterId))).toBe(true);
    const map = await prisma.map.findUniqueOrThrow({ where: { id: mapId } });
    expect((map.tokens as Array<{ controlledBy: string | null }>)[0].controlledBy).toBeNull();
  });

  it('rejects non-player and unknown controllers', async () => {
    const dmTarget = await dmAgent.put(`/api/campaigns/${campaignId}/characters/${characterId}/controller`).send({ userId: ownerId });
    const unknownTarget = await dmAgent.put(`/api/campaigns/${campaignId}/characters/${characterId}/controller`).send({ userId: 'missing-user' });
    expect(dmTarget.status).toBe(400);
    expect(unknownTarget.status).toBe(400);
  });
});
