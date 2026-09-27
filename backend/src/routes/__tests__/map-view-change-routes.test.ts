/**
 * REST map writes that change what players see, and the token PUT response.
 *
 * - Lighting toggle, wall and light routes, and the map PUT re-sync each
 *   player's token view (broadcastMapViewChange): `token.added` /
 *   `token.removed` for tokens that entered or left their view.
 * - PUT /tokens/:tokenId returns only the updated token, with DM-only
 *   fields stripped for non-DMs — never the raw map.
 *
 * No database: a stateful Prisma mock holds one map; the auth chain injects
 * the session user; the Socket.io server is a fake with a DM and a player.
 * Fixture: 10×10, gridSize 100, a closed door at x = 500 px.
 */

const mockAuth: { userId: string; role: 'DM' | 'PLAYER' } = { userId: 'dm-user', role: 'DM' };
const mockWithCampaignMapRowLock = jest.fn();

jest.mock('../../middleware/compose', () => {
  const inject = (req: any, _res: unknown, next: () => void) => {
    req.session = { userId: mockAuth.userId };
    req.campaignMembership = { role: mockAuth.role, characterIds: [], campaignId: req.params.campaignId };
    next();
  };
  const requireDm = (req: any, res: any, next: () => void) => {
    inject(req, res, () => {
      if (req.campaignMembership.role !== 'DM') return res.status(403).json({ error: 'Forbidden' });
      next();
    });
  };
  return {
    authenticated: [inject],
    adminOnly: [inject],
    campaignMember: [inject],
    campaignDM: [requireDm],
    campaignDMOrPlayer: [inject],
    compose: (...m: unknown[][]) => m.flat(),
  };
});

jest.mock('../../config/database', () => ({
  prisma: {
    map: { findUnique: jest.fn(), update: jest.fn(), delete: jest.fn() },
    campaignMembership: { findUnique: jest.fn(), findMany: jest.fn() },
    campaign: { findUnique: jest.fn(), update: jest.fn() },
    character: { findMany: jest.fn() },
  },
}));

jest.mock('../../services/combatStatePersistence', () => ({
  withCampaignMapRowLock: (...args: unknown[]) => mockWithCampaignMapRowLock(...args),
  CampaignRowNotFoundError: class CampaignRowNotFoundError extends Error {},
  MapRowNotFoundError: class MapRowNotFoundError extends Error {},
}));

