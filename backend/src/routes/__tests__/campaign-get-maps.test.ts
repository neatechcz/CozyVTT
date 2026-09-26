/**
 * GET /api/campaigns/:campaignId embeds map metadata. The spirit layer image
 * URL is DM-only there — as in the map GET, which hides it from players who
 * cannot see the spirit layer; players read the spirit layer through the map
 * GET / map.changed only.
 *
 * No database: Prisma is mocked and the auth chain injects the session user.
 */

const mockAuth: { userId: string; role: 'DM' | 'PLAYER' | 'SPECTATOR' } = { userId: 'dm-user', role: 'DM' };

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
  prisma: { campaign: { findUnique: jest.fn() } },
}));

jest.mock('../../websocket/utils', () => ({
  broadcastToCampaign: jest.fn(),
  broadcastToUser: jest.fn(),
  sendSystemMessage: jest.fn(),
  broadcastTokenEvent: jest.fn(),
}));

jest.mock('../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import express from 'express';
import request from 'supertest';
import campaignRoutes from '../campaigns';
import { prisma } from '../../config/database';

const CAMPAIGN_ID = 'campaign-1';
const db = prisma as unknown as { campaign: { findUnique: jest.Mock } };

const app = express();
app.use(express.json());
app.use('/api/campaigns', campaignRoutes);

function map(id: string, spiritLayerUrl: string | null) {
  return {
    id,
    campaignId: CAMPAIGN_ID,
    name: id,
    imageUrl: `/api/assets/maps/${id}.png`,
    width: 10,
    height: 10,
    gridSize: 100,
    feetPerSquare: 5,
    diagonalRule: 'standard',
    baseLayerUrl: '',
    spiritLayerUrl,
    lightingEnabled: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  db.campaign.findUnique.mockResolvedValue({
    id: CAMPAIGN_ID,
    name: 'Klenba',
    owner: { id: 'dm-user', displayName: 'DM', avatarUrl: null },
    memberships: [],
    maps: [map('crypt', '/api/assets/maps/secret-spirit.png'), map('road', null)],
    characters: [],
    sessions: [],
  });
});

it.each(['PLAYER', 'SPECTATOR'] as const)('hides every map\'s spirit layer URL from a %s', async (role) => {
  mockAuth.userId = 'alice';
  mockAuth.role = role;

  const res = await request(app).get(`/api/campaigns/${CAMPAIGN_ID}`);

  expect(res.status).toBe(200);
  expect(res.body.campaign.maps.map((m: { spiritLayerUrl: unknown }) => m.spiritLayerUrl)).toEqual([null, null]);
  expect(JSON.stringify(res.body)).not.toContain('secret-spirit');
  // The rest of the metadata stays.
  expect(res.body.campaign.maps[0]).toEqual(expect.objectContaining({ id: 'crypt', imageUrl: '/api/assets/maps/crypt.png' }));
});

it('keeps the spirit layer URL for a DM', async () => {
  mockAuth.userId = 'dm-user';
  mockAuth.role = 'DM';

  const res = await request(app).get(`/api/campaigns/${CAMPAIGN_ID}`);

  expect(res.status).toBe(200);
  expect(res.body.campaign.maps[0].spiritLayerUrl).toBe('/api/assets/maps/secret-spirit.png');
});
