/**
 * Map writers outside the broadcast helpers bump the map's in-process version
 * (mapVersion.ts), so cached drag snapshots of that map reload on the next
 * frame: the campaign PUT when it writes spiritLayerEnabled, session restore,
 * and initiative.set / initiative.roll.
 *
 * No database: Prisma is mocked; the auth chain injects a DM.
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

jest.mock('../../config/database', () => ({
  prisma: {
    map: { findUnique: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
    campaign: { findUnique: jest.fn(), update: jest.fn() },
    user: { findUnique: jest.fn(async () => ({ displayName: 'DM' })) },
  },
}));

jest.mock('../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import express from 'express';
import request from 'supertest';
import campaignsRouter from '../../routes/campaigns';
import { prisma } from '../../config/database';
import { restoreGameState } from '../../services/sessionState';
import { registerInitiativeHandlers } from '../handlers/initiative';
import { getMapVersion } from '../mapVersion';

const CAMPAIGN_ID = 'campaign-1';
const MAP_ID = 'map-1';

const db = prisma as unknown as {
  map: { findUnique: jest.Mock; findFirst: jest.Mock; update: jest.Mock };
  campaign: { findUnique: jest.Mock; update: jest.Mock };
};

const map = {
  id: MAP_ID,
  campaignId: CAMPAIGN_ID,
  tokens: [{ id: 'orc', name: 'Orc', imageUrl: '', position: { x: 1, y: 1 } }],
};

beforeEach(() => {
  jest.clearAllMocks();
  db.map.findUnique.mockResolvedValue(JSON.parse(JSON.stringify(map)));
  db.map.findFirst.mockResolvedValue(JSON.parse(JSON.stringify(map)));
  db.map.update.mockResolvedValue({});
  db.campaign.findUnique.mockResolvedValue({ id: CAMPAIGN_ID, currentMapId: MAP_ID });
  db.campaign.update.mockResolvedValue({ id: CAMPAIGN_ID, currentMapId: MAP_ID, spiritLayerEnabled: true });
});

describe('campaign PUT', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/campaigns', campaignsRouter);

  it('bumps the current map when spiritLayerEnabled is written', async () => {
    const before = getMapVersion(MAP_ID);
    const res = await request(app).put(`/api/campaigns/${CAMPAIGN_ID}`).send({ spiritLayerEnabled: true });

    expect(res.status).toBe(200);
    expect(getMapVersion(MAP_ID)).toBeGreaterThan(before);
  });

  it('leaves the map version alone for other settings', async () => {
    const before = getMapVersion(MAP_ID);
    const res = await request(app).put(`/api/campaigns/${CAMPAIGN_ID}`).send({ name: 'Renamed' });

    expect(res.status).toBe(200);
    expect(getMapVersion(MAP_ID)).toBe(before);
  });
});

describe('session restore', () => {
  it('bumps the restored map', async () => {
    const before = getMapVersion(MAP_ID);
    await restoreGameState(CAMPAIGN_ID, {
      mapId: MAP_ID,
      tokens: map.tokens,
      spiritLayerVisible: false,
      currentVibe: null,
      annotations: [],
    } as any);

    expect(getMapVersion(MAP_ID)).toBeGreaterThan(before);
  });
});

describe('initiative token writes', () => {
  function dmSocket() {
    const handlers: Record<string, (payload: unknown) => Promise<void>> = {};
    const socket = {
      id: 's-dm',
      userId: 'dm-user',
      role: 'DM',
      campaignId: CAMPAIGN_ID,
      emit: jest.fn(),
      on: jest.fn((event: string, handler: (payload: unknown) => Promise<void>) => {
        handlers[event] = handler;
      }),
    };
    const io = { to: jest.fn(() => ({ emit: jest.fn() })) };
    registerInitiativeHandlers(io as any, socket as any);
    return { socket, handlers };
  }

  it('initiative.set bumps the map', async () => {
    const { socket, handlers } = dmSocket();
    const before = getMapVersion(MAP_ID);
    await handlers['initiative.set']({ tokenId: 'orc', mapId: MAP_ID, value: 12 });

    expect(socket.emit).not.toHaveBeenCalledWith('error', expect.anything());
    expect(getMapVersion(MAP_ID)).toBeGreaterThan(before);
  });

  it('initiative.roll bumps the map', async () => {
    const { socket, handlers } = dmSocket();
    const before = getMapVersion(MAP_ID);
    await handlers['initiative.roll']({ tokenId: 'orc', mapId: MAP_ID, expression: '1d20' });

    expect(socket.emit).not.toHaveBeenCalledWith('error', expect.anything());
    expect(getMapVersion(MAP_ID)).toBeGreaterThan(before);
  });
});