jest.mock('../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import express from 'express';
import request from 'supertest';
import mapsRouter from '../maps';
import { prisma } from '../../config/database';
import { setSocketInstance } from '../../websocket/utils';

const CAMPAIGN_ID = 'campaign-1';
const MAP_ID = 'map-1';
const BASE = `/api/campaigns/${CAMPAIGN_ID}/maps/${MAP_ID}`;
const DOOR_ID = '11111111-1111-4111-8111-111111111111';
const LIGHT_ID = '22222222-2222-4222-8222-222222222222';

const db = prisma as unknown as {
  map: { findUnique: jest.Mock; update: jest.Mock; delete: jest.Mock };
  campaignMembership: { findUnique: jest.Mock; findMany: jest.Mock };
  campaign: { findUnique: jest.Mock; update: jest.Mock };
  character: { findMany: jest.Mock };
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

const DOOR = { id: DOOR_ID, x1: 500, y1: 0, x2: 500, y2: 1000, type: 'door-closed' };
const TORCH = { id: LIGHT_ID, x: 750, y: 450, brightRadius: 2, dimRadius: 3, color: '#ffcc66', enabled: true };

let stored: Record<string, any>;
let movementDuringLockWait: { x: number; y: number } | null;
type FakeSocket = { id: string; userId: string; role: string; emit: jest.Mock };
let dm: FakeSocket;
let alice: FakeSocket;

function tokenEvents(s: FakeSocket) {
  return s.emit.mock.calls
    .filter(([event]) => event === 'token.added' || event === 'token.removed')
    .map(([event, payload]) => [event, payload.token?.id ?? payload.tokenId]);
}

const app = express();
app.put('/api/campaigns/:campaignId/maps/:id/difficult-terrain', express.json({ limit: '8mb' }));
app.use(express.json());
app.use('/api/campaigns/:campaignId/maps', mapsRouter);

beforeEach(() => {
  jest.clearAllMocks();
  mockAuth.userId = 'dm-user';
  mockAuth.role = 'DM';
  stored = {
    id: MAP_ID,
    campaignId: CAMPAIGN_ID,
    name: 'Crypt',
    imageUrl: '',
    width: 10,
    height: 10,
    gridSize: 100,
    feetPerSquare: 5,
    diagonalRule: 'standard',
    difficultTerrain: [{ x: 4, y: 4 }],
    baseLayerUrl: '',
    spiritLayerUrl: '/api/assets/maps/secret-spirit.png',
    tokens: [
      token('pc-alice', 2, 5, { controlledBy: 'alice', sightRadius: 0, notes: 'DM: cursed' }),
      token('orc', 3, 6), // west
      token('goblin', 7, 5, { notes: 'DM secret' }), // east
      token('lurker', 3, 4, { visible: false }), // west, hidden
    ],
    annotations: [],
    wallSegments: [DOOR],
    lights: [],
    fogData: { revealed: ['secret-fog'] },
    lightingEnabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  db.map.findUnique.mockImplementation(async () => JSON.parse(JSON.stringify(stored)));
  db.map.update.mockImplementation(async ({ data }: any) => {
    stored = { ...stored, ...JSON.parse(JSON.stringify(data)) };
    return JSON.parse(JSON.stringify(stored));
  });
  db.map.delete.mockResolvedValue({ id: MAP_ID });
  db.campaignMembership.findUnique.mockImplementation(async () => ({ role: mockAuth.role }));
  db.campaignMembership.findMany.mockResolvedValue([
    { userId: 'dm-user', role: 'DM', characterIds: [] },
    { userId: 'alice', role: 'PLAYER', characterIds: [] },
  ]);
  db.campaign.findUnique.mockResolvedValue({ spiritLayerEnabled: false, currentMapId: MAP_ID, combatState: null });
  db.campaign.update.mockResolvedValue({ id: CAMPAIGN_ID, currentMapId: MAP_ID, currentMap: { id: MAP_ID } });
  db.character.findMany.mockResolvedValue([]);
  movementDuringLockWait = null;
  mockWithCampaignMapRowLock.mockImplementation(async (_prisma: unknown, _campaignId: string, mapId: string, fn: Function) => {
    if (movementDuringLockWait) stored.tokens[0].position = movementDuringLockWait;
    const campaign = await db.campaign.findUnique({ where: { id: CAMPAIGN_ID } });
    const tx = {
      map: { update: db.map.update, delete: db.map.delete },
      campaignMembership: { findUnique: db.campaignMembership.findUnique },
      campaign: { update: db.campaign.update },
    };
    return fn(tx, campaign, { ...JSON.parse(JSON.stringify(stored)), id: mapId });
  });

  dm = { id: 's-dm', userId: 'dm-user', role: 'DM', emit: jest.fn() };
  alice = { id: 's-alice', userId: 'alice', role: 'PLAYER', emit: jest.fn() };
  setSocketInstance({
    in: jest.fn(() => ({ fetchSockets: jest.fn(async () => [dm, alice]) })),
    to: jest.fn(() => ({ emit: jest.fn() })),
  } as any);
});

describe('lighting toggle', () => {
  it('removes out-of-sight tokens from players when lighting is turned on', async () => {
    stored.lightingEnabled = false;
    const res = await request(app).put(`${BASE}/lighting`).send({ enabled: true });

    expect(res.status).toBe(200);
    expect(tokenEvents(alice)).toEqual([['token.removed', 'goblin']]);
    expect(tokenEvents(dm)).toEqual([]);
  });

  it('adds every role-visible token for players when lighting is turned off', async () => {
    const res = await request(app).put(`${BASE}/lighting`).send({ enabled: false });

    expect(res.status).toBe(200);
    expect(tokenEvents(alice)).toEqual([['token.added', 'goblin']]);
    const added = alice.emit.mock.calls.find(([event]) => event === 'token.added')![1];
    expect(added.token.notes).toBeUndefined();
  });

  it('re-syncs when the map PUT changes lightingEnabled', async () => {
    const res = await request(app).put(BASE).send({ lightingEnabled: false });

    expect(res.status).toBe(200);
    expect(tokenEvents(alice)).toEqual([['token.added', 'goblin']]);
  });
});

describe('REST walls and lights', () => {
  it('reveals tokens when a door is opened (PATCH)', async () => {
    const res = await request(app).patch(`${BASE}/walls/${DOOR_ID}`).send({ type: 'door-open' });

    expect(res.status).toBe(200);
    expect(tokenEvents(alice)).toEqual([['token.added', 'goblin']]);
  });

  it('re-syncs after wall DELETE, PUT and POST', async () => {
    await request(app).delete(`${BASE}/walls/${DOOR_ID}`);
    expect(tokenEvents(alice)).toEqual([['token.added', 'goblin']]);

    alice.emit.mockClear();
    await request(app).put(`${BASE}/walls`).send({ segments: [DOOR] });
    expect(tokenEvents(alice)).toEqual([['token.removed', 'goblin']]);

    stored.wallSegments = [];
    alice.emit.mockClear();
    await request(app).post(`${BASE}/walls`).send(DOOR);
    expect(tokenEvents(alice)).toEqual([['token.removed', 'goblin']]);
  });

  it('does not reveal tokens through a wall after light POST, PATCH, DELETE or PUT', async () => {
    await request(app).post(`${BASE}/lights`).send(TORCH);
    expect(tokenEvents(alice)).toEqual([]);

    alice.emit.mockClear();
    await request(app).patch(`${BASE}/lights/${LIGHT_ID}`).send({ enabled: false });
    expect(tokenEvents(alice)).toEqual([]);

    alice.emit.mockClear();
    await request(app).put(`${BASE}/lights`).send({ lights: [TORCH] });
    expect(tokenEvents(alice)).toEqual([]);

    alice.emit.mockClear();
    await request(app).delete(`${BASE}/lights/${LIGHT_ID}`);
    expect(tokenEvents(alice)).toEqual([]);
  });
});

describe('PUT /tokens/:tokenId response', () => {
  it('gives a player exactly the updated token without DM notes, and no map', async () => {
    mockAuth.userId = 'alice';
    mockAuth.role = 'PLAYER';

    const res = await request(app).put(`${BASE}/tokens/pc-alice`).send({ position: { x: 2, y: 6 } });

    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['message', 'token']);
    const { notes: _notes, ...expected } = { ...stored.tokens[0] };
    expect(res.body.token).toEqual(expected);
    const body = JSON.stringify(res.body);
    for (const secret of ['DM: cursed', 'DM secret', 'lurker', 'goblin', 'secret-spirit', 'secret-fog']) {
      expect(body).not.toContain(secret);
    }
  });

  it('gives a DM the full updated token and no map', async () => {
    const res = await request(app).put(`${BASE}/tokens/goblin`).send({ name: 'Goblin chief' });

    expect(res.status).toBe(200);
    expect(res.body.map).toBeUndefined();
    expect(res.body.token).toEqual(expect.objectContaining({ id: 'goblin', name: 'Goblin chief', notes: 'DM secret' }));
  });

  it('rejects REST position updates while campaign combat is active', async () => {
    db.campaign.findUnique.mockResolvedValue({
      spiritLayerEnabled: false,
      currentMapId: MAP_ID,
      combatState: {
        active: true,
        round: 1,
        currentTokenId: 'pc-alice',
        combatants: [],
      },
    });

    const res = await request(app).put(`${BASE}/tokens/pc-alice`).send({ position: { x: 2, y: 6 } });

    expect(res.status).toBe(409);
    expect(res.body).toEqual(expect.objectContaining({
      error: 'Conflict',
      message: expect.stringContaining('token.move.end'),
    }));
    expect(stored.tokens[0].position).toEqual({ x: 2, y: 5 });
    expect(db.map.update).not.toHaveBeenCalled();
  });

  it('preserves a movement committed while the REST token update waits', async () => {
    // Simulate movement completing before this request obtains the campaign/map locks.
    movementDuringLockWait = { x: 3, y: 5 };

    const res = await request(app).put(`${BASE}/tokens/pc-alice`).send({ name: 'Alice' });

    expect(res.status).toBe(200);
    expect(mockWithCampaignMapRowLock).toHaveBeenCalled();
    expect(res.body.token).toEqual(expect.objectContaining({
      id: 'pc-alice',
      name: 'Alice',
      position: { x: 3, y: 5 },
    }));
    expect(stored.tokens[0].position).toEqual({ x: 3, y: 5 });
  });

  it.each([
    ['size', { size: { width: 2, height: 1 } }],
    ['conditions', { conditions: ['prone'] }],
  ])('rejects player %s updates during active combat', async (_field, update) => {
    mockAuth.userId = 'alice';
    mockAuth.role = 'PLAYER';
    db.campaign.findUnique.mockResolvedValue({
      spiritLayerEnabled: false,
      currentMapId: MAP_ID,
      combatState: { active: true, mapId: MAP_ID, combatants: [] },
    });

    const res = await request(app).put(`${BASE}/tokens/pc-alice`).send(update);

    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/Only DM/i);
    expect(db.map.update).not.toHaveBeenCalled();
  });

  it('allows the DM to change size and conditions during combat when the footprint is valid', async () => {
    db.campaign.findUnique.mockResolvedValue({
      spiritLayerEnabled: false,
      currentMapId: MAP_ID,
      combatState: { active: true, mapId: MAP_ID, combatants: [] },
    });

    const res = await request(app).put(`${BASE}/tokens/orc`).send({
      size: { width: 2, height: 2 },
      conditions: ['prone', 'poisoned'],
    });

    expect(res.status).toBe(200);
    expect(res.body.token).toEqual(expect.objectContaining({
      size: { width: 2, height: 2 },
      conditions: ['prone', 'poisoned'],
    }));
  });

  it.each([
    ['fractional coordinate', { x: 1.5, y: 2 }],
    ['missing coordinate', { x: 1 }],
  ])('rejects a %s even outside combat', async (_label, position) => {
    const res = await request(app).put(`${BASE}/tokens/orc`).send({ position });

    expect(res.status).toBe(400);
    expect(db.map.update).not.toHaveBeenCalled();
  });

  it('rejects a token position whose footprint extends beyond the map', async () => {
    stored.tokens[1].size = { width: 2, height: 1 };

    const res = await request(app).put(`${BASE}/tokens/orc`).send({ position: { x: 9, y: 3 } });

    expect(res.status).toBe(400);
    expect(db.map.update).not.toHaveBeenCalled();
  });

  it('rejects invalid DM size and conditions values', async () => {
    const badSize = await request(app).put(`${BASE}/tokens/orc`).send({ size: { width: 1.5, height: 1 } });
    expect(badSize.status).toBe(400);

    const badConditions = await request(app).put(`${BASE}/tokens/orc`).send({ conditions: ['prone', 42] });
    expect(badConditions.status).toBe(400);
    expect(db.map.update).not.toHaveBeenCalled();
  });
});

describe('difficult terrain', () => {
  it('returns difficultTerrain from GET map data', async () => {
    const res = await request(app).get(BASE);

    expect(res.status).toBe(200);
    expect(res.body.map.difficultTerrain).toEqual([{ x: 4, y: 4 }]);
  });

  it('lets a DM write unique in-bounds cells under the map lock and broadcasts filtered map.changed', async () => {
    const res = await request(app)
      .put(`${BASE}/difficult-terrain`)
      .send({ cells: [{ x: 2, y: 3 }, { x: 2, y: 3 }, { x: 9, y: 9 }] });

    expect(res.status).toBe(200);
    expect(stored.difficultTerrain).toEqual([{ x: 2, y: 3 }, { x: 9, y: 9 }]);
    expect(mockWithCampaignMapRowLock).toHaveBeenCalled();
    expect(db.map.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: MAP_ID },
      data: { difficultTerrain: [{ x: 2, y: 3 }, { x: 9, y: 9 }] },
    }));
    expect(dm.emit).toHaveBeenCalledWith('map.changed', expect.objectContaining({
      mapId: MAP_ID,
      mapData: expect.objectContaining({ difficultTerrain: [{ x: 2, y: 3 }, { x: 9, y: 9 }] }),
    }));
    expect(alice.emit).toHaveBeenCalledWith('map.changed', expect.objectContaining({
      mapId: MAP_ID,
      mapData: expect.objectContaining({ difficultTerrain: [{ x: 2, y: 3 }, { x: 9, y: 9 }] }),
    }));
  });

  it('saves future-map terrain without showing that map to players', async () => {
    const campaign = { spiritLayerEnabled: false, currentMapId: 'current-map', combatState: null };
    db.campaign.findUnique.mockResolvedValue(campaign);
    const res = await request(app).put(`${BASE}/difficult-terrain`).send({ cells: [{ x: 2, y: 3 }] });
    expect(res.status).toBe(200);
    expect(stored.difficultTerrain).toEqual([{ x: 2, y: 3 }]);
    for (const viewer of [dm, alice]) {
      expect(viewer.emit.mock.calls.filter(([event]) => event === 'map.changed')).toEqual([]);
    }
    expect(db.campaign.update).not.toHaveBeenCalled();
    expect(campaign.currentMapId).toBe('current-map');
  });

  it('requires DM and rejects invalid, out-of-map, or oversized cell lists', async () => {
    mockAuth.role = 'PLAYER';
    const forbidden = await request(app).put(`${BASE}/difficult-terrain`).send({ cells: [] });
    expect(forbidden.status).toBe(403);

    mockAuth.role = 'DM';
    const fractional = await request(app).put(`${BASE}/difficult-terrain`).send({ cells: [{ x: 1.5, y: 1 }] });
    expect(fractional.status).toBe(400);
    const outside = await request(app).put(`${BASE}/difficult-terrain`).send({ cells: [{ x: 10, y: 0 }] });
    expect(outside.status).toBe(400);
    const oversized = await request(app).put(`${BASE}/difficult-terrain`).send({ cells: Array(100001).fill({ x: 0, y: 0 }) });
    expect(oversized.status).toBe(400);
    expect(db.map.update).not.toHaveBeenCalled();
  });

  it('accepts the 100000-cell input limit and stores its deduplicated cells', async () => {
    const cells = Array(100_000).fill({ x: 1, y: 1 });

    const res = await request(app).put(`${BASE}/difficult-terrain`).send({ cells });

    expect(res.status).toBe(200);
    expect(res.body.difficultTerrain).toEqual([{ x: 1, y: 1 }]);
  });
});

