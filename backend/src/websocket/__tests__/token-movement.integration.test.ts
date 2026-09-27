import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import type { Socket as ClientSocket } from 'socket.io-client';
import { prisma } from '../../config/database';
import { loadCampaignCombatState, saveCampaignCombatState, withCampaignRowLock } from '../../services/combatStatePersistence';
import {
  createWsTestServer,
  expectNoEvent,
  waitForEvent,
  WsTestServer,
} from '../../__tests__/helpers/websocket-test-server';

jest.setTimeout(20000);

const runId = randomUUID().slice(0, 8);
const userEmail = `movement-${runId}@test.cozyvtt.local`;
const playerTokenId = randomUUID();

let server: WsTestServer;
let userId: string;
let dmId: string;
let campaignId: string;
let mapId: string;
let characterId: string;
let sessionCookie: string;
let dmCookie: string;

const combatId = randomUUID();
const turnId = randomUUID();

type MoveOutcome = { kind: 'accepted' | 'rejected'; payload: any };

function waitForMoveOutcome(client: ClientSocket, requestId: string): Promise<MoveOutcome> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`No movement result for ${requestId}`)), 3000);
    const finish = (error?: Error, outcome?: MoveOutcome) => {
      clearTimeout(timer);
      client.off('token.move.accepted', onAccepted);
      client.off('token.move.rejected', onRejected);
      if (error) reject(error);
      else resolve(outcome!);
    };
    const onAccepted = (payload: any) => {
      if (payload?.requestId === requestId) finish(undefined, { kind: 'accepted', payload });
    };
    const onRejected = (payload: any) => {
      if (payload?.requestId === requestId) finish(undefined, { kind: 'rejected', payload });
    };
    client.on('token.move.accepted', onAccepted);
    client.on('token.move.rejected', onRejected);
  });
}

function tokens() {
  return [{
    id: playerTokenId,
    characterId,
    name: 'Movement Hero',
    imageUrl: '',
    position: { x: 5, y: 5 },
    size: { width: 1, height: 1 },
    layer: 'token',
    visible: true,
    controlledBy: userId,
    rotation: 0,
    conditions: [],
    metadata: {},
    type: 'player',
    disposition: 'friendly',
  }];
}

beforeAll(async () => {
  const [dm, player] = await Promise.all([
    prisma.user.create({ data: {
      email: `movement-dm-${runId}@test.cozyvtt.local`,
      passwordHash: 'not-used-by-socket-auth',
      displayName: 'Movement DM',
    } }),
    prisma.user.create({ data: {
      email: userEmail,
      passwordHash: 'not-used-by-socket-auth',
      displayName: 'Movement Player',
    } }),
  ]);
  dmId = dm.id;
  userId = player.id;

  const campaign = await prisma.campaign.create({ data: {
    name: `Movement Test ${runId}`,
    ownerId: dmId,
    gameSystem: 'DND_5E',
    vibeSettings: {},
  } });
  campaignId = campaign.id;

  const map = await prisma.map.create({ data: {
    campaignId,
    name: 'Movement Map',
    imageUrl: '/api/assets/maps/placeholder',
    baseLayerUrl: '/api/assets/maps/placeholder',
    width: 20,
    height: 20,
    gridSize: 50,
    feetPerSquare: 5,
    diagonalRule: 'flat',
    tokens: [] as any,
    annotations: [] as any,
    wallSegments: [] as any,
    difficultTerrain: [] as any,
  } });
  mapId = map.id;

  await prisma.campaignMembership.createMany({
    data: [
      { userId: dmId, campaignId, role: 'DM', characterIds: [] },
      { userId, campaignId, role: 'PLAYER', characterIds: [] },
    ],
  });

  const character = await prisma.character.create({ data: {
    userId,
    campaignId,
    name: 'Movement Hero',
    gameSystem: 'DND_5E',
    data: {
      speed: 30,
      conditions: [],
      survival: { exhaustionLevel: 0 },
      hp: { current: 10, maximum: 10, temporary: 0 },
    },
  } });
  characterId = character.id;
  await prisma.campaignMembership.update({
    where: { userId_campaignId: { userId, campaignId } },
    data: { characterIds: [characterId] },
  });

  server = await createWsTestServer();
  [sessionCookie, dmCookie] = await Promise.all([server.loginAs(userId), server.loginAs(dmId)]);
});

