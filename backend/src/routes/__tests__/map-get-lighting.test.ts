/**
 * GET /api/campaigns/:campaignId/maps/:id on a map with dynamic lighting:
 * a player receives only the tokens in their line of sight — the same view
 * map.changed gives them (role filter, then filterTokensByLighting with the
 * player's userId). DMs receive every token. Without lighting nothing changes.
 *
 * No database: Prisma is mocked and the auth chain injects the session user.
 * Fixture: 10×10 squares, gridSize 100 px, a solid wall at x = 500 px.
 */

const mockAuth: { userId: string; role: 'DM' | 'PLAYER' } = { userId: 'alice', role: 'PLAYER' };

jest.mock('../../middleware/compose', () => {
  const inject = (req: any, _res: unknown, next: () => void) => {
    req.session = { userId: mockAuth.userId };
    req.campaignMembership = { role: mockAuth.role, characterIds: [], campaignId: req.params.campaignId };
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

jest.mock('../../config/database', () => ({
  prisma: {
    map: { findUnique: jest.fn() },
    campaignMembership: { findUnique: jest.fn() },
    campaign: { findUnique: jest.fn() },
  },
}));

jest.mock('../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import express from 'express';
import request from 'supertest';
import mapsRouter from '../maps';
import { prisma } from '../../config/database';

const CAMPAIGN_ID = 'campaign-1';
const MAP_ID = 'map-1';

const db = prisma as unknown as {
  map: { findUnique: jest.Mock };
  campaignMembership: { findUnique: jest.Mock };
  campaign: { findUnique: jest.Mock };
};

function token(id: string, x: number, y: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: id,
    imageUrl: '',
    position: { x, y },
    size: { width: 1, height: 1 },
    layer: 'token',
    visible: true,
    controlledBy: null,
    rotation: 0,
    conditions: [],
    metadata: {},
    ...overrides,
  };
}

const tokens = [
  token('pc-alice', 2, 5, { controlledBy: 'alice', sightRadius: 0 }),
  token('orc', 3, 6, { notes: 'DM secret' }), // west, in Alice's sight
  token('lurker', 3, 5, { visible: false }), // west, hidden
  token('goblin', 7, 5), // east, behind the wall
];

function mapWith(lightingEnabled: boolean) {
  return {
    id: MAP_ID,
    campaignId: CAMPAIGN_ID,
    name: 'Crypt',
    imageUrl: '',
    width: 10,
    height: 10,
    gridSize: 100,
    feetPerSquare: 5,
    diagonalRule: 'standard',
    baseLayerUrl: '',
    spiritLayerUrl: null,
    tokens,
    annotations: [],
    wallSegments: [{ id: 'wall-1', x1: 500, y1: 0, x2: 500, y2: 1000, type: 'wall' }],
    fogData: null,
    lightingEnabled,
    lights: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

const app = express();
app.use(express.json());
app.use('/api/campaigns/:campaignId/maps', mapsRouter);

async function getMapTokenIds(): Promise<string[]> {
  const res = await request(app).get(`/api/campaigns/${CAMPAIGN_ID}/maps/${MAP_ID}`);
  expect(res.status).toBe(200);
  return res.body.map.tokens.map((t: { id: string }) => t.id).sort();
}

beforeEach(() => {
  jest.clearAllMocks();
  db.campaignMembership.findUnique.mockImplementation(async () => ({ role: mockAuth.role }));
  db.campaign.findUnique.mockResolvedValue({ spiritLayerEnabled: false, currentMapId: MAP_ID });
});

it('gives a player only the tokens in their line of sight on a lighting map', async () => {
  mockAuth.userId = 'alice';
  mockAuth.role = 'PLAYER';
  db.map.findUnique.mockResolvedValue(mapWith(true));

  expect(await getMapTokenIds()).toEqual(['orc', 'pc-alice']);
});

it('gives a DM every token on a lighting map', async () => {
  mockAuth.userId = 'dm-user';
  mockAuth.role = 'DM';
  db.map.findUnique.mockResolvedValue(mapWith(true));

  expect(await getMapTokenIds()).toEqual(['goblin', 'lurker', 'orc', 'pc-alice']);
});

it('gives a player every role-visible token when lighting is off', async () => {
  mockAuth.userId = 'alice';
  mockAuth.role = 'PLAYER';
  db.map.findUnique.mockResolvedValue(mapWith(false));

  expect(await getMapTokenIds()).toEqual(['goblin', 'orc', 'pc-alice']);
});