describe('map deletion during combat', () => {
  it('rejects deleting the map used by active combat', async () => {
    db.campaign.findUnique.mockResolvedValue({
      spiritLayerEnabled: false,
      currentMapId: 'another-map',
      combatState: { active: true, mapId: MAP_ID, combatants: [] },
    });

    const res = await request(app).delete(BASE);

    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/active combat/i);
    expect(db.map.delete).not.toHaveBeenCalled();
  });
});

describe('set current map during combat', () => {
  it('rejects switching away from the map recorded by active combat', async () => {
    db.campaign.findUnique.mockResolvedValue({
      spiritLayerEnabled: false,
      currentMapId: 'another-map',
      combatState: { active: true, mapId: MAP_ID, combatants: [] },
    });

    const res = await request(app).put(`/api/campaigns/${CAMPAIGN_ID}/maps/another-map/set-current`);

    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/active combat/i);
    expect(mockWithCampaignMapRowLock).toHaveBeenCalled();
    expect(db.campaign.update).not.toHaveBeenCalled();
  });

  it('allows selecting the active combat map to repair a drifted currentMapId', async () => {
    db.campaign.findUnique.mockResolvedValue({
      spiritLayerEnabled: false,
      currentMapId: 'another-map',
      combatState: { active: true, mapId: MAP_ID, combatants: [] },
    });

    const res = await request(app).put(`${BASE}/set-current`);

    expect(res.status).toBe(200);
    expect(db.campaign.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { currentMapId: MAP_ID },
    }));
  });
});