afterAll(async () => {
  try {
    await server?.close();
    // The harness dispatches leave messages asynchronously when closing sockets.
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (campaignId) await prisma.campaign.deleteMany({ where: { id: campaignId } });
    if (userId && dmId) await prisma.user.deleteMany({ where: { id: { in: [userId, dmId] } } });
  } finally {
    await prisma.$disconnect();
  }
});

beforeEach(async () => {
  await prisma.campaign.update({ where: { id: campaignId }, data: { gameSystem: 'DND_5E', currentMapId: mapId } });
  await prisma.map.update({ where: { id: mapId }, data: {
    tokens: tokens() as any,
    wallSegments: [] as any,
    difficultTerrain: [] as any,
  } });
  await prisma.character.update({ where: { id: characterId }, data: {
    data: {
      speed: 30,
      conditions: [],
      survival: { exhaustionLevel: 0 },
      hp: { current: 10, maximum: 10, temporary: 0 },
    },
  } });
  await prisma.campaignMembership.update({
    where: { userId_campaignId: { userId, campaignId } },
    data: { characterIds: [characterId] },
  });
  await withCampaignRowLock(prisma, campaignId, async (tx, campaign) => {
    await saveCampaignCombatState(tx, campaign.id, {
      active: true,
      round: 1,
      currentTokenId: playerTokenId,
      combatants: [{
        tokenId: playerTokenId,
        name: 'Movement Hero',
        imageUrl: '',
        initiative: 15,
        hp: { current: 10, max: 10, temp: 0 },
        type: 'player',
        disposition: 'friendly',
      }],
      combatId,
      turnId,
      mapId,
      movement: {
        tokenId: playerTokenId,
        turnId,
        speedFeet: 30,
        spentFeet: 0,
        dashBonusFeet: 0,
        dashUsed: false,
        diagonalStepsTaken: 0,
        remainingMovementFeet: 30,
      },
    });
  });
});

it('accepts a legal combat route and commits its position and movement ledger together', async () => {
  const player = await server.connectAndAuth(sessionCookie, campaignId);
  try {
    const requestId = randomUUID();
    const accepted = waitForEvent<any>(player, 'token.move.accepted');
    const moved = waitForEvent<any>(player, 'token.moved');
    const initiative = waitForEvent<any>(player, 'initiative.state');

    player.emit('token.move.end', {
      requestId,
      tokenId: playerTokenId,
      mapId,
      x: 7,
      y: 5,
      route: [{ x: 6, y: 5 }, { x: 7, y: 5 }],
    });

    const [acceptedEvent, movedEvent, initiativeState] = await Promise.all([accepted, moved, initiative]);
    expect(acceptedEvent).toMatchObject({
      requestId,
      tokenId: playerTokenId,
      mapId,
      position: { x: 7, y: 5 },
      movement: {
        tokenId: playerTokenId,
        turnId,
        speedFeet: 30,
        movementCostFeet: 10,
        spentFeet: 10,
        remainingMovementFeet: 20,
      },
    });
    expect(movedEvent).toMatchObject({ tokenId: playerTokenId, mapId, x: 7, y: 5 });
    expect(initiativeState).toMatchObject({
      active: true,
      currentTokenId: playerTokenId,
      movement: { spentFeet: 10, remainingMovementFeet: 20 },
    });

    const [map, campaign] = await Promise.all([
      prisma.map.findUniqueOrThrow({ where: { id: mapId } }),
      prisma.campaign.findUniqueOrThrow({ where: { id: campaignId }, select: { combatState: true } }),
    ]);
    expect((map.tokens as any[])[0].position).toEqual({ x: 7, y: 5 });
    expect((campaign.combatState as any).movement).toMatchObject({ spentFeet: 10, diagonalStepsTaken: 0 });
    expect(campaign.combatState).not.toBeNull();
  } finally {
    player.disconnect();
  }
});

