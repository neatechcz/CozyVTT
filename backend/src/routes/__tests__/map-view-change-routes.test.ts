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
    map: { findUnique: jest.fn(), update: jest.fn() },
    campaignMembership: { findUnique: jest.fn(), findMany: jest.fn() },
    campaign: { findUnique: jest.fn() },
    character: { findMany: jest.fn() },
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
import { setSocketInstance } from '../../websocket/utils';

const CAMPAIGN_ID = 'campaign-1';
const MAP_ID = 'map-1';
const BASE = `/api/campaigns/${CAMPAIGN_ID}/maps/${MAP_ID}`;
const DOOR_ID = '11111111-1111-4111-8111-111111111111';
const LIGHT_ID = '22222222-2222-4222-8222-222222222222';

const db = prisma as unknown as {
  map: { findUnique: jest.Mock; update: jest.Mock };
  campaignMembership: { findUnique: jest.Mock; findMany: jest.Mock };
  campaign: { findUnique: jest.Mock };
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
type FakeSocket = { id: string; userId: string; role: string; emit: jest.Mock };
let dm: FakeSocket;
let alice: FakeSocket;

function tokenEvents(s: FakeSocket) {
  return s.emit.mock.calls
    .filter(([event]) => event === 'token.added' || event === 'token.removed')
    .map(([event, payload]) => [event, payload.token?.id ?? payload.tokenId]);
}

const app = express();
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
  db.campaignMembership.findUnique.mockImplementation(async () => ({ role: mockAuth.role }));
  db.campaignMembership.findMany.mockResolvedValue([
    { userId: 'dm-user', role: 'DM', characterIds: [] },
    { userId: 'alice', role: 'PLAYER', characterIds: [] },
  ]);
  db.campaign.findUnique.mockResolvedValue({ spiritLayerEnabled: false, currentMapId: MAP_ID });
  db.character.findMany.mockResolvedValue([]);

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

  it('re-syncs after light POST, PATCH, DELETE and PUT', async () => {
    await request(app).post(`${BASE}/lights`).send(TORCH);
    expect(tokenEvents(alice)).toEqual([['token.added', 'goblin']]);

    alice.emit.mockClear();
    await request(app).patch(`${BASE}/lights/${LIGHT_ID}`).send({ enabled: false });
    expect(tokenEvents(alice)).toEqual([['token.removed', 'goblin']]);

    alice.emit.mockClear();
    await request(app).put(`${BASE}/lights`).send({ lights: [TORCH] });
    expect(tokenEvents(alice)).toEqual([['token.added', 'goblin']]);

    alice.emit.mockClear();
    await request(app).delete(`${BASE}/lights/${LIGHT_ID}`);
    expect(tokenEvents(alice)).toEqual([['token.removed', 'goblin']]);
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
});
