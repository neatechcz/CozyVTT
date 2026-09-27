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
    creatureTemplate: { findUnique: jest.fn() },
    session: { findFirst: jest.fn(), update: jest.fn() },
    user: { findUnique: jest.fn(async () => ({ displayName: 'DM' })) },
  },
}));

const mockWithCampaignRowLock = jest.fn();
const mockLockCampaignMapRows = jest.fn();
const mockWithCampaignMapRowLock = jest.fn();
const mockLoadCampaignCombatState = jest.fn();
const mockSaveCampaignCombatState = jest.fn();

jest.mock('../../services/combatStatePersistence', () => ({
  withCampaignRowLock: (...args: unknown[]) => mockWithCampaignRowLock(...args),
  lockCampaignMapRows: (...args: unknown[]) => mockLockCampaignMapRows(...args),
  withCampaignMapRowLock: (...args: unknown[]) => mockWithCampaignMapRowLock(...args),
  loadCampaignCombatState: (...args: unknown[]) => mockLoadCampaignCombatState(...args),
  saveCampaignCombatState: (...args: unknown[]) => mockSaveCampaignCombatState(...args),
  MapRowNotFoundError: class MapRowNotFoundError extends Error {},
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
import { defaultCombatState, readCombatState } from '../initiativeState';

const CAMPAIGN_ID = 'campaign-1';
const MAP_ID = 'map-1';

const db = prisma as unknown as {
  map: { findUnique: jest.Mock; findFirst: jest.Mock; update: jest.Mock };
  campaign: { findUnique: jest.Mock; update: jest.Mock };
  creatureTemplate: { findUnique: jest.Mock };
  session: { findFirst: jest.Mock; update: jest.Mock };
};

const map = {
  id: MAP_ID,
  campaignId: CAMPAIGN_ID,
  tokens: [{ id: 'orc', name: 'Orc', imageUrl: '', position: { x: 1, y: 1 } }],
};
let persistedCombatState: unknown;

beforeEach(() => {
  jest.clearAllMocks();
  persistedCombatState = null;
  db.map.findUnique.mockResolvedValue(JSON.parse(JSON.stringify(map)));
  db.map.findFirst.mockResolvedValue(JSON.parse(JSON.stringify(map)));
  db.map.update.mockResolvedValue({});
  db.campaign.findUnique.mockImplementation(async () => ({
    id: CAMPAIGN_ID,
    currentMapId: MAP_ID,
    gameSystem: 'DND_5E',
    combatState: persistedCombatState,
  }));
  db.campaign.update.mockResolvedValue({ id: CAMPAIGN_ID, currentMapId: MAP_ID, spiritLayerEnabled: true });
  db.session.findFirst.mockResolvedValue(null);
  db.session.update.mockResolvedValue({});
  mockWithCampaignRowLock.mockImplementation(async (_prisma: unknown, _campaignId: string, fn: Function) => {
    return fn(db, await db.campaign.findUnique({ where: { id: CAMPAIGN_ID } }));
  });
  mockLockCampaignMapRows.mockImplementation(async (_tx: unknown, _campaignId: string, mapId: string) => ({
    campaign: { id: CAMPAIGN_ID, combatState: null },
    map: await db.map.findFirst({ where: { id: mapId, campaignId: CAMPAIGN_ID } }),
  }));
  mockWithCampaignMapRowLock.mockImplementation(async (_prisma: unknown, _campaignId: string, mapId: string, fn: Function) => {
    const currentMap = await db.map.findUnique({ where: { id: mapId } });
    return fn(db, { id: CAMPAIGN_ID, gameSystem: 'DND_5E', combatState: persistedCombatState }, currentMap);
  });
  mockLoadCampaignCombatState.mockImplementation(async () => readCombatState(persistedCombatState));
  mockSaveCampaignCombatState.mockImplementation(async (_tx: unknown, _campaignId: string, state: unknown) => {
    persistedCombatState = state ?? defaultCombatState();
  });
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
    expect(mockWithCampaignRowLock).toHaveBeenCalled();
    expect(mockLockCampaignMapRows).toHaveBeenCalledWith(db, CAMPAIGN_ID, MAP_ID);
  });

  it('rejects restoring a saved state while combat is active before writing campaign or map state', async () => {
    persistedCombatState = {
      active: true,
      combatId: 'combat-1',
      mapId: MAP_ID,
      round: 1,
      currentTokenId: 'orc',
      turnId: 'turn-1',
      combatants: [{ tokenId: 'orc', name: 'Orc', initiative: 12 }],
    };

    await expect(restoreGameState(CAMPAIGN_ID, {
      mapId: MAP_ID,
      tokens: [],
      spiritLayerVisible: false,
      currentVibe: null,
      annotations: [],
    } as any)).rejects.toThrow(/active combat/i);

    expect(db.campaign.update).not.toHaveBeenCalled();
    expect(db.map.update).not.toHaveBeenCalled();
  });

  it('returns 409 from resume when restoring a saved state during active combat', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/campaigns', campaignsRouter);
    persistedCombatState = {
      active: true,
      combatId: 'combat-1',
      mapId: MAP_ID,
      round: 1,
      currentTokenId: 'orc',
      turnId: 'turn-1',
      combatants: [{ tokenId: 'orc', name: 'Orc', initiative: 12 }],
    };
    db.session.findFirst.mockResolvedValue({
      id: 'session-1',
      sessionNumber: 4,
      startedAt: new Date('2026-09-27T10:00:00.000Z'),
      savedState: { mapId: MAP_ID, tokens: [], spiritLayerVisible: false, currentVibe: null, annotations: [] },
    });

    const res = await request(app).put(`/api/campaigns/${CAMPAIGN_ID}/resume`);

    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/active combat/i);
    expect(db.campaign.update).not.toHaveBeenCalled();
    expect(db.map.update).not.toHaveBeenCalled();
    expect(db.session.update).not.toHaveBeenCalled();
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

  it('initiative.dash resolves speed from a linked creature template when the NPC token has no statBlock', async () => {
    persistedCombatState = {
      active: true,
      round: 1,
      currentTokenId: 'wolf-token',
      combatants: [{ tokenId: 'wolf-token', name: 'Wolf', initiative: 12, type: 'npc' }],
      combatId: 'combat-1',
      turnId: 'turn-1',
      mapId: MAP_ID,
      movement: null,
    };
    const wolfToken = {
      id: 'wolf-token',
      name: 'Wolf',
      type: 'npc',
      position: { x: 1, y: 1 },
      size: { width: 1, height: 1 },
      creatureTemplateId: 'wolf-template',
      statBlock: null,
      conditions: [],
    };
    db.map.findFirst.mockResolvedValue({ ...map, tokens: [wolfToken] });
    db.creatureTemplate.findUnique.mockResolvedValue({
      gameSystem: 'DND_5E',
      statBlock: { speed: '35 ft.' },
    });

    const { socket, handlers } = dmSocket();
    await handlers['initiative.dash']({ tokenId: 'wolf-token' });

    expect(socket.emit).not.toHaveBeenCalledWith('error', expect.anything());
    const savedState = mockSaveCampaignCombatState.mock.calls.at(-1)?.[2] as any;
    expect(savedState.movement).toEqual(expect.objectContaining({
      tokenId: 'wolf-token',
      turnId: 'turn-1',
      speedFeet: 35,
      dashBonusFeet: 35,
      dashUsed: true,
      remainingMovementFeet: 70,
    }));
    expect(db.creatureTemplate.findUnique).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'wolf-template' },
      select: expect.objectContaining({ statBlock: true }),
    }));
  });
});