it('rejects a route beyond the remaining speed without changing map or ledger state', async () => {
  const [player, dm] = await Promise.all([
    server.connectAndAuth(sessionCookie, campaignId),
    server.connectAndAuth(dmCookie, campaignId),
  ]);
  try {
    const requestId = randomUUID();
    const rejected = waitForEvent<any>(player, 'token.move.rejected');
    const preview = waitForEvent<any>(dm, 'token.move.preview');

    player.emit('token.move', { tokenId: playerTokenId, mapId, x: 13, y: 5 });
    await expect(preview).resolves.toMatchObject({ preview: true, x: 13, y: 5 });
    const snapback = waitForEvent<any>(dm, 'token.move.preview');
    player.emit('token.move.end', {
      requestId,
      tokenId: playerTokenId,
      mapId,
      x: 13,
      y: 5,
      route: Array.from({ length: 8 }, (_, index) => ({ x: 6 + index, y: 5 })),
    });

    const [rejectedEvent, snapbackEvent] = await Promise.all([rejected, snapback]);
    expect(rejectedEvent).toMatchObject({
      requestId,
      tokenId: playerTokenId,
      mapId,
      position: { x: 5, y: 5 },
      movement: { spentFeet: 0, remainingMovementFeet: 30 },
      error: { code: 'INSUFFICIENT_MOVEMENT' },
    });
    expect(snapbackEvent).toMatchObject({
      requestId,
      tokenId: playerTokenId,
      mapId,
      x: 5,
      y: 5,
      position: { x: 5, y: 5 },
      preview: false,
    });
    const [map, campaign] = await Promise.all([
      prisma.map.findUniqueOrThrow({ where: { id: mapId } }),
      prisma.campaign.findUniqueOrThrow({ where: { id: campaignId }, select: { combatState: true } }),
    ]);
    expect((map.tokens as any[])[0].position).toEqual({ x: 5, y: 5 });
    expect((campaign.combatState as any).movement).toMatchObject({ spentFeet: 0 });
  } finally {
    player.disconnect();
    dm.disconnect();
  }
});

it('broadcasts drag frames as previews, not committed token moves', async () => {
  const [player, dm] = await Promise.all([
    server.connectAndAuth(sessionCookie, campaignId),
    server.connectAndAuth(dmCookie, campaignId),
  ]);
  try {
    const preview = waitForEvent<any>(dm, 'token.move.preview');
    const noCommittedMove = expectNoEvent(dm, 'token.moved', 250);
    player.emit('token.move', { tokenId: playerTokenId, mapId, x: 6, y: 5 });

    const [previewEvent] = await Promise.all([preview, noCommittedMove]);
    expect(previewEvent).toMatchObject({
      tokenId: playerTokenId,
      mapId,
      x: 6,
      y: 5,
      position: { x: 6, y: 5 },
      preview: true,
    });
  } finally {
    player.disconnect();
    dm.disconnect();
  }
});

