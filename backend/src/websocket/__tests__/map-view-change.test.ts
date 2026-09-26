/**
 * Changes that move what players see without touching tokens — a door, a
 * wall, a light, the lighting toggle — re-sync each player's token view
 * (broadcastMapViewChange): tokens that entered their sight arrive as
 * `token.added`, tokens that left it as `token.removed`. DMs receive nothing
 * extra. Also: map.changed uses the same ownership rule (assigned characters).
 *
 * No database: a stateful Prisma mock holds one map (reads return a copy,
 * updates merge into it); the Socket.io server is a fake whose room emits
 * reach the fake sockets. Real raycasting.
 *
 * Fixture: 10×10 squares, gridSize 100 px. A door segment at x = 500 px
 * splits the map into west (Alice's PC) and east (the goblin).
 */

jest.mock('../../config/database', () => ({
  prisma: {
    map: { findUnique: jest.fn(), update: jest.fn() },
    campaignMembership: { findMany: jest.fn() },
    campaign: { findUnique: jest.fn() },
    character: { findMany: jest.fn() },
  },
}));

jest.mock('../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { prisma } from '../../config/database';
import { setSocketInstance } from '../utils';
import { registerWallHandlers } from '../handlers/walls';
import { registerLightHandlers } from '../handlers/lights';
import { registerMapHandlers } from '../handlers/maps';

const CAMPAIGN_ID = 'campaign-1';
const MAP_ID = 'map-1';

const db = prisma as unknown as {
  map: { findUnique: jest.Mock; update: jest.Mock };
  campaignMembership: { findMany: jest.Mock };
  campaign: { findUnique: jest.Mock };
  character: { findMany: jest.Mock };
};

type FakeSocket = {
  id: string;
  userId: string;
  role: string;
  campaignId: string;
  emit: jest.Mock;
  on: jest.Mock;
  to: jest.Mock;
  handlers: Record<string, (payload: unknown) => unknown>;
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

const DOOR_CLOSED = { id: '11111111-1111-4111-8111-111111111111', x1: 500, y1: 0, x2: 500, y2: 1000, type: 'door-closed' };
const TORCH = { id: '22222222-2222-4222-8222-222222222222', x: 750, y: 450, brightRadius: 2, dimRadius: 3, color: '#ffcc66', enabled: true };

let stored: Record<string, any>;
let sockets: FakeSocket[];

function makeSocket(id: string, userId: string, role: string): FakeSocket {
  const s: FakeSocket = {
    id,
    userId,
    role,
    campaignId: CAMPAIGN_ID,
    emit: jest.fn(),
    handlers: {},
    on: jest.fn(),
    to: jest.fn(),
  };
  s.on.mockImplementation((event: string, handler: (payload: unknown) => unknown) => {
    s.handlers[event] = handler;
  });
  s.to.mockImplementation(() => ({
    emit: (event: string, payload: unknown) => {
      for (const other of sockets) if (other.id !== s.id) other.emit(event, payload);
    },
  }));
  return s;
}

const io = {
  in: jest.fn(() => ({ fetchSockets: jest.fn(async () => sockets) })),
  to: jest.fn(() => ({
    emit: (event: string, payload: unknown) => {
      for (const s of sockets) s.emit(event, payload);
    },
  })),
};

let dm: FakeSocket;
let alice: FakeSocket;

/** Token events (token.added / token.removed) a socket received. */
function tokenEvents(s: FakeSocket) {
  return s.emit.mock.calls
    .filter(([event]) => event === 'token.added' || event === 'token.removed')
    .map(([event, payload]) => [event, payload.token?.id ?? payload.tokenId]);
}

beforeEach(() => {
  jest.clearAllMocks();
  stored = {
    id: MAP_ID,
    campaignId: CAMPAIGN_ID,
    name: 'Crypt',
    width: 10,
    height: 10,
    gridSize: 100,
    tokens: [
      token('pc-alice', 2, 5, { controlledBy: 'alice', sightRadius: 0 }),
      token('orc', 3, 6), // west
      token('goblin', 7, 5, { notes: 'DM secret' }), // east
      token('lurker', 8, 5, { visible: false }), // east, hidden
    ],
    annotations: [],
    wallSegments: [DOOR_CLOSED],
    lights: [],
    lightingEnabled: true,
    spiritLayerUrl: null,
    fogData: null,
  };
  db.map.findUnique.mockImplementation(async () => JSON.parse(JSON.stringify(stored)));
  db.map.update.mockImplementation(async ({ data }: any) => {
    stored = { ...stored, ...JSON.parse(JSON.stringify(data)) };
    return JSON.parse(JSON.stringify(stored));
  });
  db.campaignMembership.findMany.mockResolvedValue([
    { userId: 'dm-user', role: 'DM', characterIds: [] },
    { userId: 'alice', role: 'PLAYER', characterIds: [] },
  ]);
  db.campaign.findUnique.mockResolvedValue({ spiritLayerEnabled: false, currentMapId: MAP_ID });
  db.character.findMany.mockResolvedValue([]);

  dm = makeSocket('s-dm', 'dm-user', 'DM');
  alice = makeSocket('s-alice', 'alice', 'PLAYER');
  sockets = [dm, alice];
  setSocketInstance(io as any);
  for (const s of sockets) {
    registerWallHandlers(io as any, s as any);
    registerLightHandlers(io as any, s as any);
    registerMapHandlers(io as any, s as any);
  }
});

describe('walls', () => {
  it('reveals the tokens behind a door a player opens', async () => {
    await alice.handlers['wall:update']({ mapId: MAP_ID, segment: { ...DOOR_CLOSED, type: 'door-open' } });

    expect(tokenEvents(alice)).toEqual([['token.added', 'goblin']]);
    const added = alice.emit.mock.calls.find(([event]) => event === 'token.added')![1];
    expect(added.token.notes).toBeUndefined();
    expect(tokenEvents(dm)).toEqual([]);
  });

  it('hides the tokens behind a door the DM closes', async () => {
    stored.wallSegments = [{ ...DOOR_CLOSED, type: 'door-open' }];
    await dm.handlers['wall:update']({ mapId: MAP_ID, segment: DOOR_CLOSED });

    expect(tokenEvents(alice)).toEqual([['token.removed', 'goblin']]);
  });

  it('re-syncs after a wall is removed and after walls are replaced', async () => {
    await dm.handlers['wall:remove']({ mapId: MAP_ID, segmentId: '11111111-1111-4111-8111-111111111111' });
    expect(tokenEvents(alice)).toEqual([['token.added', 'goblin']]);

    alice.emit.mockClear();
    await dm.handlers['walls:replace']({ mapId: MAP_ID, segments: [DOOR_CLOSED] });
    expect(tokenEvents(alice)).toEqual([['token.removed', 'goblin']]);
  });

  it('re-syncs after a wall is added', async () => {
    stored.wallSegments = [];
    await dm.handlers['wall:add']({ mapId: MAP_ID, segment: DOOR_CLOSED });
    expect(tokenEvents(alice)).toEqual([['token.removed', 'goblin']]);
  });
});

describe('lights', () => {
  it('reveals the tokens a new light shines on', async () => {
    await dm.handlers['light:add']({ mapId: MAP_ID, light: TORCH });

    expect(tokenEvents(alice)).toEqual([['token.added', 'goblin']]);
    expect(tokenEvents(dm)).toEqual([]);
  });

  it('hides them again when the light is removed, disabled or replaced', async () => {
    stored.lights = [TORCH];
    await dm.handlers['light:update']({ mapId: MAP_ID, light: { ...TORCH, enabled: false } });
    expect(tokenEvents(alice)).toEqual([['token.removed', 'goblin']]);

    alice.emit.mockClear();
    await dm.handlers['lights:replace']({ mapId: MAP_ID, lights: [TORCH] });
    expect(tokenEvents(alice)).toEqual([['token.added', 'goblin']]);

    alice.emit.mockClear();
    await dm.handlers['light:remove']({ mapId: MAP_ID, lightId: '22222222-2222-4222-8222-222222222222' });
    expect(tokenEvents(alice)).toEqual([['token.removed', 'goblin']]);
  });
});

describe('map.changed ownership', () => {
  it('gives an assigned player sight from their character-linked token (controlledBy null)', async () => {
    stored.tokens = [
      token('pc-robin', 2, 5, { characterId: 'char-robin', sightRadius: 0 }),
      token('orc', 3, 6),
      token('goblin', 7, 5),
    ];
    db.campaignMembership.findMany.mockResolvedValue([
      { userId: 'dm-user', role: 'DM', characterIds: ['char-robin'] },
      { userId: 'alice', role: 'PLAYER', characterIds: ['char-robin'] },
    ]);

    await dm.handlers['map.change']({ mapId: MAP_ID });

    const changed = alice.emit.mock.calls.find(([event]) => event === 'map.changed')![1];
    expect(changed.mapData.tokens.map((t: { id: string }) => t.id).sort()).toEqual(['orc', 'pc-robin']);
  });
});
