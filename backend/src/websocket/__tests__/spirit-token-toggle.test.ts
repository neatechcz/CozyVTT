/**
 * spirit_layer.token.toggle (DM shows / hides a token) goes through the same
 * per-recipient pipeline as the REST token events (broadcastTokenEvent):
 * players get `token.added` / `token.removed` for tokens they may see (line
 * of sight on lighting maps, DM notes stripped), never the raw token; the
 * `spirit_layer.token.toggled` event with the full token goes to DMs only.
 * The stored token is not mutated in place.
 *
 * No database: a stateful Prisma mock and a fake Socket.io server.
 * Fixture: 10×10, gridSize 100, a wall at x = 500 px (west: Alice).
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
import { registerSpiritHandlers } from '../handlers/spirit';

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

let stored: Record<string, any>;
let sockets: FakeSocket[];
let dm: FakeSocket;
let alice: FakeSocket;

function makeSocket(id: string, userId: string, role: string): FakeSocket {
  const s: FakeSocket = { id, userId, role, campaignId: CAMPAIGN_ID, emit: jest.fn(), handlers: {}, on: jest.fn() };
  s.on.mockImplementation((event: string, handler: (payload: unknown) => unknown) => {
    s.handlers[event] = handler;
  });
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

function events(s: FakeSocket) {
  return s.emit.mock.calls.map(([event, payload]) => [event, payload]);
}

async function toggle(tokenId: string, visible: boolean) {
  await dm.handlers['spirit_layer.token.toggle']({ mapId: MAP_ID, tokenId, visible });
}

beforeEach(() => {
  jest.clearAllMocks();
  stored = {
    id: MAP_ID,
    campaignId: CAMPAIGN_ID,
    width: 10,
    height: 10,
    gridSize: 100,
    tokens: [
      token('pc-alice', 2, 5, { controlledBy: 'alice', sightRadius: 0 }),
      token('orc', 3, 6, { visible: false, notes: 'DM secret' }), // west, in sight
      token('goblin', 7, 5, { visible: false }), // east, out of sight
      token('wraith', 3, 4, { layer: 'spirit', visible: false }), // west, spirit plane
    ],
    wallSegments: [{ id: 'w', x1: 500, y1: 0, x2: 500, y2: 1000, type: 'wall' }],
    lights: [],
    lightingEnabled: true,
  };
  db.map.findUnique.mockImplementation(async () => JSON.parse(JSON.stringify(stored)));
  db.map.update.mockImplementation(async ({ data }: any) => {
    stored = { ...stored, ...JSON.parse(JSON.stringify(data)) };
    return stored;
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
  registerSpiritHandlers(io as any, dm as any);
});

it('reveals an in-sight token to the player as token.added without DM notes', async () => {
  await toggle('orc', true);

  const { notes: _notes, ...orcView } = { ...stored.tokens[1] };
  expect(events(alice)).toEqual([['token.added', { mapId: MAP_ID, token: orcView }]]);
  expect(JSON.stringify(events(alice))).not.toContain('DM secret');
});

it('sends the player nothing for a token revealed outside their sight', async () => {
  await toggle('goblin', true);

  expect(alice.emit).not.toHaveBeenCalled();
});

it('sends the player nothing for a spirit-layer token they cannot see', async () => {
  await toggle('wraith', true);

  expect(alice.emit).not.toHaveBeenCalled();
});

it('sends token.removed when an in-sight token is hidden', async () => {
  stored.tokens[1].visible = true;
  await toggle('orc', false);

  expect(events(alice)).toEqual([['token.removed', { mapId: MAP_ID, tokenId: 'orc' }]]);
});

it('sends spirit_layer.token.toggled with the full token to DMs only', async () => {
  await toggle('orc', true);

  const toggled = dm.emit.mock.calls.find(([event]) => event === 'spirit_layer.token.toggled');
  expect(toggled![1]).toEqual(
    expect.objectContaining({ mapId: MAP_ID, tokenId: 'orc', visible: true, token: expect.objectContaining({ notes: 'DM secret' }) })
  );
  expect(alice.emit.mock.calls.some(([event]) => event === 'spirit_layer.token.toggled')).toBe(false);
  // The DM also gets the regular token event.
  expect(dm.emit.mock.calls.some(([event]) => event === 'token.updated')).toBe(true);
});

it('does not mutate the token read from the map in place', async () => {
  const read = JSON.parse(JSON.stringify(stored));
  db.map.findUnique.mockResolvedValueOnce(read);

  await toggle('orc', true);

  expect(read.tokens[1].visible).toBe(false);
  expect(stored.tokens[1].visible).toBe(true);
});