it('serializes simultaneous moves so only one request can spend the turn allowance', async () => {
  const [firstSocket, secondSocket] = await Promise.all([
    server.connectAndAuth(sessionCookie, campaignId),
    server.connectAndAuth(sessionCookie, campaignId),
  ]);
  try {
    const firstRequestId = randomUUID();
    const secondRequestId = randomUUID();
    const firstOutcome = waitForMoveOutcome(firstSocket, firstRequestId);
    const secondOutcome = waitForMoveOutcome(secondSocket, secondRequestId);
    firstSocket.emit('token.move.end', {
      requestId: firstRequestId, tokenId: playerTokenId, mapId, x: 11, y: 5,
    });
    secondSocket.emit('token.move.end', {
      requestId: secondRequestId, tokenId: playerTokenId, mapId, x: 13, y: 5,
    });

    const [first, second] = await Promise.all([firstOutcome, secondOutcome]);
    expect(first.kind).toBe('accepted');
    expect(second.kind).toBe('rejected');
    expect(second.payload.error.code).toBe('INSUFFICIENT_MOVEMENT');
    const [map, persistedState] = await Promise.all([
      prisma.map.findUniqueOrThrow({ where: { id: mapId } }),
      loadCampaignCombatState(prisma, campaignId),
    ]);
    expect((map.tokens as any[])[0].position).toEqual({ x: 11, y: 5 });
    expect(persistedState.movement).toMatchObject({ spentFeet: 30, remainingMovementFeet: 0 });
  } finally {
    firstSocket.disconnect();
    secondSocket.disconnect();
  }
});

it('rejects a delayed move after initiative.next changes the active combatant', async () => {
  const npcTokenId = randomUUID();
  const npcToken = {
    id: npcTokenId,
    name: 'Movement Goblin',
    imageUrl: '',
    position: { x: 10, y: 10 },
    size: { width: 1, height: 1 },
    layer: 'token',
    visible: true,
    controlledBy: null,
    rotation: 0,
    conditions: [],
    metadata: {},
    type: 'npc',
    disposition: 'hostile',
    statBlock: { size: 'Small', speed: '30 ft.' },
  };
  await prisma.map.update({ where: { id: mapId }, data: {
    tokens: [...tokens(), npcToken] as any,
  } });
  await withCampaignRowLock(prisma, campaignId, async (tx, campaign) => {
    await saveCampaignCombatState(tx, campaign.id, {
      active: true,
      round: 1,
      currentTokenId: playerTokenId,
      combatants: [
        { tokenId: playerTokenId, name: 'Movement Hero', imageUrl: '', initiative: 15, hp: { current: 10, max: 10, temp: 0 }, type: 'player', disposition: 'friendly' },
        { tokenId: npcTokenId, name: 'Movement Goblin', imageUrl: '', initiative: 10, hp: null, type: 'npc', disposition: 'hostile' },
      ],
      combatId,
      turnId,
      mapId,
      movement: {
        tokenId: playerTokenId,
        turnId,
        speedFeet: 30,
        spentFeet: 0,
        dashBonusFeet: 0,
        dashUsed: false,
        diagonalStepsTaken: 0,
        remainingMovementFeet: 30,
      },
    });
  });

  const [player, dm] = await Promise.all([
    server.connectAndAuth(sessionCookie, campaignId),
    server.connectAndAuth(dmCookie, campaignId),
  ]);
  try {
    const nextStatePromise = waitForEvent<any>(player, 'initiative.state');
    dm.emit('initiative.next');
    const nextState = await nextStatePromise;
    expect(nextState).toMatchObject({ currentTokenId: npcTokenId, movement: { tokenId: npcTokenId, spentFeet: 0 } });
    expect(nextState.turnId).not.toBe(turnId);

    const requestId = randomUUID();
    const rejected = waitForEvent<any>(player, 'token.move.rejected');
    player.emit('token.move.end', {
      requestId, tokenId: playerTokenId, mapId, x: 6, y: 5,
      route: [{ x: 6, y: 5 }],
    });
    expect(await rejected).toMatchObject({
      requestId,
      tokenId: playerTokenId,
      position: { x: 5, y: 5 },
      movement: null,
      error: { code: 'TURN_MISMATCH' },
    });
    const [map, state] = await Promise.all([
      prisma.map.findUniqueOrThrow({ where: { id: mapId } }),
      loadCampaignCombatState(prisma, campaignId),
    ]);
    expect((map.tokens as any[]).find((token) => token.id === playerTokenId).position).toEqual({ x: 5, y: 5 });
    expect(state.currentTokenId).toBe(npcTokenId);
    expect(state.movement).toMatchObject({ tokenId: npcTokenId, turnId: nextState.turnId, spentFeet: 0 });
  } finally {
    player.disconnect();
    dm.disconnect();
  }
});

