/**
 * PUT /api/campaigns/:campaignId/characters/:characterId/controller moves the
 * character's map tokens to the new controller; like every other REST token
 * write it broadcasts token.updated (per-recipient filtering happens in
 * broadcastTokenEvent) — after the transaction committed.
 * No database: Prisma, the auth chain and the broadcasters are mocked.
 */

jest.mock('../../middleware/compose', () => {
  const inject = (req: any, _res: unknown, next: () => void) => {
    req.session = { userId: 'dm-user' };
    req.campaignMembership = { role: 'DM', characterIds: [], campaignId: req.params.campaignId };
    next();
  };
  return {
    authenticated: [inject],
    adminOnly: [inject],
    campaignMember: [inject],
    campaignDM: [inject],
    campaignDMOrPlayer: [inject],
    compose: (...m: unknown[][]) => m.flat(),
  };
});

jest.mock('../../config/database', () => {
  const prisma: any = {
    character: { findUnique: jest.fn() },
    campaignMembership: { findMany: jest.fn(), update: jest.fn() },
    map: { findMany: jest.fn(), update: jest.fn() },
  };
  prisma.$transaction = jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
    const result = await fn(prisma);
    prisma.__committed = true;
    return result;
  });
  return { prisma };
});

jest.mock('../../websocket/utils', () => ({
  broadcastToCampaign: jest.fn(),
  broadcastToUser: jest.fn(),
  sendSystemMessage: jest.fn(),
  broadcastTokenEvent: jest.fn(async () => undefined),
}));

jest.mock('../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import express from 'express';
import request from 'supertest';
import campaignRoutes from '../campaigns';
import { prisma } from '../../config/database';
import { broadcastTokenEvent } from '../../websocket/utils';

const db = prisma as any;
const tokenBroadcast = broadcastTokenEvent as jest.Mock;

const app = express();
app.use(express.json());
app.use('/api/campaigns', campaignRoutes);

beforeEach(() => {
  jest.clearAllMocks();
  db.__committed = false;
  db.character.findUnique.mockResolvedValue({ campaignId: 'camp-1' });
  db.campaignMembership.findMany.mockResolvedValue([
    { id: 'm-player', userId: 'player-1', role: 'PLAYER', characterIds: [] },
  ]);
  db.map.findMany.mockResolvedValue([
    {
      id: 'map-1',
      tokens: [
        { id: 'tok-mich', characterId: 'char-1', controlledBy: 'owner', name: 'Mich' },
        { id: 'tok-other', characterId: 'char-2', controlledBy: 'owner', name: 'Tomin' },
      ],
    },
    { id: 'map-2', tokens: [{ id: 'tok-mich-2', characterId: 'char-1', controlledBy: 'player-1', name: 'Mich' }] },
  ]);
  tokenBroadcast.mockImplementation(async () => {
    expect(db.__committed).toBe(true);
  });
});

test('broadcasts token.updated for each token whose controller changed, after commit', async () => {
  const res = await request(app)
    .put('/api/campaigns/camp-1/characters/char-1/controller')
    .send({ userId: 'player-1' });

  expect(res.status).toBe(200);
  expect(db.map.update).toHaveBeenCalledTimes(1);
  expect(tokenBroadcast).toHaveBeenCalledTimes(1);
  expect(tokenBroadcast).toHaveBeenCalledWith(
    'camp-1',
    'map-1',
    expect.objectContaining({ id: 'tok-mich', controlledBy: 'owner' }),
    expect.objectContaining({ id: 'tok-mich', controlledBy: 'player-1' }),
  );
});

test('an invalid controller changes and broadcasts nothing', async () => {
  const res = await request(app)
    .put('/api/campaigns/camp-1/characters/char-1/controller')
    .send({ userId: 'not-a-player' });

  expect(res.status).toBe(400);
  expect(db.map.update).not.toHaveBeenCalled();
  expect(tokenBroadcast).not.toHaveBeenCalled();
});
