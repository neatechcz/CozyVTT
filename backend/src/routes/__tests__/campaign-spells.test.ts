const mockAuth: { role: 'DM' | 'PLAYER'; userId: string } = { role: 'DM', userId: 'dm' };

jest.mock('../../middleware/compose', () => {
  const member = (req: any, _res: any, next: () => void) => {
    req.session = { userId: mockAuth.userId };
    req.campaignMembership = { role: mockAuth.role, campaignId: req.params.campaignId };
    next();
  };
  const dm = (req: any, res: any, next: () => void) => {
    member(req, res, () => {
      if (mockAuth.role !== 'DM') return res.status(403).json({ error: 'Forbidden' });
      next();
    });
  };
  return {
    authenticated: [member], adminOnly: [dm], campaignMember: [member],
    campaignDM: [dm], campaignDMOrPlayer: [member], compose: (...parts: unknown[][]) => parts.flat(),
  };
});

const saved = new Map<string, any>();
const spellDb = {
  findUnique: jest.fn(async ({ where }: any) => saved.get(`${where.campaignId_normalizedName.campaignId}:${where.campaignId_normalizedName.normalizedName}`) ?? null),
  upsert: jest.fn(async ({ where, create, update }: any) => {
    const key = `${where.campaignId_normalizedName.campaignId}:${where.campaignId_normalizedName.normalizedName}`;
    const spell = { ...(saved.get(key) ?? create), ...update };
    saved.set(key, spell);
    return spell;
  }),
};

jest.mock('../../config/database', () => ({
  prisma: { campaignSpellDescription: spellDb },
}));

jest.mock('../../websocket/utils', () => ({
  broadcastToCampaign: jest.fn(), broadcastToUser: jest.fn(),
  sendSystemMessage: jest.fn(), broadcastTokenEvent: jest.fn(),
}));

jest.mock('../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import express from 'express';
import request from 'supertest';
import campaignRoutes from '../campaigns';

const app = express();
app.use(express.json());
app.use('/api/campaigns', campaignRoutes);

beforeEach(() => {
  saved.clear();
  jest.clearAllMocks();
  mockAuth.role = 'DM';
});

it('lets a DM upload and replace a spell description, and a member read it by normalized name', async () => {
  const first = await request(app).put('/api/campaigns/alpha/spells/Magic%20Missile')
    .send({ description: '**Three** darts.' });
  expect(first.status).toBe(200);
  expect(first.body.spell).toEqual(expect.objectContaining({ name: 'Magic Missile', description: '**Three** darts.' }));

  const second = await request(app).put('/api/campaigns/alpha/spells/magic-missile')
    .send({ description: 'Updated rules.' });
  expect(second.status).toBe(200);
  expect(spellDb.upsert).toHaveBeenCalledTimes(2);
  expect(saved.size).toBe(1);

  mockAuth.role = 'PLAYER';
  const read = await request(app).get('/api/campaigns/alpha/spells/MÁGIC%20MISSILE');
  expect(read.status).toBe(200);
  expect(read.body.spell.description).toBe('Updated rules.');
});

it('keeps descriptions separate by campaign and returns 404 for an absent spell', async () => {
  await request(app).put('/api/campaigns/alpha/spells/Light').send({ description: 'Bright light.' });
  expect((await request(app).get('/api/campaigns/beta/spells/Light')).status).toBe(404);
  expect((await request(app).get('/api/campaigns/alpha/spells/Unknown')).status).toBe(404);
});

it('rejects a player write and invalid descriptions', async () => {
  mockAuth.role = 'PLAYER';
  expect((await request(app).put('/api/campaigns/alpha/spells/Light').send({ description: 'Light.' })).status).toBe(403);
  mockAuth.role = 'DM';
  expect((await request(app).put('/api/campaigns/alpha/spells/Light').send({ description: '  ' })).status).toBe(400);
  expect((await request(app).put('/api/campaigns/alpha/spells/Light').send({ description: 'x'.repeat(20001) })).status).toBe(400);
  expect(spellDb.upsert).not.toHaveBeenCalled();
});