it('records an explicit DM movement override as a transactional audit message', async () => {
  const dm = await server.connectAndAuth(dmCookie, campaignId);
  try {
    const requestId = randomUUID();
    const accepted = waitForEvent<any>(dm, 'token.move.accepted');
    const initiative = waitForEvent<any>(dm, 'initiative.state');
    dm.emit('token.move.end', {
      requestId,
      tokenId: playerTokenId,
      mapId,
      x: 13,
      y: 5,
      route: Array.from({ length: 8 }, (_, index) => ({ x: 6 + index, y: 5 })),
      override: { reason: 'The collapsing floor separates the party.' },
    });
    const [acceptedEvent] = await Promise.all([accepted, initiative]);
    expect(acceptedEvent).toMatchObject({
      requestId,
      movement: { movementCostFeet: 40, spentFeet: 40, remainingMovementFeet: 0, override: true },
    });
    const audit = await prisma.message.findFirstOrThrow({
      where: { campaignId, userId: dmId, type: 'SYSTEM' },
      orderBy: { createdAt: 'desc' },
    });
    expect(audit.metadata).toMatchObject({
      kind: 'combat_movement_override',
      reason: 'The collapsing floor separates the party.',
      combatId,
      turnId,
      tokenId: playerTokenId,
      from: { x: 5, y: 5 },
      to: { x: 13, y: 5 },
      ordinaryCostFeet: 40,
      requestId,
    });
  } finally {
    dm.disconnect();
  }
});

it('rejects a wall crossing and a move whose current character speed is unresolved', async () => {
  const player = await server.connectAndAuth(sessionCookie, campaignId);
  try {
    await prisma.map.update({ where: { id: mapId }, data: {
      wallSegments: [{ id: randomUUID(), x1: 275, y1: 725, x2: 325, y2: 725, type: 'wall' }] as any,
    } });
    const wallRequestId = randomUUID();
    const wallRejected = waitForEvent<any>(player, 'token.move.rejected');
    player.emit('token.move.end', {
      requestId: wallRequestId, tokenId: playerTokenId, mapId,
      x: 6, y: 5, route: [{ x: 6, y: 5 }],
    });
    const wallEvent = await wallRejected;
    expect(wallEvent.error.code).toBe('WALL_BLOCKED');

    await prisma.map.update({ where: { id: mapId }, data: { wallSegments: [] as any } });
    await prisma.character.update({ where: { id: characterId }, data: {
      data: { speed: null, conditions: [], survival: { exhaustionLevel: 0 } },
    } });
    const speedRequestId = randomUUID();
    const speedRejected = waitForEvent<any>(player, 'token.move.rejected');
    player.emit('token.move.end', {
      requestId: speedRequestId, tokenId: playerTokenId, mapId,
      x: 6, y: 5, route: [{ x: 6, y: 5 }],
    });
    const speedEvent = await speedRejected;
    expect(speedEvent.error.code).toBe('UNRESOLVED_SPEED');
    const [map, campaign] = await Promise.all([
      prisma.map.findUniqueOrThrow({ where: { id: mapId } }),
      prisma.campaign.findUniqueOrThrow({ where: { id: campaignId }, select: { combatState: true } }),
    ]);
    expect((map.tokens as any[])[0].position).toEqual({ x: 5, y: 5 });
    expect((campaign.combatState as any).movement).toMatchObject({ spentFeet: 0 });
  } finally {
    player.disconnect();
  }
});

