/**
 * Token REST routes broadcast token.added / token.updated / token.removed.
 *
 * No database: Prisma is mocked, the auth middleware chain is replaced with a
 * pass-through that injects the session user + campaign role, and the
 * Socket.io server is a fake whose room contains one DM and one player socket.
 * The real broadcast helper (websocket/utils) runs against that fake server so
 * the per-socket visibility filtering is exercised end to end.
 */

const mockAuth: { userId: string; role: 'DM' | 'PLAYER' | 'SPECTATOR' } = {
  userId: 'dm-user',
  role: 'DM',
};

jest.mock('../../middleware/compose', () => {
  const inject = (req: any, _res: unknown, next: () => void) => {
    req.session = { userId: mockAuth.userId };
    req.campaignMembership = {
      role: mockAuth.role,
      characterIds: [],
      campaignId: req.params.campaignId,
    };
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
    character: { findMany: jest.fn(async () => []) },
    message: { create: jest.fn() },
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
const OTHER_MAP_ID = 'map-2';

type FakeSocket = { id: string; userId: string; role: string; emit: jest.Mock };

function makeSocket(id: string, userId: string, role: string): FakeSocket {
  return { id, userId, role, emit: jest.fn() };
}

const mockedPrisma = prisma as unknown as {
  map: { findUnique: jest.Mock; update: jest.Mock };
  campaignMembership: { findUnique: jest.Mock; findMany: jest.Mock };
  campaign: { findUnique: jest.Mock };
};

function baseToken(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tok-1',
    characterId: null,
    name: 'Goblin',
    imageUrl: '',
    position: { x: 1, y: 1 },
    size: { width: 1, height: 1 },
    layer: 'token',
    visible: true,
    controlledBy: null,
    rotation: 0,
    conditions: [],
    metadata: {},
    type: 'npc',
    disposition: 'hostile',
    hp: { current: 7, max: 7, temp: 0 },
    showHpBar: false,
    notes: 'DM secret',
    initiative: null,
    displayMode: 'pog',
    statBlock: null,
    creatureTemplateId: null,
    ...overrides,
  };
}

function mapWith(tokens: unknown[]) {
  return {
    id: MAP_ID,
    campaignId: CAMPAIGN_ID,
    name: 'Map',
    width: 20,
    height: 20,
    gridSize: 50,
    tokens,
    lightingEnabled: false,
  };
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/campaigns/:campaignId/maps', mapsRouter);
  return app;
}

/** Events a socket received, as [event, payload] tuples. */
function received(socket: FakeSocket) {
  return socket.emit.mock.calls.map(([event, payload]) => [event, payload]);
}

describe('token REST routes broadcast token events', () => {
  const app = buildApp();
  let dmSocket: FakeSocket;
  let playerSocket: FakeSocket;
  let fetchSockets: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockAuth.userId = 'dm-user';
    mockAuth.role = 'DM';

    dmSocket = makeSocket('s-dm', 'dm-user', 'DM');
    playerSocket = makeSocket('s-player', 'player-user', 'PLAYER');
    fetchSockets = jest.fn().mockResolvedValue([dmSocket, playerSocket]);
    const roomEmit = jest.fn();
    setSocketInstance({
      in: jest.fn(() => ({ fetchSockets })),
      to: jest.fn(() => ({ emit: roomEmit })),
    } as any);

    mockedPrisma.map.update.mockImplementation(async ({ data }: any) => ({ ...mapWith(data.tokens) }));
    mockedPrisma.campaignMembership.findUnique.mockImplementation(async ({ where }: any) => ({
      role: where.userId_campaignId.userId === 'dm-user' ? 'DM' : 'PLAYER',
    }));
    mockedPrisma.campaignMembership.findMany.mockResolvedValue([
      { userId: 'dm-user', role: 'DM' },
      { userId: 'player-user', role: 'PLAYER' },
    ]);
    mockedPrisma.campaign.findUnique.mockResolvedValue({ spiritLayerEnabled: false, currentMapId: MAP_ID });
  });

  describe('POST /:id/tokens', () => {
    it('sends token.added with the created token to DM and players', async () => {
      mockedPrisma.map.findUnique.mockResolvedValue(mapWith([]));

      const res = await request(app)
        .post(`/api/campaigns/${CAMPAIGN_ID}/maps/${MAP_ID}/tokens`)
        .send({ name: 'Goblin', position: { x: 2, y: 3 }, notes: 'DM secret' });

      expect(res.status).toBe(201);
      const created = res.body.token;
      expect(received(dmSocket)).toEqual([['token.added', { mapId: MAP_ID, token: created }]]);
      // Players get the same shape the map GET returns: DM-only notes stripped.
      const { notes: _notes, ...playerView } = created;
      expect(received(playerSocket)).toEqual([['token.added', { mapId: MAP_ID, token: playerView }]]);
    });

    it('sends a hidden token only to DM sockets', async () => {
      mockedPrisma.map.findUnique.mockResolvedValue(mapWith([]));

      const res = await request(app)
        .post(`/api/campaigns/${CAMPAIGN_ID}/maps/${MAP_ID}/tokens`)
        .send({ name: 'Lurker', position: { x: 2, y: 3 }, visible: false });

      expect(res.status).toBe(201);
      expect(received(dmSocket)).toEqual([['token.added', { mapId: MAP_ID, token: res.body.token }]]);
      expect(playerSocket.emit).not.toHaveBeenCalled();
    });

    it('does not send spirit-layer tokens to players who cannot see the spirit layer', async () => {
      mockedPrisma.map.findUnique.mockResolvedValue(mapWith([]));

      const res = await request(app)
        .post(`/api/campaigns/${CAMPAIGN_ID}/maps/${MAP_ID}/tokens`)
        .send({ name: 'Wraith', position: { x: 2, y: 3 }, layer: 'spirit' });

      expect(res.status).toBe(201);
      expect(received(dmSocket)).toEqual([['token.added', { mapId: MAP_ID, token: res.body.token }]]);
      expect(playerSocket.emit).not.toHaveBeenCalled();
    });

    it('still succeeds when the broadcast fails', async () => {
      mockedPrisma.map.findUnique.mockResolvedValue(mapWith([]));
      fetchSockets.mockRejectedValue(new Error('adapter down'));

      const res = await request(app)
        .post(`/api/campaigns/${CAMPAIGN_ID}/maps/${MAP_ID}/tokens`)
        .send({ name: 'Goblin', position: { x: 2, y: 3 } });

      expect(res.status).toBe(201);
      expect(res.body.token.name).toBe('Goblin');
    });

    it('does not broadcast when the route rejects the request', async () => {
      mockedPrisma.map.findUnique.mockResolvedValue({ ...mapWith([]), campaignId: 'someone-else' });

      const res = await request(app)
        .post(`/api/campaigns/${CAMPAIGN_ID}/maps/${MAP_ID}/tokens`)
        .send({ name: 'Goblin', position: { x: 2, y: 3 } });

      expect(res.status).toBe(404);
      expect(dmSocket.emit).not.toHaveBeenCalled();
      expect(playerSocket.emit).not.toHaveBeenCalled();
    });
  });

  describe('PUT /:id/tokens/:tokenId', () => {
    async function put(existing: Record<string, unknown>, updates: Record<string, unknown>) {
      mockedPrisma.map.findUnique.mockResolvedValue(mapWith([existing, baseToken({ id: 'tok-other' })]));
      return request(app)
        .put(`/api/campaigns/${CAMPAIGN_ID}/maps/${MAP_ID}/tokens/${existing.id}`)
        .send(updates);
    }

    it('sends token.updated with the updated token to everyone for a visible token', async () => {
      const res = await put(baseToken(), { hp: { current: 3, max: 7, temp: 0 } });

      expect(res.status).toBe(200);
      const updated = res.body.token;
      expect(updated.hp.current).toBe(3);
      expect(received(dmSocket)).toEqual([['token.updated', { mapId: MAP_ID, token: updated }]]);
      const { notes: _notes, ...playerView } = updated;
      expect(received(playerSocket)).toEqual([['token.updated', { mapId: MAP_ID, token: playerView }]]);
    });

    it('sends token.updated for a hidden token only to DM sockets', async () => {
      const res = await put(baseToken({ visible: false }), { name: 'Hidden goblin' });

      expect(res.status).toBe(200);
      expect(received(dmSocket)).toEqual([['token.updated', { mapId: MAP_ID, token: res.body.token }]]);
      expect(playerSocket.emit).not.toHaveBeenCalled();
    });

    it('sends token.removed to players when a token becomes hidden', async () => {
      const res = await put(baseToken(), { visible: false });

      expect(res.status).toBe(200);
      expect(received(dmSocket)).toEqual([['token.updated', { mapId: MAP_ID, token: res.body.token }]]);
      expect(received(playerSocket)).toEqual([['token.removed', { mapId: MAP_ID, tokenId: 'tok-1' }]]);
    });

    it('sends token.added to players when a token becomes visible', async () => {
      const res = await put(baseToken({ visible: false }), { visible: true });

      expect(res.status).toBe(200);
      const updated = res.body.token;
      expect(received(dmSocket)).toEqual([['token.updated', { mapId: MAP_ID, token: updated }]]);
      const { notes: _notes, ...playerView } = updated;
      expect(received(playerSocket)).toEqual([['token.added', { mapId: MAP_ID, token: playerView }]]);
    });

    it('broadcasts a player-controlled token update made by that player', async () => {
      mockAuth.userId = 'player-user';
      mockAuth.role = 'PLAYER';
      const res = await put(baseToken({ controlledBy: 'player-user' }), { position: { x: 4, y: 4 } });

      expect(res.status).toBe(200);
      // The player's response carries no DM notes; DM sockets get the full token.
      expect(res.body.token.notes).toBeUndefined();
      expect(received(dmSocket)).toEqual([
        ['token.updated', { mapId: MAP_ID, token: { ...res.body.token, notes: 'DM secret' } }],
      ]);
      expect(received(playerSocket)[0][0]).toBe('token.updated');
    });

    it('does not broadcast when the update is forbidden', async () => {
      mockAuth.userId = 'player-user';
      mockAuth.role = 'PLAYER';
      const res = await put(baseToken(), { position: { x: 4, y: 4 } });

      expect(res.status).toBe(403);
      expect(dmSocket.emit).not.toHaveBeenCalled();
      expect(playerSocket.emit).not.toHaveBeenCalled();
    });
  });

  describe('DELETE /:id/tokens/:tokenId', () => {
    it('sends token.removed to everyone for a visible token', async () => {
      mockedPrisma.map.findUnique.mockResolvedValue(mapWith([baseToken()]));

      const res = await request(app).delete(`/api/campaigns/${CAMPAIGN_ID}/maps/${MAP_ID}/tokens/tok-1`);

      expect(res.status).toBe(200);
      const payload = { mapId: MAP_ID, tokenId: 'tok-1' };
      expect(received(dmSocket)).toEqual([['token.removed', payload]]);
      expect(received(playerSocket)).toEqual([['token.removed', payload]]);
    });

    it('sends token.removed for a hidden token only to DM sockets', async () => {
      mockedPrisma.map.findUnique.mockResolvedValue(mapWith([baseToken({ visible: false })]));

      const res = await request(app).delete(`/api/campaigns/${CAMPAIGN_ID}/maps/${MAP_ID}/tokens/tok-1`);

      expect(res.status).toBe(200);
      expect(received(dmSocket)).toEqual([['token.removed', { mapId: MAP_ID, tokenId: 'tok-1' }]]);
      expect(playerSocket.emit).not.toHaveBeenCalled();
    });

    it('does not broadcast when the token does not exist', async () => {
      mockedPrisma.map.findUnique.mockResolvedValue(mapWith([]));

      const res = await request(app).delete(`/api/campaigns/${CAMPAIGN_ID}/maps/${MAP_ID}/tokens/tok-1`);

      expect(res.status).toBe(404);
      expect(dmSocket.emit).not.toHaveBeenCalled();
    });
  });

  it('carries the mapId of the map that changed', async () => {
    mockedPrisma.map.findUnique.mockResolvedValue({ ...mapWith([baseToken()]), id: OTHER_MAP_ID });

    const res = await request(app).delete(`/api/campaigns/${CAMPAIGN_ID}/maps/${OTHER_MAP_ID}/tokens/tok-1`);

    expect(res.status).toBe(200);
    expect(received(dmSocket)).toEqual([['token.removed', { mapId: OTHER_MAP_ID, tokenId: 'tok-1' }]]);
  });
});