it('keeps out-of-combat placement available and checks the full token footprint', async () => {
  await prisma.campaign.update({ where: { id: campaignId }, data: { combatState: Prisma.DbNull } });
  const player = await server.connectAndAuth(sessionCookie, campaignId);
  try {
    const legacyAccepted = waitForEvent<any>(player, 'token.move.accepted');
    player.emit('token.move.end', { tokenId: playerTokenId, mapId, x: 8, y: 8 });
    const accepted = await legacyAccepted;
    expect(accepted).toMatchObject({
      tokenId: playerTokenId,
      mapId,
      position: { x: 8, y: 8 },
      movement: null,
    });
    expect(typeof accepted.requestId).toBe('string');

    const fractionalDestination = waitForEvent<any>(player, 'token.move.rejected');
    player.emit('token.move.end', {
      requestId: randomUUID(), tokenId: playerTokenId, mapId, x: 8.5, y: 8,
    });
    expect(await fractionalDestination).toMatchObject({
      tokenId: playerTokenId,
      mapId,
      position: null,
      error: { code: 'INVALID_DESTINATION' },
    });

    await prisma.map.update({ where: { id: mapId }, data: {
      tokens: [{ ...tokens()[0], position: { x: 18, y: 5 }, size: { width: 2, height: 2 } }] as any,
    } });
    const outOfBounds = waitForEvent<any>(player, 'token.move.rejected');
    player.emit('token.move.end', { tokenId: playerTokenId, mapId, x: 19, y: 5 });
    expect(await outOfBounds).toMatchObject({
      tokenId: playerTokenId,
      mapId,
      position: { x: 18, y: 5 },
      error: { code: 'OUT_OF_BOUNDS' },
    });
    const map = await prisma.map.findUniqueOrThrow({ where: { id: mapId } });
    expect((map.tokens as any[])[0].position).toEqual({ x: 18, y: 5 });
  } finally {
    player.disconnect();
  }
});


it('starts and moves a linked D&D character in a legacy campaign with no ruleset', async () => {
  await prisma.campaign.update({ where: { id: campaignId }, data: { gameSystem: null } });
  await withCampaignRowLock(prisma, campaignId, async (tx, campaign) => {
    const state = await loadCampaignCombatState(prisma, campaignId);
    await saveCampaignCombatState(tx, campaign.id, { ...state, active: false, currentTokenId: null, movement: null });
  });
  const dm = await server.connectAndAuth(dmCookie, campaignId);
  try {
    const started = waitForEvent<any>(dm, 'initiative.state');
    dm.emit('initiative.start');
    expect((await started).movement).toMatchObject({ tokenId: playerTokenId, speedFeet: 30 });
    const requestId = randomUUID();
    const result = waitForMoveOutcome(dm, requestId);
    dm.emit('token.move.end', { requestId, tokenId: playerTokenId, mapId, x: 6, y: 5, route: [{ x: 6, y: 5 }] });
    expect(await result).toMatchObject({ kind: 'accepted', payload: { movement: { spentFeet: 5, remainingMovementFeet: 25 } } });
  } finally { dm.disconnect(); }
});

it('wraps to the first combatant when removing the active last combatant', async () => {
  const second = randomUUID();
  const last = randomUUID();
  await prisma.map.update({ where: { id: mapId }, data: { tokens: [
    ...tokens(),
    ...[second, last].map((id) => ({ ...tokens()[0], id, characterId: null, type: 'npc', statBlock: { speed: '30 ft.' } })),
  ] as any } });
  const state = await loadCampaignCombatState(prisma, campaignId);
  await withCampaignRowLock(prisma, campaignId, async (tx, campaign) => {
    await saveCampaignCombatState(tx, campaign.id, {
      ...state, currentTokenId: last,
      combatants: [playerTokenId, second, last].map((id, index) => ({ ...state.combatants[0], tokenId: id, initiative: 20 - index })),
    });
  });
  const dm = await server.connectAndAuth(dmCookie, campaignId);
  try {
    const removed = waitForEvent<any>(dm, 'initiative.state');
    dm.emit('initiative.remove', { tokenId: last });
    expect(await removed).toMatchObject({ round: 2, currentTokenId: playerTokenId, movement: { tokenId: playerTokenId, spentFeet: 0, speedFeet: 30 } });
  } finally { dm.disconnect(); }
});
